'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawnSync, spawn} = require('node:child_process');
const {once} = require('node:events');
const JSZip = require('@turbowarp/jszip');
const extension = require('../src/extension-commands');
const policy = require('../src/permission-policy');
const network = require('../src/network-policy');
const pack = require('../src/package-commands');
const root = path.resolve(__dirname, '..');
const temp = async t => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tw-ext-policy-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true})); return directory;
};
const ext = (session, action, args = [], options = {}) => extension.execute(session, 'ext', [action, ...args], options);
const permit = (session, action, args = [], options = {}) => extension.execute(session, 'permission', [action, ...args], options);

test('unified frozen permission enumeration includes all D5 categories and records unsupported/default-deny reasons', async () => {
  const s = {};
  const list = await permit(s, 'list'); assert.equal(list.default, 'deny'); assert.ok(Object.isFrozen(list.capabilities));
  for (const id of ['read', 'write', 'net', 'extension-code', 'extension-execute', 'custom-js', 'custom-css', 'cloud-network', 'unsafe-cloud',
    'clipboard-read', 'clipboard-write', 'notifications', 'location', 'audio-input', 'video-input', 'open-window', 'redirect', 'embed', 'bluetooth', 'usb', 'serial']) assert.ok(list.capabilities.some(item => item.id === id));
  for (const item of list.capabilities) {
    const resource = item.scope === 'path' ? '/explicit.txt' : item.scope === 'host' ? 'example.org' : item.scope === 'id' ? 'pen' : item.scope === 'url' ? 'https://example.org/' : null;
    const token = item.id + (resource ? ':' + resource : '');
    const denied = await permit(s, 'check', [token]); assert.equal(denied.allowed, false); assert.ok(denied.reason);
    const decision = await permit(s, 'check', [token], {allow: token}); assert.equal(decision.allowed, item.supported); assert.ok(decision.reason);
    if (!item.supported) assert.match(decision.reason, /未实现|fail-closed/);
  }
  assert.equal((await permit(s, 'inspect')).vmIsSecuritySandbox, false);
  assert.equal((await permit(s, 'inspect')).grantLifetime, 'single-command');
  assert.ok((await permit(s, 'log')).decisions.every(item => typeof item.reason === 'string' && item.reason));
});

test('exact grants reject wildcard/prototype/ambiguous paths, credentials, URLs and implicit fs authorizations', async t => {
  const directory = await temp(t), s = {};
  for (const value of ['*', 'net:*', 'net:*.org', 'net:https://example.org', 'net:example.org:443', 'net:127.1', 'net:example.org.',
    'net:example.org/path', 'net:user@example.org', 'fs:/tmp', 'extension:evil', 'read:../escape', 'read:/a/../b',
    'read:file:///tmp/a', 'write:%2e%2e/a', 'read:C:\\a', 'custom-js:yes', 'net:example.org,net:example.org', '["net:example.org",false]']) {
    assert.throws(() => policy.createPolicy(s, {allow: value}), /权限|net|path|token|需要|JSON|拒绝|范围|数组/);
  }
  assert.ok(s.permissionDecisions.every(item => !item.allowed));
  assert.throws(() => policy.safeURL('https://user:pass@example.org/a'), /拒绝/);
  assert.throws(() => policy.safeURL('https://example.org/a/../b'), /拒绝/);
  assert.throws(() => policy.safeURL('https://example.org/%2e%2e/a'), /拒绝/);
  const file = path.join(directory, 'input.txt'); await fs.writeFile(file, 'explicit');
  const p = policy.createPolicy(s, {}, 'input');
  await assert.rejects(policy.readFile(p, file), /缺少 --allow read:/);
  assert.equal((await policy.readFile(p, file, {explicit: true})).toString(), 'explicit');
  await assert.rejects(policy.writeFile(p, path.join(directory, 'out.txt'), Buffer.from('x')), /缺少 --allow write:/);
  await policy.writeFile(p, path.join(directory, 'out.txt'), Buffer.from('x'), {explicit: true});
  const other = path.join(directory, 'other.txt'); await fs.writeFile(other, 'other');
  const exact = policy.createPolicy(s, {allow: `read:${file}`});
  assert.equal((await policy.readFile(exact, file)).toString(), 'explicit'); await assert.rejects(policy.readFile(exact, other), /拒绝/);
  await assert.rejects(policy.readFile(policy.createPolicy(s), file), /拒绝/, 'no subsequent-command permission leakage');
  const link = path.join(directory, 'link'); await fs.symlink(file, link);
  await assert.rejects(policy.readFile(policy.createPolicy(s, {allow: `read:${link}`}), link), /符号链接/);
  await assert.rejects(policy.writeFile(p, link, Buffer.from('bad'), {explicit: true, force: true}), /符号链接/);
  assert.equal((await fs.readFile(file)).toString(), 'explicit');
});

