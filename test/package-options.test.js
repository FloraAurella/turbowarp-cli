'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {Script} = require('node:vm');
const {createCanvas} = require('@napi-rs/canvas');
const {parseDOM} = require('htmlparser2');
const {spawnSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const Packager = require('@turbowarp/packager');
const pack = require('../src/package-commands');
const policy = require('../src/permission-policy');
const network = require('../src/network-policy');
const {blankProject} = require('../src/project');
const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temp = async t => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tw-pack-options-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true})); return directory;
};
const sourceProject = async () => {
  const zip = await JSZip.loadAsync(await blankProject());
  const json = JSON.parse(await zip.file('project.json').async('string'));
  const canvas = createCanvas(3, 2), ctx = canvas.getContext('2d'); ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 3, 2);
  const png = canvas.toBuffer('image/png'), pngID = createHash('md5').update(png).digest('hex');
  zip.file(pngID + '.png', png);
  json.targets[1].costumes.push({assetId: pngID, md5ext: pngID + '.png', dataFormat: 'png', name: 'bitmap', bitmapResolution: 1, rotationCenterX: 1, rotationCenterY: 1});
  const wav = require('../src/commands').wav({length: 4, numberOfChannels: 1, sampleRate: 44100,
    getChannelData: () => new Float32Array([0.3, -0.25, 0.1, 0])});
  const soundID = createHash('md5').update(wav).digest('hex'); zip.file(soundID + '.wav', wav);
  json.targets[1].sounds.push({assetId: soundID, md5ext: soundID + '.wav', dataFormat: 'wav', name: 'sound', rate: 44100, sampleCount: 4});
  json.targets[0].variables.score = ['score', 17];
  json.targets[0].variables.cloud = ['☁ cloud', 42, true];
  json.targets[1].lists.items = ['items', ['one', 2]];
  json.targets[1].blocks = {hat: {opcode: 'event_whenflagclicked', next: 'move', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true},
    move: {opcode: 'motion_movesteps', next: null, parent: 'hat', inputs: {STEPS: [1, [4, '25']]}, fields: {}, shadow: false, topLevel: false}};
  zip.file('project.json', JSON.stringify(json));
  return {bytes: await zip.generateAsync({type: 'nodebuffer'}), json};
};
const sessionFor = bytes => ({project: {vm: {}}, snapshot: async () => bytes});
const run = (session, action, args = [], options = {}) => pack.execute(session, 'pack', [action, ...args], options);
const getAt = (value, name) => name.split('.').reduce((object, key) => object[key], value);
const scripts = html => {
  let count = 0; const pending = parseDOM(html);
  while (pending.length) {
    const node = pending.pop(); pending.push(...(node.children || []));
    if (node.name !== 'script' || node.attribs.src || node.attribs.type && !/javascript|module/.test(node.attribs.type)) continue;
    const code = (node.children || []).map(child => child.data || '').join('');
    new Script(code); count++;
  }
  assert.ok(count > 1, 'inline scripts parse without executing untrusted packaged code');
};
const embedded = html => {
  const chunks = [...html.matchAll(/<script data="([^"]*)">decodeChunk\((\d+)\)<\/script>/g)];
  assert.ok(chunks.length, 'HTML includes actual SB3 payload');
  return Buffer.concat(chunks.map(([, data, length]) => {
    assert.equal(data.length % 5, 0); const bytes = Buffer.alloc(data.length / 5 * 4);
    for (let i = 0; i < data.length; i += 5) {
      let word = 0;
      for (let n = 4; n >= 0; n--) {
        let code = data.charCodeAt(i + n); if (code === 40) code = 60; if (code === 41) code = 62;
        assert.ok(code >= 42 && code <= 126); word = word * 85 + code - 42;
      }
      bytes.writeUInt32LE(word >>> 0, i / 5 * 4);
    }
    return bytes.subarray(0, Number(length));
  }));
};
const assetsEqual = async (archive, prefix, source) => {
  const expected = await JSZip.loadAsync(source), json = JSON.parse(await archive.file(prefix + 'project.json').async('string'));
  assert.equal(json.targets[0].variables.score[1], 17);
  assert.deepEqual(json.targets[0].variables.cloud, ['☁ cloud', 42, true]);
  assert.deepEqual(json.targets[1].lists.items[1], ['one', 2]);
  const blocks = Object.values(json.targets[1].blocks);
  assert.equal(blocks.length, 2); assert.ok(blocks.some(block => block.opcode === 'motion_movesteps' && block.inputs.STEPS[1][1] === '25'));
  for (const target of json.targets) for (const asset of [...target.costumes, ...target.sounds]) {
    const bytes = await archive.file(prefix + asset.md5ext).async('nodebuffer');
    const original = await expected.file(asset.md5ext).async('nodebuffer');
    assert.deepEqual(bytes, original); assert.equal(hash(bytes), hash(original));
    assert.equal(createHash('md5').update(bytes).digest('hex'), asset.assetId);
  }
};

