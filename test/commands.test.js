const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const {Image, createCanvas, loadImage} = require('@napi-rs/canvas');
const {CommandSession, wav} = require('../src/commands');
const {blankProject, readProject, atomicWrite} = require('../src/project');
const {tokenize} = require('../bin/tw');

const cli = (args, input) => spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), ...args],
  {input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024});
const jsonl = requests => {
  const result = cli(['session', '--jsonl'], requests.map(request => typeof request === 'string' ? request : JSON.stringify(request)).join('\n') + '\n');
  assert.equal(result.error, undefined);
  return {...result, replies: result.stdout.trim().split('\n').map(line => JSON.parse(line))};
};
const request = (command, ...args) => ({command, args});

const withSession = async operation => {
  const session = new CommandSession();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-cli-test-'));
  try {await operation(session, dir);} finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
};

test('tokenizer preserves quoted unicode names and JSON', () => {
  assert.deepEqual(tokenize("sprite rename '我的角色'"), ['sprite', 'rename', '我的角色']);
  assert.deepEqual(tokenize("block add motion_movesteps --inputs '{\"STEPS\":25}'"), ['block', 'add', 'motion_movesteps', '--inputs', '{"STEPS":25}']);
  assert.throws(() => tokenize("open 'oops"), /Unclosed/);
});

test('commands create/save/reopen, preserve layers/assets, undo/redo and rollback', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3');
  await session.execute(['new', file]);
  const stableId = (await session.execute(['info'])).targets[1].id;
  await session.execute(['sprite', 'set', 'x', '42']);
  await session.execute(['sprite', 'rename', '我的角色']);
  await session.execute(['var', 'add', '得分', '7']);
  await session.execute(['var', 'set', '得分', '9']);
  assert.equal((await session.execute(['var', 'list']))[0].value, 9);
  await session.execute(['undo']);
  assert.equal((await session.execute(['var', 'list']))[0].value, 7);
  await session.execute(['redo']);
  await assert.rejects(session.execute(['sprite', 'set', 'size', '-1']), /Size/);
  assert.equal((await session.execute(['info'])).targets[1].x, 42);
  assert.equal((await session.execute(['var', 'list']))[0].value, 9);
  await session.execute(['sprite', 'add', '第二个角色']);
  await session.execute(['sprite', 'front', '--target', '我的角色']);
  await session.execute(['save']);
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const json = JSON.parse(await zip.file('project.json').async('string'));
  assert.ok(json.targets.find(target => target.name === '我的角色').layerOrder > json.targets.find(target => target.name === '第二个角色').layerOrder);
  for (const target of json.targets) for (const costume of target.costumes) assert.ok(zip.file(costume.md5ext));
  await session.execute(['open', file]);
  const info = await session.execute(['info']);
  assert.equal(info.targets.find(target => target.name === '我的角色').id, stableId);
  assert.equal(info.targets.find(target => target.name === '我的角色').x, 42);
  assert.equal(info.targets.find(target => target.name === '我的角色').variables[0].value, 9);
  assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
}));

test('isolated runtime interprets and compiles green-flag motion without changing editor', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  await session.execute(['script', 'demo', '25']);
  for (const compiler of [[], ['--compile']]) {
    const result = await session.execute(['run', '--frames', '2', ...compiler]);
    assert.equal(result.targets.find(target => target.name === 'Sprite1').x, 25);
    assert.equal(result.noDOM, true);
  }
  assert.equal((await session.execute(['info'])).targets[1].x, 0);
  await session.execute(['render', path.join(dir, 'stage.png')]);
  const image = await loadImage(await fs.readFile(path.join(dir, 'stage.png')));
  assert.equal(image.width, 480); assert.equal(image.height, 360);
  const canvas = createCanvas(480, 360); canvas.getContext('2d').drawImage(image, 0, 0);
  const pixel = canvas.getContext('2d').getImageData(240, 180, 1, 1).data;
  assert.ok(pixel[0] > 200 && pixel[1] < 150);
  assert.equal((await session.execute(['sense', 'color', '#ffffff'])).touching, true);
  await session.execute(['sprite', 'add', 'Other']);
  assert.equal((await session.execute(['sense', 'touching', 'Other', '--target', 'Sprite1'])).touching, true);
  await session.execute(['sprite', 'set', 'x', '200', '--target', 'Other']);
  assert.equal((await session.execute(['sense', 'touching', 'Other', '--target', 'Sprite1'])).touching, false);
}));

test('parameterized procedures accept named values and argument reporter inputs', async () => withSession(async session => {
  await session.execute(['new']);
  const proc = await session.execute(['proc', 'define', '走路', '--params', '[{"name":"距离","type":"number"}]']);
  const motion = await session.execute(['block', 'add', 'motion_movesteps', '--inputs', '{"STEPS":1}', '--after', proc.id]);
  const reporter = await session.execute(['block', 'add', 'argument_reporter_string_number', '--fields', '{"VALUE":"距离"}']);
  await session.execute(['block', 'input', motion.id, 'STEPS', reporter.id]);
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  await session.execute(['proc', 'call', '走路', '--values', '{"距离":37}', '--after', hat.id]);
  assert.equal((await session.execute(['run', '--frames', '3'])).targets[1].x, 37);
  await session.execute(['proc', 'rename', '走路', '前进']);
  assert.equal((await session.execute(['run', '--frames', '3'])).targets[1].x, 37);
}));

