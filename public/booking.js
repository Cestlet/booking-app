const state = {
  data: null,
  scheduleId: null,
  productId: null,
  slotId: null,
  currentBooking: null,
  currentTemplate: null,
  payUrls: {} // 支付类型 -> 爱发电跳转链接（pending 重渲染时复用）
};

const el = {
  siteName: document.getElementById('siteName'),
  siteNotice: document.getElementById('siteNotice'),
  dateHint: document.getElementById('dateHint'),
  dateTabs: document.getElementById('dateTabs'),
  productList: document.getElementById('productList'),
  productSlotHint: document.getElementById('productSlotHint'),
  slotList: document.getElementById('slotList'),
  formSection: document.getElementById('formSection'),
  selectedSlotLabel: document.getElementById('selectedSlotLabel'),
  bookingForm: document.getElementById('bookingForm'),
  formError: document.getElementById('formError'),
  submitBtn: document.getElementById('submitBtn'),
  resultSection: document.getElementById('resultSection'),
  resultCard: document.getElementById('resultCard'),
  backBtn: document.getElementById('backBtn')
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

// HTML 转义：渲染摄影师/客妹输入时防 XSS
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getSchedule(id) {
  return state.data.schedules.find((item) => item.id === id);
}

function getSelectedSlot() {
  const schedule = getSchedule(state.scheduleId);
  return schedule && schedule.slots.find((slot) => slot.id === state.slotId);
}

function formatDate(dateStr) {
  const [year, month, day] = dateStr.split('-');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const dow = weekdays[new Date(year, month - 1, day).getDay()];
  return `${month}.${day} ${dow}`;
}

function renderDates() {
  el.dateTabs.innerHTML = '';
  el.dateHint.textContent = `共 ${state.data.schedules.length} 天可约`;
  if (!state.data.schedules.length) {
    el.dateTabs.innerHTML = '<div class="muted">暂无开放日期</div>';
    return;
  }

  state.data.schedules.forEach((schedule, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `date-tab${index === 0 ? ' active' : ''}`;
    const availableCount = schedule.slots.filter((slot) => slot.available).length;
    btn.innerHTML = `<strong>${formatDate(schedule.date)}</strong><span class="dow">${availableCount} 个可约时段</span>`;
    btn.addEventListener('click', () => {
      state.scheduleId = schedule.id;
      state.slotId = null;
      renderDates();
      renderSchedule(schedule);
    });
    el.dateTabs.appendChild(btn);
  });
}

function getProduct(id) {
  return state.data.products.find((item) => item.id === id);
}

function renderProducts() {
  el.productList.innerHTML = '';
  if (!state.data.products.length) {
    el.productList.innerHTML = '<div class="card muted">摄影师尚未上架商品</div>';
    return;
  }
  const slotMinutes = state.data.settings.slotMinutes || 20;
  state.data.products.forEach((product) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `slot-card${state.productId === product.id ? ' slot-selected' : ''}`;
    const total = Number(product.deposit) + Number(product.balance);
    card.className = `slot-card product-card${state.productId === product.id ? ' slot-selected' : ''}`;
    card.innerHTML = `
      <div class="product-inner">
        <div class="slot-time">${esc(product.name)}<span class="total-price">¥${total}</span></div>
        <div class="slot-meta">
          <span class="tag">定金 ¥${product.deposit}</span>
          <span class="tag">尾款 ¥${product.balance}</span>
          <span class="tag">时长 ${product.slotUnits * slotMinutes} 分钟</span>
        </div>
      </div>
    `;
    card.addEventListener('click', () => {
      state.productId = product.id;
      state.slotId = null;
      renderProducts();
      if (state.scheduleId) {
        renderProductSlots(getSchedule(state.scheduleId));
      }
      el.formSection.classList.add('hidden');
    });
    el.productList.appendChild(card);
  });
}

// 与后端 isRangeAvailable 同构的客户端检查
function isRangeAvailableClient(slots, index, units) {
  if (index < 0 || index + units > slots.length) return false;
  for (let i = index; i < index + units; i += 1) {
    const slot = slots[i];
    if (!slot.enabled) return false;
    if (slot.booked >= slot.capacity) return false;
  }
  return true;
}

