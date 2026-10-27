// 邮件发送模块（零依赖，手写 SMTP 客户端，仅用内置 net/tls/fs/path/os）
// 支持：465 隐式 TLS、587 STARTTLS、AUTH LOGIN、中文标题/正文（base64 编码）
// 未配置 SMTP 或 MAIL_MOCK=1 时：不建连接，降级为日志输出（验证码由调用方打印）

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const TIMEOUT_MS = 15000;

let config = null; // { smtp: { host, port, secure, user, pass, from }, mock }

async function load() {
  try {
    config = JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    config = null;
  }
  if (isDevMode()) {
    console.log('[mail] 未配置 SMTP 或处于开发模式：验证码将输出到服务端日志，不真实发信。');
  } else {
    console.log(`[mail] SMTP 已配置：${config.smtp.host}:${config.smtp.port}`);
  }
}

function isConfigured() {
  return !!(config && config.smtp && config.smtp.host && config.smtp.user && config.smtp.pass);
}

// 开发模式：MAIL_MOCK=1 强制、config.mock 置 true、或未配置 SMTP
function isDevMode() {
  return process.env.MAIL_MOCK === '1' || !!config?.mock || !isConfigured();
}

// ---------- SMTP 会话 ----------

function connectSocket(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect(port, host);
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy(new Error('SMTP 连接超时'));
    });
  });
}

// 应答读取器：按 \r\n 切行，多行应答以 "code-" 续行、以 "code " 结束
function createReader(socket) {
  let buffer = '';
  let nextResolve = null;
  const waiters = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\r\n')) {
      const line = buffer.slice(0, buffer.indexOf('\r\n'));
      buffer = buffer.slice(buffer.indexOf('\r\n') + 2);
      const code = line.slice(0, 3);
      if (/^\d{3}$/.test(code) && !line.startsWith(`${code}-`)) {
        if (nextResolve) {
          const resolve = nextResolve;
          nextResolve = null;
          resolve({ code: Number(code), lines: line });
        }
      }
    }
  });

  return {
    // 等待一个完整应答
    wait() {
      return new Promise((resolve) => {
        nextResolve = resolve;
      });
    }
  };
}

function writeLine(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()));
  });
}

// 发送一行并期待允许的应答码
async function expect(socket, reader, step, line, allowedCodes) {
  await writeLine(socket, line);
  const res = await reader.wait();
  if (!allowedCodes.includes(res.code)) {
    throw new Error(`SMTP ${step} 失败：${res.code} ${res.lines}`);
  }
  return res;
}

async function sendMail({ to, subject, text }) {
  if (isDevMode()) {
    return { delivered: false };
  }
  const { host, port, secure, user, pass, from } = config.smtp;
  const smtpPort = port || (secure ? 465 : 587);

  let socket = await connectSocket(host, smtpPort, !!secure);
  try {
    let reader = createReader(socket);

    // 1. 问候
    const greeting = await reader.wait();
    if (![220].includes(greeting.code)) {
      throw new Error(`SMTP 问候失败：${greeting.code} ${greeting.lines}`);
    }

    // 2. EHLO（失败退 HELO）
    const ehloName = os.hostname() || 'localhost';
    await writeLine(socket, `EHLO ${ehloName}`);
    let ehlo = await reader.wait();
    if (![250].includes(ehlo.code)) {
      await expect(socket, reader, 'HELO', `HELO ${ehloName}`, [250]);
    }

    // 3. STARTTLS 升级（非隐式 TLS 时）
    if (!secure) {
      await writeLine(socket, 'STARTTLS');
      const starttls = await reader.wait();
      if (starttls.code === 220) {
        socket = tls.connect({ socket, servername: host });
        socket.setTimeout(TIMEOUT_MS);
        reader = createReader(socket);
        await writeLine(socket, `EHLO ${ehloName}`);
        const ehlo2 = await reader.wait();
        if (![250].includes(ehlo2.code)) {
          throw new Error(`SMTP STARTTLS 后 EHLO 失败：${ehlo2.code} ${ehlo2.lines}`);
        }
      } else if (starttls.code !== 250) {
        // 服务器不支持 STARTTLS 则继续（部分服务器 EHLO 已列出）
        throw new Error(`SMTP STARTTLS 失败：${starttls.code} ${starttls.lines}`);
      }
    }

    // 4. AUTH LOGIN
    await expect(socket, reader, 'AUTH', 'AUTH LOGIN', [334]);
    await expect(socket, reader, '用户名', Buffer.from(user, 'utf8').toString('base64'), [334]);
    await expect(socket, reader, '密码', Buffer.from(pass, 'utf8').toString('base64'), [235]);

    // 5. 发件人 / 收件人
    await expect(socket, reader, 'MAIL FROM', `MAIL FROM:<${from}>`, [250]);
    await expect(socket, reader, 'RCPT TO', `RCPT TO:<${to}>`, [250, 251]);

    // 6. DATA 邮件体
    await expect(socket, reader, 'DATA', 'DATA', [354]);
    const body = buildMessage({ from, to, subject, text });
    await writeLine(socket, body.replace(/\r?\n/g, '\r\n'));
    await expect(socket, reader, '邮件发送', '.', [250]);

    return { delivered: true };
  } finally {
    try {
      socket.end('QUIT\r\n');
    } catch (err) {
      /* 忽略 */
    }
    socket.destroy();
  }
}

// 中文邮件编码：标题 UTF-8 base64，正文 base64 每 76 字符换行
function buildMessage({ from, to, subject, text }) {
  const subjectEnc = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const bodyBase64 = Buffer.from(text, 'utf8').toString('base64');
  const bodyLines = bodyBase64.match(/.{1,76}/g).join('\r\n');
  const date = new Date().toUTCString();
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subjectEnc}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyLines,
    ''
  ].join('\r\n');
}

// ---------- 验证码邮件 ----------

async function sendVerifyCodeMail({ to, code, minutes = 5, siteName = '摄影约单' }) {
  const subject = '约单注册验证码';
  const text = [
    `您好，欢迎注册${siteName}！`,
    '',
    `您的注册验证码是：${code}`,
    `验证码 ${minutes} 分钟内有效，请勿泄露给他人。`,
    '',
    '如非本人操作，请忽略本邮件。',
    `（${new Date().toLocaleString('zh-CN')}）`
  ].join('\n');
  return sendMail({ to, subject, text });
}

module.exports = {
  load,
  isConfigured,
  isDevMode,
  sendMail,
  sendVerifyCodeMail
};