test('keyboard input events reach isolated runtime copy', async () => withSession(async session => {
  await session.execute(['new']);
  const hat = await session.execute(['block', 'add', 'event_whenkeypressed', '--fields', '{"KEY_OPTION":"space"}']);
  await session.execute(['block', 'add', 'motion_movesteps', '--inputs', '{"STEPS":10}', '--after', hat.id]);
  await session.execute(['input', 'key', 'space', 'down']);
  assert.equal((await session.execute(['run', '--frames', '2'])).targets[1].x, 10);
}));

test('frame-clock wait, say bubbles and pen rendering stay DOM-free', async () => withSession(async session => {
  await session.execute(['new']);
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  const wait = await session.execute(['block', 'add', 'control_wait', '--inputs', '{"DURATION":0.5}', '--after', hat.id]);
  await session.execute(['block', 'add', 'motion_movesteps', '--inputs', '{"STEPS":30}', '--after', wait.id]);
  assert.equal((await session.execute(['run', '--frames', '10'])).targets[1].x, 0);
  assert.equal((await session.execute(['run', '--frames', '30'])).targets[1].x, 30);
  const sayHat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  await session.execute(['block', 'add', 'looks_say', '--inputs', '{"MESSAGE":"hello"}', '--after', sayHat.id]);
  assert.equal((await session.execute(['run', '--frames', '2'])).noDOM, true);
  const renderer = session.project.renderer;
  const skin = renderer.createPenSkin();
  renderer.penLine(skin, {color4f: [1, 0, 0, 1], diameter: 5}, -40, 0, 40, 0);
  const drawable = renderer.createDrawable(require('scratch-vm/src/engine/stage-layering').PEN_LAYER);
  renderer.updateDrawableSkinId(drawable, skin);
  assert.ok(renderer.png().length > 1000);
}));

test('commands import/export bitmap and WAV, render PCM and package HTML/ZIP', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const canvas = createCanvas(20, 10); canvas.getContext('2d').fillRect(0, 0, 20, 10);
  const bitmap = path.join(dir, 'bitmap.png'); await fs.writeFile(bitmap, canvas.toBuffer('image/png'));
  await session.execute(['costume', 'add', bitmap]);
  const exported = path.join(dir, 'export.png'); await session.execute(['costume', 'export', 'bitmap', exported]);
  assert.deepEqual(await fs.readFile(exported), await fs.readFile(bitmap));
  const {OfflineAudioContext} = await import('node-web-audio-api');
  const context = new OfflineAudioContext(1, 4410, 44100);
  const buffer = context.createBuffer(1, 4410, 44100); buffer.getChannelData(0).fill(0.1);
  const sound = path.join(dir, 'tone.wav'); await fs.writeFile(sound, wav(buffer));
  await session.execute(['sound', 'add', sound]);
  assert.equal((await session.execute(['sound', 'list']))[0].samples, 4410);
  for (const effect of ['reverse', 'louder', 'softer', 'faster', 'slower', 'echo', 'robot', 'fade-in', 'fade-out', 'mute']) {
    const edited = await session.execute(['sound', 'effect', 'tone', effect]);
    assert.ok(edited.samples > 0);
    await session.execute(['undo']);
  }
  const trimmed = await session.execute(['sound', 'trim', 'tone', '0', '0.05']);
  assert.equal(trimmed.samples, 2205);
  await session.execute(['undo']);
  const output = path.join(dir, 'audio.wav'); await session.execute(['sound', 'render', 'tone', output, '--volume', '50']);
  const audio = await fs.readFile(output); assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  for (const ext of ['html', 'zip']) {
    const packed = path.join(dir, `package.${ext}`); await session.execute(['package', packed]);
    assert.ok((await fs.stat(packed)).size > 10000);
  }
}));

test('lists, broadcasts, comments, monitors, procedures and bitmap edits survive save', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  await session.execute(['list', 'add', 'items', '[1,2]']);
  await session.execute(['list', 'append', 'items', '3']);
  await session.execute(['list', 'replace', 'items', '2', '8']);
  assert.deepEqual((await session.execute(['list', 'get', 'items'])).value, [1, 8, 3]);
  await session.execute(['broadcast', 'add', 'start']);
  const comment = await session.execute(['comment', 'add', '说明']);
  await session.execute(['comment', 'set', comment.id, '更新说明']);
  await session.execute(['var', 'add', 'score', '5']);
  await session.execute(['monitor', 'add', 'score']);
  await session.execute(['monitor', 'set', 'score', 'mode', 'slider']);
  const proc = await session.execute(['proc', 'define', 'walk']);
  await session.execute(['block', 'add', 'motion_movesteps', '--inputs', '{"STEPS":55}', '--after', proc.id]);
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  await session.execute(['proc', 'call', 'walk', '--after', hat.id]);
  assert.equal((await session.execute(['run', '--frames', '3'])).targets[1].x, 55);
  await session.execute(['proc', 'rename', 'walk', '前进']);
  assert.equal((await session.execute(['run', '--frames', '3'])).targets[1].x, 55);
  const shape = await session.execute(['vector', 'add', '0', 'rect', '0', '0', '15', '10', '#00ff00']);
  await session.execute(['vector', 'translate', '0', shape.id, '5', '5']);
  assert.ok((await session.execute(['vector', 'source', '0'])).svg.includes('translate(5 5)'));
  await session.execute(['vector', 'delete', '0', shape.id]);
  await session.execute(['bitmap', 'resize', '0', '30', '40']);
  await session.execute(['bitmap', 'fill', '0', '#00ff00']);
  const file = path.join(dir, 'edited.sb3'); await session.execute(['save', file]);
  await session.execute(['open', file]);
  assert.deepEqual((await session.execute(['list', 'get', 'items'])).value, [1, 8, 3]);
  assert.equal((await session.execute(['comment', 'list']))[0].text, '更新说明');
  assert.equal((await session.execute(['monitor', 'list']))[0].mode, 'slider');
  assert.equal((await session.execute(['proc', 'list']))[0].name, '前进');
  assert.equal((await session.execute(['costume', 'list']))[0].format, 'png');
}));