function renderProductSlots(schedule) {
  el.slotList.innerHTML = '';
  const product = getProduct(state.productId);
  if (!product) {
    el.slotList.innerHTML = '<div class="card muted">请先选择商品</div>';
    el.productSlotHint.textContent = '';
    return;
  }
  if (!schedule) {
    el.slotList.innerHTML = '<div class="card muted">请先选择日期</div>';
    el.productSlotHint.textContent = '';
    return;
  }
  if (!schedule.slots.length) {
    el.slotList.innerHTML = '<div class="card muted">这一天还没有配置时间段</div>';
    el.productSlotHint.textContent = '';
    return;
  }
  const slotMinutes = state.data.settings.slotMinutes || 20;
  el.productSlotHint.textContent = `${product.name} · 预计 ${product.slotUnits * slotMinutes} 分钟`;

  const units = product.slotUnits;
  let availableCount = 0;
  schedule.slots.forEach((slot, index) => {
    if (index + units > schedule.slots.length) return; // 超出范围的不展示
    const available = isRangeAvailableClient(schedule.slots, index, units);
    if (available) availableCount += 1;
    const endSlot = schedule.slots[index + units - 1];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `slot-card product-card time-card${available ? '' : ' slot-disabled'}${state.slotId === slot.id ? ' slot-selected' : ''}`;
    card.disabled = !available;
    const statusTag = available ? '<span class="tag available">可约</span>' : '<span class="tag full">已约满/关闭</span>';
    card.innerHTML = `
      <div class="product-inner">
        <div class="slot-time time-display">
          <span class="time-text">${slot.start} - ${endSlot.end}</span>
          ${statusTag}
          ${slot.note ? `<span class="tag note-tag">${esc(slot.note)}</span>` : ''}
        </div>
      </div>
    `;
    card.addEventListener('click', () => {
      state.slotId = slot.id;
      renderProductSlots(schedule);
      renderForm(schedule.formTemplate);
      el.formSection.classList.remove('hidden');
      el.selectedSlotLabel.textContent = `${formatDate(schedule.date)} ${product.name} ${slot.start}-${endSlot.end}`;
    });
    el.slotList.appendChild(card);
  });
  if (!availableCount) {
    el.slotList.innerHTML = '<div class="card muted">该商品今日无可用时间</div>';
  }
}

function renderForm(template) {
  el.bookingForm.innerHTML = '';
  if (!template) {
    el.bookingForm.innerHTML = '<div class="muted">该日程尚未配置表单模板</div>';
    return;
  }
  state.currentTemplate = template;

  template.fields.forEach((field, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    wrapper.dataset.fieldId = field.id;
    const requiredMark = field.required ? '<span class="required">*</span>' : '';
    const id = `answer-${field.id}`;
    const hint = field.hint ? `<div class="field-hint">${field.hint}</div>` : '';
    const questionHead = `
      <div class="question-head">
        <span class="q-number">${index + 1}</span>
        <label for="${id}">${field.label} ${requiredMark}</label>
      </div>
    `;

    let control = '';
    if (field.type === 'remark') {
      wrapper.innerHTML = `
        ${questionHead}
        ${hint}
        <div class="remark-note">
          <p>${field.text || ''}</p>
        </div>
      `;
      el.bookingForm.appendChild(wrapper);
      return;
    } else if (field.type === 'textarea') {
      control = `<textarea id="${id}" class="textarea"></textarea>`;
    } else if (field.type === 'select') {
      const options = (field.options || []).map((option) => `
        <label class="check-option">
          <input type="radio" name="${id}" value="${option}">
          <span>${option}</span>
        </label>
      `).join('');
      control = `<div class="check-group" id="${id}">${options}</div>`;
    } else if (field.type === 'checkbox') {
      const options = (field.options || []).map((option) => `
        <label class="check-option">
          <input type="checkbox" name="${id}" value="${option}">
          <span>${option}</span>
        </label>
      `).join('');
      control = `<div class="check-group" id="${id}">${options}</div>`;
    } else if (field.type === 'contact') {
      const options = (field.options || ['QQ', '微信']).map((option, index) => `
        <label class="contact-option">
          <input type="radio" name="contact-type-${field.id}" value="${option}" ${index === 0 ? 'checked' : ''}>
          <span>${option}</span>
        </label>
      `).join('');
      control = `
        <div class="contact-box" id="${id}">
          <div class="contact-types">${options}</div>
          <input id="contact-value-${field.id}" class="input contact-value">
        </div>
      `;
    } else if (field.type === 'image') {
      const max = field.maxFiles || 3;
      control = `
        <input id="${id}" class="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>
        <div class="muted" style="font-size:12px;margin-top:6px">最多 ${max} 张，支持 png/jpg/webp/gif</div>
      `;
    } else {
      control = `<input id="${id}" class="input" type="text">`;
    }

    wrapper.innerHTML = `${questionHead}${hint}${control}`;
    el.bookingForm.appendChild(wrapper);
  });
  updateConditionalVisibility();
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

function getFieldValue(fieldId) {
  const field = state.currentTemplate?.fields.find((item) => item.id === fieldId);
  if (!field) return '';
  if (field.type === 'checkbox') {
    return Array.from(document.querySelectorAll(`input[name="answer-${fieldId}"]:checked`)).map((input) => input.value);
  }
  if (field.type === 'contact') {
    return document.querySelector(`input[name="contact-type-${fieldId}"]:checked`)?.value || '';
  }
  return document.getElementById(`answer-${fieldId}`)?.value || '';
}

function updateConditionalVisibility() {
  const template = state.currentTemplate;
  if (!template) return;
  const fields = template.fields;

  fields.forEach((field, index) => {
    let hidden = false;
    fields.forEach((controller, controllerIndex) => {
      const logic = controller.displayLogic;
      if (!logic || !logic.enabled || controllerIndex === index) return;
      const start = Number(logic.startIndex) || 0;
      const end = Number(logic.endIndex) || 0;
      if (start < 1 || end < start) return;
      if (index + 1 < start || index + 1 > end) return;
      if (!fieldMatches(getFieldValue(controller.id), logic.value)) {
        hidden = true;
      }
    });
    const wrapper = el.bookingForm.querySelector(`[data-field-id="${field.id}"]`);
    if (wrapper) {
      wrapper.classList.toggle('hidden', hidden);
    }
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  const dataUrl = await readFileAsDataURL(file);
  return api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, dataUrl })
  });
}