test('freeze gallery/offline metadata, enumerate every builtin and render docs only as safe plain text', async t => {
  const directory = await temp(t), s = {};
  t.mock.method(network, 'fetchBytes', async () => {throw new Error('catalog must be offline');});
  const builtins = await ext(s, 'list', ['builtin']);
  assert.deepEqual(builtins.extensions.map(item => item.id).sort(), ['pen', 'music', 'videoSensing', 'Gamepad', 'faceSensing', 'text2speech', 'translate', 'makeymakey', 'microbit', 'ev3', 'boost', 'wedo2', 'gdxfor', 'tw'].sort());
  assert.deepEqual(builtins.extensions.filter(item => item.supported).map(item => item.id).sort(), ['Gamepad', 'music', 'pen', 'videoSensing']);
  assert.equal(builtins.extensions.find(item => item.id === 'faceSensing').vmBuiltin, false);
  assert.equal(builtins.extensions.find(item => item.id === 'Gamepad').source, 'cli-data-adapter');
  const gallery = await ext(s, 'list', ['gallery']), offline = await ext(s, 'list', ['offline']);
  assert.equal(gallery.network, false); assert.equal(gallery.frozen, true); assert.equal(gallery.extensions.length, 103); assert.deepEqual(gallery, offline);
  const info = await ext(s, 'inspect', ['box2d']); assert.equal(info.supported, false); assert.match(info.compressedSHA256, /^[0-9a-f]{64}$/);
  const file = path.join(directory, 'box2d.txt'), doc = await ext(s, 'doc', ['box2d', file]);
  const text = await fs.readFile(file, 'utf8'); assert.equal(doc.format, 'text/plain'); assert.match(text, /Box2D/); assert.doesNotMatch(text, /<script|<iframe/i);
  assert.equal(doc.sha256, policy.sha256(Buffer.from(text)));
  const malicious = extension.plainHTML('<h1>标题</h1><script>process.exit()</script><p onclick="evil()">文本 &amp; 字节\u001b[31m</p><iframe src="http://evil"></iframe>');
  assert.match(malicious, /标题/); assert.match(malicious, /文本 & 字节/); assert.doesNotMatch(malicious, /process.exit|iframe|onclick|\u001b/);
  for (const value of ['../box2d', '%2e%2e/box2d', 'C:\\box2d', 'box2d\u001b']) await assert.rejects(ext(s, 'doc', [value]), /拒绝/);
  await assert.rejects(ext(s, 'doc', ['box2d', file], {output: file}), /不能同时/);
});

test('custom file/text/URL JS execution stays explicitly unsupported even with every relevant grant', async t => {
  const directory = await temp(t), marker = path.join(directory, 'escaped.txt'), file = path.join(directory, 'evil.js');
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped');require('node:net').connect(80,'example.org');process.exit(7);({}).constructor.constructor('return process')();`;
  await fs.writeFile(file, code);
  const s = {};
  const allow = `extension-code,extension-execute,custom-js,read:${file},write:${marker},net:example.org`;
  for (const [action, arg] of [['load-file', file], ['load-text', code], ['load-url', 'https://example.org/evil.js']]) {
    await assert.rejects(ext(s, action, [arg], {allow}), error => {
      assert.equal(error.code, 'ERR_CAPABILITY_UNSUPPORTED'); assert.match(error.message, /独立受限子进程/); return true;
    });
    assert.equal(s.permissionDecisions.at(-1).allowed, false); assert.equal(s.permissionDecisions.at(-1).capability, 'extension-execute');
  }
  await assert.rejects(fs.stat(marker), {code: 'ENOENT'});
  assert.equal((await fs.readFile(file, 'utf8')), code);
  for (const item of extension.BUILTINS.filter(item => !item.supported)) {
    await assert.rejects(ext(s, 'load', [item.id], {allow: 'extension-code,net:example.org'}), /权限拒绝/);
    assert.equal(s.permissionDecisions.at(-1).allowed, false);
  }
  assert.equal((await permit(s, 'inspect')).customExtensionSandbox, 'unsupported-fail-closed');
});