test('explicit preferences file preserves v2 schema and migrates legacy data', async () => withSession(async (session, dir) => {
  const config = path.join(dir, 'settings.json');
  await fs.writeFile(config, JSON.stringify({locale: 'zh-cn', disable_update_checker: true, hardware_acceleration: false}));
  assert.equal((await session.execute(['pref', 'get', 'locale', '--config', config])).value, 'zh-cn');
  assert.equal((await session.execute(['pref', 'get', 'updateChecker', '--config', config])).value, 'never');
  const result = await session.execute(['pref', 'set', 'richPresence', 'true', '--config', config]);
  assert.equal(result.effectiveInCLI, false);
  const data = JSON.parse(await fs.readFile(config, 'utf8'));
  assert.equal(data.v2.hardwareAcceleration, false); assert.equal(data.v2.richPresence, true);
  await assert.rejects(session.execute(['pref', 'set', 'bypassCORS', 'yes', '--config', config]), /boolean/);
}));

test('local cloud state shares values between isolated runtime and another session', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const state = path.join(dir, 'cloud.json');
  await session.execute(['cloud', 'use', state]);
  await session.execute(['cloud', 'add', '☁ score', '7']);
  await session.execute(['cloud', 'set', '☁ score', '18']);
  assert.equal((await session.execute(['cloud', 'get', '☁ score'])).value, 18);
  const file = path.join(dir, 'cloud-project.sb3'); await session.execute(['save', file]);
  const other = new CommandSession();
  try {
    await other.execute(['open', file]); await other.execute(['cloud', 'use', state]);
    await other.execute(['cloud', 'set', '☁ score', '42']);
    assert.equal((await session.execute(['cloud', 'get', '☁ score'])).value, 42);
    const result = await session.execute(['run', '--frames', '2']);
    assert.equal(result.targets[0].variables.find(variable => variable.name === '☁ score').value, 42);
  } finally {other.dispose();}
}));

test('custom extension fail-closed and atomic output refuses overwrite by default', async () => withSession(async (session, dir) => {
  const bytes = await blankProject(); const zip = await JSZip.loadAsync(bytes);
  const json = JSON.parse(await zip.file('project.json').async('string'));
  json.extensionURLs = {evil: 'https://example.invalid/evil.js'};
  zip.file('project.json', JSON.stringify(json));
  await assert.rejects(readProject(await zip.generateAsync({type: 'nodebuffer'})), /denied/);
  const file = path.join(dir, 'keep.txt'); await fs.writeFile(file, 'original');
  await assert.rejects(atomicWrite(file, Buffer.from('changed')), /EEXIST/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
}));

test('CLI JSONL keeps stdout machine-readable and returns request-scoped errors', () => {
  const input = [
    {id: 1, command: 'new', args: []},
    {id: 2, command: 'sprite', args: ['set', 'x', '55']},
    {id: 3, command: 'info', args: []},
    {id: 4, command: 'nonsense', args: []},
    {id: 5, command: 'quit', args: ['--force']}
  ].map(request => JSON.stringify(request)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'], {input, encoding: 'utf8', timeout: 15000});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 5);
  assert.equal(lines[2].result.targets[1].x, 55);
  assert.equal(lines[3].ok, false);
  assert.equal(lines[4].result.closed, true);
});

test('CLI validates command-specific options, arity and duplicates before side effects', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3');
  const ignored = path.join(dir, 'ignored.sb3');
  await session.execute(['new', file]);
  const original = await fs.readFile(file);
  const invalid = [
    request('info', '--frames', '2'), request('sprite', 'set', 'x', '55', 'extra'),
    request('sprite', 'set', 'x', '55', '--compile'), request('sprite', 'list', '--out', ignored),
    request('run', '--frames', '1', '--frames', '2'), request('run', '--compile', '--compile'),
    request('list', 'append', 'missing'), request('input', 'mouse', '0', '0', 'sideways'),
    request('block', 'move', 'missing', '--after', 'a', '--parent', 'b'),
    request('pref', 'list', '--config', path.join(dir, 'pref.json'), '--out', ignored)
  ];
  const result = jsonl([request('open', file), ...invalid, request('info'), request('var', 'add', '--', '--frames', '7'),
    request('var', 'list'), request('quit', '--force')]);
  assert.equal(result.status, 0, result.stderr);
  for (const reply of result.replies.slice(1, invalid.length + 1)) assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.equal(result.replies[invalid.length + 1].result.dirty, false);
  assert.equal(result.replies[invalid.length + 1].result.targets[1].x, 0);
  assert.equal(result.replies[invalid.length + 3].result[0].name, '--frames');
  assert.deepEqual(await fs.readFile(file), original);
  await assert.rejects(fs.stat(ignored), {code: 'ENOENT'});
}));