async function collectAnswers(template) {
  const answers = {};
  for (const field of template.fields) {
    const wrapper = el.bookingForm.querySelector(`[data-field-id="${field.id}"]`);
    if (wrapper?.classList.contains('hidden')) {
      continue;
    }
    if (field.type === 'remark') {
      answers[field.id] = '';
      continue;
    }
    if (field.type === 'checkbox') {
      answers[field.id] = Array.from(document.querySelectorAll(`input[name="answer-${field.id}"]:checked`))
        .map((input) => input.value);
      continue;
    }
    if (field.type === 'select') {
      answers[field.id] = document.querySelector(`input[name="answer-${field.id}"]:checked`)?.value || '';
      continue;
    }
    if (field.type === 'contact') {
      const type = document.querySelector(`input[name="contact-type-${field.id}"]:checked`)?.value || '';
      const value = document.getElementById(`contact-value-${field.id}`)?.value.trim() || '';
      answers[field.id] = { type, value };
      continue;
    }
    if (field.type === 'image') {
      const input = document.getElementById(`answer-${field.id}`);
      const maxFiles = field.maxFiles || 3;
      const files = input?.files ? Array.from(input.files).slice(0, maxFiles) : [];
      const urls = [];
      for (const file of files) {
        const uploaded = await uploadFile(file);
        urls.push(uploaded.url);
      }
      answers[field.id] = urls;
      continue;
    }
    const input = document.getElementById(`answer-${field.id}`);
    answers[field.id] = input ? input.value.trim() : '';
  }
  return answers;
}

