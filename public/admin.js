const state = {
  token: '',
  role: 'photographer', // 'photographer' | 'super'
  photographer: null,
  bookings: [],
  formTemplates: [],
  timeTemplates: [],
  schedules: [],
  products: [],
  afdianConfig: null,
  afdianPending: [],
  filterDate: '', // 预约管理日期筛选（空 = 全部）
  superStats: null,
  superAccounts: [],
  superSchedules: [],
  superBookings: []
};

const el = {
  loginView: document.getElementById('loginView'),
  adminView: document.getElementById('adminView'),
  loginTab: document.getElementById('loginTab'),
  registerTab: document.getElementById('registerTab'),
  loginFields: document.getElementById('loginFields'),
  registerFields: document.getElementById('registerFields'),
  emailInput: document.getElementById('emailInput'),
  passwordInput: document.getElementById('passwordInput'),
  registerEmailInput: document.getElementById('registerEmailInput'),
  registerCodeInput: document.getElementById('registerCodeInput'),
  sendCodeBtn: document.getElementById('sendCodeBtn'),
  registerNameInput: document.getElementById('registerNameInput'),
  registerPasswordInput: document.getElementById('registerPasswordInput'),
  loginBtn: document.getElementById('loginBtn'),
  registerBtn: document.getElementById('registerBtn'),
  loginError: document.getElementById('loginError'),
  logoutBtn: document.getElementById('logoutBtn'),
  profileName: document.getElementById('profileName'),
  profileId: document.getElementById('profileId'),
  bookingCount: document.getElementById('bookingCount'),
  bookingStats: document.getElementById('bookingStats'),
  bookingRows: document.getElementById('bookingRows'),
  dateFilterLabel: document.getElementById('dateFilterLabel'),
  bookingDateFilter: document.getElementById('bookingDateFilter'),
  dateFilterToggle: document.getElementById('dateFilterToggle'),
  afdianUserId: document.getElementById('afdianUserId'),
  afdianToken: document.getElementById('afdianToken'),
  afdianPlanUrl: document.getElementById('afdianPlanUrl'),
  afdianHomeUrl: document.getElementById('afdianHomeUrl'),
  saveAfdianConfigBtn: document.getElementById('saveAfdianConfigBtn'),
  afdianPollBtn: document.getElementById('afdianPollBtn'),
  afdianPendingList: document.getElementById('afdianPendingList'),
  productList: document.getElementById('productList'),
  newProductBtn: document.getElementById('newProductBtn'),
  photographerTabbar: document.getElementById('photographerTabbar'),
  superTabbar: document.getElementById('superTabbar'),
  statCards: document.getElementById('statCards'),
  accountRows: document.getElementById('accountRows'),
  scheduleList: document.getElementById('scheduleList'),
  superBookingRows: document.getElementById('superBookingRows'),
  superDetailInfo: document.getElementById('superDetailInfo'),
  superDetailStats: document.getElementById('superDetailStats'),
  superDetailSchedules: document.getElementById('superDetailSchedules'),
  superDetailBookingRows: document.getElementById('superDetailBookingRows'),
  wechatQrPreview: document.getElementById('wechatQrPreview'),
  alipayQrPreview: document.getElementById('alipayQrPreview'),
  wechatQrFile: document.getElementById('wechatQrFile'),
  alipayQrFile: document.getElementById('alipayQrFile'),
  formTemplates: document.getElementById('formTemplates'),
  timeTemplates: document.getElementById('timeTemplates'),
  schedulesList: document.getElementById('schedulesList'),
  newScheduleDate: document.getElementById('newScheduleDate'),
  newScheduleFormTemplate: document.getElementById('newScheduleFormTemplate'),
  newScheduleTimeTemplate: document.getElementById('newScheduleTimeTemplate'),
  detailModal: document.getElementById('detailModal'),
  detailBody: document.getElementById('detailBody')
};

const STATUS_LABELS = {
  pending: '待确认/未付定金',
  deposit_paid: '已付定金',
  completed: '已付尾款',
  finished: '已完成',
  cancelled: '已取消'
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatAnswer(value) {
  if (Array.isArray(value)) {
    return value.join('、');
  }
  if (value && typeof value === 'object') {
    return Object.values(value).filter(Boolean).join(': ');
  }
  return value == null || value === '' ? '—' : String(value);
}

function renderAnswer(value) {
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => typeof item === 'string' && item.startsWith('/uploads/'))) {
      return value.map((url, index) => `<a href="${esc(url)}" target="_blank">参考图 ${index + 1}</a>`).join(' ');
    }
    return esc(value.join('、'));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${esc(key)}：${esc(item)}`).join(' ');
  }
  return esc(value == null || value === '' ? '—' : String(value));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`
    },
    ...options
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function showView(showAdmin) {
  el.loginView.classList.toggle('hidden', showAdmin);
  el.adminView.classList.toggle('hidden', !showAdmin);
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

let codeTimer = null;

async function login() {
  const email = el.emailInput.value.trim();
  const password = el.passwordInput.value.trim();
  if (!email || !EMAIL_RE.test(email)) {
    el.loginError.textContent = '请输入正确的邮箱';
    el.loginError.classList.remove('hidden');
    return;
  }
  if (!password) {
    el.loginError.textContent = '请输入密码';
    el.loginError.classList.remove('hidden');
    return;
  }
  // 点击反馈：按钮进入加载态，避免「没反应」的错觉
  el.loginBtn.disabled = true;
  el.loginBtn.textContent = '登录中...';
  try {
    await doLogin(email, password);
  } finally {
    el.loginBtn.disabled = false;
    el.loginBtn.textContent = '登录';
  }
}

async function doLogin(email, password) {
  const body = JSON.stringify({ email, password });
  // 先试管理员身份
  try {
    const superRes = await fetch('/api/super/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const superData = await superRes.json();
    if (superRes.ok) {
      state.token = superData.token;
      state.role = 'super';
      sessionStorage.setItem('cosSuperAdminToken', state.token);
      el.loginError.classList.add('hidden');
      enterSuperView();
      await loadAll();
      return;
    }
    if (superRes.status === 400) {
      // 管理员后台未配置：跳过，走摄影师
    }
    // 401：管理员密码错误，继续试摄影师
  } catch (err) {
    /* 网络错误继续试摄影师 */
  }
  // 再试摄影师身份
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    await enterDashboard(data);
  } catch (err) {
    el.loginError.textContent = err.message;
    el.loginError.classList.remove('hidden');
  }
}

// 进入管理员视图
function enterSuperView() {
  state.photographer = null;
  sessionStorage.removeItem('cosPhotographerToken');
  document.querySelector('.profile-bar')?.classList.add('hidden');
  el.photographerTabbar.classList.add('hidden');
  el.superTabbar.classList.remove('hidden');
  // 切到管理员第一个 tab
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
  el.superTabbar.querySelector('.tab-btn').classList.add('active');
  document.getElementById('panel-super-stats').classList.add('active');
  showView(true);
}

// 进入摄影师视图
function enterPhotographerView() {
  sessionStorage.removeItem('cosSuperAdminToken');
  document.querySelector('.profile-bar')?.classList.remove('hidden');
  el.superTabbar.classList.add('hidden');
  el.photographerTabbar.classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
  el.photographerTabbar.querySelector('.tab-btn').classList.add('active');
  document.getElementById('panel-bookings').classList.add('active');
  showView(true);
}

// 获取邮箱验证码（60 秒倒计时）
async function sendCode() {
  const email = el.registerEmailInput.value.trim();
  if (!email || !EMAIL_RE.test(email)) {
    el.loginError.textContent = '请先输入正确的邮箱';
    el.loginError.classList.remove('hidden');
    return;
  }
  el.sendCodeBtn.disabled = true;
  let seconds = 60;
  el.sendCodeBtn.textContent = `重新获取(${seconds}s)`;
  codeTimer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(codeTimer);
      codeTimer = null;
      el.sendCodeBtn.disabled = false;
      el.sendCodeBtn.textContent = '获取验证码';
    } else {
      el.sendCodeBtn.textContent = `重新获取(${seconds}s)`;
    }
  }, 1000);
  try {
    const data = await api('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    if (data.devCode) {
      el.registerCodeInput.value = data.devCode;
      el.loginError.textContent = '开发模式：验证码已自动填入';
    } else {
      el.loginError.textContent = '验证码已发送至邮箱，请注意查收';
    }
    el.loginError.classList.remove('hidden');
  } catch (err) {
    if (codeTimer) {
      clearInterval(codeTimer);
      codeTimer = null;
    }
    el.sendCodeBtn.disabled = false;
    el.sendCodeBtn.textContent = '获取验证码';
    el.loginError.textContent = err.message;
    el.loginError.classList.remove('hidden');
  }
}