test('CLI one-shot new --out persists, while unsaved edits and EOF return exit code 2', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'one-shot.sb3');
  const created = cli(['new', '--out', file]);
  assert.equal(created.status, 0, created.stderr);
  assert.ok((await JSZip.loadAsync(await fs.readFile(file))).file('project.json'));
  const before = await fs.readFile(file);
  const unsaved = cli(['sprite', 'set', 'x', '55', '--project', file]);
  assert.equal(unsaved.status, 2); assert.match(unsaved.stderr, /persist/);
  assert.deepEqual(await fs.readFile(file), before);
  const eof = jsonl([request('open', file), request('sprite', 'set', 'x', '25')]);
  assert.equal(eof.status, 2); assert.match(eof.stderr, /Unsaved/);
  const saved = cli(['sprite', 'set', 'x', '55', '--project', file, '--out', file]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(cli(['info', '--project', file]).stdout).targets[1].x, 55);
}));

test('JSONL rejects malformed envelopes and quit arguments without terminating or corrupting stdout', () => {
  const result = jsonl(['null', '[]', '{', {id: 7, command: 'help', args: false},
    {id: 8, command: 'help', args: null}, request('new'), request('quit', 'typo', '--force'),
    {id: 9, command: 'help', args: []}, request('info'), request('quit', '--force')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.replies.length, 10);
  for (const index of [0, 1, 2, 3, 4, 6]) assert.equal(result.replies[index].ok, false);
  assert.equal(result.replies[7].id, 9); assert.equal(result.replies[7].ok, true);
  assert.equal(result.replies[8].result.targets.length, 2);
  assert.equal(result.replies[9].result.closed, true);
});

test('failed edit output rolls back project, selection, dirty state and history', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3');
  const occupied = path.join(dir, 'occupied.sb3');
  await session.execute(['new', file]); await fs.writeFile(occupied, 'keep');
  const result = jsonl([request('open', file), request('sprite', 'select', 'stage'), request('info'),
    request('sprite', 'rename', 'Changed', '--target', 'Sprite1', '--out', occupied), request('info'),
    request('history'), request('quit')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.replies[3].ok, false);
  assert.deepEqual(result.replies[4].result, result.replies[2].result);
  assert.deepEqual(result.replies[5].result, {undo: [], redo: []});
  assert.equal(await fs.readFile(occupied, 'utf8'), 'keep');
}));

test('stable target IDs disambiguate names and selection survives rollback and undo/redo', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'); await session.execute(['new', file]);
  const original = (await session.execute(['info'])).targets[1].id;
  const result = jsonl([request('open', file), request('sprite', 'select', 'stage'),
    request('sprite', 'rename', 'Renamed', '--target', original), request('undo'), request('info'),
    request('redo'), request('info'), request('sprite', 'set', 'size', '-1', '--target', original), request('info'),
    request('sprite', 'add', original), request('sprite', 'select', original), request('info'), request('quit', '--force')]);
  assert.equal(result.status, 0, result.stderr);
  for (const index of [4, 6, 8]) assert.equal(result.replies[index].result.selected, 'Stage');
  assert.equal(result.replies[7].ok, false);
  assert.equal(result.replies[6].result.targets[1].id, original);
  assert.equal(result.replies[6].result.targets[1].name, 'Renamed');
  assert.equal(result.replies[10].ok, true);
  assert.equal(result.replies[11].result.selected, 'Renamed');
}));

test('corrupt and denied SB3 opens preserve previous unsaved project, history and save path', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'); await session.execute(['new', file]);
  const zip = await JSZip.loadAsync(await blankProject());
  const json = JSON.parse(await zip.file('project.json').async('string'));
  const costume = json.targets[1].costumes[0];
  zip.remove(costume.md5ext); costume.dataFormat = 'png'; costume.md5ext = `${costume.assetId}.png`;
  zip.file(costume.md5ext, 'not a PNG'); zip.file('project.json', JSON.stringify(json));
  const corrupt = path.join(dir, 'corrupt.sb3'); await fs.writeFile(corrupt, await zip.generateAsync({type: 'nodebuffer'}));
  const result = jsonl([request('open', file), request('sprite', 'set', 'x', '81'), request('info'),
    request('open', corrupt, '--force'), request('info'), request('history'), request('save'), request('quit')]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.replies[3].ok, false);
  assert.deepEqual(result.replies[4].result, result.replies[2].result);
  assert.equal(result.replies[5].result.undo.length, 1);
  assert.equal(JSON.parse(cli(['info', '--project', file]).stdout).targets[1].x, 81);
}));