test('pen/music load real native builtin opcodes and serialize no-block load through undo/redo/save/open', async t => {
  const directory = await temp(t), {CommandSession} = require('../src/commands');
  const s = new CommandSession(); t.after(() => s.dispose());
  await s.execute(['new']);
  for (const id of ['pen', 'music']) {
    const result = await s.execute(['ext', 'load', id]); assert.equal(result.loaded, true); assert.equal(result.id, id);
    assert.equal(s.project.vm.extensionManager.isExtensionLoaded(id), true);
  }
  assert.equal(typeof s.project.vm.runtime.getOpcodeFunction('pen_penDown'), 'function');
  assert.equal(typeof s.project.vm.runtime.getOpcodeFunction('music_setTempo'), 'function');
  await assert.rejects(s.execute(['ext', 'load', 'pen', '--out', directory + '/x/../escape.sb3']), /path|拒绝/);
  const before = await s.snapshot();
  await s.execute(['undo']); assert.equal(s.project.vm.extensionManager.isExtensionLoaded('music'), false); assert.equal(s.project.vm.extensionManager.isExtensionLoaded('pen'), true);
  await s.execute(['redo']); assert.equal(s.project.vm.extensionManager.isExtensionLoaded('music'), true);
  const bytes = await s.snapshot(), zip = await JSZip.loadAsync(bytes), metadata = JSON.parse(await zip.file('tw-cli-state.json').async('string'));
  assert.ok(metadata.extra.loadedExtensions.includes('music')); assert.ok(metadata.extra.loadedExtensions.includes('pen'));
  const file = path.join(directory, 'loaded.sb3'); await s.execute(['save', file]); await s.execute(['open', file]);
  assert.deepEqual((await s.execute(['ext', 'list', 'loaded'])).extensions.sort(), ['music', 'pen']);
  assert.equal((await s.execute(['ext', 'load', 'pen'])).alreadyLoaded, true);
  await s.execute(['block', 'add', 'music_setTempo', '--inputs', '{"TEMPO":90}']);
  const output = path.join(directory, 'loaded.html'); await pack.execute(s, 'pack', ['build', output]);
  assert.match(await fs.readFile(output, 'utf8'), /_instrumentPlayer/);
  assert.equal(before.subarray(0, 2).toString(), 'PK');
});

test('safe videoSensing/Gamepad factories really load/reload, persist history, and missing package conversion fails closed', async t => {
  const directory = await temp(t), {CommandSession} = require('../src/commands');
  const s = new CommandSession(); t.after(() => s.dispose()); await s.execute(['new']);
  for (const id of ['videoSensing', 'Gamepad']) assert.equal((await s.execute(['ext', 'load', id])).loaded, true);
  assert.equal(typeof s.project.vm.runtime.getOpcodeFunction('videoSensing_videoOn'), 'function');
  assert.equal(typeof s.project.vm.runtime.getOpcodeFunction('Gamepad_axisValue'), 'function');
  await s.execute(['undo']); assert.equal(s.project.vm.extensionManager.isExtensionLoaded('Gamepad'), false);
  await s.execute(['redo']); assert.equal(s.project.vm.extensionManager.isExtensionLoaded('Gamepad'), true);
  const file = path.join(directory, 'data-extensions.sb3'); await s.execute(['save', file]); await s.execute(['open', file]);
  assert.deepEqual((await s.execute(['ext', 'list', 'loaded'])).extensions.sort(), ['Gamepad', 'videoSensing']);
  assert.equal((await ext(s, 'inspect', ['videoSensing'])).source, 'cli-data-adapter');
  assert.equal((await ext(s, 'inspect', ['faceSensing'])).supported, false);
  for (const id of ['videoSensing', 'Gamepad']) {
    const source = await require('../src/project').blankProject(), zip = await JSZip.loadAsync(source);
    const json = JSON.parse(await zip.file('project.json').async('string')); json.extensions = [id]; zip.file('project.json', JSON.stringify(json));
    const bytes = await zip.generateAsync({type: 'nodebuffer'}), fake = {project: {vm: {}}, snapshot: async () => bytes};
    await assert.rejects(pack.execute(fake, 'pack', ['build', path.join(directory, id + '.html')]), error => {
      assert.equal(error.code, 'ERR_CAPABILITY_UNSUPPORTED'); assert.match(error.message, /missing-data-provider-conversion/); return true;
    });
  }
});