function renderResult(booking) {
  const schedule = getSchedule(booking.scheduleId);
  const slot = schedule.slots.find((item) => item.id === booking.slotId);
  const product = booking.productId ? getProduct(booking.productId) : null;
  const deposit = booking.payment.deposit;
  const balance = booking.payment.balance;
  const afdianEnabled = state.data.photographer?.afdianEnabled;
  const btnText = afdianEnabled ? '去爱发电支付' : '模拟支付';
  const statusText = (p) => (p.status === 'paid' ? '已支付' : p.status === 'pending' ? '支付确认中' : '未支付');

  const payQr = state.data.photographer?.payQr || {};
  const hasPayQr = payQr.wechat || payQr.alipay;
  const payArea = [];
  if (deposit.status === 'unpaid') {
    payArea.push(`<button id="payDeposit" class="btn btn-primary">${btnText}定金</button>`);
  } else if (deposit.status === 'pending') {
    payArea.push(pendingPayHtml(booking.id, 'deposit'));
  }
  if (deposit.status === 'paid' && balance.status === 'unpaid') {
    payArea.push(`<button id="payBalance" class="btn btn-cyan">${btnText}尾款</button>`);
  } else if (deposit.status === 'paid' && balance.status === 'pending') {
    payArea.push(pendingPayHtml(booking.id, 'balance'));
  }
  if (hasPayQr) {
    payArea.push('<button id="viewPayQr" class="btn btn-ghost">查看收款码</button>');
  }

  el.resultCard.innerHTML = `
    <div class="muted">预约提交成功，请保留预约编号</div>
    <div class="big">${booking.id}</div>
    <p class="muted">${formatDate(schedule.date)} ${slot.start} - ${slot.end}${product ? ` · ${esc(product.name)}` : ''}</p>
    <div class="pay-box">
      <div class="pay-row">
        <span>定金</span>
        <strong>¥${deposit.amount} · ${statusText(deposit)}${deposit.transactionId ? ` <span class="muted">(${deposit.transactionId})</span>` : ''}</strong>
      </div>
      <div class="pay-row">
        <span>尾款</span>
        <strong>¥${balance.amount} · ${statusText(balance)}${balance.transactionId ? ` <span class="muted">(${balance.transactionId})</span>` : ''}</strong>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;justify-content:center;flex-wrap:wrap">
      ${payArea.join('')}
    </div>
    <div class="muted" style="margin-top:12px;font-size:12px">${afdianEnabled ? '支付通过爱发电完成，付款后自动确认到账。' : '当前为模拟支付，正式版将接入爱发电。'}</div>
  `;

  document.getElementById('payDeposit')?.addEventListener('click', () => pay(booking.id, 'deposit'));
  document.getElementById('payBalance')?.addEventListener('click', () => pay(booking.id, 'balance'));
  document.getElementById('refreshDeposit')?.addEventListener('click', () => refreshPayStatus(booking.id, 'deposit'));
  document.getElementById('refreshBalance')?.addEventListener('click', () => refreshPayStatus(booking.id, 'balance'));
  document.getElementById('viewPayQr')?.addEventListener('click', () => showPayQr(payQr));
}

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

// pending 态：爱发电跳转面板 + 刷新按钮
function pendingPayHtml(bookingId, key) {
  const label = key === 'deposit' ? '定金' : '尾款';
  const payUrl = state.payUrls[key];
  // 只允许 http(s) 链接，防 javascript: 协议注入
  const safeUrl = /^https?:\/\//i.test(payUrl || '') ? payUrl : '';
  const linkHtml = safeUrl
    ? `<p style="margin:8px 0"><a href="${esc(safeUrl)}" target="_blank" rel="noopener" class="btn btn-primary">前往爱发电支付${label}</a></p>`
    : '';
  return `
    <div class="pay-pending" style="margin-top:10px;text-align:center">
      ${linkHtml}
      <div class="muted" style="font-size:13px;margin:8px 0">支付完成后系统将自动确认到账，也可点击下方按钮手动刷新。</div>
      <button id="refresh${key === 'deposit' ? 'Deposit' : 'Balance'}" class="btn">我已完成支付，刷新状态</button>
    </div>
  `;
}