test('cloud validation rejects invalid adds before external writes and preserves attachment on failure', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'), state = path.join(dir, 'cloud.json'), invalid = path.join(dir, 'invalid.json');
  await session.execute(['new', file]); await fs.writeFile(invalid, '{}');
  const result = jsonl([request('open', file), request('cloud', 'use', state), request('cloud', 'add', 'bad', '{}'),
    request('cloud', 'list'), request('cloud', 'add', '☁ score', '7'), request('cloud', 'use', invalid),
    request('cloud', 'set', '☁ score', '18'), request('cloud', 'get', '☁ score'),
    request('var', 'set', '☁ score', '{}', '--target', 'stage'), request('cloud', 'get', '☁ score'), request('quit', '--force')]);
  assert.equal(result.status, 0, result.stderr);
  for (const index of [2, 5, 8]) assert.equal(result.replies[index].ok, false);
  assert.deepEqual(result.replies[3].result.values, {});
  assert.equal(result.replies[7].result.value, 18); assert.equal(result.replies[9].result.value, 18);
  assert.deepEqual(JSON.parse(await fs.readFile(state, 'utf8')).values, {'☁ score': 18});
}));

test('seeded runtime and per-frame variable watch reproduce Scratch random in interpreter and compiler', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const variable = await session.execute(['var', 'add', 'score', '0']);
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  const loop = await session.execute(['block', 'add', 'control_forever', '--after', hat.id]);
  const change = await session.execute(['block', 'add', 'data_changevariableby', '--fields', '{"VARIABLE":"score"}',
    '--inputs', '{"VALUE":1}', '--parent', loop.id, '--input', 'SUBSTACK']);
  const random = await session.execute(['block', 'add', 'operator_random', '--inputs', '{"FROM":1,"TO":1000000}']);
  await session.execute(['block', 'input', change.id, 'VALUE', random.id]);
  const file = path.join(dir, 'random.sb3'); await session.execute(['save', file]);
  const before = await fs.readFile(file);
  const run = extra => {
    const result = cli(['run', '--project', file, '--frames', '6', '--seed', '1234', '--watch', 'score', ...extra]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const interpreted = run([]), again = run([]), compiled = run(['--compile']);
  assert.deepEqual(interpreted.watch, again.watch);
  assert.deepEqual(interpreted.watch, compiled.watch);
  assert.equal(interpreted.seed, 1234);
  assert.equal(interpreted.watch.variableId, variable.id);
  assert.deepEqual(interpreted.watch.samples.map(sample => sample.frame), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(interpreted.watch.samples.map(sample => sample.value), [73295, 776707, 1679564, 2650114, 2691078, 2808842]);
  assert.ok(interpreted.watch.samples.every((sample, index, samples) => index === 0 ? sample.value > 0 : sample.value > samples[index - 1].value));
  assert.equal(interpreted.watch.samples[0].timeMS, 0);
  assert.equal(interpreted.targets[1].variables[0].value, interpreted.watch.samples.at(-1).value);
  const different = cli(['run', '--project', file, '--frames', '6', '--seed', '1235', '--watch', variable.id]);
  assert.equal(different.status, 0, different.stderr);
  assert.notDeepEqual(JSON.parse(different.stdout).watch.samples, interpreted.watch.samples);
  for (const extra of [['--seed', '-1'], ['--seed', '4294967296'], ['--seed', '1.5'], ['--watch', 'missing']]) {
    const invalid = cli(['run', '--project', file, '--frames', '1', ...extra]); assert.equal(invalid.status, 1);
  }
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await session.execute(['var', 'list']))[0].value, 0);
}));

test('failed runtime watch is request-scoped and a subsequent run remains isolated', async () => withSession(async (session, dir) => {
  await session.execute(['new']); await session.execute(['list', 'add', 'huge', JSON.stringify(['x'.repeat(1500000)])]);
  const file = path.join(dir, 'watch.sb3'); await session.execute(['save', file]);
  const result = jsonl([request('open', file), request('run', '--watch', 'huge', '--frames', '4'),
    request('run', '--frames', '1'), request('info'), request('quit')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.replies[1].ok, false); assert.match(result.replies[1].error, /4 MiB/);
  assert.equal(result.replies[2].ok, true); assert.equal(result.replies[3].result.dirty, false);
}));

test('undo/redo output failures preserve history and actual persisted SB3', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'history.sb3'), occupied = path.join(dir, 'occupied.sb3');
  await session.execute(['new', file]); await fs.writeFile(occupied, 'keep');
  const result = jsonl([request('open', file), request('sprite', 'set', 'x', '55'), request('history'),
    request('undo', '--out', occupied), request('history'), request('info'), request('undo', '--out', file),
    request('redo', '--out', occupied), request('history'), request('info'), request('redo', '--out', file), request('quit')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.replies[3].ok, false); assert.deepEqual(result.replies[4].result, result.replies[2].result);
  assert.equal(result.replies[5].result.targets[1].x, 55);
  assert.equal(result.replies[7].ok, false); assert.equal(result.replies[8].result.redo.length, 1);
  assert.equal(result.replies[9].result.targets[1].x, 0); assert.equal(result.replies[9].result.dirty, false);
  assert.equal(JSON.parse(cli(['info', '--project', file]).stdout).targets[1].x, 55);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'keep');
}));