test('controlled host request is isolated; default TCP/UDP/fetch deny remains during and after download', async t => {
  const observed = [];
  const server = http.createServer((request, response) => {
    observed.push(request.url);
    if (request.url === '/redirect') {response.writeHead(302, {location: `http://localhost:${server.address().port}/secret`}); response.end();}
    else if (request.url === '/huge') {response.writeHead(200, {'content-length': 2000000}); response.end('x');}
    else response.end('allowed-bytes');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const s = {}, denied = policy.createPolicy(s);
  await assert.rejects(network.fetchBytes(url + '/denied', denied, {httpsOnly: false}), /net/); assert.deepEqual(observed, []);
  const approved = policy.createPolicy(s, {allow: 'net:127.0.0.1'});
  assert.equal((await network.fetchBytes(url + '/good', approved, {httpsOnly: false})).toString(), 'allowed-bytes');
  await assert.rejects(network.fetchBytes(url + '/redirect', approved, {httpsOnly: false}), /localhost/);
  assert.ok(!observed.includes('/secret'));
  await assert.rejects(network.fetchBytes(url + '/huge', approved, {httpsOnly: false, maxBytes: 100}), /超出限制/);
  await assert.rejects(network.fetchBytes(url + '/insecure', approved), /协议/);
  await assert.rejects(network.fetchBytes(url + '/no-policy'), /missing explicit/);
  const code = `const a=require('node:assert/strict');const n=require(${JSON.stringify(path.join(root, 'src/network-policy'))});const p=require(${JSON.stringify(path.join(root, 'src/permission-policy'))});n.install();
    a.throws(()=>require('node:net').connect(80,'127.0.0.1'),/denied/);a.throws(()=>require('node:dgram').createSocket('udp4'),/denied/);
    const go=async()=>{const result=await n.fetchBytes(${JSON.stringify(url + '/child')},p.createPolicy({}, {allow:'net:127.0.0.1'}),{httpsOnly:false});
      a.equal(result.toString(),'allowed-bytes');await a.rejects(fetch('https://example.org'),/denied/);a.throws(()=>require('node:net').connect(80,'127.0.0.1'),/denied/);process.stdout.write('isolated');};go().catch(e=>{console.error(e);process.exitCode=1;});`;
  const child = spawn(process.execPath, ['-e', code], {stdio: ['ignore', 'pipe', 'pipe']}); let stdout = '', stderr = '';
  child.stdout.on('data', bytes => {stdout += bytes;}); child.stderr.on('data', bytes => {stderr += bytes;});
  const [exit] = await once(child, 'close'); assert.equal(exit, 0, stderr); assert.equal(stdout, 'isolated');
  assert.ok(s.permissionDecisions.some(item => item.capability === 'net' && item.resource === 'localhost' && !item.allowed));
});

test('permission log is bounded with explicit truncation count, not silent unlimited growth', async () => {
  const s = {}, p = policy.createPolicy(s);
  for (let i = 0; i < 1010; i++) p.decide('custom-js');
  const result = await permit(s, 'log'); assert.equal(result.decisions.length, 1000); assert.equal(result.dropped, 10); assert.ok(result.decisions.every(item => !item.allowed));
});

test('Node24 CLI exposes frozen extension list and fail-closed custom loader', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/tw.js'), 'session', '--jsonl'], {encoding: 'utf8', timeout: 15000,
    input: [{command: 'permission', args: ['list']}, {command: 'ext', args: ['list', 'offline']},
      {command: 'ext', args: ['load-file', '/nonexistent/evil.js', '--allow', 'extension-code']}, {command: 'permission', args: ['log']}, {command: 'quit'}].map(value => JSON.stringify(value)).join('\n') + '\n'});
  assert.equal(result.status, 0, result.stderr); const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].ok, true); assert.equal(replies[1].result.extensions.length, 103); assert.equal(replies[2].ok, false);
  assert.match(replies[2].error, /未支持自定义扩展执行/); assert.equal(replies[3].result.decisions.at(-1).allowed, false);
});
