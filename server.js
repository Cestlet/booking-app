const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const afdian = require('./lib/afdian');
const mail = require('./lib/mail');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'store.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, 'config.json');
const PORT = process.env.PORT || 3000;

let appConfig = null; // { admin: { email, password }, smtp, mock }

function loadAppConfig() {
  try {
    appConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    appConfig = null;
  }
}

let store = null;
const sessions = new Map();
const adminSessions = new Map(); // 管理员 token -> 管理员邮箱（与摄影师 sessions 完全隔离）

function createAdminSession(email) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, email);
  return token;
}

function requireAdmin(req, res) {
  // 只认 Authorization 头，不认 x-photographer-token——与摄影师会话物理隔离
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !adminSessions.has(token)) {
    sendJson(res, 401, { error: '管理员未登录' });
    return null;
  }
  return token;
}

// 邮箱验证码（内存态，重启失效可接受）
const VERIFY_TTL_MS = 5 * 60 * 1000;     // 验证码 5 分钟有效
const VERIFY_COOLDOWN_MS = 60 * 1000;    // 同邮箱 60 秒冷却
const VERIFY_DAILY_LIMIT = 10;           // 同邮箱当日最多 10 次
const VERIFY_MAX_ATTEMPTS = 5;           // 验证码最多尝试 5 次
const verificationCodes = new Map();     // email -> { code, expiresAt, attempts }
const sendLog = new Map();               // email -> { dateKey, count, lastSentAt }

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

function makeVerifyCode() {
  return String(crypto.randomInt(100000, 1000000)); // 恒 6 位数字
}

// 发送限流检查：冷却期 / 当日上限
function checkSendLimit(email) {
  const now = Date.now();
  const record = sendLog.get(email);
  if (record) {
    if (now - record.lastSentAt < VERIFY_COOLDOWN_MS) {
      const retryAfter = Math.ceil((VERIFY_COOLDOWN_MS - (now - record.lastSentAt)) / 1000);
      return { ok: false, status: 429, error: `发送太频繁，请 ${retryAfter} 秒后再试` };
    }
    const dateKey = new Date().toISOString().slice(0, 10);
    if (record.dateKey === dateKey && record.count >= VERIFY_DAILY_LIMIT) {
      return { ok: false, status: 429, error: '今日发送次数已达上限，请明天再试' };
    }
  }
  return { ok: true };
}

function recordSend(email) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const record = sendLog.get(email);
  sendLog.set(email, {
    dateKey,
    count: record && record.dateKey === dateKey ? record.count + 1 : 1,
    lastSentAt: Date.now()
  });
}

// 校验验证码：'ok' | 'wrong' | 'expired'；一次性（成功即删），5 次错误失效
function consumeCode(email, code) {
  const entry = verificationCodes.get(email);
  if (!entry) return 'expired';
  if (Date.now() > entry.expiresAt) {
    verificationCodes.delete(email);
    return 'expired';
  }
  if (entry.code !== String(code || '').trim()) {
    entry.attempts += 1;
    if (entry.attempts >= VERIFY_MAX_ATTEMPTS) {
      verificationCodes.delete(email);
    }
    return 'wrong';
  }
  verificationCodes.delete(email);
  return 'ok';
}

