'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {createServer, MAX_UPLOAD} = require('../protected-preview/server');

async function listen(compile) {
  const server = createServer({compile});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, base: `http://127.0.0.1:${server.address().port}`};
}
const close = server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
const request = (url, headers) => new Promise((resolve, reject) => {
  const req = http.get(url, {headers}, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
  });
  req.on('error', reject);
});

test('upload produces HTML download and a separate-origin in-memory preview', async () => {
  const {server, base} = await listen(async (bytes, options) => {
    assert.equal(bytes.toString(), 'test-sb3');
    assert.equal(options.title, '中文作品');
    return {html: Buffer.from('<!doctype html><title>compiled</title>'), report: {sourceGraphIncluded: false}};
  });
  try {
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.ok, true); assert.equal(health.persistence, 'memory-only');
    const response = await fetch(base + '/api/compile?title=' + encodeURIComponent('中文作品'), {method: 'POST', headers: {Origin: base}, body: 'test-sb3'});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(JSON.parse(Buffer.from(response.headers.get('x-protection-report'), 'base64')).sourceGraphIncluded, false);
    const preview = new URL(response.headers.get('x-preview-url'));
    assert.equal(preview.hostname, 'localhost');
    const result = await request(base + preview.pathname, {Host: preview.host});
    assert.equal(result.status, 200);
    assert.equal(result.body, '<!doctype html><title>compiled</title>');
    assert.equal(result.headers['content-security-policy'], `frame-ancestors ${base}; base-uri 'none'; object-src 'none'`);
    assert.equal((await fetch(base + preview.pathname)).status, 403);
  } finally {await close(server);}
});

test('rejects foreign host/origin, invalid names, empty and over-limit uploads', async () => {
  let calls = 0;
  const {server, base} = await listen(async () => {calls++; throw new Error('must not compile');});
  try {
    assert.equal((await request(base + '/api/health', {Host: 'evil.example'})).status, 403);
    assert.equal((await fetch(base + '/api/compile', {method: 'POST', headers: {Origin: 'null'}, body: 'x'})).status, 403);
    assert.equal((await fetch(base + '/api/compile?title=' + 'a'.repeat(121), {method: 'POST', body: 'x'})).status, 400);
    assert.equal((await fetch(base + '/api/compile', {method: 'POST'})).status, 400);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(base + '/api/compile', {method: 'POST', headers: {'Content-Length': MAX_UPLOAD + 1}}, res => {res.resume(); resolve(res.statusCode);});
      req.on('error', reject); req.end();
    });
    assert.equal(status, 413); assert.equal(calls, 0);
  } finally {await close(server);}
});

test('serializes jobs, returns actionable build errors, and releases failed jobs', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const {server, base} = await listen(async () => {await gate; throw Object.assign(new Error('Unsupported extension: custom'), {status: 422, code: 'UNSUPPORTED_EXTENSION'});});
  try {
    const first = fetch(base + '/api/compile', {method: 'POST', body: 'x'});
    for (let i = 0; i < 50; i++) {if ((await (await fetch(base + '/api/health')).json()).busy) break; await new Promise(resolve => setTimeout(resolve, 5));}
    assert.equal((await fetch(base + '/api/compile', {method: 'POST', body: 'x'})).status, 429);
    release();
    const result = await first;
    assert.equal(result.status, 422); assert.equal((await result.json()).code, 'UNSUPPORTED_EXTENSION');
    assert.equal((await (await fetch(base + '/api/health')).json()).busy, false);
  } finally {release(); await close(server);}
});