test('Node24, module contract and all actual defaults/ledger paths are covered', async () => {
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(pack.usesProjectTarget, false); assert.equal(pack.requiresProject('pack', ['inspect']), false);
  assert.equal(pack.requiresProject('pack', ['build']), true); assert.equal(pack.isReadOnly('pack', ['build']), true);
  for (const definition of Object.values(pack.specs.pack)) {
    assert.ok(Number.isInteger(definition.min)); assert.ok(definition.max >= definition.min); assert.ok(definition.options.every(name => typeof name === 'string'));
  }
  const enumerate = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
    const name = prefix ? prefix + '.' + key : key;
    return child && typeof child === 'object' && !Array.isArray(child) && name !== 'cloudVariables.custom' ? enumerate(child, name) : [name];
  });
  assert.deepEqual(pack.OPTION_KEYS, enumerate(new Packager.Packager().options));
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'docs/census/m1-census.json'), 'utf8'));
  for (const action of ledger.actions.filter(item => item.id.startsWith('package.option.'))) assert.ok(pack.OPTION_KEYS.includes(action.id.slice('package.option.'.length)), action.id);
  assert.equal(pack.OPTION_KEYS.length, 58);
  assert.equal(pack.defaults().cloudVariables.mode, 'local'); assert.equal(pack.defaults().cloudVariables.cloudHost, '');
});

test('every default leaf supports strict set/get, nested config, export/import and reset', async t => {
  const directory = await temp(t), s = {};
  const allows = { 'cloudVariables.mode': 'cloud-network,net:clouddata.turbowarp.org,net:clouddata.turbowarp.xyz',
    'cloudVariables.cloudHost': 'cloud-network,net:clouddata.turbowarp.org,net:clouddata.turbowarp.xyz'};
  for (const key of pack.OPTION_KEYS) {
    await run(s, 'reset');
    const value = getAt(pack.upstreamDefaults(), key);
    if (key === 'cloudVariables.mode') await run(s, 'set', ['cloudVariables.cloudHost', 'wss://clouddata.turbowarp.org'], {allow: allows[key]});
    await run(s, 'set', [key, JSON.stringify(value)], allows[key] ? {allow: allows[key]} : {});
    assert.deepEqual((await run(s, 'get', [key])).value, value, key);
    await run(s, 'reset', [key]); assert.deepEqual((await run(s, 'get', [key])).value, getAt(pack.defaults(), key));
  }
  await run(s, 'reset');
  await run(s, 'config', [JSON.stringify({controls: {pause: {enabled: true}}, cursor: {center: {x: 4, y: 2}}, app: {windowTitle: '中文 <safe> & "标题"'}, framerate: 60})]);
  assert.equal(s.packagerSettings.controls.pause.enabled, true); assert.equal(s.packagerSettings.controls.fullscreen.enabled, false);
  const file = path.join(directory, 'settings.json'), result = await run(s, 'export', [file]);
  assert.equal(result.sha256, hash(await fs.readFile(file))); const saved = structuredClone(s.packagerSettings);
  assert.equal(saved.allow, undefined); assert.equal(result.permissionsExported, false);
  await run(s, 'reset'); await run(s, 'import', [file]); assert.deepEqual(s.packagerSettings, saved);
  await assert.rejects(run(s, 'export', [file]), /EEXIST/);
  await assert.rejects(run(s, 'export', [file], {output: file}), /不能同时/);
  await assert.rejects(run(s, 'build', ['package.html'], {out: 'project.sb3'}), /不允许 --out/);
});

