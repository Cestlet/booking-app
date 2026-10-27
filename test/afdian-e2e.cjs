// 爱发电 MOCK 端到端测试（AFDIAN_MOCK=1）
// 用法：node test/afdian-e2e.cjs
// 使用临时 DATA_FILE，不碰生产数据；自动备份/恢复 data/afdian.json
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AFDIAN_FILE = path.join(ROOT, 'data', 'afdian.json');
const TMP_STORE = path.join(os.tmpdir(), `afdian-e2e-${Date.now()}.json`);
const TMP_CONFIG = path.join(os.tmpdir(), `super-e2e-${Date.now()}.json`);
const BASE = 'http://localhost:3100';
const POLL_MS = 1000;

let pass = 0;
let fail = 0;
let server = null;

function md5(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
}

// 独立实现的爱发电签名（与 lib/afdian.js 对拍）
function refSign(userId, token, params, ts) {
  return md5(`${token}params${params}ts${ts}user_id${userId}`);
}

async function req(pathname, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (err) {
    /* 纯文本 */
  }
  return { status: res.status, data };
}

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? `（${extra}）` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}`);
  }
}

function startServer() {
  return new Promise((resolve) => {
    server = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '3100',
        DATA_FILE: TMP_STORE,
        AFDIAN_MOCK: '1',
        AFDIAN_POLL_MS: String(POLL_MS),
        MAIL_MOCK: '1',
        CONFIG_FILE: TMP_CONFIG
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (chunk) => console.log('  [server]', String(chunk).trim().split('\n').join(' | ')));
    server.stderr.on('data', (chunk) => console.log('  [server-err]', String(chunk).trim()));
    const tryConnect = async () => {
      try {
        const res = await fetch(BASE + '/');
        if (res.ok || res.status === 404) return resolve();
      } catch (err) {
        /* 未就绪 */
      }
      setTimeout(tryConnect, 300);
    };
    setTimeout(tryConnect, 300);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', resolve);
    server.kill();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const afdianBackup = fs.existsSync(AFDIAN_FILE) ? fs.readFileSync(AFDIAN_FILE, 'utf8') : null;
  // 临时管理员配置（CONFIG_FILE 隔离，不碰全局 config.json）
  fs.writeFileSync(TMP_CONFIG, JSON.stringify({ admin: { email: 'super@test.com', password: 'admin-pass' }, mock: true }, null, 2));

  try {
    // ---- 用例 1：签名对拍 ----
    console.log('\n=== 1. 签名算法对拍 ===');
    const { sign } = require(path.join(ROOT, 'lib', 'afdian.js'));
    const params = JSON.stringify({ page: 1 });
    const ts = Math.floor(Date.now() / 1000);
    ok('sign() 与独立实现一致', sign('uid1', 'tok1', params, ts) === refSign('uid1', 'tok1', params, ts));
    ok('sign() 为 32 位小写 hex', /^[0-9a-f]{32}$/.test(sign('uid1', 'tok1', params, ts)));

    await startServer();

    // ---- 准备数据：邮箱验证码注册闭环 + 日程 ----
    console.log('\n=== 准备：邮箱验证码注册闭环 ===');
    const EMAIL = 'demo@example.com';
    const sendCode = await req('/api/auth/send-code', { method: 'POST', body: { email: EMAIL } });
    ok('send-code 返回 devCode（6 位数字）', sendCode.status === 200 && /^\d{6}$/.test(sendCode.data?.devCode || ''));
    const codeCool = await req('/api/auth/send-code', { method: 'POST', body: { email: EMAIL } });
    ok('60 秒内重发被限流（429）', codeCool.status === 429);
    const badCode = await req('/api/auth/register', {
      method: 'POST', body: { email: EMAIL, code: '000000', displayName: '小早', password: 'pass123456' }
    });
    ok('错误验证码注册被拒（400）', badCode.status === 400);
    const reg = await req('/api/auth/register', {
      method: 'POST', body: { email: EMAIL, code: sendCode.data.devCode, displayName: '小早', password: 'pass123456' }
    });
    ok('正确验证码注册成功（201）', reg.status === 201);
    const token = reg.data.token;
    const photographerId = reg.data.photographer.id;
    const dupReg = await req('/api/auth/register', {
      method: 'POST', body: { email: EMAIL, code: sendCode.data.devCode, displayName: '小早', password: 'pass123456' }
    });
    ok('重复邮箱注册被拒（400）', dupReg.status === 400);
    const login = await req('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: 'pass123456' } });
    ok('邮箱密码登录成功', login.status === 200);

    const formTpl = await req('/api/admin/form-templates', {
      method: 'POST', body: { name: '测试表单', fields: [{ id: 'field_0', label: 'CN', type: 'text', required: true, placeholder: '' }] }, token
    });
    ok('表单模板创建成功', formTpl.status === 201);
    const timeTemplate = await req('/api/admin/time-templates', {
      method: 'POST', body: { name: '测试模板', startTime: '14:00', endTime: '16:00', intervalMinutes: 20 }, token
    });
    const schedule = await req('/api/admin/schedules', {
      method: 'POST', body: { date: '2026-08-20', formTemplateId: formTpl.data.id, timeTemplateId: timeTemplate.data.id }, token
    });
    ok('日程创建成功', schedule.status === 201);

    // 建两个商品：prodA（1 格 50/50），prodB（2 格 100/100）
    const prodA = await req('/api/admin/products', {
      method: 'POST', body: { name: '单人4图', deposit: 50, balance: 50, slotUnits: 1, enabled: true }, token
    });
    const prodB = await req('/api/admin/products', {
      method: 'POST', body: { name: '双人', deposit: 100, balance: 100, slotUnits: 2, enabled: true }, token
    });
    ok('商品 prodA 创建', prodA.status === 201);
    ok('商品 prodB 创建（2 格）', prodB.status === 201);

    // 第二个日程：商品占用检查专用（干净时段）
    const schedule2 = await req('/api/admin/schedules', {
      method: 'POST', body: { date: '2026-08-22', formTemplateId: formTpl.data.id, timeTemplateId: timeTemplate.data.id }, token
    });
    ok('占用检查日程创建成功', schedule2.status === 201);

    let slotIndex = 0;
    const createBooking = async () => {
      // 每个预约用不同时段（capacity=1）
      const targetSlot = schedule.data.slots[slotIndex % schedule.data.slots.length];
      slotIndex += 1;
      const booking = await req('/api/bookings', {
        method: 'POST',
        body: { scheduleId: schedule.data.id, productId: prodA.data.id, slotId: targetSlot.id, formAnswers: { field_0: '测试客妹' } }
      });
      if (booking.status !== 201) {
        console.log(`  [warn] booking 创建失败（${booking.status}）：${booking.data?.error || ''}`);
        return null;
      }
      return booking.data.id;
    };

    // ---- 用例 2：配置 PUT/GET ----
    console.log('\n=== 2. 爱发电配置保存与掩码 ===');
    const saveCfg = await req('/api/admin/afdian/config', {
      method: 'PUT',
      body: { enabled: true, user_id: 'mock-user-1', token: 'testtoken', webhookToken: 'testwebhook', planUrl: 'https://afdian.com/item/test', homeUrl: 'https://afdian.com/a/test' },
      token
    });
    ok('配置保存成功', saveCfg.status === 200);
    ok('token 掩码显示', saveCfg.data?.config?.token === '••••oken' && saveCfg.data?.config?.tokenSet === true);

    // ---- 用例 3：pay 分流 ----
    console.log('\n=== 3. pay 分流（afdian 模式） ===');
    const bookingId1 = await createBooking();
    const pay1 = await req(`/api/bookings/${bookingId1}/pay`, { method: 'POST', body: { type: 'deposit' }, token: '' });
    ok('mode=afdian', pay1.data?.mode === 'afdian');
    ok('payment 状态 pending', pay1.data?.booking?.payment?.deposit?.status === 'pending');
    ok('payUrl 含 custom_order_id', pay1.data?.afdian?.payUrl?.includes(`custom_order_id=${bookingId1}-deposit`));
    ok('payUrl 含 custom_price=50.00', pay1.data?.afdian?.payUrl?.includes('custom_price=50.00'));
    ok('payUrl 用统一下单链接（item/test）', pay1.data?.afdian?.payUrl?.includes('item/test'));

    // ---- 用例 4：webhook 无鉴权处理 + 不匹配订单进待核对 ----
    console.log('\n=== 4. webhook 处理（爱发电官方不带 Bearer） ===');
    const noAuth = await req('/api/afdian/webhook', { method: 'POST', body: { ec: 200, data: { type: 'order', order: { out_trade_no: 'AFD-TEST-1', user_id: 'buyer-x', plan_id: 'pl9', total_amount: '5.00', status: 2, remark: '', sku_detail: [] } } } });
    ok('无 token 回调仍返回 ec 结构', noAuth.status === 200 && noAuth.data?.ec === 200);
    const badAuth = await req('/api/afdian/webhook', { method: 'POST', body: { ec: 200, data: { order: { out_trade_no: 'AFD-TEST-2', total_amount: '5.00', status: 2 } } }, token: 'wrong-token' });
    ok('错 token 不阻断处理（ec 结构返回）', badAuth.status === 200 && badAuth.data?.ec === 200);
    // 无 Bearer 的真实爱发电回调：从 custom_order_id 推断摄影师并入账（bookingId1 尾款）
    const bookingId5 = await createBooking();
    await req(`/api/bookings/${bookingId5}/pay`, { method: 'POST', body: { type: 'balance' } });
    const realCallback = await req('/api/afdian/webhook', {
      method: 'POST',
      body: { ec: 200, data: { type: 'order', order: { out_trade_no: 'AFD-NOTOKEN-1', total_amount: '50.00', status: 2, custom_order_id: `${bookingId5}-balance`, remark: '', sku_detail: [] } } }
    });
    ok('无 Bearer 回调从订单推断摄影师', realCallback.status === 200 && realCallback.data?.ec === 200);
    const b5b = await req(`/api/bookings/${bookingId5}`);
    ok('推断摄影师后自动入账', b5b.data?.payment?.balance?.status === 'paid');
    // 金额为 0 的伪造订单被拒
    const zeroOrder = await req('/api/afdian/webhook', {
      method: 'POST',
      body: { ec: 200, data: { order: { out_trade_no: 'AFD-ZERO-1', total_amount: '0.00', status: 2, custom_order_id: `${bookingId1}-balance` } } }
    });
    const b1z = await req(`/api/bookings/${bookingId1}`);
    ok('0 元订单不入账（加固）', zeroOrder.status === 200 && b1z.data?.payment?.balance?.status !== 'paid');

    // ---- 用例 5：webhook 正常入账（custom_order_id 匹配） ----
    console.log('\n=== 5. webhook 回调入账 ===');
    const whBody = { ec: 200, data: { order: { out_trade_no: 'AFD-1001', plan_id: 'pl1', total_amount: '50.00', status: 2, remark: '', custom_order_id: `${bookingId1}-deposit`, paid_time: new Date().toISOString(), user_id: 'buyer1' } } };
    const wh = await req('/api/afdian/webhook', { method: 'POST', body: whBody, token: 'testwebhook' });
    ok('回调返回 200', wh.status === 200);
    const b1 = await req(`/api/bookings/${bookingId1}`);
    ok('定金已付 + 状态 deposit_paid', b1.data?.payment?.deposit?.status === 'paid' && b1.data?.status === 'deposit_paid');
    ok('交易号回填', b1.data?.payment?.deposit?.transactionId === 'AFD-1001');

    // ---- 用例 6：幂等（重复回调） ----
    console.log('\n=== 6. 重复回调幂等 ===');
    const wh2 = await req('/api/afdian/webhook', { method: 'POST', body: whBody, token: 'testwebhook' });
    const b1b = await req(`/api/bookings/${bookingId1}`);
    ok('重复回调仍 200 且状态不变', wh2.status === 200 && b1b.data?.status === 'deposit_paid');

    // ---- 用例 7：轮询闭环 ----
    console.log('\n=== 7. 轮询自动确认 ===');
    const bookingId2 = await createBooking();
    await req(`/api/bookings/${bookingId2}/pay`, { method: 'POST', body: { type: 'deposit' } });
    const inject = await req('/api/afdian/mock/orders', {
      method: 'POST',
      body: { photographerUserId: 'mock-user-1', customOrderId: `${bookingId2}-deposit`, totalAmount: 50 }
    });
    ok('mock 订单注入成功', inject.status === 201);
    await sleep(POLL_MS * 2 + 500);
    const b2 = await req(`/api/bookings/${bookingId2}`);
    ok('轮询后自动入账', b2.data?.payment?.deposit?.status === 'paid' && b2.data?.status === 'deposit_paid');

    // ---- 用例 8：金额不符 → 待核对不入账 ----
    console.log('\n=== 8. 金额不符进待核对 ===');
    const bookingId3 = await createBooking();
    await req(`/api/bookings/${bookingId3}/pay`, { method: 'POST', body: { type: 'deposit' } });
    await req('/api/afdian/mock/orders', {
      method: 'POST',
      body: { photographerUserId: 'mock-user-1', customOrderId: `${bookingId3}-deposit`, totalAmount: 99.99 }
    });
    await sleep(POLL_MS * 2 + 500);
    const b3 = await req(`/api/bookings/${bookingId3}`);
    ok('金额不符未入账', b3.data?.payment?.deposit?.status === 'pending');
    const pending = await req('/api/admin/afdian/pending', { token });
    ok('订单进入待核对', pending.data?.pending?.some((item) => item.customOrderId === `${bookingId3}-deposit`));

    // ---- 用例 9：remark 匹配 ----
    console.log('\n=== 9. remark 备注匹配 ===');
    const bookingId4 = await createBooking();
    await req(`/api/bookings/${bookingId4}/pay`, { method: 'POST', body: { type: 'deposit' } });
    await req('/api/afdian/mock/orders', {
      method: 'POST',
      body: { photographerUserId: 'mock-user-1', customOrderId: '', remark: `${bookingId4} 定金`, totalAmount: 50 }
    });
    await sleep(POLL_MS * 2 + 500);
    const b4 = await req(`/api/bookings/${bookingId4}`);
    ok('remark 匹配自动入账', b4.data?.payment?.deposit?.status === 'paid');

    // ---- 用例 10：人工关联 ----
    console.log('\n=== 10. 人工关联（待核对 → 确认收款） ===');
    const pendingList = await req('/api/admin/afdian/pending', { token });
    const target = pendingList.data.pending.find((item) => item.customOrderId === `${bookingId3}-deposit`);
    ok('待核对存在金额不符订单', !!target);
    if (target) {
      const link = await req(`/api/admin/afdian/pending/${target.id}/link`, {
        method: 'POST', body: { bookingId: bookingId3, paymentKey: 'deposit' }, token
      });
      ok('人工关联成功', link.status === 200);
      const b3b = await req(`/api/bookings/${bookingId3}`);
      ok('人工关联后已入账', b3b.data?.payment?.deposit?.status === 'paid');
    }

    // ---- 用例 10.5：商品占用检查 ----
    console.log('\n=== 商品占用检查 ===');
    const OCC_FORM = { field_0: '占用测试' };
    const occ1 = await req('/api/bookings', { method: 'POST', body: { scheduleId: schedule2.data.id, productId: prodB.data.id, slotId: schedule2.data.slots[0].id, formAnswers: OCC_FORM } });
    ok('2 格商品约起始格成功', occ1.status === 201);
    const occ2 = await req('/api/bookings', { method: 'POST', body: { scheduleId: schedule2.data.id, productId: prodA.data.id, slotId: schedule2.data.slots[1].id, formAnswers: OCC_FORM } });
    ok('与 2 格预约重叠 → 拒绝', occ2.status === 400);
    const occ3 = await req('/api/bookings', { method: 'POST', body: { scheduleId: schedule2.data.id, productId: prodA.data.id, slotId: schedule2.data.slots[2].id, formAnswers: OCC_FORM } });
    ok('相邻空闲格可约', occ3.status === 201);
    const occ4 = await req('/api/bookings', { method: 'POST', body: { scheduleId: schedule2.data.id, productId: prodB.data.id, slotId: schedule2.data.slots[5].id, formAnswers: OCC_FORM } });
    ok('2 格商品约末尾格 → 超范围拒绝', occ4.status === 400);
    const offResp = await req(`/api/admin/products/${prodB.data.id}`, {
      method: 'PUT', body: { name: '双人', deposit: 100, balance: 100, slotUnits: 2, enabled: false }, token
    });
    ok('商品下架成功', offResp.status === 200);
    const occ5 = await req('/api/bookings', { method: 'POST', body: { scheduleId: schedule2.data.id, productId: prodB.data.id, slotId: schedule2.data.slots[3].id, formAnswers: OCC_FORM } });
    ok('下架商品提交 → 拒绝', occ5.status === 400);
    const prodBPay = await req(`/api/bookings/${occ1.data.id}/pay`, { method: 'POST', body: { type: 'deposit' } });
    ok('商品支付用统一下单链接', prodBPay.data?.mode === 'afdian' && prodBPay.data?.afdian?.payUrl?.includes('item/test'));

    // ---- 用例 11：手动同步 + 无配置回归 ----
    console.log('\n=== 11. 手动同步 + 无配置摄影师回归 ===');
    const poll = await req('/api/admin/afdian/poll', { method: 'POST', body: {}, token });
    ok('手动同步返回统计', poll.status === 200 && typeof poll.data?.stats === 'object');

    const NEW_EMAIL = 'newbie@example.com';
    const newCode = await req('/api/auth/send-code', { method: 'POST', body: { email: NEW_EMAIL } });
    const reg2 = await req('/api/auth/register', {
      method: 'POST', body: { email: NEW_EMAIL, code: newCode.data.devCode, displayName: '新摄影师', password: 'pass123456' }
    });
    ok('新摄影师邮箱注册', reg2.status === 201);
    const token2 = reg2.data.token;
    const pubNew = await req(`/api/public/${reg2.data.photographer.id}`);
    ok('新摄影师默认商品自动生成', Array.isArray(pubNew.data?.products) && pubNew.data.products.length === 1);
    const defaultProd = pubNew.data.products[0].id;
    const tt2 = await req('/api/admin/time-templates', { method: 'POST', body: { name: 'T2', startTime: '10:00', endTime: '11:00', intervalMinutes: 20 }, token: token2 });
    const sch2 = await req('/api/admin/schedules', { method: 'POST', body: { date: '2026-08-21', timeTemplateId: tt2.data.id }, token: token2 });
    const b5 = await req('/api/bookings', {
      method: 'POST',
      body: { scheduleId: sch2.data.id, productId: defaultProd, slotId: sch2.data.slots[0].id, formAnswers: {} }
    });
    const pay5 = await req(`/api/bookings/${b5.data.id}/pay`, { method: 'POST', body: { type: 'deposit' } });
    ok('无配置摄影师 mode=mock 直接已付', pay5.data?.mode === 'mock' && pay5.data?.payment?.deposit?.status === 'paid');
    ok('publicPayload afdianEnabled=false', pubNew.data?.photographer?.afdianEnabled === false);
    const pubDemo = await req(`/api/public/${photographerId}`);
    ok('publicPayload 返回商品列表', Array.isArray(pubDemo.data?.products) && pubDemo.data.products.length > 0);
    ok('afdianEnabled 聚合判断（配置了统一下单链接）', pubDemo.data?.photographer?.afdianEnabled === true);

    // ---- 用例 12：超级管理员 ----
    console.log('\n=== 12. 超级管理员 ===');
    const badLogin = await req('/api/super/login', { method: 'POST', body: { email: 'super@test.com', password: 'wrong-pass' } });
    ok('错误密码登录被拒（401）', badLogin.status === 401);
    const superLogin = await req('/api/super/login', { method: 'POST', body: { email: 'super@test.com', password: 'admin-pass' } });
    ok('管理员登录成功', superLogin.status === 200);
    const superToken = superLogin.data.token;
    const superNoAuth = await req('/api/super/accounts');
    ok('无 token 访问被拒（401）', superNoAuth.status === 401);
    const photToken = await req('/api/super/accounts', { token });
    ok('摄影师 token 不能访问管理员接口（会话隔离）', photToken.status === 401);
    const accounts = await req('/api/super/accounts', { token: superToken });
    ok('账号列表含注册账号', accounts.status === 200 && accounts.data.accounts.some((a) => a.username === EMAIL));
    ok('账号字段含 frozen', accounts.data.accounts.every((a) => typeof a.frozen === 'boolean'));
    const stats = await req('/api/super/stats', { token: superToken });
    ok('统计接口正常', stats.status === 200 && stats.data.photographerCount >= 2 && stats.data.totalReceived >= 50);
    const freeze = await req(`/api/super/accounts/${photographerId}/freeze`, { method: 'PUT', body: { frozen: true }, token: superToken });
    ok('冻结成功', freeze.status === 200 && freeze.data.frozen === true);
    const frozenLogin = await req('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: 'pass123456' } });
    ok('冻结后登录被拒（401）', frozenLogin.status === 401);
    const frozenPublic = await req(`/api/public/${photographerId}`);
    ok('冻结后公开页 403', frozenPublic.status === 403);
    const frozenApi = await req('/api/admin/bookings', { token });
    ok('冻结后已登录 token 失效（401）', frozenApi.status === 401);
    const superSchedules = await req('/api/super/schedules', { token: superToken });
    ok('约单列表正常', superSchedules.status === 200 && superSchedules.data.schedules.some((s) => s.photographerDisplayName === '小早'));
    const superBookings = await req('/api/super/bookings', { token: superToken });
    ok('预约列表正常', superBookings.status === 200 && superBookings.data.bookings.some((b) => b.id === bookingId1));
    const unfreeze = await req(`/api/super/accounts/${photographerId}/freeze`, { method: 'PUT', body: { frozen: false }, token: superToken });
    ok('解冻成功', unfreeze.status === 200 && unfreeze.data.frozen === false);
    const unfrozenLogin = await req('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: 'pass123456' } });
    ok('解冻后可重新登录', unfrozenLogin.status === 200);

    await stopServer();
  } finally {
    // 清理：删除临时 store/config、恢复 afdian.json
    if (fs.existsSync(TMP_STORE)) fs.rmSync(TMP_STORE);
    if (fs.existsSync(TMP_CONFIG)) fs.rmSync(TMP_CONFIG);
    if (afdianBackup !== null) {
      fs.writeFileSync(AFDIAN_FILE, afdianBackup, 'utf8');
    } else if (fs.existsSync(AFDIAN_FILE)) {
      fs.rmSync(AFDIAN_FILE);
    }
    await stopServer();
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