test('cloud writes cannot grow beyond 2 MiB or leave an unpersisted editor value', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const state = path.join(dir, 'cloud.json');
  await session.execute(['cloud', 'use', state]); await session.execute(['cloud', 'add', '☁ score', '7']);
  const values = {'☁ score': 7};
  for (let i = 0; i < 208; i++) values[`padding${i}`] = 'x'.repeat(10000);
  const bytes = Buffer.from(JSON.stringify({version: 1, values}, null, 2));
  assert.ok(bytes.length < 2 * 1024 * 1024); await fs.writeFile(state, bytes);
  await assert.rejects(session.execute(['cloud', 'set', '☁ score', '😀'.repeat(5000)]), /2 MiB/);
  assert.deepEqual(await fs.readFile(state), bytes);
  assert.equal((await session.execute(['info'])).targets[0].variables[0].value, 7);
  assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
}));

test('two VM sessions load approved extensions independently and dispose all native targets', async () => withSession(async (session, dir) => {
  const zip = await JSZip.loadAsync(await blankProject()); const json = JSON.parse(await zip.file('project.json').async('string'));
  json.extensions = ['pen'];
  json.targets[1].blocks.pen = {opcode: 'pen_clear', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
  zip.file('project.json', JSON.stringify(json));
  const file = path.join(dir, 'pen.sb3'); await fs.writeFile(file, await zip.generateAsync({type: 'nodebuffer'}));
  await session.execute(['new']); const other = new CommandSession();
  try {
    await other.execute(['open', file]);
    // Refreshing the first VM after a second VM registers its services used to
    // silently register pen on the wrong runtime.
    await session.execute(['open', file, '--force']);
    await other.project.vm.extensionManager.refreshBlocks();
    await other.execute(['block', 'add', 'pen_clear']);
    await session.execute(['block', 'add', 'pen_clear']);
    const vm = other.project.vm, renderer = other.project.renderer;
    assert.ok(vm.runtime.targets.length);
    other.dispose(); other.dispose();
    assert.equal(vm.runtime.targets.length, 0); assert.equal(vm.runtime.executableTargets.length, 0);
    assert.equal(vm.runtime.threads.length, 0); assert.equal(vm.runtime.eventNames().length, 0);
    assert.equal(other.project.vm, null);
    assert.equal((await session.execute(['run', '--frames', '1'])).noDOM, true);
  } finally {other.dispose();}
}));

test('Node bootstrap hands off an incompatible host and rejects invalid overrides before native addons', () => {
  const result = cli(['--version']); assert.equal(result.status, 0, result.stderr);
  const incompatible = spawnSync(process.execPath, ['-e', `
    Object.defineProperty(process.versions, 'node', {value: '26.0.0'});
    require('node:module').runMain(${JSON.stringify(path.join(__dirname, '../bin/tw.js'))});
  `], {encoding: 'utf8', timeout: 5000});
  assert.equal(incompatible.status, 0, incompatible.stderr);
  assert.doesNotMatch(incompatible.stderr, /NODE_MODULE_VERSION|dlopen/);
  const invalid = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), '--version'],
    {encoding: 'utf8', timeout: 5000, env: {...process.env, TW_NODE: '/missing/explicit/node24'}});
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Node.js 24 is required/);
  assert.doesNotMatch(invalid.stderr, /NODE_MODULE_VERSION|dlopen/);
});

test('failed new output keeps prior unsaved work, history and cloud binding', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'), occupied = path.join(dir, 'occupied.sb3'), state = path.join(dir, 'cloud.json');
  await session.execute(['new', file]); await fs.mkdir(occupied);
  const result = jsonl([request('open', file), request('cloud', 'use', state), request('sprite', 'set', 'x', '81'),
    request('input', 'key', 'space', 'down'), request('info'), request('history'),
    request('new', '--force', '--out', occupied), request('info'), request('history'), request('cloud', 'list'),
    request('save'), request('quit')]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.replies[6].ok, false);
  assert.deepEqual(result.replies[7].result, result.replies[4].result);
  assert.deepEqual(result.replies[8].result, result.replies[5].result);
  assert.equal(result.replies[9].result.file, state);
  assert.equal(JSON.parse(cli(['info', '--project', file]).stdout).targets[1].x, 81);
  assert.ok((await fs.stat(occupied)).isDirectory());
}));

test('cloud variable count, value and name boundaries are enforced without stray writes', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'), state = path.join(dir, 'cloud.json'); await session.execute(['new', file]);
  const requests = [request('open', file), request('cloud', 'use', state),
    ...Array.from({length: 10}, (_, index) => request('cloud', 'add', `☁ c${index}`, String(index))),
    request('cloud', 'add', 'overflow', '0'), request('cloud', 'add', 'n'.repeat(257), '0'),
    request('cloud', 'set', '☁ c0', 'x'.repeat(10001)), request('var', 'rename', '☁ c0', 'n'.repeat(257), '--target', 'stage'),
    request('cloud', 'set', '☁ c0', 'x'.repeat(10000)), request('cloud', 'get', '☁ c0'),
    request('var', 'delete', '☁ c9', '--target', 'stage'), request('cloud', 'add', 'replacement', '9'),
    request('save'), request('quit')];
  const result = jsonl(requests); assert.equal(result.status, 0, result.stderr);
  assert.ok(result.replies.slice(2, 12).every(reply => reply.ok));
  for (const index of [12, 13, 14, 15]) assert.equal(result.replies[index].ok, false);
  assert.equal(result.replies[17].result.value.length, 10000);
  const values = JSON.parse(await fs.readFile(state, 'utf8')).values;
  assert.equal(Object.keys(values).length, 10); assert.ok(!Object.hasOwn(values, 'overflow')); assert.equal(values.replacement, 9);
  const info = JSON.parse(cli(['info', '--project', file]).stdout); assert.equal(info.targets[0].variables.filter(variable => variable.cloud).length, 10);
}));