test('eight frozen GUI partial reset groups clear only bound fields, including image state, and cursor center decodes pixels', async t => {
  const directory = await temp(t), base = pack.defaults();
  const canvas = createCanvas(7, 5), file = path.join(directory, 'cursor.png');
  await fs.writeFile(file, canvas.toBuffer('image/png'));
  const modified = structuredClone(base);
  Object.assign(modified, {turbo: true, framerate: 45, autoplay: true, username: 'changed', projectId: 'x', target: 'zip', maxTextureDimension: 4096});
  modified.app = {...modified.app, windowTitle: 'different', icon: {file}, packageName: 'changed', version: '2.1.0', windowControls: 'frameless', windowMode: 'maximize', escapeBehavior: 'exit-only', backgroundThrottling: true};
  modified.loadingScreen.image = {file}; modified.cursor = {type: 'custom', custom: {file}, center: {x: 1, y: 2}};
  modified.compiler.enabled = false; modified.monitors.editableLists = true; modified.steamworks.appId = '123';
  for (const [group, fields] of Object.entries(pack.RESET_GROUPS)) {
    const s = {packagerSettings: structuredClone(modified)}; await run(s, 'reset-group', [group]);
    for (const key of pack.OPTION_KEYS) assert.deepEqual(getAt(s.packagerSettings, key), fields.some(field => key === field || key.startsWith(field + '.')) ? getAt(base, key) : getAt(modified, key), group + ':' + key);
  }
  const s = {packagerSettings: structuredClone(modified)};
  await assert.rejects(run(s, 'cursor-center'), /缺少 --allow read/);
  const centered = await run(s, 'cursor-center', [], {allow: 'read:' + file});
  assert.deepEqual(centered.center, {x: 4, y: 3}); assert.equal(centered.sourceSHA256, hash(await fs.readFile(file)));
  assert.equal(s.packagerSettings.app.windowTitle, modified.app.windowTitle);
  await assert.rejects(run(s, 'reset-group', ['unknown']), /重置分组/);
});

test('malformed types, enums, prototype keys, dangerous paths and imports fail atomically', async t => {
  const directory = await temp(t), s = {}; await run(s, 'set', ['framerate', '45']);
  const original = structuredClone(s.packagerSettings);
  const attempts = [
    ['turbo', '"false"'], ['framerate', '"60"'], ['framerate', 'null'], ['framerate', '0'], ['maxClones', '1.5'],
    ['stageWidth', '-1'], ['stageHeight', '9000'], ['resizeMode', 'whatever'], ['app.windowControls', 'injected'],
    ['appearance.accent', 'red;}</style><script>evil()</script>'], ['custom.js', '</script><script>evil()</script>'],
    ['username', '</script><script>evil()</script>'], ['projectId', '</script><script>evil()</script>'],
    ['cloudVariables.custom', '{"</script><script>evil()</script>":"local"}'], ['extensions', '["https://example.org/</script>"]'],
    ['app.packageName', '../outside'], ['app.packageName', 'C:\\outside'], ['app.packageName', 'CON'],
    ['app.version', 'invalid'], ['steamworks.appId', '480'], ['extensions', '{}'], ['extensions', '[1]'],
    ['cloudVariables.custom', '{"score":"evil"}'], ['app.icon', 'https://example.org/icon.png'],
    ['app.icon', '{"file":"../evil.png"}'], ['app.icon', '{"mimeType":"image/png","buffer":"evil"}'],
    ['__proto__.polluted', 'true'], ['app.constructor.prototype', 'true'], ['app/../icon', 'true'],
    ['app.unknown', 'true'], ['controls.pause', 'true']
  ];
  // String option values require strings in JSON, but simple raw CLI string is
  // deliberately accepted. steamworks.appId raw 480 is therefore valid.
  attempts.splice(attempts.findIndex(([key]) => key === 'steamworks.appId'), 1);
  for (const [key, value] of attempts) {
    await assert.rejects(run(s, 'set', [key, value]), undefined, key); assert.deepEqual(s.packagerSettings, original, key);
  }
  for (const bad of ['{"__proto__":{"polluted":true}}', '{"app":{"constructor":{}}}', '{"turbo":"false"}', '{"extensions":["file:///tmp/a.js"]}', '{"framerate":NaN}']) {
    await assert.rejects(run(s, 'config', [bad])); assert.deepEqual(s.packagerSettings, original);
    const file = path.join(directory, 'bad.json'); await fs.writeFile(file, bad);
    await assert.rejects(run(s, 'import', [file])); assert.deepEqual(s.packagerSettings, original);
  }
  assert.equal({}.polluted, undefined);
  for (const filename of ['../escape.html', 'a/../escape.html', '%2e%2e/escape.html', 'C:\\escape.html', 'file:///tmp/a.html', '\u0000.html']) await assert.rejects(run(sessionFor((await sourceProject()).bytes), 'build', [filename]));
  const linked = path.join(directory, 'linked'); await fs.symlink(directory, linked);
  await assert.rejects(run(sessionFor((await sourceProject()).bytes), 'build', [path.join(linked, 'evil.html')]), /符号链接/);
  for (const entry of ['../escape', 'C:\\escape', '/absolute']) {
    const zip = new JSZip(); zip.file(entry, 'evil'); await assert.rejects(pack.validateArchive(await zip.generateAsync({type: 'nodebuffer'})), /traversal/);
  }
});