async function register() {
  const email = el.registerEmailInput.value.trim();
  const code = el.registerCodeInput.value.trim();
  const displayName = el.registerNameInput.value.trim();
  const password = el.registerPasswordInput.value;
  if (!email || !EMAIL_RE.test(email)) {
    el.loginError.textContent = '请填写正确的邮箱';
    el.loginError.classList.remove('hidden');
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    el.loginError.textContent = '请填写 6 位验证码';
    el.loginError.classList.remove('hidden');
    return;
  }
  if (!displayName) {
    el.loginError.textContent = '请填写摄影昵称';
    el.loginError.classList.remove('hidden');
    return;
  }
  if (password.length < 6) {
    el.loginError.textContent = '密码至少 6 位';
    el.loginError.classList.remove('hidden');
    return;
  }
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, code, displayName, password })
    });
    await enterDashboard(data);
  } catch (err) {
    el.loginError.textContent = err.message;
    el.loginError.classList.remove('hidden');
  }
}

async function enterDashboard(data) {
  state.token = data.token;
  state.role = 'photographer';
  state.photographer = data.photographer;
  sessionStorage.setItem('cosPhotographerToken', state.token);
  el.loginError.classList.add('hidden');
  renderProfile();
  enterPhotographerView();
  await loadAll();
}

