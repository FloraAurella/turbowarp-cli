'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {fork} = require('node:child_process');
const {randomBytes} = require('node:crypto');

const PUBLIC = path.join(__dirname, 'public');
const MAX_UPLOAD = 32 * 1024 * 1024;
const BUILD_TIMEOUT = 180000;
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

const replyJSON = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
};

function compileInWorker(bytes, options, signal) {
  return new Promise((resolve, reject) => {
    const env = {...process.env};
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = fork(path.join(__dirname, '../src/protected/build-worker.js'), [], {
      execArgv: ['--max-old-space-size=768'], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let settled = false;
    let errorOutput = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(Object.assign(new Error('编译已取消。'), {status: 499}));
    const timer = setTimeout(() => finish(Object.assign(new Error('编译超过 3 分钟，请缩小项目后重试。'), {status: 504})), BUILD_TIMEOUT);
    child.stderr.on('data', data => {if (errorOutput.length < 2048) errorOutput += data.toString();});
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (!settled) finish(new Error(`编译进程退出（${code ?? 'signal'}）。${errorOutput.slice(-500)}`));
    });
    child.once('message', message => {
      if (!message || typeof message.ok !== 'boolean') return finish(new Error('编译进程返回无效结果。'));
      if (!message.ok) return finish(Object.assign(new Error(message.error || '项目编译失败。'), {status: 422, code: message.code, details: message.details}));
      if (typeof message.html !== 'string' || message.html.length > 200 * 1024 * 1024) return finish(new Error('编译产物超出限制。'));
      finish(null, {html: Buffer.from(message.html, 'base64'), report: message.report});
    });
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) return abort();
    child.send({bytes: bytes.toString('base64'), options}, error => {if (error) finish(error);});
  });
}

async function readBody(req) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_UPLOAD)) {
    req.resume();
    throw Object.assign(new Error('SB3 文件不能超过 32 MiB。'), {status: 413});
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD) {
      req.resume();
      throw Object.assign(new Error('SB3 文件不能超过 32 MiB。'), {status: 413});
    }
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error('请选择一个 SB3 文件。'), {status: 400});
  return Buffer.concat(chunks, size);
}

function createServer({compile = compileInWorker} = {}) {
  let busy = false;
  const previews = new Map();
  const retainPreview = (html, origin) => {
    const token = randomBytes(24).toString('hex');
    let total = html.length;
    for (const entry of previews.values()) total += entry.html.length;
    while (previews.size && (previews.size >= 4 || total > 256 * 1024 * 1024)) {
      const [oldToken, entry] = previews.entries().next().value;
      clearTimeout(entry.timer); previews.delete(oldToken); total -= entry.html.length;
    }
    const timer = setTimeout(() => previews.delete(token), 30 * 60 * 1000);
    timer.unref();
    previews.set(token, {html, origin, timer});
    return token;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    const hosts = new Set([expectedHost, `localhost:${server.address()?.port}`]);
    if (!hosts.has(req.headers.host)) {req.resume(); return replyJSON(res, 403, {error: '只接受本机地址访问。'});}
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      req.resume(); return replyJSON(res, 403, {error: '请从本机预览页面提交文件。'});
    }
    try {
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.method === 'GET' && /^\/preview\/[a-f\d]{48}$/.test(url.pathname)) {
        const entry = previews.get(url.pathname.slice('/preview/'.length));
        if (!entry) return replyJSON(res, 410, {error: '预览已过期，请重新编译。下载的 HTML 可继续离线使用。'});
        if (`http://${req.headers.host}` === entry.origin) return replyJSON(res, 403, {error: '请使用编译结果提供的独立预览地址。'});
        res.setHeader('Content-Security-Policy', `frame-ancestors ${entry.origin}; base-uri 'none'; object-src 'none'`);
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        return res.end(entry.html);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return replyJSON(res, 200, {
        ok: true, service: 'scratch-protected-preview', version: 1, busy, maxUploadBytes: MAX_UPLOAD,
        sourceDelivery: 'ahead-of-time; no project block graph', persistence: 'memory-only'
      });
      if (req.method === 'GET' && url.pathname === '/api/example') {
        const bytes = await require('../src/protected/demo').createDemo();
        res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="orbit-demo.sb3"'});
        return res.end(bytes);
      }
      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        const [name, mime] = STATIC.get(url.pathname);
        const data = await fs.readFile(path.join(PUBLIC, name));
        res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src http://localhost:${server.address().port} http://${expectedHost}; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
        res.writeHead(200, {'Content-Type': mime});
        return res.end(data);
      }
      if (req.method === 'POST' && url.pathname === '/api/compile') {
        if (busy) {req.resume(); return replyJSON(res, 429, {error: '另一个项目正在编译，请稍后重试。'});}
        const title = (url.searchParams.get('title') || '我的 Scratch 作品').trim();
        if (!title || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) {req.resume(); return replyJSON(res, 400, {error: '作品名称需为 1–120 个字符。'});}
        busy = true;
        const controller = new AbortController();
        const onClose = () => {if (!res.writableEnded) controller.abort();};
        res.once('close', onClose);
        try {
          const bytes = await readBody(req);
          const result = await compile(bytes, {title}, controller.signal);
          if (res.destroyed) return;
          const name = `${title.replace(/[\\/<>:"|?*]/g, '_')}.html`;
          const report = {...result.report, htmlBytes: result.html.length};
          const origin = `http://${req.headers.host}`;
          const token = retainPreview(result.html, origin);
          const previewHost = req.headers.host.startsWith('localhost:') ? expectedHost : `localhost:${server.address().port}`;
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `attachment; filename="scratch-protected.html"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'X-Protection-Report': Buffer.from(JSON.stringify(report)).toString('base64'),
            'X-Preview-URL': `http://${previewHost}/preview/${token}`
          });
          res.end(result.html);
        } finally {
          busy = false;
          res.removeListener('close', onClose);
        }
        return;
      }
      req.resume();
      replyJSON(res, 404, {error: '页面不存在。'});
    } catch (error) {
      replyJSON(res, error.status || 500, {error: error.message || '编译失败。', code: error.code, details: error.details});
    }
  });
  server.requestTimeout = 210000;
  server.headersTimeout = 10000;
  server.once('close', () => {for (const entry of previews.values()) clearTimeout(entry.timer); previews.clear();});
  return server;
}

if (require.main === module) {
  const port = Number(process.env.SCRATCH_PREVIEW_PORT || 5196);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SCRATCH_PREVIEW_PORT 必须为 1024–65535。');
  const server = createServer();
  server.on('error', error => {console.error(error.message); process.exitCode = 1;});
  server.listen(port, '127.0.0.1', () => console.log(`Scratch 受保护构建页面：http://127.0.0.1:${port}`));
}

module.exports = {createServer, compileInWorker, MAX_UPLOAD};