test('missing or poisoned source assets cannot trigger implicit upstream networking', async t => {
  const directory = await temp(t), source = (await sourceProject()).bytes;
  t.mock.method(network, 'fetchBytes', async () => {throw new Error('no downloader must be reached');});
  t.mock.method(global, 'fetch', async () => {throw new Error('no fetch must be reached');});
  for (const poison of [false, true]) {
    const zip = await JSZip.loadAsync(source), json = JSON.parse(await zip.file('project.json').async('string'));
    const filename = json.targets[0].costumes[0].md5ext;
    if (poison) zip.file(filename, 'poison'); else zip.remove(filename);
    const bytes = await zip.generateAsync({type: 'nodebuffer'});
    await assert.rejects(run(sessionFor(bytes), 'build', [path.join(directory, 'missing.html')], {allow: 'net:assets.scratch.mit.edu'}), poison ? /MD5不匹配/ : /隐式资产下载/);
  }
});

test('independent custom JS/CSS/extensions/cloud/unsafe and device grants are not persisted', async t => {
  const directory = await temp(t), {bytes} = await sourceProject();
  for (const [key, value, allow] of [['custom.js', 'globalThis.marker=1;', 'custom-js'], ['custom.css', 'body {opacity:0.9}', 'custom-css'],
    ['extensions', '["https://example.org/a.js"]', 'extension-code,net:example.org'],
    ['cloudVariables.unsafeCloudBehaviors', 'true', 'unsafe-cloud'], ['chunks.gamepad', 'true', 'gamepad'], ['chunks.pointerlock', 'true', 'pointerlock']]) {
    const s = sessionFor(bytes); await assert.rejects(run(s, 'set', [key, value]), /权限拒绝/);
    await run(s, 'set', [key, value], {allow}); await assert.rejects(run(s, 'build', [path.join(directory, 'denied.html')]), /权限拒绝/);
    assert.equal(s.permissionDecisions.at(-1).allowed, false); assert.ok(s.permissionDecisions.at(-1).reason);
  }
  const s = sessionFor(bytes);
  await assert.rejects(run(s, 'config', ['{"cloudVariables":{"mode":"ws","cloudHost":"wss://example.org"}}'], {allow: 'net:example.org'}), /cloud-network/);
  await run(s, 'config', ['{"cloudVariables":{"mode":"ws","cloudHost":"wss://example.org"}}'], {allow: 'cloud-network,net:example.org'});
  const output = path.join(directory, 'cloud.html'); await run(s, 'build', [output], {allow: 'cloud-network,net:example.org'});
  const html = await fs.readFile(output, 'utf8'); assert.match(html, /new Scaffolding.Cloud.WebSocketProvider\("wss:\/\/example.org"/); scripts(html);
  await assert.rejects(run(s, 'config', ['{"cloudVariables":{"cloudHost":"wss://clouddata.turbowarp.org"}}'], {allow: 'cloud-network,net:clouddata.turbowarp.org'}), /clouddata.turbowarp.xyz/);
});

test('authorized custom JS/CSS only embed in the actual artifact and never execute in CLI', async t => {
  const directory = await temp(t), s = sessionFor((await sourceProject()).bytes), marker = path.join(directory, 'must-not-exist.txt');
  const js = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe-execution');`, css = 'body { --explicit-marker: 123; }';
  await run(s, 'config', [JSON.stringify({custom: {js, css}})], {allow: 'custom-js,custom-css'});
  await assert.rejects(run(s, 'build', [path.join(directory, 'half.html')], {allow: 'custom-js'}), /custom-css/);
  const output = path.join(directory, 'authorized.html'); await run(s, 'build', [output], {allow: 'custom-js,custom-css'});
  const html = await fs.readFile(output, 'utf8'); assert.ok(html.includes(js)); assert.ok(html.includes(css)); scripts(html);
  await assert.rejects(fs.stat(marker), {code: 'ENOENT'});
});

test('extension baking requires independent code/host grant and fails closed instead of fallback remote URL', async t => {
  const directory = await temp(t), s = sessionFor((await sourceProject()).bytes), url = 'https://example.org/approved.js';
  const script = 'class TestExtension { getInfo(){return {id:"test"};} } Scratch.extensions.register(new TestExtension());';
  await run(s, 'set', ['extensions', JSON.stringify([url])], {allow: 'extension-code,net:example.org'});
  t.mock.method(network, 'fetchBytes', async (requested, p) => {
    assert.equal(requested, url); assert.ok(p.grants.some(grant => grant.id === 'extension-code')); p.require('net', 'example.org');
    return Buffer.from(script);
  });
  const output = path.join(directory, 'baked.html'); await run(s, 'build', [output], {allow: 'extension-code,net:example.org'});
  const html = await fs.readFile(output, 'utf8');
  const uri = html.match(/data:text\/javascript;,([^"\s<]+)/)[1];
  assert.ok(decodeURIComponent(uri).includes(script)); scripts(html);
  t.mock.method(network, 'fetchBytes', async () => {throw new Error('download failed deterministically');});
  const failed = path.join(directory, 'failed.html'); await assert.rejects(run(s, 'build', [failed], {allow: 'extension-code,net:example.org'}), /download failed/);
  await assert.rejects(fs.stat(failed), {code: 'ENOENT'});
});

for (const target of ['html', 'zip', 'zip-one-asset']) test(`real ${target}: offline output, parsing, asset bytes+MD5+SHA256, local cloud and safe titles`, async t => {
  t.mock.method(require('node:net').Socket.prototype, 'connect', () => {throw new Error('test forbids net');});
  t.mock.method(global, 'fetch', async () => {throw new Error('test forbids fetch');});
  t.mock.method(network, 'fetchBytes', async () => {throw new Error('offline package attempted downloader');});
  const directory = await temp(t), source = await sourceProject(), s = sessionFor(source.bytes);
  const title = '中文 <safe> & "title"';
  await run(s, 'config', [JSON.stringify({app: {windowTitle: title}, controls: {pause: {enabled: true}}, framerate: 60, compiler: {warpTimer: true}})]);
  const output = path.join(directory, target === 'html' ? 'game.html' : target + '.zip');
  const result = await run(s, 'build', [output], {target});
  const bytes = await fs.readFile(output); assert.equal(result.sha256, hash(bytes)); assert.equal(result.launched, false); assert.deepEqual(result.downloads, []);
  let html;
  if (target === 'html') {html = bytes.toString('utf8'); await assetsEqual(await JSZip.loadAsync(embedded(html)), '', source.bytes);}
  else {
    const zip = await pack.validateArchive(bytes); html = await zip.file('index.html').async('string');
    const runtime = await zip.file('script.js').async('string'); new Script(runtime); assert.match(runtime, /Scaffolding/);
    if (target === 'zip') {assert.equal(zip.file('project.zip'), null); await assetsEqual(zip, 'assets/', source.bytes);}
    else {assert.equal(zip.file('assets/project.json'), null); await assetsEqual(await JSZip.loadAsync(await zip.file('project.zip').async('nodebuffer')), '', source.bytes);}
  }
  scripts(html); assert.match(html, /new Scaffolding.Cloud.LocalStorageProvider/); assert.doesNotMatch(html, /new Scaffolding.Cloud.WebSocketProvider/);
  assert.match(html, /setFramerate\(60\)/); assert.match(html, /warpTimer: true/);
  const elements = parseDOM(html, {decodeEntities: true}).flatMap(function walk(node) {return [node, ...(node.children || []).flatMap(walk)];});
  assert.equal(elements.find(node => node.name === 'title').children.map(node => node.data || '').join(''), title);
  await assert.rejects(run(s, 'build', [output], {target}), /EEXIST/); assert.deepEqual(await fs.readFile(output), bytes);
  assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
});

test('icon/cursor/loadingScreen use safe Packager.Image files, never URL/prototype/data payloads', async t => {
  const directory = await temp(t), s = sessionFor((await sourceProject()).bytes), canvas = createCanvas(8, 8);
  canvas.getContext('2d').fillStyle = '#abcdef'; canvas.getContext('2d').fillRect(0, 0, 8, 8);
  const file = path.join(directory, 'icon.png'); await fs.writeFile(file, canvas.toBuffer('image/png'));
  for (const key of ['app.icon', 'cursor.custom', 'loadingScreen.image']) await run(s, 'set', [key, file]);
  await run(s, 'set', ['cursor.type', 'custom']);
  const output = path.join(directory, 'images.html'); await assert.rejects(run(s, 'build', [output]), /缺少 --allow read:/);
  const result = await run(s, 'build', [output], {allow: 'read:' + file});
  assert.equal(result.images.length, 3);
  for (const report of result.images) {assert.equal(report.sourceSHA256, hash(await fs.readFile(file))); assert.equal(report.width, 8);}
  const html = await fs.readFile(output, 'utf8'); const imageData = [...html.matchAll(/data:image\/png;base64,([a-zA-Z\d+/=]+)/g)]; assert.ok(imageData.length >= 3);
  assert.ok(imageData.some(([, data]) => hash(Buffer.from(data, 'base64')) === result.images[0].pngSHA256)); scripts(html);
  const parsed = await pack.imageBytes(await fs.readFile(file)); assert.ok(parsed.image instanceof Packager.Image);
  for (const svg of ['<svg width="8" height="8"><script>evil()</script></svg>', '<svg width="8" height="8"><image href="file:///etc/passwd"/></svg>',
    '<svg width="8" height="8"><image href="https://example.org/a"/></svg>', '<!DOCTYPE svg SYSTEM "http://evil"><svg width="8" height="8"/>',
    '<svg width="8" height="8" onload="evil()"/>', '<svg width="8" height="8"><style>url(http://evil)</style></svg>']) await assert.rejects(pack.imageBytes(Buffer.from(svg)), /拒绝/);
  const svg = await pack.imageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>'));
  assert.ok(svg.image instanceof Packager.Image); assert.equal(svg.image.mimeType, 'image/png');
  const huge = Buffer.from(await fs.readFile(file)); huge.writeUInt32BE(100000, 16); await assert.rejects(pack.imageBytes(huge), /尺寸/);
  const symlink = path.join(directory, 'link.png'); await fs.symlink(file, symlink); await run(s, 'set', ['app.icon', symlink]);
  await assert.rejects(run(s, 'build', [path.join(directory, 'link.html')], {allow: `read:${symlink},read:${file}`}), /符号链接/);
});

test('all official targets deny network/cache omission, use fixed directory cache hashes and never execute', async t => {
  const directory = await temp(t), source = (await sourceProject()).bytes;
  const assetFile = path.join(directory, 'cache');
  for (const target of pack.TARGETS.filter(id => pack.LARGE_ASSETS[id])) {
    const s = sessionFor(source);
    await assert.rejects(run(s, 'build', [path.join(directory, 'desktop.zip')], {target}), /cache/);
    await assert.rejects(run(s, 'build', [path.join(directory, 'desktop.zip')], {target, cache: assetFile}), /net:packagerdata/);
    await assert.rejects(run(s, 'download', [target], {cache: assetFile}), /net:/);
    const wrong = path.join(assetFile, pack.LARGE_ASSETS[target].sha256 + '.zip'); await fs.mkdir(assetFile, {recursive: true}); await fs.writeFile(wrong, 'poisoned');
    await assert.rejects(run(s, 'download', [target], {cache: assetFile, allow: 'net:packagerdata.turbowarp.org'}), /SHA-256/);
    assert.deepEqual(await fs.readFile(wrong), Buffer.from('poisoned'));
  }
  // A deterministic test-only official asset fixture exercises the real cache
  // and package assembly without claiming a fake Electron is a real download.
  const zip = new JSZip(); zip.file('LICENSES.chromium.html', '<p>fixture license</p>'); zip.file('electron.exe', 'TEST-FIXTURE-NOT-EXECUTABLE');
  const fixture = await zip.generateAsync({type: 'nodebuffer'}), target = 'electron-win64';
  const realAsset = pack.LARGE_ASSETS[target];
  // Production manifests are immutable. Use direct upstream assembly with the
  // fixture and assert that none of its runtime source is ever evaluated.
  const upstream = new Packager.Packager(); upstream.options.app.packageName = 'fixture-app'; upstream.options.target = target;
  upstream.project = await Packager.loadProject(source); upstream.options.cloudVariables.mode = 'none';
  upstream.fetchLargeAsset = async () => fixture;
  const resources = new JSZip(); resources.file('index.html', '<!DOCTYPE html>'); resources.file('script.js', '/* fixture */');
  const assembled = await upstream.addElectron(resources);
  new Script(await assembled.file('fixture-app/resources/app/electron-main.js').async('string'));
  new Script(await assembled.file('fixture-app/resources/app/electron-preload.js').async('string'));
  assert.equal(JSON.parse(await assembled.file('fixture-app/resources/app/package.json').async('string')).name, 'fixture-app');
  assert.deepEqual(await assembled.file('fixture-app/fixture-app.exe').async('nodebuffer'), Buffer.from('TEST-FIXTURE-NOT-EXECUTABLE'));
  assert.ok(Object.isFrozen(realAsset));
});

test('native macOS adapters operate only on files, escape plist, and encode ICNS without DOM', async () => {
  const canvas = createCanvas(128, 128); canvas.getContext('2d').fillRect(0, 0, 128, 128);
  const bytes = await pack.nativeICNS(canvas.toBuffer('image/png')); assert.equal(bytes.toString('ascii', 0, 4), 'icns'); assert.equal(bytes.readUInt32BE(4), bytes.length);
  const zip = new JSZip(); zip.file('Info.plist', '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Old</string><key>Untouched</key><true/></dict></plist>');
  await pack.updatePlist(zip, 'Info.plist', {CFBundleName: '<safe>&中文', CFBundleVersion: '1.2.3'});
  const xml = await zip.file('Info.plist').async('string'); assert.match(xml, /&lt;safe&gt;&amp;/); assert.match(xml, /<true\s*\/>/); assert.match(xml, /1\.2\.3/);
  const strings = parseDOM(xml, {xmlMode: true, decodeEntities: true}).flatMap(function walk(node) {return [node, ...(node.children || []).flatMap(walk)];}).filter(node => node.name === 'string');
  assert.equal(strings[0].children.map(node => node.data || '').join(''), '<safe>&中文');
  assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
});

test('project preflight denies traversal/invalid configuration before core opens or replaces a session', async t => {
  const directory = await temp(t), {CommandSession} = require('../src/commands'), s = new CommandSession();
  t.after(() => s.dispose()); await s.execute(['new']);
  let opened = 0; s.open = async () => {opened++; throw new Error('preflight incorrectly opened project');};
  await assert.rejects(s.execute(['pack', 'build', path.join(directory, 'bad.html'), '--project', '../escape.sb3']), /拒绝|path/);
  await assert.rejects(s.execute(['pack', 'build', path.join(directory, 'bad.html'), '--project', '/nonexistent.sb3', '--opt', 'turbo="true"']), /类型/);
  await assert.rejects(s.execute(['pack', 'build', path.join(directory, 'bad.html'), '--project', '/nonexistent.sb3', '--opt', 'custom.js=evil()']), /custom-js/);
  assert.equal(opened, 0); assert.equal(s.project.target('stage').getName(), 'Stage');
});

test('CLI routes pack settings/HTML output with --output not --out under Node24', async t => {
  const directory = await temp(t), project = path.join(directory, 'input.sb3'), output = path.join(directory, 'cli.html');
  await fs.writeFile(project, (await sourceProject()).bytes);
  const requests = [{command: 'pack', args: ['set', 'framerate', '60']}, {command: 'pack', args: ['build', '--project', project, '--output', output]},
    {command: 'pack', args: ['build', '--project', project, '--out', path.join(directory, 'bad.html')]}, {command: 'quit'}];
  const result = spawnSync(process.execPath, [path.join(root, 'bin/tw.js'), 'session', '--jsonl'], {encoding: 'utf8', timeout: 30000,
    input: requests.map(item => JSON.stringify(item)).join('\n') + '\n'});
  assert.equal(result.status, 0, result.stderr); const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].ok, true); assert.equal(replies[1].ok, true, replies[1].error); assert.equal(replies[1].result.target, 'html');
  assert.equal(replies[2].ok, false); scripts(await fs.readFile(output, 'utf8'));
});
