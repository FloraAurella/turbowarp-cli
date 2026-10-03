'use strict';
const net = require('node:net');
const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const {safeURL} = require('./permission-policy');

// Capture only for the narrow audited HTTP downloader below. Never restore
// process-wide networking, even briefly, and never pass this to extension JS.
const originalConnect = net.Socket.prototype.connect;
const deny = () => {throw new Error('Network access denied by pure CLI default policy');};
let installed = false;
const install = () => {
  if (installed) return;
  installed = true;
  net.Socket.prototype.connect = deny;
  dgram.createSocket = deny;
  global.fetch = async () => {throw new Error('Network access denied by pure CLI default policy');};
};
const requestOnce = (url, maxBytes, timeoutMs) => new Promise((resolve, reject) => {
  const encrypted = url.protocol === 'https:';
  const transport = encrypted ? https : http;
  const agent = new transport.Agent({keepAlive: false, maxSockets: 1});
  agent.createConnection = options => {
    const socket = new net.Socket();
    originalConnect.call(socket, {host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (encrypted ? 443 : 80))});
    return encrypted ? tls.connect({socket, servername: net.isIP(options.host) ? undefined : options.host,
      rejectUnauthorized: true}) : socket;
  };
  let response, settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (response) response.destroy(); request.destroy(); agent.destroy();
    if (error) reject(error); else resolve(value);
  };
  const request = transport.get(url, {agent, headers: {'user-agent': 'tw-cli/packager-3.13.0', 'accept-encoding': 'identity'}}, result => {
    response = result;
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      return finish(null, {redirect: result.headers.location});
    }
    if (result.statusCode !== 200) return finish(new Error(`HTTP ${result.statusCode}：${url.origin}${url.pathname}`));
    const size = Number(result.headers['content-length']);
    if (Number.isFinite(size) && size > maxBytes) return finish(new Error('下载 Content-Length 超出限制'));
    let total = 0;
    const chunks = [];
    result.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) return finish(new Error('下载字节超出限制'));
      chunks.push(chunk);
    });
    result.once('error', error => finish(error));
    result.once('aborted', () => finish(new Error('下载中断')));
    result.once('end', () => finish(null, {bytes: Buffer.concat(chunks, total)}));
  });
  const timer = setTimeout(() => finish(new Error('下载超时')), timeoutMs);
  request.once('error', error => finish(error));
});
const fetchBytes = async (value, policy, {maxBytes = 256 * 1024 * 1024, timeoutMs = 120000, httpsOnly = true} = {}) => {
  if (!policy || typeof policy.require !== 'function') throw new Error('Network access denied: missing explicit command permission policy');
  const deadline = Date.now() + timeoutMs;
  let current = value;
  for (let count = 0; count <= 5; count++) {
    let url;
    try {url = safeURL(current, httpsOnly ? ['https:'] : ['https:', 'http:']);}
    catch (error) {return policy.deny('net', current, error.message, error.code);}
    policy.require('net', url.hostname);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('下载超时');
    const result = await requestOnce(url, maxBytes, remaining);
    if (result.bytes) return result.bytes;
    if (!result.redirect) throw new Error('重定向缺少 Location');
    const next = new URL(result.redirect, url);
    if (url.protocol === 'https:' && next.protocol !== 'https:') return policy.deny('net', next.hostname, '拒绝 HTTPS 降级重定向');
    // Each redirect is validated and authorized before opening another socket.
    current = next.href;
  }
  throw new Error('下载重定向超过 5 次');
};
module.exports = {install, fetchBytes};