function defaultStore() {
  const now = new Date().toISOString();
  return {
    settings: {
      siteName: '摄影约单',
      notice: '请先确认可约时间，再填写表单。定金支付后视为预约成功。',
      slotMinutes: 20,
      adminPassword: ''
    },
    photographers: [],
    formTemplates: [],
    timeTemplates: [],
    schedules: [],
    bookings: [],
    products: []
  };
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// scrypt 密码哈希（内存困难算法，抗 GPU 爆破）；带 scrypt$ 前缀，旧数据（HMAC-SHA256）兼容验证
function hashPassword(password, salt) {
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${derived.toString('hex')}`;
}

function verifyPassword(password, salt, stored) {
  if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
    const derived = crypto.scryptSync(password, salt, 64);
    return `scrypt$${derived.toString('hex')}` === stored;
  }
  // 旧格式：HMAC-SHA256（无前缀）
  return crypto.createHmac('sha256', salt).update(password).digest('hex') === stored;
}

// 登录失败限流：5 次失败锁定 15 分钟（防暴力破解）
const loginAttempts = new Map(); // email -> { count, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function checkLoginLock(email) {
  const record = loginAttempts.get(email);
  if (record && record.lockedUntil && Date.now() < record.lockedUntil) {
    return { locked: true, retryAfter: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
  }
  if (record && record.lockedUntil && Date.now() >= record.lockedUntil) {
    loginAttempts.delete(email);
  }
  return { locked: false };
}

function recordLoginFailure(email) {
  const record = loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    record.count = 0;
  }
  loginAttempts.set(email, record);
}

function generatePhotographerId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do {
    id = 'P';
    for (let i = 0; i < 5; i += 1) {
      id += chars[crypto.randomInt(chars.length)];
    }
  } while (store.photographers.some((photographer) => photographer.id === id));
  return id;
}

function createSession(photographerId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, photographerId);
  return token;
}

function requireAuth(req, res) {
  const header = req.headers.authorization || req.headers['x-photographer-token'] || '';
  const token = String(header).replace(/^Bearer\s+/i, '').trim();
  const photographerId = sessions.get(token);
  if (!photographerId) {
    sendJson(res, 401, { error: '请先登录' });
    return null;
  }
  const photographer = store.photographers.find((item) => item.id === photographerId);
  if (!photographer) {
    sendJson(res, 401, { error: '账号不存在' });
    return null;
  }
  if (photographer.frozen) {
    sendJson(res, 401, { error: '账号已冻结，请联系管理员' });
    return null;
  }
  return photographerId;
}

async function loadStore() {
  try {
    store = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fs.promises.mkdir(path.join(ROOT, 'data'), { recursive: true });
    store = defaultStore();
    await saveStore();
  }
  // 旧数据兼容迁移：清空旧式账号（非邮箱）后，为无商品摄影师补默认商品
  let changed = resetLegacyAuthData();
  if (migrateStore()) changed = true;
  if (changed) {
    await saveStore();
  }
  await fs.promises.mkdir(path.join(PUBLIC_DIR, 'uploads'), { recursive: true });
}

// 清空重来：仅当存在旧式（非邮箱）用户名账号时触发，幂等（清空后无非邮箱账号即 no-op）
// RESET_STORE=1 显式开关双保险；settings 保留
function resetLegacyAuthData() {
  const legacy = store.photographers.filter((photographer) => !String(photographer.username || '').includes('@'));
  const allLegacy = store.photographers.length > 0 && legacy.length === store.photographers.length;
  const forced = process.env.RESET_STORE === '1' && legacy.length > 0;
  if (legacy.length === 0 || (!forced && !allLegacy)) {
    return false;
  }
  const count = store.photographers.length;
  store.photographers = [];
  store.formTemplates = [];
  store.timeTemplates = [];
  store.schedules = [];
  store.bookings = [];
  store.products = [];
  console.log(`[migrate] 已清空 ${count} 个旧摄影师账号及关联数据，请使用邮箱重新注册。`);
  return true;
}

// 为无商品的摄影师生成默认商品；返回是否有变更
function migrateStore() {
  if (!Array.isArray(store.products)) store.products = [];
  let changed = false;
  for (const photographer of store.photographers) {
    if (store.products.some((product) => product.photographerId === photographer.id)) continue;
    // 金额对齐老数据：取该摄影师首个带价格 slot 的金额，取不到用 50/50
    const schedule = store.schedules.find((item) => item.photographerId === photographer.id);
    const pricedSlot = schedule?.slots?.find((slot) => Number(slot.deposit) > 0);
    const deposit = Number(pricedSlot?.deposit) || 50;
    const balance = Number(pricedSlot?.balance) || 50;
    store.products.push({
      id: uid('prod'),
      photographerId: photographer.id,
      name: '默认约单',
      deposit,
      balance,
      slotUnits: 1,
      enabled: true,
      sortOrder: 0,
      createdAt: new Date().toISOString()
    });
    changed = true;
  }
  return changed;
}

async function saveStore() {
  await fs.promises.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 12 * 1024 * 1024) {
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function findSchedule(id) {
  return store.schedules.find((item) => item.id === id);
}

// 某时间格上的有效预约数（预约按 slotUnits 展开占用连续格，老 booking 缺省占 1 格）
function slotBookingCount(schedule, slotId) {
  const slotIndex = schedule.slots.findIndex((slot) => slot.id === slotId);
  if (slotIndex < 0) return 0;
  return store.bookings.filter((booking) => {
    if (booking.scheduleId !== schedule.id || booking.status === 'cancelled') return false;
    const startIndex = schedule.slots.findIndex((slot) => slot.id === booking.slotId);
    if (startIndex < 0) return false;
    const units = Math.max(1, Number(booking.slotUnits) || 1);
    return slotIndex >= startIndex && slotIndex < startIndex + units;
  }).length;
}

// 检查从 slotIndex 起连续 units 格是否可预约
function isRangeAvailable(schedule, slotIndex, units) {
  if (slotIndex < 0 || slotIndex + units > schedule.slots.length) {
    return { ok: false, reason: '该商品占用时间超出当日可约范围' };
  }
  for (let index = slotIndex; index < slotIndex + units; index += 1) {
    const slot = schedule.slots[index];
    if (!slot.enabled) {
      return { ok: false, reason: '该时段已关闭' };
    }
    if (slotBookingCount(schedule, slot.id) >= slot.capacity) {
      return { ok: false, reason: '该时段已约满' };
    }
  }
  return { ok: true };
}

function publicPayload(photographerId) {
  const photographer = store.photographers.find((item) => item.id === photographerId);
  if (!photographer) {
    return null;
  }
  const schedules = store.schedules
    .filter((schedule) => schedule.photographerId === photographerId)
    .map((schedule) => {
    const template = store.formTemplates.find((item) => item.id === schedule.formTemplateId && item.photographerId === photographerId);
    // slots 白名单：剥离价格等内部字段
    const slots = schedule.slots.map((slot) => {
      const booked = slotBookingCount(schedule, slot.id);
      return {
        id: slot.id,
        start: slot.start,
        end: slot.end,
        capacity: slot.capacity,
        enabled: slot.enabled,
        note: slot.note || '',
        booked,
        available: slot.enabled && booked < slot.capacity
      };
    });
    return {
      id: schedule.id,
      date: schedule.date,
      formTemplate: template ? { id: template.id, name: template.name, fields: template.fields } : null,
      slots
    };
  });

  // 启用商品列表（仅回传客妹端需要的信息）
  const products = store.products
    .filter((product) => product.photographerId === photographerId && product.enabled)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((product) => ({
      id: product.id,
      name: product.name,
      deposit: product.deposit,
      balance: product.balance,
      slotUnits: Math.max(1, Number(product.slotUnits) || 1)
    }));

  // 爱发电可用：配置启用 且有统一下单链接
  const cfg = afdian.getConfig(photographerId);
  const afdianEnabled = !!cfg?.enabled && !!cfg?.planUrl;

  return {
    photographer: {
      id: photographer.id,
      displayName: photographer.displayName,
      afdianEnabled,
      payQr: photographer.payQr || null
    },
    settings: {
      siteName: store.settings.siteName,
      notice: store.settings.notice,
      slotMinutes: store.settings.slotMinutes
    },
    schedules,
    products
  };
}

// 商品输入归一化（支付链接统一在爱发电配置中填写，商品不再单独配置）
function normalizeProduct(body) {
  return {
    name: String(body.name || '').trim() || '未命名商品',
    deposit: Math.max(0, Number(body.deposit) || 0),
    balance: Math.max(0, Number(body.balance) || 0),
    slotUnits: Math.max(1, Math.round(Number(body.slotUnits) || 1)),
    enabled: body.enabled === undefined ? true : !!body.enabled
  };
}

// 时间格白名单：剥离价格等内部字段（价格只属于商品）
function normalizeScheduleSlots(slots) {
  return (Array.isArray(slots) ? slots : []).map((slot) => ({
    id: slot.id,
    start: slot.start || '',
    end: slot.end || '',
    capacity: Math.max(1, Number(slot.capacity) || 1),
    enabled: slot.enabled === undefined ? true : !!slot.enabled,
    note: String(slot.note || '')
  }));
}

function createBookingId(schedule) {
  const datePart = schedule.date.replaceAll('-', '').slice(4);
  const count = store.bookings.filter((booking) => booking.scheduleId === schedule.id).length + 1;
  return `YB-${datePart}-${String(count).padStart(3, '0')}`;
}

// 统一「标记已付 + 推进订单状态机」：模拟支付 / 爱发电回调 / 人工关联 / 后台手动标记共用
// 返回是否发生状态变更（已付幂等守卫返回 false）
function applyPaidTransition(booking, key, info) {
  const current = booking.payment[key];
  if (!current || current.status === 'paid') {
    return false;
  }
  booking.payment[key] = {
    ...current,
    status: 'paid',
    paidAt: info.paidAt || new Date().toISOString(),
    provider: info.provider || 'mock',
    transactionId: info.transactionId || null,
    intentId: null,
    intentAt: null
  };
  if (key === 'deposit' && booking.status === 'pending') {
    booking.status = 'deposit_paid';
  }
  if (key === 'balance' && booking.status === 'deposit_paid') {
    booking.status = 'completed';
  }
  return true;
}

function paymentFromProduct(product) {
  const item = (amount) => ({
    amount: Number(amount) || 0,
    status: 'unpaid', // unpaid 未付 → pending 支付中 → paid 已付
    paidAt: null,
    provider: null,
    transactionId: null,
    intentId: null, // 爱发电 custom_order_id（如 YB-0815-001-deposit）
    intentAt: null   // 发起支付时间
  });
  return {
    deposit: item(product.deposit),
    balance: item(product.balance)
  };
}

function timeToMinutes(value) {
  if (!value) return NaN;
  const [hours, minutes] = String(value).split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : NaN;
}

function minutesToTime(value) {
  const hours = String(Math.floor(value / 60)).padStart(2, '0');
  const minutes = String(value % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function generateTimeSlots(template) {
  const start = timeToMinutes(template.startTime);
  const end = timeToMinutes(template.endTime);
  const interval = Number(template.intervalMinutes) || 20;
  if (Number.isNaN(start) || Number.isNaN(end) || interval <= 0 || end <= start) {
    return [];
  }

  const slots = [];
  for (let current = start; current + interval <= end; current += interval) {
    slots.push({
      start: minutesToTime(current),
      end: minutesToTime(current + interval),
      note: ''
    });
  }
  return slots;
}

function templateSlots(template) {
  if (template.startTime && template.endTime) {
    return generateTimeSlots(template);
  }
  return Array.isArray(template.slots) ? template.slots : [];
}

function fieldMatches(value, expected) {
  // 显示逻辑支持多选：expected 为数组（任一选中即匹配），兼容旧字符串数据
  const list = Array.isArray(expected) ? expected : [expected].filter((x) => x !== undefined && x !== null && x !== '');
  if (Array.isArray(value)) {
    return list.some((item) => value.includes(item));
  }
  if (value && typeof value === 'object') {
    return list.includes(String(value.type || '')) || list.includes(String(value.value || ''));
  }
  return list.includes(String(value || ''));
}

function isFieldVisible(template, formAnswers, fieldIndex) {
  for (let index = 0; index < template.fields.length; index += 1) {
    const controller = template.fields[index];
    const logic = controller.displayLogic;
    if (!logic || !logic.enabled || index === fieldIndex) {
      continue;
    }
    const start = Number(logic.startIndex) || 0;
    const end = Number(logic.endIndex) || 0;
    if (start < 1 || end < start) {
      continue;
    }
    if (fieldIndex + 1 < start || fieldIndex + 1 > end) {
      continue;
    }
    if (!fieldMatches(formAnswers[controller.id], logic.value)) {
      return false;
    }
  }
  return true;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if ((method === 'POST' || method === 'GET') && parts[0] === 'api' && parts[1] === 'afdian' && parts[2] === 'webhook') {
    // 爱发电回调：官方 webhook 无签名，且测试/真实回调都不携带 Bearer token，
    // 因此不强制鉴权——以「订单必须精确匹配真实未付预约」作为实质校验。
    // 若请求带了 Authorization 且配置了 webhookToken，仍校验（可选安全层）。
    // 响应必须是 JSON 且含 ec:200，否则平台判定请求失败。
    if (method === 'GET') {
      // 保存 URL 时的连通性探测
      return sendJson(res, 200, { ec: 200, em: 'ok' });
    }
    const header = req.headers.authorization || '';
    const token = String(header).replace(/^Bearer\s+/i, '').trim();
    const photographerId = token ? afdian.verifyWebhookToken(token) : null;
    try {
      const body = await readBody(req);
      // 真实爱发电回调不带 Bearer：无 token 时从订单内容（custom_order_id 的预约编号）推断摄影师
      const effectiveId = photographerId || afdian.inferPhotographerId(body, store);
      const stats = await afdian.handleWebhookOrders(body, effectiveId);
      return sendJson(res, 200, { ec: 200, em: 'ok', data: stats });
    } catch (err) {
      // 解析失败仍返回 ec 结构，避免平台重试风暴
      console.error('[afdian] webhook 处理失败：', err.message);
      return sendJson(res, 200, { ec: 400, em: 'bad request' });
    }
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'afdian' && parts[2] === 'mock' && parts[3] === 'orders') {
    // 仅 AFDIAN_MOCK=1 时可用：注入假订单（测试用）
    if (!afdian.isMock()) {
      return sendJson(res, 404, { error: '接口不存在' });
    }
    const body = await readBody(req);
    const order = afdian.injectMockOrder({
      photographerUserId: String(body.photographerUserId || ''),
      customOrderId: String(body.customOrderId || ''),
      remark: String(body.remark || ''),
      totalAmount: Number(body.totalAmount),
      planId: String(body.planId || '')
    });
    return sendJson(res, 201, { order });
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'public' && parts[2]) {
    const targetPhotographer = store.photographers.find((item) => item.id === parts[2]);
    if (targetPhotographer && targetPhotographer.frozen) {
      return sendJson(res, 403, { error: '该摄影师账号已冻结' });
    }
    const payload = publicPayload(parts[2]);
    if (!payload) {
      return sendJson(res, 404, { error: '摄影师不存在' });
    }
    return sendJson(res, 200, payload);
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'send-code') {
    // 发送注册验证码到邮箱
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) {
      return sendJson(res, 400, { error: '邮箱格式不正确' });
    }
    if (store.photographers.some((photographer) => photographer.username === email)) {
      return sendJson(res, 400, { error: '该邮箱已注册' });
    }
    const limit = checkSendLimit(email);
    if (!limit.ok) {
      return sendJson(res, limit.status, { error: limit.error });
    }
    const code = makeVerifyCode();
    try {
      await mail.sendVerifyCodeMail({ to: email, code });
    } catch (err) {
      console.error('[mail] 验证码邮件发送失败：', err.message);
      return sendJson(res, 500, { error: '邮件发送失败，请稍后重试' });
    }
    verificationCodes.set(email, { code, expiresAt: Date.now() + VERIFY_TTL_MS, attempts: 0 });
    recordSend(email);
    const response = { ok: true, cooldownSeconds: VERIFY_COOLDOWN_MS / 1000 };
    if (mail.isDevMode()) {
      response.devCode = code;
      console.log('[mail-dev] ============================================');
      console.log(`[mail-dev] 注册验证码（开发模式）：${email} -> ${code}`);
      console.log('[mail-dev] ============================================');
    }
    return sendJson(res, 200, response);
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'register') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const code = String(body.code || '').trim();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim();
    if (!isValidEmail(email)) {
      return sendJson(res, 400, { error: '邮箱格式不正确' });
    }
    if (!displayName) {
      return sendJson(res, 400, { error: '请填写摄影昵称' });
    }
    if (password.length < 6) {
      return sendJson(res, 400, { error: '密码至少 6 位' });
    }
    if (store.photographers.some((photographer) => photographer.username === email)) {
      return sendJson(res, 400, { error: '该邮箱已注册' });
    }
    if (consumeCode(email, code) !== 'ok') {
      return sendJson(res, 400, { error: '验证码错误或已过期' });
    }
    const id = generatePhotographerId();
    const salt = crypto.randomBytes(8).toString('hex');
    const photographer = {
      id,
      username: email,
      displayName,
      salt,
      passwordHash: hashPassword(password, salt),
      qrTitle: displayName, // 接单二维码外框名称
      createdAt: new Date().toISOString()
    };
    store.photographers.push(photographer);
    // 新摄影师同步生成默认商品（与 migrateStore 同构）
    store.products.push({
      id: uid('prod'),
      photographerId: id,
      name: '默认约单',
      deposit: 50,
      balance: 50,
      slotUnits: 1,
      enabled: true,
      sortOrder: 0,
      createdAt: new Date().toISOString()
    });
    await saveStore();
    return sendJson(res, 201, {
      token: createSession(id),
      photographer: { id, username: email, displayName }
    });
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'login') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email ?? body.username); // 兼容旧字段
    const password = String(body.password || '');
    const lock = checkLoginLock(email);
    if (lock.locked) {
      return sendJson(res, 429, { error: `尝试次数过多，请 ${lock.retryAfter} 秒后再试` });
    }
    const photographer = store.photographers.find((item) => item.username === email);
    if (!photographer || !verifyPassword(password, photographer.salt, photographer.passwordHash)) {
      recordLoginFailure(email);
      return sendJson(res, 401, { error: '邮箱或密码错误' });
    }
    loginAttempts.delete(email);
    if (photographer.frozen) {
      return sendJson(res, 401, { error: '账号已冻结，请联系管理员' });
    }
    return sendJson(res, 200, {
      token: createSession(photographer.id),
      photographer: { id: photographer.id, username: photographer.username, displayName: photographer.displayName }
    });
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'me') {
    const photographerId = requireAuth(req, res);
    if (!photographerId) {
      return;
    }
    const photographer = store.photographers.find((item) => item.id === photographerId);
    if (!photographer) {
      return sendJson(res, 401, { error: '账号不存在' });
    }
    return sendJson(res, 200, {
      photographer: {
        id: photographer.id,
        username: photographer.username,
        displayName: photographer.displayName,
        qrTitle: photographer.qrTitle || photographer.displayName,
        payQr: photographer.payQr || null
      }
    });
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'bookings' && parts.length === 2) {
    const body = await readBody(req);
    const schedule = findSchedule(body.scheduleId);
    const product = body.productId ? store.products.find((item) => item.id === body.productId) : null;
    const template = schedule && store.formTemplates.find((item) => item.id === schedule.formTemplateId);

    if (!schedule) {
      return sendJson(res, 404, { error: '日程不存在' });
    }
    const schedulePhotographer = store.photographers.find((item) => item.id === schedule.photographerId);
    if (schedulePhotographer && schedulePhotographer.frozen) {
      return sendJson(res, 403, { error: '该摄影师账号已冻结' });
    }
    if (!product || product.photographerId !== schedule.photographerId) {
      return sendJson(res, 400, { error: '商品不存在' });
    }
    if (!product.enabled) {
      return sendJson(res, 400, { error: '该商品已下架' });
    }
    const slotIndex = schedule.slots.findIndex((slot) => slot.id === body.slotId);
    if (slotIndex < 0) {
      return sendJson(res, 404, { error: '时间段不存在' });
    }
    const rangeCheck = isRangeAvailable(schedule, slotIndex, product.slotUnits);
    if (!rangeCheck.ok) {
      return sendJson(res, 400, { error: rangeCheck.reason });
    }
    const slot = schedule.slots[slotIndex];

    const formAnswers = body.formAnswers || {};
    if (template) {
      for (let fieldIndex = 0; fieldIndex < template.fields.length; fieldIndex += 1) {
        const field = template.fields[fieldIndex];
        if (!isFieldVisible(template, formAnswers, fieldIndex)) {
          continue;
        }
        if (field.type === 'remark') {
          continue;
        }
        const value = formAnswers[field.id];
        if (field.type === 'checkbox' || field.type === 'image') {
          const list = Array.isArray(value) ? value : [];
          if (field.required && list.length === 0) {
            return sendJson(res, 400, { error: `请选择：${field.label}` });
          }
        } else if (field.type === 'contact') {
          const contact = value || {};
          if (field.required && (!contact.type || !String(contact.value || '').trim())) {
            return sendJson(res, 400, { error: `请填写：${field.label}` });
          }
        } else if (field.required && !String(value || '').trim()) {
          return sendJson(res, 400, { error: `请填写：${field.label}` });
        }
      }
    }

    const booking = {
      id: createBookingId(schedule),
      photographerId: schedule.photographerId,
      scheduleId: schedule.id,
      slotId: slot.id,
      productId: product.id,
      slotUnits: product.slotUnits,
      formAnswers,
      status: 'pending',
      shotDone: false, // 拍摄标记（独立于订单状态）
      payment: paymentFromProduct(product),
      createdAt: new Date().toISOString()
    };
    store.bookings.push(booking);
    await saveStore();
    return sendJson(res, 201, booking);
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'bookings' && parts[2] && parts.length === 3) {
    // 公共查询：客妹端轮询支付状态
    const booking = store.bookings.find((item) => item.id === parts[2]);
    if (!booking) {
      return sendJson(res, 404, { error: '预约不存在' });
    }
    return sendJson(res, 200, booking);
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'bookings' && parts[3] === 'pay') {
    const booking = store.bookings.find((item) => item.id === parts[2]);
    const body = await readBody(req);
    if (!booking) {
      return sendJson(res, 404, { error: '预约不存在' });
    }
    if (booking.status === 'cancelled') {
      return sendJson(res, 400, { error: '已取消的预约不能支付' });
    }

    const key = body.type === 'deposit' ? 'deposit' : body.type === 'balance' ? 'balance' : null;
    if (!key) {
      return sendJson(res, 400, { error: '支付类型只能是 deposit 或 balance' });
    }
    if (booking.payment[key].status === 'paid') {
      return sendJson(res, 400, { error: '该款项已支付' });
    }

    // 爱发电模式：置 pending 并返回跳转链接，付款由 webhook/轮询确认
    // 链接统一取摄影师配置的下单链接（金额由 custom_price 参数区分定金/尾款）
    const cfg = afdian.getConfig(booking.photographerId);
    const planUrl = (cfg?.planUrl || '').trim() || null;
    if (cfg && cfg.enabled && planUrl) {
      const payment = booking.payment[key];
      const intentId = payment.intentId || `${booking.id}-${key}`;
      if (payment.status !== 'pending' || !payment.intentId) {
        booking.payment[key] = {
          ...payment,
          status: 'pending',
          intentId,
          intentAt: new Date().toISOString()
        };
        await saveStore();
      }
      return sendJson(res, 200, {
        mode: 'afdian',
        booking,
        afdian: {
          payUrl: afdian.buildPayUrl(planUrl, intentId, booking.payment[key].amount),
          homeUrl: cfg.homeUrl || ''
        }
      });
    }

    // 未配置爱发电：保持模拟支付（原行为）
    applyPaidTransition(booking, key, {
      provider: body.provider || 'mock',
      transactionId: body.transactionId || `MOCK-${Date.now()}`
    });
    await saveStore();
    return sendJson(res, 200, { ...booking, mode: 'mock' });
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'uploads' && parts.length === 2) {
    const body = await readBody(req);
    const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/.exec(body.dataUrl || '');
    if (!match) {
      return sendJson(res, 400, { error: '只支持 png/jpg/webp/gif 图片' });
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 8 * 1024 * 1024) {
      return sendJson(res, 400, { error: '单张图片不能超过 8MB' });
    }
    const filename = `${uid('img')}.${ext}`;
    await fs.promises.writeFile(path.join(PUBLIC_DIR, 'uploads', filename), buffer);
    return sendJson(res, 201, { url: `/uploads/${filename}`, name: body.fileName || '' });
  }

  if (parts[0] === 'api' && parts[1] === 'super') {
    // ---------- 超级管理员 ----------
    if (method === 'POST' && parts[2] === 'login') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const admin = appConfig && appConfig.admin;
      if (!admin || !admin.email || !admin.password) {
        return sendJson(res, 400, { error: '管理员后台未配置，请联系服务部署者' });
      }
      const lock = checkLoginLock(email);
      if (lock.locked) {
        return sendJson(res, 429, { error: `尝试次数过多，请 ${lock.retryAfter} 秒后再试` });
      }
      if (normalizeEmail(admin.email) !== email || String(admin.password) !== password) {
        recordLoginFailure(email);
        return sendJson(res, 401, { error: '邮箱或密码错误' });
      }
      loginAttempts.delete(email);
      return sendJson(res, 200, { token: createAdminSession(email), email });
    }

    const adminToken = requireAdmin(req, res);
    if (!adminToken) {
      return;
    }

    if (method === 'GET' && parts[2] === 'accounts' && parts.length === 3) {
      const accounts = store.photographers.map((photographer) => ({
        id: photographer.id,
        username: photographer.username,
        displayName: photographer.displayName,
        createdAt: photographer.createdAt,
        frozen: !!photographer.frozen,
        productCount: store.products.filter((product) => product.photographerId === photographer.id).length,
        bookingCount: store.bookings.filter((booking) => booking.photographerId === photographer.id).length
      })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return sendJson(res, 200, { accounts });
    }

    if (method === 'GET' && parts[2] === 'accounts' && parts[3] && parts[4] === 'detail') {
      // 单个摄影师的详情：信息 + 统计 + 该摄影师的约单/预约
      const photographer = store.photographers.find((item) => item.id === parts[3]);
      if (!photographer) {
        return sendJson(res, 404, { error: '摄影师不存在' });
      }
      const schedules = store.schedules
        .filter((schedule) => schedule.photographerId === photographer.id)
        .map((schedule) => {
          const template = store.formTemplates.find((item) => item.id === schedule.formTemplateId);
          return {
            id: schedule.id,
            date: schedule.date,
            formTemplateName: template ? template.name : '—',
            slotCount: (schedule.slots || []).length,
            openSlotCount: (schedule.slots || []).filter((slot) => slot.enabled).length,
            products: store.products
              .filter((product) => product.photographerId === photographer.id)
              .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
              .map((product) => ({ id: product.id, name: product.name, deposit: product.deposit, balance: product.balance, slotUnits: product.slotUnits, enabled: product.enabled }))
          };
        })
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const bookings = store.bookings
        .filter((booking) => booking.photographerId === photographer.id)
        .map((booking) => {
          const product = store.products.find((item) => item.id === booking.productId);
          const schedule = store.schedules.find((item) => item.id === booking.scheduleId);
          const slot = schedule && schedule.slots.find((item) => item.id === booking.slotId);
          return {
            id: booking.id,
            productName: product ? product.name : '—',
            date: schedule ? schedule.date : '—',
            slotStart: slot ? slot.start : '—',
            slotEnd: slot ? slot.end : '—',
            status: booking.status,
            payment: booking.payment,
            createdAt: booking.createdAt
          };
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      let totalReceived = 0;
      let activeBookings = 0;
      for (const booking of bookings) {
        if (booking.status !== 'cancelled') activeBookings += 1;
        if (booking.payment.deposit.status === 'paid') totalReceived += Number(booking.payment.deposit.amount) || 0;
        if (booking.payment.balance.status === 'paid') totalReceived += Number(booking.payment.balance.amount) || 0;
      }
      return sendJson(res, 200, {
        photographer: {
          id: photographer.id,
          username: photographer.username,
          displayName: photographer.displayName,
          createdAt: photographer.createdAt,
          frozen: !!photographer.frozen
        },
        stats: {
          productCount: store.products.filter((product) => product.photographerId === photographer.id).length,
          scheduleCount: schedules.length,
          bookingCount: bookings.length,
          activeBookingCount: activeBookings,
          totalReceived
        },
        schedules,
        bookings
      });
    }

    if (method === 'PUT' && parts[2] === 'accounts' && parts[3] && parts[4] === 'freeze') {
      const body = await readBody(req);
      const photographer = store.photographers.find((item) => item.id === parts[3]);
      if (!photographer) {
        return sendJson(res, 404, { error: '摄影师不存在' });
      }
      photographer.frozen = !!body.frozen;
      await saveStore();
      return sendJson(res, 200, { ok: true, id: photographer.id, frozen: photographer.frozen });
    }

    if (method === 'GET' && parts[2] === 'schedules') {
      const schedules = store.schedules.map((schedule) => {
        const photographer = store.photographers.find((item) => item.id === schedule.photographerId);
        const template = store.formTemplates.find((item) => item.id === schedule.formTemplateId);
        return {
          id: schedule.id,
          date: schedule.date,
          photographerId: schedule.photographerId,
          photographerEmail: photographer ? photographer.username : '—',
          photographerDisplayName: photographer ? photographer.displayName : '—',
          frozen: !!(photographer && photographer.frozen),
          formTemplateName: template ? template.name : '—',
          slotCount: (schedule.slots || []).length,
          openSlotCount: (schedule.slots || []).filter((slot) => slot.enabled).length,
          products: store.products
            .filter((product) => product.photographerId === schedule.photographerId)
            .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
            .map((product) => ({ id: product.id, name: product.name, deposit: product.deposit, balance: product.balance, slotUnits: product.slotUnits, enabled: product.enabled }))
        };
      }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return sendJson(res, 200, { schedules });
    }

    if (method === 'GET' && parts[2] === 'bookings') {
      const bookings = store.bookings.map((booking) => {
        const photographer = store.photographers.find((item) => item.id === booking.photographerId);
        const product = store.products.find((item) => item.id === booking.productId);
        const schedule = store.schedules.find((item) => item.id === booking.scheduleId);
        const slot = schedule && schedule.slots.find((item) => item.id === booking.slotId);
        return {
          id: booking.id,
          photographerId: booking.photographerId,
          photographerEmail: photographer ? photographer.username : '—',
          photographerDisplayName: photographer ? photographer.displayName : '—',
          productId: booking.productId,
          productName: product ? product.name : '—',
          date: schedule ? schedule.date : '—',
          slotStart: slot ? slot.start : '—',
          slotEnd: slot ? slot.end : '—',
          status: booking.status,
          payment: booking.payment,
          createdAt: booking.createdAt
        };
      }).sort((a, b) => {
        // 按拍摄时间排序（日期 + 时段开始时间）
        if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
        if (a.slotStart !== b.slotStart) return String(a.slotStart).localeCompare(String(b.slotStart));
        return String(a.createdAt).localeCompare(String(b.createdAt));
      });
      return sendJson(res, 200, { bookings });
    }

    if (method === 'GET' && parts[2] === 'stats') {
      let totalReceived = 0;
      for (const booking of store.bookings) {
        if (booking.payment.deposit.status === 'paid') totalReceived += Number(booking.payment.deposit.amount) || 0;
        if (booking.payment.balance.status === 'paid') totalReceived += Number(booking.payment.balance.amount) || 0;
      }
      return sendJson(res, 200, {
        photographerCount: store.photographers.length,
        frozenCount: store.photographers.filter((photographer) => photographer.frozen).length,
        scheduleCount: store.schedules.length,
        bookingCount: store.bookings.length,
        totalReceived
      });
    }

    return sendJson(res, 404, { error: '管理接口不存在' });
  }

  if (parts[0] === 'api' && parts[1] === 'admin') {
    const photographerId = requireAuth(req, res);
    if (!photographerId) {
      return;
    }
    if (method === 'GET' && parts[2] === 'bookings') {
      const scheduleIds = new Set(store.schedules.filter((schedule) => schedule.photographerId === photographerId).map((schedule) => schedule.id));
      // 显示顺序：按拍摄时间排序（日程日期 + 时段开始时间，9 点在 10 点前）
      const scheduleMap = new Map(store.schedules.map((schedule) => [schedule.id, schedule]));
      const bookings = store.bookings
        .filter((booking) => scheduleIds.has(booking.scheduleId) || booking.photographerId === photographerId)
        .sort((a, b) => {
          const scheduleA = scheduleMap.get(a.scheduleId);
          const scheduleB = scheduleMap.get(b.scheduleId);
          const dateA = scheduleA ? scheduleA.date : '';
          const dateB = scheduleB ? scheduleB.date : '';
          if (dateA !== dateB) return dateA.localeCompare(dateB);
          const slotA = scheduleA && scheduleA.slots.find((slot) => slot.id === a.slotId);
          const slotB = scheduleB && scheduleB.slots.find((slot) => slot.id === b.slotId);
          const startA = slotA ? slotA.start : '';
          const startB = slotB ? slotB.start : '';
          if (startA !== startB) return startA.localeCompare(startB);
          return String(a.createdAt).localeCompare(String(b.createdAt));
        });
      return sendJson(res, 200, { bookings });
    }

    if (method === 'DELETE' && parts[2] === 'bookings' && parts[3]) {
      // 直接删除预约记录（物理删除，不可恢复）
      const index = store.bookings.findIndex((item) => item.id === parts[3] && item.photographerId === photographerId);
      if (index < 0) {
        return sendJson(res, 404, { error: '预约不存在' });
      }
      store.bookings.splice(index, 1);
      await saveStore();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'PATCH' && parts[2] === 'bookings' && parts[3]) {
      const booking = store.bookings.find((item) => item.id === parts[3] && item.photographerId === photographerId);
      const body = await readBody(req);
      if (!booking) {
        return sendJson(res, 404, { error: '预约不存在' });
      }
      if (body.status) booking.status = body.status;
      if (body.shotDone !== undefined) booking.shotDone = !!body.shotDone;
      if (body.payment) {
        for (const key of ['deposit', 'balance']) {
          const patch = body.payment[key];
          if (!patch) continue;
          if (patch.status === 'paid') {
            // 手动标记已付：走统一状态推进（顺带修复原逻辑不推进订单状态机的问题）
            applyPaidTransition(booking, key, {
              provider: patch.provider || 'manual',
              transactionId: patch.transactionId || null,
              paidAt: patch.paidAt || null
            });
          } else {
            booking.payment[key] = { ...booking.payment[key], ...patch };
          }
        }
      }
      await saveStore();
      return sendJson(res, 200, booking);
    }

    if (method === 'GET' && parts[2] === 'form-templates') {
      return sendJson(res, 200, { templates: store.formTemplates.filter((template) => template.photographerId === photographerId) });
    }
    if (method === 'POST' && parts[2] === 'form-templates') {
      const body = await readBody(req);
      const template = {
        id: uid('form'),
        photographerId,
        name: body.name || '未命名表单',
        fields: Array.isArray(body.fields) ? body.fields : [],
        updatedAt: new Date().toISOString()
      };
      store.formTemplates.push(template);
      await saveStore();
      return sendJson(res, 201, template);
    }
    if (method === 'PUT' && parts[2] === 'form-templates' && parts[3]) {
      const template = store.formTemplates.find((item) => item.id === parts[3] && item.photographerId === photographerId);
      const body = await readBody(req);
      if (!template) {
        return sendJson(res, 404, { error: '表单模板不存在' });
      }
      if (body.name) template.name = body.name;
      if (Array.isArray(body.fields)) template.fields = body.fields;
      template.updatedAt = new Date().toISOString();
      await saveStore();
      return sendJson(res, 200, template);
    }
    if (method === 'DELETE' && parts[2] === 'form-templates' && parts[3]) {
      const index = store.formTemplates.findIndex((item) => item.id === parts[3] && item.photographerId === photographerId);
      if (index < 0) {
        return sendJson(res, 404, { error: '表单模板不存在' });
      }
      // 引用保护：正被日程使用的模板不能删除，避免客妹端无表单可填
      if (store.schedules.some((schedule) => schedule.photographerId === photographerId && schedule.formTemplateId === parts[3])) {
        return sendJson(res, 400, { error: '该模板正被日程使用，不能删除；请先在发布日程中更换模板' });
      }
      store.formTemplates.splice(index, 1);
      await saveStore();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && parts[2] === 'time-templates') {
      return sendJson(res, 200, { templates: store.timeTemplates.filter((template) => template.photographerId === photographerId) });
    }
    if (method === 'POST' && parts[2] === 'time-templates') {
      const body = await readBody(req);
      const template = {
        id: uid('time'),
        photographerId,
        name: body.name || '未命名时间模板',
        startTime: body.startTime || '14:00',
        endTime: body.endTime || '16:00',
        intervalMinutes: Number(body.intervalMinutes) || store.settings.slotMinutes,
        slots: []
      };
      template.slots = generateTimeSlots(template);
      store.timeTemplates.push(template);
      await saveStore();
      return sendJson(res, 201, template);
    }
    if (method === 'PUT' && parts[2] === 'time-templates' && parts[3]) {
      const template = store.timeTemplates.find((item) => item.id === parts[3] && item.photographerId === photographerId);
      const body = await readBody(req);
      if (!template) {
        return sendJson(res, 404, { error: '时间模板不存在' });
      }
      if (body.name) template.name = body.name;
      if (body.startTime) template.startTime = body.startTime;
      if (body.endTime) template.endTime = body.endTime;
      if (body.intervalMinutes) template.intervalMinutes = Number(body.intervalMinutes);
      template.slots = generateTimeSlots(template);
      await saveStore();
      return sendJson(res, 200, template);
    }
    if (method === 'DELETE' && parts[2] === 'time-templates' && parts[3]) {
      const index = store.timeTemplates.findIndex((item) => item.id === parts[3] && item.photographerId === photographerId);
      if (index < 0) {
        return sendJson(res, 404, { error: '时间模板不存在' });
      }
      store.timeTemplates.splice(index, 1);
      await saveStore();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && parts[2] === 'schedules') {
      return sendJson(res, 200, { schedules: store.schedules.filter((schedule) => schedule.photographerId === photographerId) });
    }
    if (method === 'POST' && parts[2] === 'schedules') {
      const body = await readBody(req);
      const source = store.timeTemplates.find((item) => item.id === body.timeTemplateId && item.photographerId === photographerId);
      if (!source) {
        return sendJson(res, 400, { error: '时间模板不存在' });
      }
      const formTemplate = store.formTemplates.find((item) => item.id === (body.formTemplateId || '') && item.photographerId === photographerId);
      const schedule = {
        id: uid('sch'),
        photographerId,
        date: body.date || '',
        formTemplateId: formTemplate ? formTemplate.id : store.formTemplates.find((item) => item.photographerId === photographerId)?.id,
        slots: normalizeScheduleSlots(templateSlots(source).map((slot) => ({
          id: uid('slot'),
          start: slot.start,
          end: slot.end,
          capacity: 1,
          enabled: true,
          note: slot.note || ''
        })))
      };
      store.schedules.push(schedule);
      await saveStore();
      return sendJson(res, 201, schedule);
    }
    if (method === 'PUT' && parts[2] === 'schedules' && parts[3]) {
      const schedule = store.schedules.find((item) => item.id === parts[3] && item.photographerId === photographerId);
      const body = await readBody(req);
      if (!schedule) {
        return sendJson(res, 404, { error: '日程不存在' });
      }
      if (body.date) schedule.date = body.date;
      if (body.formTemplateId) schedule.formTemplateId = body.formTemplateId;
      if (Array.isArray(body.slots)) schedule.slots = normalizeScheduleSlots(body.slots);
      await saveStore();
      return sendJson(res, 200, schedule);
    }
    if (method === 'DELETE' && parts[2] === 'schedules' && parts[3]) {
      const index = store.schedules.findIndex((item) => item.id === parts[3] && item.photographerId === photographerId);
      if (index < 0) {
        return sendJson(res, 404, { error: '日程不存在' });
      }
      // 引用保护：有未取消预约的日程不能删除，避免预约变孤儿数据
      if (store.bookings.some((booking) => booking.scheduleId === parts[3] && booking.status !== 'cancelled')) {
        return sendJson(res, 400, { error: '该日程已有预约，不能删除；请先处理相关预约或将其取消' });
      }
      store.schedules.splice(index, 1);
      await saveStore();
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 商品管理 ----------

    if (method === 'PUT' && parts[2] === 'me') {
      const body = await readBody(req);
      const photographer = store.photographers.find((item) => item.id === photographerId);
      if (!photographer) {
        return sendJson(res, 401, { error: '账号不存在' });
      }
      if (body.qrTitle !== undefined) {
        photographer.qrTitle = String(body.qrTitle || '').trim() || photographer.displayName;
      }
      if (body.payQr !== undefined) {
        const payQr = body.payQr || {};
        photographer.payQr = {
          wechat: String(payQr.wechat || '').trim(),
          alipay: String(payQr.alipay || '').trim()
        };
      }
      await saveStore();
      return sendJson(res, 200, {
        photographer: {
          id: photographer.id,
          username: photographer.username,
          displayName: photographer.displayName,
          qrTitle: photographer.qrTitle,
          payQr: photographer.payQr || null
        }
      });
    }

    if (method === 'GET' && parts[2] === 'products') {
      const products = store.products
        .filter((product) => product.photographerId === photographerId)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      return sendJson(res, 200, { products });
    }

    if (method === 'POST' && parts[2] === 'products') {
      const body = await readBody(req);
      const normalized = normalizeProduct(body, false);
      if (normalized.error) {
        return sendJson(res, 400, { error: normalized.error });
      }
      const nextSort = store.products
        .filter((product) => product.photographerId === photographerId)
        .reduce((max, product) => Math.max(max, product.sortOrder || 0), 0) + 1;
      const product = {
        id: uid('prod'),
        photographerId,
        ...normalized,
        sortOrder: nextSort,
        createdAt: new Date().toISOString()
      };
      store.products.push(product);
      await saveStore();
      return sendJson(res, 201, product);
    }

    if (method === 'PUT' && parts[2] === 'products' && parts[3]) {
      const product = store.products.find((item) => item.id === parts[3] && item.photographerId === photographerId);
      const body = await readBody(req);
      if (!product) {
        return sendJson(res, 404, { error: '商品不存在' });
      }
      const normalized = normalizeProduct(body, true);
      if (normalized.error) {
        return sendJson(res, 400, { error: normalized.error });
      }
      Object.assign(product, normalized);
      if (body.sortOrder !== undefined) product.sortOrder = Number(body.sortOrder) || 0;
      await saveStore();
      return sendJson(res, 200, product);
    }

    if (method === 'DELETE' && parts[2] === 'products' && parts[3]) {
      const index = store.products.findIndex((item) => item.id === parts[3] && item.photographerId === photographerId);
      if (index < 0) {
        return sendJson(res, 404, { error: '商品不存在' });
      }
      // 引用保护：有非取消预约引用时禁止删除
      if (store.bookings.some((booking) => booking.productId === parts[3] && booking.status !== 'cancelled')) {
        return sendJson(res, 400, { error: '该商品已有预约，建议停用而非删除' });
      }
      store.products.splice(index, 1);
      await saveStore();
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 爱发电支付 ----------

    if (method === 'GET' && parts[2] === 'afdian' && parts[3] === 'config') {
      return sendJson(res, 200, { config: afdian.maskConfig(afdian.getConfig(photographerId)) });
    }

    if (method === 'PUT' && parts[2] === 'afdian' && parts[3] === 'config') {
      const body = await readBody(req);
      if (body.planUrl && !/^https?:\/\//.test(String(body.planUrl))) {
        return sendJson(res, 400, { error: '方案链接必须以 http(s):// 开头' });
      }
      const patch = {};
      if (body.user_id !== undefined) patch.user_id = String(body.user_id || '').trim();
      if (body.token !== undefined) patch.token = String(body.token || '').trim();
      if (body.webhookToken !== undefined) patch.webhookToken = String(body.webhookToken || '').trim();
      if (body.planUrl !== undefined) patch.planUrl = String(body.planUrl || '').trim();
      if (body.homeUrl !== undefined) patch.homeUrl = String(body.homeUrl || '').trim();
      // 保存配置即启用（无独立启用开关）
      patch.enabled = true;
      await afdian.saveConfig(photographerId, patch);
      return sendJson(res, 200, { config: afdian.maskConfig(afdian.getConfig(photographerId)) });
    }

    if (method === 'GET' && parts[2] === 'afdian' && parts[3] === 'pending') {
      const pending = afdian.getPendingOrders()
        .filter((item) => item.photographerId === photographerId && !item.ignored)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      return sendJson(res, 200, { pending });
    }

    if (method === 'POST' && parts[2] === 'afdian' && parts[3] === 'pending' && parts[4] && parts[5] === 'link') {
      const body = await readBody(req);
      const result = await afdian.linkOrder(parts[4], {
        bookingId: String(body.bookingId || ''),
        paymentKey: body.paymentKey === 'balance' ? 'balance' : 'deposit'
      }, store, saveStore);
      if (result.error) {
        return sendJson(res, 400, { error: result.error });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && parts[2] === 'afdian' && parts[3] === 'pending' && parts[4] && parts[5] === 'ignore') {
      const result = await afdian.ignoreOrder(parts[4]);
      if (result.error) {
        return sendJson(res, 404, { error: result.error });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && parts[2] === 'afdian' && parts[3] === 'poll') {
      const stats = await afdian.pollPhotographer(photographerId, store, saveStore);
      return sendJson(res, 200, { stats });
    }
    return sendJson(res, 404, { error: '管理接口不存在' });
  }

  sendJson(res, 404, { error: '接口不存在' });
}

async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '/admin.html') pathname = '/admin.html';
  if (pathname.startsWith('/p/') || pathname.startsWith('/b/')) pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }

  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    sendJson(res, 404, { error: '页面不存在' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(res, url);
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message || '服务器错误' });
  }
});

loadStore().then(async () => {
  loadAppConfig();
  await mail.load();
  await afdian.load();
  afdian.init({ applyPayment: applyPaidTransition });
  afdian.setStoreRefs(store, saveStore);
  afdian.startPoller();
  server.listen(PORT, () => {
    console.log(`预约工具已启动：http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
