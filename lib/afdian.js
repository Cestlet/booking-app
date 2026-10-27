// 爱发电（afdian）收款模块（零依赖，仅用内置 https/crypto/fs/path）
// 说明：签名算法与接口字段以爱发电开发者文档为准，全部收敛在 sign()/normalizeOrder() 两处，联调只改这里。

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'afdian.json');
// 爱发电双域名：afdian.net 在某些网络（阿里云 DNS）解析失败，改用 ifdian.net
const API_BASE = 'https://ifdian.net/api/open';
const POLL_INTERVAL = Number(process.env.AFDIAN_POLL_MS) || 5 * 60 * 1000; // 默认 5 分钟
// 金额单位统一为「元」：爱发电 total_amount 返回字符串元（如 "5.00"），custom_price 下单参数同为元

let file = { configs: {}, pendingOrders: [] };
const processed = new Map(); // outTradeNo -> 时间戳（本轮去重）
const suspended = new Map(); // photographerId -> { consecutiveFailures, lastError }
let busy = false;

// ---------- 文件读写（与 server.js 的 loadStore/saveStore 同构） ----------

async function load() {
  try {
    file = JSON.parse(await fs.promises.readFile(FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    file = { configs: {}, pendingOrders: [] };
  }
  if (!file.configs) file.configs = {};
  if (!Array.isArray(file.pendingOrders)) file.pendingOrders = [];
}

async function save() {
  await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
  await fs.promises.writeFile(FILE, JSON.stringify(file, null, 2), 'utf8');
}

function getConfig(photographerId) {
  return file.configs[photographerId] || null;
}

// 保存配置；token/webhookToken 为空或等于掩码占位则保留旧值
async function saveConfig(photographerId, patch) {
  const current = getConfig(photographerId) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  for (const key of ['token', 'webhookToken']) {
    const value = String(next[key] || '');
    if (!value || value.startsWith('••••')) next[key] = current[key] || '';
  }
  file.configs[photographerId] = next;
  suspended.delete(photographerId);
  await save();
  return next;
}

function mask(value) {
  return value ? `••••${String(value).slice(-4)}` : '';
}

function maskConfig(cfg) {
  if (!cfg) {
    return { enabled: false, tokenSet: false, webhookTokenSet: false };
  }
  return {
    ...cfg,
    token: mask(cfg.token),
    webhookToken: mask(cfg.webhookToken),
    tokenSet: !!cfg.token,
    webhookTokenSet: !!cfg.webhookToken
  };
}

function isMock() {
  return process.env.AFDIAN_MOCK === '1';
}

// ---------- 签名与请求（联调校准点一） ----------

function md5(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
}

// 官方 SDK 实测：sign = md5(token + "params" + params + "ts" + ts + "user_id" + user_id)，小写 hex
function sign(userId, token, params, ts) {
  const body = { user_id: userId, ts, params };
  return md5(`${token}params${body.params}ts${body.ts}user_id${body.user_id}`);
}

function requestApi(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      `${API_BASE}/${pathname}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`爱发电响应解析失败：${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('爱发电请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function queryOrders(config, page = 1) {
  if (isMock()) {
    return { ec: 200, em: 'ok', data: { list: mockOrdersFor(config), total_count: 0, total_page: 1 } };
  }
  const params = JSON.stringify({ page });
  const ts = Math.floor(Date.now() / 1000);
  const body = {
    user_id: config.user_id,
    ts,
    params,
    sign: sign(config.user_id, config.token, params, ts)
  };
  const res = await requestApi('query-order', body);
  if (String(res.ec) !== '200' && String(res.ec) !== '0' && String(res.ec) !== '1') {
    const err = new Error(`爱发电 query-order 失败：ec=${res.ec} em=${res.em || ''}`);
    err.authFailed = String(res.ec) === '403' || /sign|auth|token/i.test(String(res.em || ''));
    throw err;
  }
  return res;
}

// ---------- 订单归一化与匹配（联调校准点二） ----------

// raw 是爱发电订单字段，转成内部结构；字段名不一致时只改这里
function normalizeOrder(raw) {
  if (!raw || !raw.out_trade_no) return null;
  return {
    outTradeNo: String(raw.out_trade_no),
    planId: String(raw.plan_id || ''),
    totalAmount: Number(raw.total_amount), // 元（爱发电返回字符串元，如 "5.00"）
    status: Number(raw.status),
    remark: String(raw.remark || ''),
    customOrderId: String(raw.custom_order_id || ''),
    paidAt: String(raw.paid_time || ''),
    buyerUserId: String(raw.user_id || '')
  };
}

function orderAlreadyApplied(order, store) {
  // 持久化去重：任一 booking 已记录该交易号，或待核对列表已存在
  for (const booking of store.bookings) {
    for (const key of ['deposit', 'balance']) {
      if (booking.payment[key]?.transactionId === order.outTradeNo) return true;
    }
  }
  return file.pendingOrders.some((item) => item.outTradeNo === order.outTradeNo);
}

// 匹配 booking；返回 { booking, key } 或 null；金额不符/歧义返回 null（进待核对）
function matchBooking(order, photographerId, store) {
  const bookingRef = order.customOrderId ? /^(YB-\d{4}-\d{3})-(deposit|balance)$/.exec(order.customOrderId) : null;
  const remarkRef = /(YB-\d{4}-\d{3})(?:[-\s]?(deposit|balance))?/.exec(order.remark);

  const tryMatch = (booking, key) => {
    if (!booking || booking.photographerId !== photographerId) return null;
    if (booking.status === 'cancelled') return null;
    const payment = booking.payment && booking.payment[key];
    if (!payment || payment.status === 'paid') return null;
    // 金额校验：订单金额（元）必须与应付款一致，不符不自动入账
    if (Math.abs(order.totalAmount - payment.amount) > 0.01) return null;
    return { booking, key };
  };

  // 1. custom_order_id 精确匹配（优先）
  if (bookingRef) {
    const booking = store.bookings.find((item) => item.id === bookingRef[1]);
    const match = tryMatch(booking, bookingRef[2]);
    if (match) return match;
    // 订单号明确但金额不符/已付：不再兜底匹配其他预约（防客妹改金额导致误配），交人工核对
    if (booking && booking.photographerId === photographerId) return null;
  }

  // 2. remark 备注匹配
  if (remarkRef) {
    const booking = store.bookings.find((item) => item.id === remarkRef[1]);
    if (remarkRef[2]) {
      const match = tryMatch(booking, remarkRef[2]);
      if (match) return match;
      if (booking && booking.photographerId === photographerId) return null;
    } else {
      // 未注明定金/尾款：按未付项 + 金额唯一候选判定
      for (const key of ['deposit', 'balance']) {
        const match = tryMatch(booking, key);
        if (match) return match;
      }
      if (booking && booking.photographerId === photographerId) return null;
    }
  }

  // 3. 兜底：该摄影师名下未付且金额唯一的 booking
  const candidates = [];
  for (const booking of store.bookings) {
    if (booking.photographerId !== photographerId || booking.status === 'cancelled') continue;
    for (const key of ['deposit', 'balance']) {
      const payment = booking.payment[key];
      if (payment && payment.status !== 'paid' && Math.abs(order.totalAmount - payment.amount) <= 0.01) {
        candidates.push({ booking, key });
      }
    }
  }
  if (candidates.length === 1) return candidates[0];
  return null;
}

// ---------- 入账 ----------

// 由 server.js 注入（避免循环依赖）：applyPayment(booking, key, info) -> boolean
let applyPaidFn = null;
function init({ applyPayment }) {
  applyPaidFn = applyPayment;
}

// 从订单内容推断摄影师：真实爱发电回调不带 Bearer token，
// 通过 custom_order_id 中的预约编号反查摄影师归属（加固：不依赖请求头鉴权）
function inferPhotographerId(body, store) {
  const orders = extractOrders(body);
  for (const raw of orders) {
    const ref = /^(YB-\d{4}-\d{3})-(deposit|balance)$/.exec(String(raw.custom_order_id || ''));
    if (ref) {
      const booking = store.bookings.find((item) => item.id === ref[1]);
      if (booking) return booking.photographerId;
    }
  }
  return null;
}

// 处理单个订单（webhook 与轮询共用）：返回 'matched' | 'pending' | 'duplicate' | 'skip'
async function processOrder(order, photographerId, store, saveStore) {
  if (!order || order.status !== 2) return 'skip';
  // 加固：金额必须为正（拒绝 0 元/负数订单伪造入账）
  if (!Number.isFinite(order.totalAmount) || order.totalAmount <= 0) return 'skip';
  if (processed.has(order.outTradeNo)) return 'duplicate';
  if (orderAlreadyApplied(order, store)) {
    processed.set(order.outTradeNo, Date.now());
    return 'duplicate';
  }
  processed.set(order.outTradeNo, Date.now());
  // processed 只保留 24 小时，防无限增长
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, ts] of processed) {
    if (ts < cutoff) processed.delete(key);
  }

  const match = matchBooking(order, photographerId, store);
  if (match && applyPaidFn) {
    const changed = await applyPaidFn(match.booking, match.key, {
      provider: 'afdian',
      transactionId: order.outTradeNo,
      paidAt: order.paidAt || null
    });
    if (changed) {
      await saveStore();
      console.log(`[afdian] 已确认收款：${order.outTradeNo}（${match.booking.id} ${match.key}）`);
      return 'matched';
    }
  }

  file.pendingOrders.push({
    id: `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    photographerId,
    outTradeNo: order.outTradeNo,
    planId: order.planId,
    totalAmount: order.totalAmount,
    remark: order.remark,
    customOrderId: order.customOrderId,
    receivedAt: new Date().toISOString(),
    matchedBookingId: null,
    matchedKey: null,
    ignored: false
  });
  await save();
  console.log(`[afdian] 订单待人工核对：${order.outTradeNo}（¥${order.totalAmount.toFixed(2)}，备注：${order.remark || '无'}）`);
  return 'pending';
}

// ---------- 人工关联 ----------

async function linkOrder(orderId, { bookingId, paymentKey }, store, saveStore) {
  const pending = file.pendingOrders.find((item) => item.id === orderId);
  if (!pending || pending.ignored) return { error: '待核对订单不存在' };
  const booking = store.bookings.find((item) => item.id === bookingId);
  if (!booking || booking.photographerId !== pending.photographerId) {
    return { error: '预约不存在或不属于当前摄影师' };
  }
  const payment = booking.payment && booking.payment[paymentKey];
  if (!payment) return { error: '支付类型不正确' };
  if (payment.status === 'paid') return { error: '该款项已支付' };
  // 人工关联不做金额硬校验：自动匹配失败的订单（金额差异/备注缺失）由摄影师人工确认后放行
  const changed = await applyPaidFn(booking, paymentKey, {
    provider: 'afdian',
    transactionId: pending.outTradeNo,
    paidAt: null
  });
  if (!changed) return { error: '该款项已支付' };
  pending.ignored = true;
  pending.matchedBookingId = bookingId;
  pending.matchedKey = paymentKey;
  await save();
  await saveStore();
  return { ok: true };
}

async function ignoreOrder(orderId) {
  const pending = file.pendingOrders.find((item) => item.id === orderId);
  if (!pending) return { error: '待核对订单不存在' };
  pending.ignored = true;
  await save();
  return { ok: true };
}

// ---------- Webhook ----------

function verifyWebhookToken(token) {
  if (!token) return null;
  for (const [photographerId, cfg] of Object.entries(file.configs)) {
    if (!cfg.webhookToken) continue;
    const a = Buffer.from(String(token));
    const b = Buffer.from(String(cfg.webhookToken));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return photographerId;
    }
  }
  return null;
}

// 防御式解析：兼容 body.data.order（单订单，爱发电 webhook 实际格式）、
//               body.data.list（数组，query-order 轮询格式）与 body.data（单对象）
function extractOrders(body) {
  const data = body && body.data;
  if (data && data.order && typeof data.order === 'object') return [data.order];
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && typeof data === 'object' && data.out_trade_no) return [data];
  return [];
}

// 处理 webhook 请求体（photographerId 由路由层从 webhookToken 匹配得到），返回统计
async function handleWebhookOrders(body, photographerId) {
  const orders = extractOrders(body);
  const stats = { matched: 0, pending: 0, duplicate: 0, skip: 0 };
  for (const raw of orders) {
    const order = normalizeOrder(raw);
    if (!order) {
      stats.skip += 1;
      continue;
    }
    const result = await processOrder(order, photographerId, storeRef, saveStoreRef);
    stats[result] = (stats[result] || 0) + 1;
  }
  return stats;
}

// ---------- 轮询 ----------

let pollTimer = null;

async function pollPhotographer(photographerId, store, saveStore) {
  const cfg = getConfig(photographerId);
  if (!cfg || !cfg.enabled) return { skipped: 'not_configured' };
  if (suspended.get(photographerId)?.consecutiveFailures >= 3) {
    return { skipped: 'suspended' };
  }
  try {
    const stats = { fetched: 0, matched: 0, pending: 0, duplicate: 0, skip: 0 };
    const res1 = await queryOrders(cfg, 1);
    const totalPages = Math.min(2, Number(res1.data?.total_page) || 1);
    for (let page = 1; page <= totalPages; page += 1) {
      const res = page === 1 ? res1 : await queryOrders(cfg, page);
      const list = (res.data && res.data.list) || [];
      for (const raw of list) {
        const order = normalizeOrder(raw);
        if (!order) continue;
        stats.fetched += 1;
        const result = await processOrder(order, photographerId, store, saveStore);
        stats[result] = (stats[result] || 0) + 1;
      }
    }
    suspended.delete(photographerId);
    return stats;
  } catch (err) {
    const record = suspended.get(photographerId) || { consecutiveFailures: 0, lastError: '' };
    record.consecutiveFailures += 1;
    record.lastError = err.message;
    suspended.set(photographerId, record);
    console.error(`[afdian] ${photographerId} 轮询失败（${record.consecutiveFailures} 次）：${err.message}`);
    return { error: err.message, consecutiveFailures: record.consecutiveFailures };
  }
}

let storeRef = null;
let saveStoreRef = null;

function startPoller() {
  const loop = async () => {
    if (busy) {
      pollTimer = setTimeout(loop, POLL_INTERVAL);
      return;
    }
    busy = true;
    try {
      if (!storeRef || !saveStoreRef) return;
      for (const photographerId of Object.keys(file.configs)) {
        await pollPhotographer(photographerId, storeRef, saveStoreRef);
      }
    } catch (err) {
      console.error('[afdian] 轮询任务异常：', err.message);
    } finally {
      busy = false;
      pollTimer = setTimeout(loop, POLL_INTERVAL);
    }
  };
  pollTimer = setTimeout(loop, POLL_INTERVAL);
}

function stopPoller() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function setStoreRefs(store, saveStore) {
  storeRef = store;
  saveStoreRef = saveStore;
}

// ---------- 下单链接 ----------

function buildPayUrl(planUrl, customOrderId, amountYuan) {
  const sep = planUrl.includes('?') ? '&' : '?';
  // custom_price 单位为元（两位小数）
  return `${planUrl}${sep}custom_order_id=${encodeURIComponent(customOrderId)}&custom_price=${Number(amountYuan).toFixed(2)}`;
}

// ---------- Mock（AFDIAN_MOCK=1，仅测试用） ----------

const mockOrders = [];

function mockOrdersFor(config) {
  return mockOrders.filter((order) => order.photographerId === config.user_id);
}

function injectMockOrder({ photographerUserId, customOrderId, remark, totalAmount, planId }) {
  const order = {
    photographerId: photographerUserId,
    out_trade_no: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    plan_id: planId || '',
    total_amount: totalAmount,
    status: 2,
    remark: remark || '',
    custom_order_id: customOrderId || '',
    paid_time: new Date().toISOString(),
    user_id: 'mock-buyer'
  };
  mockOrders.push(order);
  return order;
}

module.exports = {
  load,
  save,
  getConfig,
  saveConfig,
  maskConfig,
  isMock,
  sign,
  queryOrders,
  normalizeOrder,
  processOrder,
  inferPhotographerId,
  matchBooking,
  linkOrder,
  ignoreOrder,
  verifyWebhookToken,
  extractOrders,
  handleWebhookOrders,
  pollPhotographer,
  startPoller,
  stopPoller,
  setStoreRefs,
  init,
  buildPayUrl,
  injectMockOrder,
  getPendingOrders: () => file.pendingOrders
};