async function pay(bookingId, type) {
  const label = type === 'deposit' ? '定金' : '尾款';
  const btn = document.querySelector(`#${type === 'deposit' ? 'payDeposit' : 'payBalance'}`);
  btn.disabled = true;
  btn.textContent = '处理中...';
  try {
    const updated = await api(`/api/bookings/${bookingId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ type })
    });
    if (updated.mode === 'afdian') {
      state.currentBooking = updated.booking;
      state.payUrls[type] = updated.afdian?.payUrl;
      renderResult(updated.booking);
      if (updated.afdian?.payUrl) {
        window.open(updated.afdian.payUrl, '_blank');
      }
      startStatusPolling(bookingId, type);
      return;
    }
    // 模拟支付：updated 已展开 booking 字段
    state.currentBooking = updated;
    renderResult(updated);
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = `${state.data.photographer?.afdianEnabled ? '去爱发电支付' : '模拟支付'}${label}`;
  }
}

// ---------- 支付状态轮询（5 秒一次，最长 2 分钟） ----------

let statusPollTimer = null;
let statusPollCount = 0;

function startStatusPolling(bookingId, payKey) {
  stopStatusPolling();
  statusPollCount = 0;
  statusPollTimer = setInterval(async () => {
    statusPollCount += 1;
    try {
      const booking = await api(`/api/bookings/${bookingId}`);
      if (booking.payment[payKey]?.status === 'paid') {
        stopStatusPolling();
        state.currentBooking = booking;
        renderResult(booking);
        return;
      }
    } catch (err) {
      // 网络抖动忽略，继续轮询
    }
    if (statusPollCount >= 24) {
      stopStatusPolling();
    }
  }, 5000);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

async function refreshPayStatus(bookingId, payKey) {
  try {
    const booking = await api(`/api/bookings/${bookingId}`);
    state.currentBooking = booking;
    if (booking.payment[payKey]?.status === 'paid') {
      stopStatusPolling();
      renderResult(booking);
      return;
    }
    alert('支付尚未确认到账，请确认已完成支付');
  } catch (err) {
    alert(err.message);
  }
}

async function submitBooking() {
  const schedule = getSchedule(state.scheduleId);
  if (!schedule) {
    el.formError.textContent = '请先选择日期';
    el.formError.classList.remove('hidden');
    return;
  }
  if (!state.productId) {
    el.formError.textContent = '请先选择商品';
    el.formError.classList.remove('hidden');
    return;
  }
  if (!state.slotId) {
    el.formError.textContent = '请先选择开始时间';
    el.formError.classList.remove('hidden');
    return;
  }
  const template = schedule.formTemplate;
  const answers = template ? await collectAnswers(template) : {};

  el.submitBtn.disabled = true;
  el.submitBtn.textContent = '提交中...';
  el.formError.classList.add('hidden');

  try {
    const booking = await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ scheduleId: state.scheduleId, productId: state.productId, slotId: state.slotId, formAnswers: answers })
    });
    state.currentBooking = booking;
    document.querySelector('.hero').classList.add('hidden');
    document.querySelectorAll('.section').forEach((section) => {
      if (section.id !== 'resultSection') section.classList.add('hidden');
    });
    el.resultSection.classList.remove('hidden');
    renderResult(booking);
  } catch (err) {
    el.formError.textContent = err.message;
    el.formError.classList.remove('hidden');
  } finally {
    el.submitBtn.disabled = false;
    el.submitBtn.textContent = '提交预约';
  }
}

el.submitBtn.addEventListener('click', submitBooking);
el.backBtn.addEventListener('click', () => {
  location.reload();
});
el.bookingForm.addEventListener('change', updateConditionalVisibility);
el.bookingForm.addEventListener('input', updateConditionalVisibility);

async function init() {
  try {
    const match = location.pathname.match(/^\/(?:p|b)\/([^/]+)/);
    const photographerId = match ? match[1] : 'P7K2QX';
    state.data = await api(`/api/public/${encodeURIComponent(photographerId)}`);
    if (!match) {
      el.siteNotice.textContent = '请在摄影师接单链接中打开本页面';
    }
    el.siteName.textContent = state.data.settings.siteName;
    if (state.data.photographer?.displayName) {
      el.siteName.textContent = `${state.data.photographer.displayName} 的接单问卷`;
    }
    el.siteNotice.textContent = state.data.settings.notice;
    const payNotice = document.getElementById('payNotice');
    if (payNotice) {
      payNotice.textContent = state.data.photographer?.afdianEnabled
        ? '提交前请确认信息无误。支付通过爱发电完成，付款后自动确认到账。'
        : '提交前请确认信息无误。当前为模拟支付，正式版将接入爱发电。';
    }
    renderProducts();
    if (state.data.schedules.length) {
      state.scheduleId = state.data.schedules[0].id;
      renderDates();
      renderSchedule(state.data.schedules[0]);
    } else {
      renderDates();
    }
  } catch (err) {
    el.siteNotice.textContent = err.message;
  }
}

function renderSchedule(schedule) {
  el.formSection.classList.add('hidden');
  state.slotId = null;
  renderProductSlots(schedule);
}

init();