test('watch list samples are value snapshots and target/global selection is deterministic', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const list = await session.execute(['list', 'add', 'items', '[]']);
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  const loop = await session.execute(['block', 'add', 'control_forever', '--after', hat.id]);
  await session.execute(['block', 'add', 'data_addtolist', '--inputs', '{"ITEM":"coin"}', '--fields', '{"LIST":"items"}', '--parent', loop.id, '--input', 'SUBSTACK']);
  await session.execute(['var', 'add', 'global', '9', '--target', 'stage']);
  const file = path.join(dir, 'list.sb3'); await session.execute(['save', file]);
  const result = jsonl([request('open', file), request('run', '--seed', '0', '--frames', '3', '--watch', list.id),
    request('run', '--seed', '0', '--frames', '1', '--watch', 'global'), request('info'), request('quit')]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.replies[1].result.watch.samples.map(sample => sample.value), [['coin'], ['coin', 'coin'], ['coin', 'coin', 'coin']]);
  assert.equal(result.replies[2].result.watch.samples[0].value, 9);
  assert.equal(result.replies[2].result.watch.targetId, result.replies[3].result.targets[0].id);
  assert.deepEqual(result.replies[3].result.targets[1].variables[0].value, []);
}));

test('session dispose terminates an in-flight native worker and rejects its unfinished run', async () => withSession(async session => {
  await session.execute(['new']);
  const running = session.execute(['run', '--frames', '100000']);
  const rejected = assert.rejects(running, /Runtime exited|disposed/);
  const deadline = Date.now() + 5000;
  while (!session.workers.size) {assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve));}
  const [worker] = session.workers;
  session.dispose(); await rejected;
  assert.ok(worker.signalCode || worker.exitCode !== null);
  assert.equal(session.workers.size, 0);
  await assert.rejects(session.execute(['new']), /disposed/);
  const early = new CommandSession();
  try {
    await early.execute(['new']);
    const pending = early.execute(['run', '--frames', '100000']);
    const rejected = assert.rejects(pending, /disposed/);
    early.dispose(); await rejected;
    assert.equal(early.workers.size, 0);
  } finally {early.dispose();}
}));

test('block move refuses to overwrite occupied links or create cycles; persisted graph still runs', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const script = await session.execute(['script', 'demo', '25']);
  const stray = await session.execute(['block', 'add', 'motion_movesteps', '--inputs', '{"STEPS":99}']);
  const file = path.join(dir, 'graph.sb3'); await session.execute(['save', file]);
  const result = jsonl([request('open', file), request('block', 'move', stray.id, '--after', script.blocks[0]),
    request('block', 'move', script.blocks[0], '--after', script.blocks[1]), request('history'),
    request('run', '--frames', '2'), request('save'), request('quit')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.replies[1].ok, false); assert.match(result.replies[1].error, /already|occupied/);
  assert.equal(result.replies[2].ok, false); assert.match(result.replies[2].error, /cycle/);
  assert.deepEqual(result.replies[3].result, {undo: [], redo: []});
  assert.equal(result.replies[4].result.targets[1].x, 25);
  const saved = await JSZip.loadAsync(await fs.readFile(file)); const graph = JSON.parse(await saved.file('project.json').async('string')).targets[1].blocks;
  assert.equal(graph[script.blocks[0]].next, script.blocks[1]); assert.equal(graph[stray.id].parent, null);
}));

test('late SB3 asset rejection and malformed identity metadata preserve selection, cloud and undo history', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'), cloud = path.join(dir, 'cloud.json'); await session.execute(['new', file]);
  const inputs = [];
  for (const identity of [null, {version: 2, targets: ['stage-id', 'sprite-id']}, {version: 1, targets: ['same', 'same']}]) {
    const zip = await JSZip.loadAsync(await fs.readFile(file)); zip.file('tw-cli-state.json', JSON.stringify(identity));
    const output = path.join(dir, `identity-${inputs.length}.sb3`); await fs.writeFile(output, await zip.generateAsync({type: 'nodebuffer'})); inputs.push(output);
  }
  const zip = await JSZip.loadAsync(await blankProject()); const json = JSON.parse(await zip.file('project.json').async('string'));
  zip.file(json.targets[1].costumes[0].md5ext, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script/></svg>');
  const output = path.join(dir, 'unsafe-svg.sb3'); await fs.writeFile(output, await zip.generateAsync({type: 'nodebuffer'})); inputs.push(output);
  const result = jsonl([request('open', file), request('cloud', 'use', cloud), request('cloud', 'add', '☁ score', '7'),
    request('sprite', 'select', 'stage'), request('sprite', 'set', 'x', '81', '--target', 'Sprite1'), request('info'), request('history'),
    ...inputs.flatMap(file => [request('open', file, '--force'), request('info'), request('history'), request('cloud', 'get', '☁ score')]),
    request('save'), request('quit')]);
  assert.equal(result.status, 0, result.stderr);
  for (let index = 0; index < inputs.length; index++) {
    assert.equal(result.replies[7 + index * 4].ok, false);
    assert.deepEqual(result.replies[8 + index * 4].result, result.replies[5].result);
    assert.deepEqual(result.replies[9 + index * 4].result, result.replies[6].result);
    assert.equal(result.replies[10 + index * 4].result.value, 7);
  }
}));