// 导出完整外框图片（名字 + 二维码 + 底部小字），3 倍高清
function downloadQrImage(title, link) {
  const scale = 3; // 高清导出倍率（720px 二维码）
  const qrSize = 240 * scale;
  const pad = 24 * scale;
  const titleH = 36 * scale;
  const footH = 28 * scale;
  const width = qrSize + pad * 2;
  const height = titleH + qrSize + footH + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // 白底圆角外框
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(0, 0, width, height, 16 * scale);
  } else {
    ctx.rect(0, 0, width, height);
  }
  ctx.fill();
  // 名字（长名自动缩小字号）
  const text = title || '扫码接单';
  ctx.fillStyle = '#222222';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${(text.length > 12 ? 15 : 18) * scale}px "Microsoft YaHei", sans-serif`;
  ctx.fillText(text, width / 2, pad + titleH / 2);
  // 二维码：qrcodejs 会在容器内创建自己的 canvas 绘制，
  // 因此必须用普通 div 承载，再取出内部 canvas 绘制到导出画布
  const holder = document.createElement('div');
  holder.style.display = 'none';
  document.body.appendChild(holder);
  new QRCode(holder, { text: link, width: qrSize, height: qrSize });
  const qrCanvas = holder.querySelector('canvas');
  if (qrCanvas) {
    ctx.drawImage(qrCanvas, pad, pad + titleH, qrSize, qrSize);
  }
  holder.remove();
  // 底部小字
  ctx.fillStyle = '#999999';
  ctx.font = `${12 * scale}px "Microsoft YaHei", sans-serif`;
  ctx.fillText('扫码预约拍摄', width / 2, pad + titleH + qrSize + footH / 2);
  // 下载
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `${text}.png`;
  a.click();
}

// 生成二维码外框 HTML：白卡 + 自定义名称 + 二维码容器 + 底部提示
function qrFrameHtml(title, qrId, size) {
  return `
    <div class="qr-frame" style="display:inline-block;background:#fff;border-radius:12px;padding:14px 18px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.12);border:1px solid #eee">
      <div style="font-weight:700;font-size:15px;color:#222;margin-bottom:10px;white-space:nowrap">${esc(title)}</div>
      <div id="${qrId}" style="background:#fff"></div>
      <div style="font-size:11px;color:#999;margin-top:10px">扫码预约拍摄</div>
    </div>
  `;
}

// 通用复制（兼容 http 非安全上下文）
function copyText(text, onDone) {
  const done = () => {
    if (onDone) onDone();
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (err) {
      alert(`复制失败，请手动复制：${text}`);
    }
    ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

function renderProfile() {
  el.profileName.textContent = state.photographer?.displayName || '';
  el.profileId.textContent = state.photographer?.id || '';
  const usernameTag = document.getElementById('profileUsername');
  if (usernameTag) {
    usernameTag.textContent = `邮箱：${state.photographer?.username || ''}`;
  }
  // 接单链接 + 点击复制
  const linkEl = document.getElementById('profileLink');
  const copyBtn = document.getElementById('copyProfileLink');
  const bookingLink = `${location.origin}/p/${state.photographer?.id || ''}`;
  if (linkEl) {
    linkEl.textContent = bookingLink;
  }
  if (copyBtn) {
    copyBtn.onclick = () => {
      copyText(bookingLink, () => {
        const old = copyBtn.textContent;
        copyBtn.textContent = '已复制 ✓';
        setTimeout(() => {
          copyBtn.textContent = old;
        }, 1500);
      });
    };
  }
  const link = `${location.origin}/p/${state.photographer?.id || ''}`;
  const currentTitle = state.photographer?.qrTitle || state.photographer?.displayName || '扫码接单';

  // 直接显示二维码外框（不显示文字链接）
  const qrBox = document.getElementById('bookingQr');
  if (qrBox && typeof QRCode !== 'undefined') {
    qrBox.innerHTML = qrFrameHtml(currentTitle, 'qrSmall', 120);
    new QRCode(document.getElementById('qrSmall'), { text: link, width: 120, height: 120 });
  }

  // 保存图片：直接下载完整外框图片
  const saveBtn = document.getElementById('qrSaveImageBtn');
  if (saveBtn) {
    saveBtn.onclick = () => downloadQrImage(currentTitle, link);
  }

  // 编辑名称：弹窗改名字（预览 + 可保存名称/图片）
  const editBtn = document.getElementById('qrEditBtn');
  if (editBtn) {
    editBtn.onclick = () => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop';
      overlay.style.zIndex = '999';
      const box = document.createElement('div');
      box.className = 'modal-card';
      box.style.textAlign = 'center';
      box.innerHTML = `
        <h3 style="margin-bottom:12px">二维码名称</h3>
        <div class="field">
          <input id="qrTitleInput" class="input" value="${esc(currentTitle)}" maxlength="30">
        </div>
        <div id="qrFrameBig" style="margin:12px 0">${qrFrameHtml(currentTitle, 'qrBig', 200)}</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button id="qrDownloadBtn" class="btn btn-cyan">保存图片</button>
          <button id="qrSaveBtn" class="btn btn-primary">保存名称</button>
          <button id="qrCloseBtn" class="btn btn-ghost">关闭</button>
        </div>
      `;
      new QRCode(document.getElementById('qrBig'), { text: link, width: 200, height: 200 });
      overlay.appendChild(box);
      overlay.onclick = (event) => {
        if (event.target === overlay) overlay.remove();
      };
      document.getElementById('qrCloseBtn').onclick = () => overlay.remove();
      document.getElementById('qrDownloadBtn').onclick = () => {
        downloadQrImage(document.getElementById('qrTitleInput').value.trim(), link);
      };
      document.getElementById('qrSaveBtn').onclick = async () => {
        const title = document.getElementById('qrTitleInput').value.trim();
        if (!title) {
          alert('名称不能为空');
          return;
        }
        try {
          const res = await api('/api/admin/me', { method: 'PUT', body: JSON.stringify({ qrTitle: title }) });
          state.photographer = { ...state.photographer, ...res.photographer };
          renderProfile();
          overlay.remove();
        } catch (err) {
          alert(err.message);
        }
      };
      document.body.appendChild(overlay);
    };
  }
}

function logout() {
  sessionStorage.removeItem('cosPhotographerToken');
  sessionStorage.removeItem('cosSuperAdminToken');
  state.token = '';
  state.role = 'photographer';
  state.photographer = null;
  showView(false);
}

async function loadAll() {
  if (state.role === 'super') {
    const [statsData, accountData, scheduleData, bookingData] = await Promise.all([
      api('/api/super/stats'),
      api('/api/super/accounts'),
      api('/api/super/schedules'),
      api('/api/super/bookings')
    ]);
    state.superStats = statsData;
    state.superAccounts = accountData.accounts;
    state.superSchedules = scheduleData.schedules;
    state.superBookings = bookingData.bookings;
    renderSuperStats();
    renderSuperAccounts();
    renderSuperSchedules();
    renderSuperBookings();
    return;
  }
  const [bookingData, formData, timeData, scheduleData, productData, afdianConfigData, afdianPendingData] = await Promise.all([
    api('/api/admin/bookings'),
    api('/api/admin/form-templates'),
    api('/api/admin/time-templates'),
    api('/api/admin/schedules'),
    api('/api/admin/products'),
    api('/api/admin/afdian/config'),
    api('/api/admin/afdian/pending')
  ]);
  state.bookings = bookingData.bookings;
  state.formTemplates = formData.templates;
  state.timeTemplates = timeData.templates;
  state.schedules = scheduleData.schedules;
  state.products = productData.products;
  state.afdianConfig = afdianConfigData.config;
  state.afdianPending = afdianPendingData.pending;
  renderAll();
}

function findSchedule(id) {
  return state.schedules.find((item) => item.id === id);
}

function findSlot(schedule, slotId) {
  return schedule && schedule.slots.find((item) => item.id === slotId);
}

function renderAll() {
  renderBookings();
  renderAfdian();
  renderProducts();
  renderForms();
  renderTimes();
  renderSchedules();
  renderNewScheduleSelects();
}

// 收款码预览回显
function renderPayQr() {
  const payQr = state.photographer?.payQr || {};
  el.wechatQrPreview.innerHTML = payQr.wechat
    ? `<img src="${esc(payQr.wechat)}" style="max-width:140px;max-height:140px;border-radius:8px">`
    : '<span class="muted" style="font-size:12px">未上传</span>';
  el.alipayQrPreview.innerHTML = payQr.alipay
    ? `<img src="${esc(payQr.alipay)}" style="max-width:140px;max-height:140px;border-radius:8px">`
    : '<span class="muted" style="font-size:12px">未上传</span>';
}

// 上传收款码：读文件 → 上传 → 保存到摄影师配置
async function uploadPayQr(key, file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert('请选择图片文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const uploaded = await api('/api/uploads', {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, dataUrl: reader.result })
      });
      const payQr = { ...(state.photographer?.payQr || {}) };
      payQr[key] = uploaded.url;
      const res = await api('/api/admin/me', {
        method: 'PUT',
        body: JSON.stringify({ payQr })
      });
      state.photographer = { ...state.photographer, ...res.photographer };
      renderPayQr();
    } catch (err) {
      alert(err.message);
    }
  };
  reader.onerror = () => alert('图片读取失败');
  reader.readAsDataURL(file);
}

function renderAfdian() {
  const cfg = state.afdianConfig || {};
  el.afdianUserId.value = cfg.user_id || '';
  el.afdianToken.value = '';
  el.afdianToken.placeholder = cfg.tokenSet ? `已保存：${cfg.token}（留空不修改）` : '爱发电设置中心 token';
  el.afdianPlanUrl.value = cfg.planUrl || '';
  el.afdianHomeUrl.value = cfg.homeUrl || '';
  renderPayQr();

  el.afdianPendingList.innerHTML = state.afdianPending.length ? state.afdianPending.map((order) => `
    <div class="card" data-id="${esc(order.id)}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <strong>${esc(order.outTradeNo)}</strong>
        <span class="tag">¥${Number(order.totalAmount).toFixed(2)}</span>
      </div>
      <div style="margin:8px 0">
        <div class="pay-row"><span>订单号</span><span class="muted">${esc(order.outTradeNo)}</span></div>
        <div class="pay-row"><span>备注</span><span class="muted">${esc(order.remark || '—')}</span></div>
        <div class="pay-row"><span>custom_order_id</span><span class="muted">${esc(order.customOrderId || '—')}</span></div>
        <div class="pay-row"><span>收到时间</span><span class="muted">${esc(order.receivedAt.replace('T', ' ').slice(0, 19))}</span></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary link-pending-order" data-id="${esc(order.id)}">关联到预约</button>
        <button class="btn btn-ghost ignore-pending-order" data-id="${esc(order.id)}">忽略</button>
      </div>
    </div>
  `).join('') : '<div class="muted">暂无待核对订单</div>';
}

function formatDateCN(dateStr) {
  if (!dateStr) return '全部日期';
  const [year, month, day] = dateStr.split('-');
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function renderBookings() {
  // 日期下拉选项：全部 + 已发布日期（保留当前选择）
  const publishedDates = [...new Set(state.schedules.map((schedule) => schedule.date).filter(Boolean))].sort();
  el.bookingDateFilter.innerHTML = '<option value="">全部</option>'
    + publishedDates.map((date) => `<option value="${esc(date)}" ${state.filterDate === date ? 'selected' : ''}>${esc(formatDateCN(date))}</option>`).join('');
  el.dateFilterLabel.textContent = formatDateCN(state.filterDate);
  // 日期筛选：只显示选中日期的预约（空 = 全部）
  const visibleBookings = state.filterDate
    ? state.bookings.filter((booking) => findSchedule(booking.scheduleId)?.date === state.filterDate)
    : state.bookings;
  el.bookingCount.textContent = state.filterDate ? `共 ${visibleBookings.length} 条（${state.filterDate}）` : `共 ${visibleBookings.length} 条`;
  const counts = { pending: 0, deposit_paid: 0, completed: 0, finished: 0, cancelled: 0 };
  let shotDoneCount = 0;
  let income = 0;
  let unpaidTotal = 0;
  visibleBookings.forEach((booking) => {
    counts[booking.status] = (counts[booking.status] || 0) + 1;
    if (booking.shotDone) shotDoneCount += 1;
    if (booking.payment.deposit.status === 'paid') income += Number(booking.payment.deposit.amount) || 0;
    if (booking.payment.balance.status === 'paid') income += Number(booking.payment.balance.amount) || 0;
    // 未收金额：未支付的定金/尾款（已取消预约不算）
    if (booking.status !== 'cancelled') {
      if (booking.payment.deposit.status !== 'paid') unpaidTotal += Number(booking.payment.deposit.amount) || 0;
      if (booking.payment.balance.status !== 'paid') unpaidTotal += Number(booking.payment.balance.amount) || 0;
    }
  });
  el.bookingStats.innerHTML = `
    <div class="card"><span class="muted">全部预约</span><span class="stat-value">${visibleBookings.length}</span></div>
    <div class="card"><span class="muted">已拍摄</span><span class="stat-value" style="color:var(--cyan)">${shotDoneCount}</span></div>
    <div class="card"><span class="muted">待付定金</span><span class="stat-value">${counts.pending}</span></div>
    <div class="card"><span class="muted">已付定金</span><span class="stat-value">${counts.deposit_paid}</span></div>
    <div class="card"><span class="muted">已付尾款</span><span class="stat-value">${counts.completed}</span></div>
    <div class="card"><span class="muted">已完成</span><span class="stat-value">${counts.finished}</span></div>
    <div class="card"><span class="muted">未收金额</span><span class="stat-value">¥${unpaidTotal.toFixed(2)}</span></div>
    <div class="card"><span class="muted">累计实收</span><span class="stat-value">¥${income}</span></div>
  `;

  el.bookingRows.innerHTML = visibleBookings.map((booking, index) => {
    const schedule = findSchedule(booking.scheduleId);
    const slot = findSlot(schedule, booking.slotId);
    const answers = booking.formAnswers || {};
    const time = schedule && slot ? `${schedule.date} ${slot.start}-${slot.end}` : '—';
    const deposit = booking.payment.deposit;
    const balance = booking.payment.balance;
    const contact = answers.contact ? formatAnswer(answers.contact) : (formatAnswer(answers.wechat) || formatAnswer(answers.phone));
    const productName = state.products.find((item) => item.id === booking.productId)?.name || '—';
    const row1 = [`<button class="btn btn-ghost view-booking" data-id="${esc(booking.id)}">详情</button>`];
    row1.push(`<button class="btn btn-danger delete-booking" data-id="${esc(booking.id)}">删除</button>`);
    const row2 = [];
    if (booking.status !== 'finished') {
      row2.push(`<button class="btn btn-cyan complete-booking" data-id="${esc(booking.id)}">完成</button>`);
    }
    if (booking.status !== 'cancelled' && booking.status !== 'finished') {
      row2.push(`<button class="btn btn-ghost cancel-booking" data-id="${esc(booking.id)}">取消</button>`);
    }
    const payState = (payment) => (payment.status === 'paid' ? '已付' : payment.status === 'pending' ? '支付中' : '未付');
    // 客妹填写的信息（白框展示）
    const template = schedule ? state.formTemplates.find((item) => item.id === schedule.formTemplateId) : null;
    const labelFor = (key) => template?.fields.find((field) => field.id === key)?.label || key;
    const answerRows = Object.entries(answers)
      .filter(([, value]) => value !== '' && value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
      .map(([key, value]) => `<div style="margin:2px 0"><span class="muted">${esc(labelFor(key))}：</span>${renderAnswer(value)}</div>`)
      .join('');
    return `
      <div class="card booking-card status-${esc(booking.status)}">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="booking-index">${index + 1}</span>
            <span style="font-size:15px">${esc(time)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="btn shot-toggle-booking ${booking.shotDone ? 'btn-cyan' : 'btn-ghost'}" style="padding:5px 12px;font-size:12px" data-id="${esc(booking.id)}">${booking.shotDone ? '已拍摄' : '未拍摄'}</button>
            <span class="tag">${esc(STATUS_LABELS[booking.status] || booking.status)}</span>
          </div>
        </div>
        <div style="background:rgba(255,255,255,.5);border-radius:12px;padding:10px 12px;margin:8px 0;font-size:13px">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0">
            <span>定金 ¥${deposit.amount}</span>
            <span>${payState(deposit)}${booking.status !== 'cancelled' && deposit.status !== 'paid' ? ` <button class="btn btn-primary mark-paid" style="padding:4px 10px;font-size:12px" data-id="${esc(booking.id)}" data-type="deposit">标记已付</button>` : ''}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px dashed rgba(0,0,0,.08)">
            <span>尾款 ¥${balance.amount}</span>
            <span>${payState(balance)}${booking.status !== 'cancelled' && deposit.status === 'paid' && balance.status !== 'paid' ? ` <button class="btn btn-cyan mark-paid" style="padding:4px 10px;font-size:12px" data-id="${esc(booking.id)}" data-type="balance">标记已付</button>` : ''}</span>
          </div>
        </div>
        <div class="pay-box" style="font-size:13px;line-height:1.8">
          ${answerRows || '<span class="muted">—</span>'}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center">
          <select class="select status-select" data-id="${esc(booking.id)}" style="width:auto;flex:0 0 auto;padding:7px 10px">
            ${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${booking.status === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          ${row1.join('')}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${row2.join('')}</div>
      </div>
    `;
  }).join('');
}

function renderProducts() {
  el.productList.innerHTML = state.products.map((product, index) => `
    <div class="card" data-id="${esc(product.id)}">
      <div class="prod-row">
        <div class="prod-field" style="flex:2">
          <label>商品名称</label>
          <input class="input prod-name" value="${esc(product.name)}" placeholder="如：单人4图">
        </div>
        <div class="prod-field">
          <label>占用时间间隔</label>
          <input class="input prod-units" type="number" min="1" value="${esc(product.slotUnits)}">
        </div>
      </div>
      <div class="prod-row">
        <div class="prod-field">
          <label>定金（元）</label>
          <input class="input prod-deposit" type="number" min="0" value="${esc(product.deposit)}">
        </div>
        <div class="prod-field">
          <label>尾款（元）</label>
          <input class="input prod-balance" type="number" min="0" value="${esc(product.balance)}">
        </div>
        <div class="prod-field">
          <label>上架</label>
          <button type="button" class="btn prod-enabled-btn ${product.enabled ? 'active' : ''}">${product.enabled ? '上架中' : '已下架'}</button>
        </div>
      </div>
      <div class="prod-actions">
        ${index > 0 ? '<button class="btn btn-ghost move-product" data-dir="-1">↑</button>' : ''}
        ${index < state.products.length - 1 ? '<button class="btn btn-ghost move-product" data-dir="1">↓</button>' : ''}
        <button class="btn btn-primary save-product">保存</button>
        <button class="btn btn-danger delete-product">删除</button>
      </div>
    </div>
  `).join('') || '<div class="muted">暂无商品，点击右上角「上架新商品」</div>';
}

function readProductFromCard(card) {
  return {
    id: card.dataset.id,
    name: card.querySelector('.prod-name').value.trim(),
    deposit: Number(card.querySelector('.prod-deposit').value) || 0,
    balance: Number(card.querySelector('.prod-balance').value) || 0,
    slotUnits: Number(card.querySelector('.prod-units').value) || 1,
    enabled: card.querySelector('.prod-enabled-btn').classList.contains('active')
  };
}

// ---------- 管理员视图（共用后台） ----------

function renderSuperStats() {
  const stats = state.superStats || {};
  el.statCards.innerHTML = `
    <div class="card"><span class="muted">摄影师账号</span><span class="stat-value">${stats.photographerCount || 0}</span></div>
    <div class="card"><span class="muted">已冻结</span><span class="stat-value" style="color:var(--danger)">${stats.frozenCount || 0}</span></div>
    <div class="card"><span class="muted">发布约单</span><span class="stat-value">${stats.scheduleCount || 0}</span></div>
    <div class="card"><span class="muted">预约总数</span><span class="stat-value">${stats.bookingCount || 0}</span></div>
    <div class="card"><span class="muted">累计收款</span><span class="stat-value">¥${Number(stats.totalReceived || 0).toFixed(2)}</span></div>
  `;
}

function renderSuperAccounts() {
  el.accountRows.innerHTML = state.superAccounts.map((account) => `
    <tr>
      <td><a href="#" class="super-account-link" data-id="${esc(account.id)}">${esc(account.username)}</a></td>
      <td><a href="#" class="super-account-link" data-id="${esc(account.id)}">${esc(account.displayName)}</a></td>
      <td>${esc((account.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${account.frozen ? '<span class="tag frozen">已冻结</span>' : '<span class="tag">正常</span>'}</td>
      <td>${account.productCount}</td>
      <td>${account.bookingCount}</td>
      <td style="white-space:nowrap">
        ${account.frozen
          ? `<button class="btn btn-ghost toggle-freeze" data-id="${esc(account.id)}" data-name="${esc(account.displayName)}" data-frozen="0">解冻</button>`
          : `<button class="btn btn-danger toggle-freeze" data-id="${esc(account.id)}" data-name="${esc(account.displayName)}" data-frozen="1">冻结</button>`}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="muted">暂无注册账号</td></tr>';
}

function renderSuperSchedules() {
  el.scheduleList.innerHTML = state.superSchedules.map((schedule) => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <strong>${esc(schedule.photographerDisplayName)} <span class="muted">${esc(schedule.photographerEmail)}</span></strong>
        <span class="muted">${esc(schedule.date)} · ${schedule.slotCount} 个时段</span>
      </div>
      <div style="margin:8px 0">
        ${schedule.frozen ? '<span class="tag frozen">账号已冻结</span>' : ''}
        <span class="tag">${esc(schedule.formTemplateName)}</span>
        <span class="tag">可约 ${schedule.openSlotCount} 时段</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${schedule.products.map((product) => `
          <span class="tag" title="${product.enabled ? '上架中' : '已下架'}">${esc(product.name)} ¥${product.deposit}+¥${product.balance}（${product.slotUnits} 间隔）</span>
        `).join('') || '<span class="muted">该摄影师暂无商品</span>'}
      </div>
    </div>
  `).join('') || '<div class="muted">暂无发布的约单</div>';
}

function renderSuperBookings() {
  const payHtml = (payment) => `¥${payment.amount} ${payment.status === 'paid' ? '<span class="tag available">已付</span>' : payment.status === 'pending' ? '<span class="tag">支付中</span>' : '<span class="tag">未付</span>'}`;
  el.superBookingRows.innerHTML = state.superBookings.map((booking) => `
    <tr>
      <td><strong>${esc(booking.id)}</strong></td>
      <td>${esc(booking.photographerDisplayName)}<br><span class="muted">${esc(booking.photographerEmail)}</span></td>
      <td>${esc(booking.productName)}</td>
      <td>${esc(booking.date)} ${esc(booking.slotStart)}-${esc(booking.slotEnd)}</td>
      <td><span class="tag">${esc(STATUS_LABELS[booking.status] || booking.status)}</span></td>
      <td>${payHtml(booking.payment.deposit)}</td>
      <td>${payHtml(booking.payment.balance)}</td>
      <td>${esc((booking.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="muted">暂无预约</td></tr>';
}

async function toggleFreeze(id, name, nextFrozen) {
  const action = nextFrozen ? '冻结' : '解冻';
  if (!confirm(`${action}摄影师「${name}」？${nextFrozen ? '\n冻结后其无法登录，接单页不可用。' : ''}`)) return;
  try {
    await api(`/api/super/accounts/${id}/freeze`, {
      method: 'PUT',
      body: JSON.stringify({ frozen: nextFrozen })
    });
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
}

function renderForms() {
  const types = [
    ['text', '文本'],
    ['select', '单选'],
    ['checkbox', '多选'],
    ['image', '图片上传'],
    ['remark', '备注']
  ];
  el.formTemplates.innerHTML = state.formTemplates.map((template) => `
    <div class="card" data-id="${esc(template.id)}">
      <div class="template-head">
        <input class="input form-name" value="${esc(template.name)}" placeholder="模板名称">
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary save-form">保存</button>
          <button class="btn btn-danger delete-form">删除</button>
        </div>
      </div>
      <div class="field-editors" style="margin-top:12px">
        ${(template.fields || []).map((field, index) => `
          <div class="field-editor" data-index="${index}" data-field-id="${esc(field.id)}">
            <div class="field-line">
              <span class="field-index">${index + 1}</span>
              <input class="input field-label" value="${esc(field.label)}" placeholder="题目">
              <select class="select field-type">
                ${types.map(([value, label]) => `<option value="${value}" ${field.type === value ? 'selected' : ''}>${label}</option>`).join('')}
                ${types.some(([value]) => value === field.type) ? '' : `<option value="${esc(field.type)}" selected>${field.type === 'contact' ? '联系方式（旧）' : esc(field.type)}</option>`}
              </select>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" class="field-required" ${field.required ? 'checked' : ''}>必填</label>
              <button class="icon-btn danger remove-field">×</button>
            </div>
            <div class="hint-editor">
              <span class="muted">题目备注</span>
              <input class="input field-hint" value="${esc(field.hint || '')}">
            </div>
            <div class="option-editor">
              <div class="option-rows">
                ${((field.options && field.options.length ? field.options : [''])).map((option) => `
                  <div class="option-row">
                    <input class="input option-item" value="${esc(option)}" placeholder="选项内容">
                    <button type="button" class="icon-btn danger remove-option">×</button>
                  </div>
                `).join('')}
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button type="button" class="btn btn-ghost add-option">添加选项</button>
                <button type="button" class="btn btn-primary done-option hidden">完成</button>
              </div>
            </div>
            <div class="image-editor">
              <label class="muted" style="font-size:12px">最多上传张数</label>
              <input class="input field-max" type="number" min="1" value="${esc(field.maxFiles || 3)}">
            </div>
            <div class="remark-editor">
              <textarea class="textarea field-remark-text" placeholder="备注内容（只展示，不填写）">${esc(field.text || '')}</textarea>
            </div>
            ${['select', 'checkbox'].includes(field.type) ? `
            <div class="logic-row">
              <label class="logic-toggle"><input type="checkbox" class="logic-enabled" ${field.displayLogic?.enabled ? 'checked' : ''}>需要显示逻辑</label>
              <div class="logic-controls ${field.displayLogic?.enabled ? '' : 'hidden'}">
                <span class="muted">该选项选择（可多选）</span>
                <div class="logic-values">
                  ${(field.options && field.options.length ? field.options : []).map((option) => {
                    const values = Array.isArray(field.displayLogic?.value) ? field.displayLogic.value : (field.displayLogic?.value ? [field.displayLogic.value] : []);
                    return `<label class="check-option"><input type="checkbox" class="logic-value" value="${esc(option)}" ${values.includes(option) ? 'checked' : ''}><span>${esc(option)}</span></label>`;
                  }).join('') || '<span class="muted" style="font-size:12px">请先在上方添加选项</span>'}
                </div>
                <span class="muted">显示第</span>
                <input class="input logic-start" type="number" min="1" value="${esc(field.displayLogic?.startIndex || '')}" placeholder="如 2">
                <span class="muted">到第</span>
                <input class="input logic-end" type="number" min="1" value="${esc(field.displayLogic?.endIndex || '')}" placeholder="如 4">
                <span class="muted">题</span>
              </div>
            </div>` : ''}
          </div>
        `).join('')}
      </div>
      <button class="btn btn-ghost add-field" style="margin-top:10px">添加题目</button>
    </div>
  `).join('');
  el.formTemplates.querySelectorAll('.field-editor').forEach((editor) => {
    updateFieldEditorMode(editor, editor.querySelector('.field-type').value);
    toggleLogicControls(editor);
  });
}

function readFormFromCard(card) {
  const id = card.dataset.id;
  const name = card.querySelector('.form-name').value.trim();
  const fields = Array.from(card.querySelectorAll('.field-editor')).map((editor, index) => {
    const type = editor.querySelector('.field-type').value;
    const field = {
      id: editor.dataset.fieldId || `field_${index}`,
      label: editor.querySelector('.field-label').value.trim(),
      type,
      required: editor.querySelector('.field-required').checked,
      placeholder: ''
    };
    const hint = editor.querySelector('.field-hint').value.trim();
    if (hint) field.hint = hint;
    if (type === 'select' || type === 'checkbox' || type === 'contact') {
      field.options = Array.from(editor.querySelectorAll('.option-item')).map((item) => item.value.trim()).filter(Boolean);
    }
    if (type === 'image') {
      field.maxFiles = Number(editor.querySelector('.field-max').value) || 3;
    }
    if (type === 'remark') {
      field.text = editor.querySelector('.field-remark-text').value.trim();
    }
    const logicEnabled = editor.querySelector('.logic-enabled');
    if (logicEnabled && logicEnabled.checked) {
      field.displayLogic = {
        enabled: true,
        value: Array.from(editor.querySelectorAll('.logic-value:checked')).map((input) => input.value),
        startIndex: Number(editor.querySelector('.logic-start').value) || 0,
        endIndex: Number(editor.querySelector('.logic-end').value) || 0
      };
    }
    return field;
  });
  return { id, name, fields };
}

function updateFieldEditorMode(editor, type) {
  const optionEditor = editor.querySelector('.option-editor');
  const imageEditor = editor.querySelector('.image-editor');
  const remarkEditor = editor.querySelector('.remark-editor');
  const logicRow = editor.querySelector('.logic-row');
  optionEditor.classList.toggle('hidden', !['select', 'checkbox', 'contact'].includes(type));
  imageEditor.classList.toggle('hidden', type !== 'image');
  remarkEditor.classList.toggle('hidden', type !== 'remark');
  // 显示逻辑仅在单选/多选类型出现
  if (logicRow) logicRow.classList.toggle('hidden', !['select', 'checkbox'].includes(type));
}

function toggleLogicControls(editor) {
  const controls = editor.querySelector('.logic-controls');
  const enabled = editor.querySelector('.logic-enabled');
  if (!controls || !enabled) return; // 显示逻辑仅在单选/多选存在
  controls.classList.toggle('hidden', !enabled.checked);
}

function renderTimes() {
  el.timeTemplates.innerHTML = state.timeTemplates.map((template) => `
    <div class="card" data-id="${esc(template.id)}">
      <div class="template-head">
        <div style="display:flex;gap:10px;flex-wrap:wrap;flex:1;align-items:end">
          <div>
            <label class="muted" style="display:block;font-size:12px;margin-bottom:4px">模板名称</label>
            <input class="input time-name" value="${esc(template.name)}" placeholder="模板名称" style="min-width:150px">
          </div>
          <div>
            <label class="muted" style="display:block;font-size:12px;margin-bottom:4px">开始时间</label>
            <input class="input time-start" type="time" value="${esc(template.startTime || '14:00')}">
          </div>
          <div>
            <label class="muted" style="display:block;font-size:12px;margin-bottom:4px">结束时间</label>
            <input class="input time-end" type="time" value="${esc(template.endTime || '16:00')}">
          </div>
          <div>
            <label class="muted" style="display:block;font-size:12px;margin-bottom:4px">间隔（分钟）</label>
            <input class="input time-interval" type="number" min="1" value="${esc(template.intervalMinutes || 20)}" style="max-width:100px">
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary save-time">保存</button>
          <button class="btn btn-danger delete-time">删除</button>
        </div>
      </div>
      <div class="time-preview" style="margin-top:12px"></div>
    </div>
  `).join('');
  el.timeTemplates.querySelectorAll('.card').forEach((card) => updateTimePreview(card));
}

function readTimeFromCard(card) {
  const id = card.dataset.id;
  const name = card.querySelector('.time-name').value.trim();
  return {
    id,
    name,
    startTime: card.querySelector('.time-start').value,
    endTime: card.querySelector('.time-end').value,
    intervalMinutes: Number(card.querySelector('.time-interval').value) || 20
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

function generatePreviewSlots(template) {
  const start = timeToMinutes(template.startTime);
  const end = timeToMinutes(template.endTime);
  const interval = Number(template.intervalMinutes) || 20;
  if (Number.isNaN(start) || Number.isNaN(end) || interval <= 0 || end <= start) {
    return [];
  }
  const slots = [];
  for (let current = start; current + interval <= end; current += interval) {
    slots.push({ start: minutesToTime(current), end: minutesToTime(current + interval) });
  }
  return slots;
}

function updateTimePreview(card) {
  const template = readTimeFromCard(card);
  const slots = generatePreviewSlots(template);
  card.querySelector('.time-preview').innerHTML = slots.length
    ? `<div class="muted" style="font-size:12px;margin-bottom:8px">将自动生成 ${slots.length} 个时段：</div>
       <div class="preview-tags">${slots.map((slot) => `<span class="tag">${esc(slot.start)}-${esc(slot.end)}</span>`).join('')}</div>`
    : '<div class="muted" style="font-size:12px">请填写有效的开始时间、结束时间和间隔。</div>';
}

function renderSchedules() {
  el.schedulesList.innerHTML = state.schedules.map((schedule) => `
    <div class="card" data-id="${esc(schedule.id)}">
      <div class="schedule-date">
        <input class="input sch-date" type="date" value="${esc(schedule.date)}" style="max-width:160px">
        <select class="select sch-form">
          ${state.formTemplates.map((template) => `<option value="${esc(template.id)}" ${schedule.formTemplateId === template.id ? 'selected' : ''}>${esc(template.name)}</option>`).join('')}
        </select>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary save-schedule">保存</button>
          <button class="btn btn-danger delete-schedule">删除</button>
        </div>
      </div>
      <div class="sch-slots" style="margin-top:12px">
        <div class="slot-edit-head">
          <span>开始</span>
          <span>结束</span>
          <span>容量（可约人数）</span>
          <span></span>
        </div>
        ${(schedule.slots || []).map((slot, index) => `
          <div class="slot-edit-row" data-id="${esc(slot.id)}">
            <input class="input slot-start" value="${esc(slot.start)}" placeholder="开始">
            <input class="input slot-end" value="${esc(slot.end)}" placeholder="结束">
            <input class="input slot-capacity" type="number" min="1" value="${esc(slot.capacity)}">
            <button class="icon-btn danger remove-schedule-slot">×</button>
          </div>
        `).join('')}
      </div>
      <button class="btn btn-ghost add-schedule-slot" style="margin-top:10px">添加时段</button>
    </div>
  `).join('');
}

function readScheduleFromCard(card) {
  const id = card.dataset.id;
  const date = card.querySelector('.sch-date').value;
  const formTemplateId = card.querySelector('.sch-form').value;
  const slots = Array.from(card.querySelectorAll('.sch-slots .slot-edit-row')).map((row) => {
    // 备注/开关不再编辑：保存时保留原值（防已关闭时段意外重开）
    const original = state.schedules.flatMap((schedule) => schedule.slots).find((slot) => slot.id === row.dataset.id);
    return {
      id: row.dataset.id || `slot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      start: row.querySelector('.slot-start').value,
      end: row.querySelector('.slot-end').value,
      capacity: Math.max(1, Number(row.querySelector('.slot-capacity').value) || 1),
      note: original ? original.note || '' : '',
      enabled: original ? original.enabled !== false : true
    };
  });
  return { id, date, formTemplateId, slots };
}

function renderNewScheduleSelects() {
  el.newScheduleFormTemplate.innerHTML = state.formTemplates.map((template) => `<option value="${esc(template.id)}">${esc(template.name)}</option>`).join('');
  el.newScheduleTimeTemplate.innerHTML = state.timeTemplates.map((template) => `<option value="${esc(template.id)}">${esc(template.name)}（${esc(template.intervalMinutes || 20)}分钟）</option>`).join('');
}

let detailBookingId = null; // 当前打开的详情预约（修改后自动刷新）

function openDetail(booking) {
  detailBookingId = booking.id;
  const schedule = findSchedule(booking.scheduleId);
  const slot = findSlot(schedule, booking.slotId);
  const answers = booking.formAnswers || {};
  const template = state.formTemplates.find((item) => item.id === schedule?.formTemplateId);
  const labelFor = (key) => template?.fields.find((field) => field.id === key)?.label || key;
  const answerRows = Object.entries(answers).map(([key, value]) => `
    <div class="detail-line"><span class="label">${esc(labelFor(key))}</span><span>${renderAnswer(value)}</span></div>
  `).join('');
  const productName = state.products.find((item) => item.id === booking.productId)?.name || '—';
  el.detailBody.innerHTML = `
    <div class="detail-line"><span class="label">预约编号</span><span>${esc(booking.id)}</span></div>
    <div class="detail-line"><span class="label">商品</span><span>${esc(productName)}</span></div>
    <div class="detail-line"><span class="label">时间</span><span>${schedule ? esc(schedule.date) : '—'} ${slot ? esc(slot.start + '-' + slot.end) : ''}</span></div>
    <div class="detail-line"><span class="label">状态</span><span>${esc(STATUS_LABELS[booking.status] || booking.status)}</span></div>
    <div class="detail-line"><span class="label">定金</span><span>¥${booking.payment.deposit.amount} · ${booking.payment.deposit.status === 'paid' ? '已付' : '未付'}</span></div>
    <div class="detail-line"><span class="label">尾款</span><span>¥${booking.payment.balance.amount} · ${booking.payment.balance.status === 'paid' ? '已付' : '未付'}</span></div>
    ${answerRows}
  `;
  el.detailModal.classList.remove('hidden');
}

async function patchBooking(id, body) {
  await api(`/api/admin/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  await loadAll();
  // 详情弹窗开着同一条预约时立即刷新内容
  if (detailBookingId === id && !el.detailModal.classList.contains('hidden')) {
    const booking = state.bookings.find((item) => item.id === id);
    if (booking) openDetail(booking);
  }
}

document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('registerBtn').addEventListener('click', register);
el.sendCodeBtn.addEventListener('click', sendCode);
el.emailInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') login();
});
el.passwordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') login();
});
el.registerCodeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') register();
});
el.registerPasswordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') register();
});
el.logoutBtn.addEventListener('click', logout);
document.getElementById('closeModalBtn').addEventListener('click', () => {
  el.detailModal.classList.add('hidden');
  detailBookingId = null;
});

el.loginTab.addEventListener('click', () => {
  el.loginTab.classList.add('active');
  el.registerTab.classList.remove('active');
  el.loginFields.classList.remove('hidden');
  el.registerFields.classList.add('hidden');
  el.loginError.classList.add('hidden');
});
el.registerTab.addEventListener('click', () => {
  el.registerTab.classList.add('active');
  el.loginTab.classList.remove('active');
  el.registerFields.classList.remove('hidden');
  el.loginFields.classList.add('hidden');
  el.loginError.classList.add('hidden');
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    // 切到预约管理/收款时刷新数据（支付状态可能已被爱发电回调更新）
    if (state.role === 'photographer' && btn.dataset.tab === 'bookings') {
      loadAll().catch(() => {});
    }
  });
});

el.bookingRows.addEventListener('change', (event) => {
  const select = event.target.closest('.status-select');
  if (select) patchBooking(select.dataset.id, { status: select.value });
});

// 日期筛选：透明 select 覆盖在 ▾ 按钮上，点击直接弹出原生下拉
el.bookingDateFilter.addEventListener('change', () => {
  state.filterDate = el.bookingDateFilter.value;
  renderBookings();
});

el.bookingRows.addEventListener('click', async (event) => {
  const viewBtn = event.target.closest('.view-booking');
  const deleteBtn = event.target.closest('.delete-booking');
  const completeBtn = event.target.closest('.complete-booking');
  const cancelBtn = event.target.closest('.cancel-booking');
  const shotToggleBtn = event.target.closest('.shot-toggle-booking');
  if (viewBtn) {
    const booking = state.bookings.find((item) => item.id === viewBtn.dataset.id);
    if (booking) openDetail(booking);
  }
  if (shotToggleBtn) {
    // 拍摄标记切换（独立于订单状态）
    const booking = state.bookings.find((item) => item.id === shotToggleBtn.dataset.id);
    const next = !(booking && booking.shotDone);
    try {
      await patchBooking(shotToggleBtn.dataset.id, { shotDone: next });
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (completeBtn) {
    // 标记完成：不弹确认，直接生效
    try {
      await patchBooking(completeBtn.dataset.id, { status: 'finished' });
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (cancelBtn) {
    // 取消：仅一次确认
    if (confirm('确认取消该预约？')) {
      try {
        await patchBooking(cancelBtn.dataset.id, { status: 'cancelled' });
      } catch (err) {
        alert(err.message);
      }
    }
    return;
  }
  if (deleteBtn) {
    if (confirm('确认删除该预约？删除后不可恢复！')) {
      try {
        await api(`/api/admin/bookings/${deleteBtn.dataset.id}`, { method: 'DELETE' });
        await loadAll();
        alert('预约已删除');
      } catch (err) {
        alert(err.message);
      }
    }
  }
});

el.bookingRows.addEventListener('click', async (event) => {
  const btn = event.target.closest('.mark-paid');
  if (!btn) return;
  btn.disabled = true;
  const key = btn.dataset.type;
  try {
    await patchBooking(btn.dataset.id, {
      payment: { [key]: { status: 'paid', paidAt: new Date().toISOString(), provider: 'manual' } }
    });
  } catch (err) {
    alert(err.message);
  }
});

el.wechatQrFile.addEventListener('change', (event) => uploadPayQr('wechat', event.target.files[0]));
el.alipayQrFile.addEventListener('change', (event) => uploadPayQr('alipay', event.target.files[0]));

// 全屏展示收款码：微信/支付宝上下排列放大，点击任意处退出
function showPayQr(payQr) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:20px;overflow:auto';
  const qrItem = (src, label) => src
    ? `<div style="text-align:center;color:#fff"><img src="${esc(src)}" style="width:min(72vw,320px);height:auto;background:#fff;border-radius:12px;padding:12px"><div style="margin-top:8px;font-size:14px">${label}</div></div>`
    : '';
  overlay.innerHTML = `
    ${qrItem(payQr.wechat, '微信')}
    ${qrItem(payQr.alipay, '支付宝')}
    <div style="color:rgba(255,255,255,.6);font-size:12px;margin-top:6px">点击任意处关闭</div>
  `;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

document.getElementById('viewPayQrBtn').addEventListener('click', () => {
  const payQr = state.photographer?.payQr || {};
  if (!payQr.wechat && !payQr.alipay) {
    alert('尚未上传收款码，请到「支付设置」上传');
    return;
  }
  showPayQr(payQr);
});

el.saveAfdianConfigBtn.addEventListener('click', async () => {
  try {
    await api('/api/admin/afdian/config', {
      method: 'PUT',
      body: JSON.stringify({
        user_id: el.afdianUserId.value.trim(),
        token: el.afdianToken.value.trim(),
        planUrl: el.afdianPlanUrl.value.trim(),
        homeUrl: el.afdianHomeUrl.value.trim()
      })
    });
    await loadAll();
    alert('爱发电配置已保存');
  } catch (err) {
    alert(err.message);
  }
});

el.afdianPollBtn.addEventListener('click', async () => {
  el.afdianPollBtn.disabled = true;
  try {
    const result = await api('/api/admin/afdian/poll', { method: 'POST', body: JSON.stringify({}) });
    const stats = result.stats || {};
    const parts = [];
    if (stats.error) parts.push(`失败：${stats.error}`);
    if (stats.fetched) parts.push(`获取 ${stats.fetched} 单`);
    if (stats.matched) parts.push(`已匹配 ${stats.matched}`);
    if (stats.pending) parts.push(`待核对 ${stats.pending}`);
    if (stats.duplicate) parts.push(`重复 ${stats.duplicate}`);
    alert(parts.length ? `同步完成：${parts.join('，')}` : '同步完成，无新订单');
    await loadAll();
  } catch (err) {
    alert(err.message);
  } finally {
    el.afdianPollBtn.disabled = false;
  }
});

el.afdianPendingList.addEventListener('click', async (event) => {
  const linkBtn = event.target.closest('.link-pending-order');
  const ignoreBtn = event.target.closest('.ignore-pending-order');
  if (linkBtn) {
    const bookingId = prompt('输入要关联的预约编号（如 YB-0815-001）：');
    if (!bookingId) return;
    const paymentKey = confirm('确定关联为「定金」吗？点取消则关联为「尾款」') ? 'deposit' : 'balance';
    try {
      await api(`/api/admin/afdian/pending/${linkBtn.dataset.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ bookingId: bookingId.trim(), paymentKey })
      });
      await loadAll();
      alert('已关联并确认收款');
    } catch (err) {
      alert(err.message);
    }
  }
  if (ignoreBtn) {
    if (!confirm('确认忽略该订单？')) return;
    try {
      await api(`/api/admin/afdian/pending/${ignoreBtn.dataset.id}/ignore`, { method: 'POST', body: JSON.stringify({}) });
      await loadAll();
    } catch (err) {
      alert(err.message);
    }
  }
});

el.newProductBtn.addEventListener('click', async () => {
  try {
    await api('/api/admin/products', {
      method: 'POST',
      body: JSON.stringify({ name: '未命名商品', deposit: 50, balance: 50, slotUnits: 1, enabled: true })
    });
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

el.productList.addEventListener('click', async (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  const product = readProductFromCard(card);

  // 上架/下架切换按钮
  const enabledBtn = event.target.closest('.prod-enabled-btn');
  if (enabledBtn) {
    enabledBtn.classList.toggle('active');
    enabledBtn.textContent = enabledBtn.classList.contains('active') ? '上架中' : '已下架';
    return;
  }

  if (event.target.closest('.save-product')) {
    try {
      await api(`/api/admin/products/${product.id}`, { method: 'PUT', body: JSON.stringify(product) });
      await loadAll();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (event.target.closest('.delete-product')) {
    if (confirm(`确认删除商品「${product.name}」？\n（有预约的商品需先停用，删除后不可恢复）`)) {
      try {
        await api(`/api/admin/products/${product.id}`, { method: 'DELETE' });
        await loadAll();
        alert('商品已删除');
      } catch (err) {
        alert(err.message);
      }
    }
    return;
  }
  const moveBtn = event.target.closest('.move-product');
  if (moveBtn) {
    const index = state.products.findIndex((item) => item.id === product.id);
    const targetIndex = index + Number(moveBtn.dataset.dir);
    if (targetIndex < 0 || targetIndex >= state.products.length) return;
    const target = state.products[targetIndex];
    try {
      await Promise.all([
        api(`/api/admin/products/${product.id}`, { method: 'PUT', body: JSON.stringify({ ...product, sortOrder: target.sortOrder }) }),
        api(`/api/admin/products/${target.id}`, { method: 'PUT', body: JSON.stringify({ ...target, sortOrder: product.sortOrder }) })
      ]);
      await loadAll();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('newFormBtn').addEventListener('click', async () => {
  await api('/api/admin/form-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: '未命名表单',
      fields: [{ id: 'field_0', label: '新题目', type: 'text', required: false, options: [], placeholder: '' }]
    })
  });
  await loadAll();
});

document.getElementById('newTimeBtn').addEventListener('click', async () => {
  await api('/api/admin/time-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: '未命名时间模板',
      startTime: '14:00',
      endTime: '16:00',
      intervalMinutes: 20
    })
  });
  await loadAll();
});

el.formTemplates.addEventListener('click', async (event) => {
  const card = event.target.closest('.card');
  if (!card) return;

  if (event.target.closest('.add-option')) {
    const editor = event.target.closest('.option-editor');
    const rows = editor.querySelector('.option-rows');
    const row = document.createElement('div');
    row.className = 'option-row';
    row.innerHTML = '<input class="input option-item" placeholder="选项内容"><button type="button" class="icon-btn danger remove-option">×</button>';
    rows.appendChild(row);
    // 添加选项后显示「完成」按钮
    editor.querySelector('.done-option').classList.remove('hidden');
    return;
  }
  if (event.target.closest('.done-option')) {
    // 完成选项编辑：重渲染，让「显示逻辑」的选项下拉同步最新选项
    const card = event.target.closest('.card');
    const template = readFormFromCard(card);
    const index = state.formTemplates.findIndex((item) => item.id === template.id);
    state.formTemplates[index] = template;
    renderForms();
    return;
  }
  if (event.target.closest('.remove-option')) {
    event.target.closest('.option-row').remove();
    return;
  }

  const template = readFormFromCard(card);
  if (event.target.closest('.save-form')) {
    await api(`/api/admin/form-templates/${template.id}`, { method: 'PUT', body: JSON.stringify(template) });
    await loadAll();
  }
  if (event.target.closest('.delete-form')) {
    if (confirm('确认删除该表单模板？')) {
      try {
        await api(`/api/admin/form-templates/${template.id}`, { method: 'DELETE' });
        await loadAll();
        alert('表单模板已删除');
      } catch (err) {
        alert(err.message);
      }
    }
  }
  if (event.target.closest('.add-field')) {
    template.fields.push({ id: `field_${Date.now()}`, label: '新题目', type: 'text', required: false, options: [], placeholder: '' });
    const index = state.formTemplates.findIndex((item) => item.id === template.id);
    state.formTemplates[index] = template;
    renderForms();
  }
  if (event.target.closest('.remove-field')) {
    const index = Number(event.target.closest('.field-editor').dataset.index);
    template.fields.splice(index, 1);
    const templateIndex = state.formTemplates.findIndex((item) => item.id === template.id);
    state.formTemplates[templateIndex] = template;
    renderForms();
  }
});

el.formTemplates.addEventListener('input', (event) => {
  // 修改选项内容后也显示「完成」按钮
  if (event.target.matches('.option-item')) {
    const editor = event.target.closest('.option-editor');
    const doneBtn = editor && editor.querySelector('.done-option');
    if (doneBtn) doneBtn.classList.remove('hidden');
  }
});

el.formTemplates.addEventListener('change', (event) => {
  const editor = event.target.closest('.field-editor');
  if (!editor) return;
  if (event.target.matches('.field-type')) {
    // 切换类型后重新渲染（显示逻辑按单选/多选重建）
    const card = editor.closest('.card');
    const template = readFormFromCard(card);
    const index = state.formTemplates.findIndex((item) => item.id === template.id);
    state.formTemplates[index] = template;
    renderForms();
    return;
  }
  if (event.target.matches('.logic-enabled')) {
    toggleLogicControls(editor);
  }
});

el.timeTemplates.addEventListener('click', async (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  const template = readTimeFromCard(card);
  if (event.target.closest('.save-time')) {
    await api(`/api/admin/time-templates/${template.id}`, { method: 'PUT', body: JSON.stringify(template) });
    await loadAll();
  }
  if (event.target.closest('.delete-time')) {
    if (confirm('确认删除该时间模板？')) {
      try {
        await api(`/api/admin/time-templates/${template.id}`, { method: 'DELETE' });
        await loadAll();
        alert('时间模板已删除');
      } catch (err) {
        alert(err.message);
      }
    }
  }
});

el.timeTemplates.addEventListener('input', (event) => {
  const card = event.target.closest('.card');
  if (card && event.target.closest('.time-start, .time-end, .time-interval')) {
    updateTimePreview(card);
  }
});

document.getElementById('createScheduleBtn').addEventListener('click', async () => {
  const date = el.newScheduleDate.value;
  if (!date) {
    alert('请选择日期');
    return;
  }
  try {
    await api('/api/admin/schedules', {
      method: 'POST',
      body: JSON.stringify({
        date,
        formTemplateId: el.newScheduleFormTemplate.value,
        timeTemplateId: el.newScheduleTimeTemplate.value
      })
    });
    el.newScheduleDate.value = '';
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

el.schedulesList.addEventListener('click', async (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  const schedule = readScheduleFromCard(card);
  if (event.target.closest('.save-schedule')) {
    await api(`/api/admin/schedules/${schedule.id}`, { method: 'PUT', body: JSON.stringify(schedule) });
    await loadAll();
  }
  if (event.target.closest('.delete-schedule')) {
    if (confirm('确认删除该日程？\n（已有预约的日程需先处理预约）')) {
      try {
        await api(`/api/admin/schedules/${schedule.id}`, { method: 'DELETE' });
        await loadAll();
        alert('日程已删除');
      } catch (err) {
        alert(err.message);
      }
    }
  }
  if (event.target.closest('.add-schedule-slot')) {
    schedule.slots.push({ id: `slot_${Date.now()}`, start: '', end: '', capacity: 1 });
    const index = state.schedules.findIndex((item) => item.id === schedule.id);
    state.schedules[index] = schedule;
    renderSchedules();
  }
  if (event.target.closest('.remove-schedule-slot')) {
    const index = Array.from(card.querySelectorAll('.sch-slots .slot-edit-row')).indexOf(event.target.closest('.slot-edit-row'));
    schedule.slots.splice(index, 1);
    const scheduleIndex = state.schedules.findIndex((item) => item.id === schedule.id);
    state.schedules[scheduleIndex] = schedule;
    renderSchedules();
  }
});

// Webhook 回调链接：显示 + 点击复制（兼容 http 非安全上下文）
function copyWebhookUrl() {
  const text = `${location.origin}/api/afdian/webhook`;
  const done = () => {
    const el = document.getElementById('webhookUrl');
    if (el) {
      const old = el.textContent;
      el.textContent = '已复制 ✓';
      setTimeout(() => {
        el.textContent = old;
      }, 1500);
    }
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (err) {
      alert(`复制失败，请手动复制：${text}`);
    }
    ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

const webhookUrlText = document.getElementById('webhookUrlText');
if (webhookUrlText) {
  webhookUrlText.textContent = `${location.origin}/api/afdian/webhook`;
}

el.accountRows.addEventListener('click', (event) => {
  const btn = event.target.closest('.toggle-freeze');
  if (btn) {
    event.preventDefault();
    toggleFreeze(btn.dataset.id, btn.dataset.name, btn.dataset.frozen === '1');
    return;
  }
  const link = event.target.closest('.super-account-link');
  if (link) {
    event.preventDefault();
    openSuperDetail(link.dataset.id);
  }
});

// 打开摄影师详情视图
async function openSuperDetail(id) {
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
  document.getElementById('panel-super-detail').classList.add('active');
  el.superDetailInfo.innerHTML = '<div class="muted">加载中...</div>';
  try {
    const data = await api(`/api/super/accounts/${id}/detail`);
    const p = data.photographer;
    const s = data.stats;
    el.superDetailInfo.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <div>
          <strong>${esc(p.displayName)}</strong>
          <span class="tag">${esc(p.username)}</span>
          ${p.frozen ? '<span class="tag frozen">已冻结</span>' : ''}
        </div>
        <div class="muted">注册时间：${esc((p.createdAt || '').replace('T', ' ').slice(0, 19))} · ID：${esc(p.id)}</div>
      </div>
    `;
    el.superDetailStats.innerHTML = `
      <div class="card"><span class="muted">商品数</span><span class="stat-value">${s.productCount}</span></div>
      <div class="card"><span class="muted">发布约单</span><span class="stat-value">${s.scheduleCount}</span></div>
      <div class="card"><span class="muted">预约总数</span><span class="stat-value">${s.bookingCount}</span></div>
      <div class="card"><span class="muted">进行中预约</span><span class="stat-value">${s.activeBookingCount}</span></div>
      <div class="card"><span class="muted">累计收款</span><span class="stat-value">¥${Number(s.totalReceived).toFixed(2)}</span></div>
    `;
    el.superDetailSchedules.innerHTML = data.schedules.map((schedule) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <strong>${esc(schedule.date)}</strong>
          <span class="muted">${schedule.slotCount} 个时段 · 可约 ${schedule.openSlotCount}</span>
        </div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          ${schedule.products.map((product) => `
            <span class="tag" title="${product.enabled ? '上架中' : '已下架'}">${esc(product.name)} ¥${product.deposit}+¥${product.balance}（${product.slotUnits} 间隔）</span>
          `).join('') || '<span class="muted">该摄影师暂无商品</span>'}
        </div>
      </div>
    `).join('') || '<div class="muted">暂无发布的约单</div>';
    const payHtml = (payment) => `¥${payment.amount} ${payment.status === 'paid' ? '<span class="tag available">已付</span>' : payment.status === 'pending' ? '<span class="tag">支付中</span>' : '<span class="tag">未付</span>'}`;
    el.superDetailBookingRows.innerHTML = data.bookings.map((booking) => `
      <tr>
        <td><strong>${esc(booking.id)}</strong></td>
        <td>${esc(booking.productName)}</td>
        <td>${esc(booking.date)} ${esc(booking.slotStart)}-${esc(booking.slotEnd)}</td>
        <td><span class="tag">${esc(STATUS_LABELS[booking.status] || booking.status)}</span></td>
        <td>${payHtml(booking.payment.deposit)}</td>
        <td>${payHtml(booking.payment.balance)}</td>
        <td>${esc((booking.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="muted">暂无预约</td></tr>';
  } catch (err) {
    el.superDetailInfo.innerHTML = `<div class="notice">${esc(err.message)}</div>`;
  }
}

document.getElementById('superDetailBack').addEventListener('click', () => {
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
  document.getElementById('panel-super-accounts').classList.add('active');
});

async function init() {
  const photToken = sessionStorage.getItem('cosPhotographerToken');
  const superToken = sessionStorage.getItem('cosSuperAdminToken');
  if (!photToken && !superToken) return;
  state.token = photToken || superToken;
  state.role = photToken ? 'photographer' : 'super';
  try {
    if (state.role === 'super') {
      enterSuperView();
      await loadAll();
    } else {
      const data = await api('/api/auth/me');
      state.photographer = data.photographer;
      renderProfile();
      enterPhotographerView();
      await loadAll();
    }
  } catch (err) {
    logout();
  }
}

init();