test('real 30-second runtime deadline kills the worker and JSONL accepts the next run', {timeout: 45000}, async () => withSession(async (session, dir) => {
  await session.execute(['new']); await session.execute(['var', 'add', 'count', '0']);
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  const loop = await session.execute(['block', 'add', 'control_forever', '--after', hat.id]);
  await session.execute(['block', 'add', 'data_changevariableby', '--fields', '{"VARIABLE":"count"}', '--inputs', '{"VALUE":1}',
    '--parent', loop.id, '--input', 'SUBSTACK']);
  const file = path.join(dir, 'timeout.sb3'); await session.execute(['save', file]);
  const requests = [request('open', file), request('run', '--frames', '100000'), request('info'),
    request('run', '--frames', '1', '--seed', '0', '--watch', 'count'), request('quit')];
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'],
    {input: requests.map(item => JSON.stringify(item)).join('\n') + '\n', encoding: 'utf8', timeout: 40000});
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[1].ok, false); assert.match(replies[1].error, /exceeded 30 second/);
  assert.equal(replies[2].result.dirty, false); assert.equal(replies[2].result.targets[1].variables[0].value, 0);
  assert.equal(replies[3].result.watch.samples[0].value, 1);
  assert.equal(replies[4].result.closed, true);
}));

test('renaming a cloud variable to its existing name never deletes the shared value', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'), state = path.join(dir, 'cloud.json'); await session.execute(['new', file]);
  const result = jsonl([request('open', file), request('cloud', 'use', state), request('cloud', 'add', '☁ score', '18'),
    request('var', 'rename', '☁ score', '☁ score', '--target', 'stage'), request('cloud', 'get', '☁ score'),
    request('save'), request('quit')]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.replies[3].ok, true);
  assert.equal(result.replies[4].result.value, 18);
  assert.deepEqual(JSON.parse(await fs.readFile(state, 'utf8')).values, {'☁ score': 18});
  assert.equal(JSON.parse(cli(['info', '--project', file]).stdout).targets[0].variables[0].value, 18);
}));

test('invalid cloud metadata in imported SB3 fails closed rather than becoming local or escaping limits', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'project.sb3'); await session.execute(['new', file]);
  const invalid = [];
  for (const mode of ['limit', 'sprite', 'object', 'name', 'value']) {
    const zip = await JSZip.loadAsync(await blankProject()); const json = JSON.parse(await zip.file('project.json').async('string'));
    const target = mode === 'sprite' ? json.targets[1] : json.targets[0];
    target.variables = mode === 'limit' ? Object.fromEntries(Array.from({length: 11}, (_, index) => [`id${index}`, [`☁ c${index}`, 0, true]])) :
      {cloudId: [mode === 'name' ? 'n'.repeat(257) : '☁ score', mode === 'object' ? {} : mode === 'value' ? 'x'.repeat(10001) : 0, true]};
    zip.file('project.json', JSON.stringify(json)); const output = path.join(dir, `${mode}.sb3`);
    await fs.writeFile(output, await zip.generateAsync({type: 'nodebuffer'})); invalid.push(output);
  }
  const result = jsonl([request('open', file), request('info'),
    ...invalid.flatMap(file => [request('open', file, '--force'), request('info')]), request('quit')]);
  assert.equal(result.status, 0, result.stderr);
  for (let index = 0; index < invalid.length; index++) {
    assert.equal(result.replies[2 + index * 2].ok, false);
    assert.match(result.replies[2 + index * 2].error, /cloud/i);
    assert.deepEqual(result.replies[3 + index * 2].result, result.replies[1].result);
  }
}));

test('cloud reads enforce regular-file and size limits after attachment; outputs refuse symlinks', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const state = path.join(dir, 'cloud.json');
  await session.execute(['cloud', 'use', state]); await session.execute(['cloud', 'add', '☁ score', '7']);
  const safe = await fs.readFile(state);
  const outside = path.join(dir, 'outside.json'); await fs.writeFile(outside, safe);
  await fs.unlink(state); await fs.symlink(outside, state);
  await assert.rejects(session.execute(['cloud', 'get', '☁ score']), /Unsafe|regular|symlink/i);
  await assert.rejects(session.execute(['run', '--frames', '1']), /Unsafe|regular|symlink/i);
  await fs.unlink(state); await fs.writeFile(state, JSON.stringify({version: 1, values: {}}) + ' '.repeat(2 * 1024 * 1024));
  await assert.rejects(session.execute(['cloud', 'sync']), /oversized|limit/i);
  const output = path.join(dir, 'linked.sb3'); await fs.symlink(outside, output);
  const result = cli(['new', output, '--force']);
  assert.equal(result.status, 1); assert.match(result.stderr, /non-regular/);
  assert.deepEqual(await fs.readFile(outside), safe);
  assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
}));
