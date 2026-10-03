const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const {Project, blankProject, readProject, readSpriteArchive, readLocalFile, md5} = require('../src/project');
const {LibraryStore, FileStore} = require('../src/library-store');
const io = require('../src/project-io-commands');
const {CommandSession} = require('../src/commands');
const fixtures = path.join(path.dirname(require.resolve('scratch-parser')), 'test/fixtures/data');
require('../src/network-policy').install();

const temporary = async run => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-project-io-'));
  try {return await run(dir);} finally {await fs.rm(dir, {recursive: true, force: true});}
};
const call = (session, command, args, options = {}) => io.isReadOnly(command, args) ? io.execute(session, command, args, options) :
  session.transaction(`${command} ${args.join(' ')}`, () => io.execute(session, command, args, options));
const withSession = run => temporary(async dir => {
  const session = new CommandSession();
  try {await session.execute(['new']); return await run(session, dir);} finally {session.dispose();}
});
const projectAssets = async bytes => {
  const zip = await JSZip.loadAsync(bytes); const json = JSON.parse(await zip.file('project.json').async('string'));
  const assets = new Map();
  for (const target of json.targets) for (const asset of [...target.costumes, ...target.sounds]) assets.set(asset.md5ext, await zip.file(asset.md5ext).async('nodebuffer'));
  return {json, assets};
};
// Real ScratchV02 object stream. Object-table records/references are encoded by
// the documented frozen SB1 format, not a renamed SB3/JSON pretending to be SB.
const sbFixture = () => {
  const int = n => {const b = Buffer.alloc(5); b[0] = 4; b.writeInt32BE(n, 1); return b;};
  const string = value => {const b = Buffer.from(value); return Buffer.concat([Buffer.from([9]), u32(b.length), b]);};
  const u32 = n => {const b = Buffer.alloc(4); b.writeUInt32BE(n); return b;};
  const ref = n => Buffer.from([99, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const nil = Buffer.from([1]);
  const array = values => Buffer.concat([Buffer.from([20]), u32(values.length), ...values]);
  const object = (type, values) => Buffer.concat([Buffer.from([type, 1, values.length]), ...values]);
  const point = (x, y) => Buffer.concat([Buffer.from([32]), int(x), int(y)]);
  const fields = Array(21).fill(nil);
  fields[2] = array([]); fields[6] = string('Stage'); fields[7] = array([string('score'), int(17)]); fields[8] = array([]);
  fields[10] = ref(6); fields[11] = ref(2); fields[16] = array([]); fields[18] = int(77); fields[20] = array([]);
  const costume = object(162, [string('bitmap'), ref(3), point(1, 1), nil, nil, nil]);
  const bitmap = Buffer.concat([Buffer.from([34]), int(2), int(2), int(32), nil, Buffer.from([13]), u32(4),
    Buffer.from([255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255])]);
  const pcm = Buffer.from([0x20, 0, 0xe0, 0, 0x10, 0, 0, 0]);
  const uncompressed = object(109, [nil, nil, nil, Buffer.concat([Buffer.from([11]), u32(pcm.length), pcm]), int(22050)]);
  const sound = object(164, [string('tone'), ref(5), nil, nil, int(22050), int(16), nil]);
  const tableHeader = n => Buffer.concat([Buffer.from('ObjS\x01Stch\x01', 'binary'), u32(n)]);
  const info = Buffer.concat([tableHeader(1), array([])]);
  const data = Buffer.concat([tableHeader(6), object(125, fields), costume, bitmap, sound, uncompressed, array([ref(2), ref(4)])]);
  return Buffer.concat([Buffer.from('ScratchV02'), u32(info.length), info, data]);
};

test('real binary SB, frozen SB2/nested-SB2 and SB3 import offline; bytes and converted state survive reload', async () => {
  const inputs = [['sb', sbFixture()], ['sb2', await fs.readFile(path.join(fixtures, '_empty.sb2'))],
    ['sb2', await fs.readFile(path.join(fixtures, '_nestedFolder.sb2'))], ['sb3', await fs.readFile(path.join(fixtures, '_spriteNamedStage.sb3'))]];
  for (const [format, bytes] of inputs) {
    const project = new Project();
    try {
      const prepared = await readProject(bytes); assert.equal(prepared.sourceFormat, format);
      const expected = await projectAssets(prepared.bytes);
      await project.load(bytes); assert.equal(project.sourceFormat, format);
      const saved = await projectAssets(await project.bytes());
      for (const [name, data] of expected.assets) assert.deepEqual(saved.assets.get(name), data, `${format}: ${name}`);
      if (format === 'sb') {
        assert.equal(project.vm.runtime.getTargetForStage().tempo, 77);
        assert.equal(Object.values(project.target('stage').variables).find(v => v.name === 'score').value, 17);
        assert.equal(project.target('stage').getSounds()[0].sampleCount, 8, '22050 Hz SB PCM decoded to the 44100 Hz offline VM rate');
      }
      const ids = project.info().targets.map(t => t.id);
      const assetIds = project.vm.runtime.targets.filter(t => t.isOriginal).flatMap(t => [...t.getCostumes(), ...t.getSounds()].map(a => a.cliId));
      await project.load(await project.bytes());
      assert.deepEqual(project.info().targets.map(t => t.id), ids);
      assert.deepEqual(project.vm.runtime.targets.filter(t => t.isOriginal).flatMap(t => [...t.getCostumes(), ...t.getSounds()].map(a => a.cliId)), assetIds);
      assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
    } finally {project.dispose();}
  }
});

test('project import/export integrates as an undoable edit, never changes save path and validates before replacement', async () => withSession(async (session, dir) => {
  const input = path.join(dir, 'legacy.sb2'), output = path.join(dir, 'converted.sb3');
  await fs.writeFile(input, await fs.readFile(path.join(fixtures, '_empty.sb2')));
  const selected = session.project.target().id; await session.execute(['sprite', 'set', 'x', '44']);
  const result = await session.execute(['project', 'import', input]); assert.equal(result.sourceFormat, 'sb2');
  assert.equal(session.project.file, null); assert.equal(session.dirty, true);
  await session.execute(['project', 'export', '--output', output]);
  const saved = await projectAssets(await fs.readFile(output)); assert.equal(saved.json.targets.length, 2);
  await session.execute(['undo']); assert.equal(session.project.target().id, selected); assert.equal(session.project.target().x, 44);
  const bad = path.join(dir, 'bad.sb'); await fs.writeFile(bad, 'not a project');
  await assert.rejects(session.execute(['project', 'import', bad]), /archive|Scratch/);
  assert.equal(session.project.target().id, selected); assert.equal(session.project.target().x, 44);
}));

test('legacy layer order follows children, independent of target pane order; duplicate names do not collapse SB3 layers', async () => {
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(fixtures, '_empty.sb2')));
  const json = JSON.parse(await zip.file('project.json').async('string'));
  const original = json.children.find(child => child.objName);
  json.children = [{...structuredClone(original), objName: 'Back', indexInLibrary: 2}, {...structuredClone(original), objName: 'Front', indexInLibrary: 1}];
  zip.file('project.json', JSON.stringify(json));
  const project = new Project();
  try {
    await project.load(await zip.generateAsync({type: 'nodebuffer'}));
    const saved = (await projectAssets(await project.bytes())).json;
    assert.ok(saved.targets.find(t => t.name === 'Back').layerOrder < saved.targets.find(t => t.name === 'Front').layerOrder);
    const sprites = saved.targets.filter(t => !t.isStage); sprites[0].name = sprites[1].name = 'Same'; sprites[0].layerOrder = 9; sprites[1].layerOrder = 2;
    const sb3 = await JSZip.loadAsync(await project.bytes()); sb3.remove('tw-cli-state.json'); sb3.file('project.json', JSON.stringify(saved));
    await project.load(await sb3.generateAsync({type: 'nodebuffer'}));
    const output = (await projectAssets(await project.bytes())).json.targets.filter(t => !t.isStage);
    assert.ok(output[0].layerOrder > output[1].layerOrder);
  } finally {project.dispose();}
});

test('missing/hash-mismatched assets, traversal, invalid stable asset IDs and legacy executable extensions fail closed', async () => withSession(async session => {
  const before = await session.snapshot(); const id = session.project.target().id;
  const base = await JSZip.loadAsync(before); const json = JSON.parse(await base.file('project.json').async('string'));
  base.remove(json.targets[1].costumes[0].md5ext);
  await assert.rejects(session.project.load(await base.generateAsync({type: 'nodebuffer'})), /Missing.*asset/);
  const corrupt = await JSZip.loadAsync(before); corrupt.file(json.targets[1].costumes[0].md5ext, 'wrong');
  await assert.rejects(session.project.load(await corrupt.generateAsync({type: 'nodebuffer'})), /MD5 mismatch/);
  const traversal = await JSZip.loadAsync(before); traversal.file('../escape', 'evil');
  await assert.rejects(readProject(await traversal.generateAsync({type: 'nodebuffer'})), /Unsafe archive/);
  const invalid = await JSZip.loadAsync(before); const state = JSON.parse(await invalid.file('tw-cli-state.json').async('string'));
  state.assets[state.targets[1]].costumes[0] = state.assets[state.targets[0]].costumes[0]; invalid.file('tw-cli-state.json', JSON.stringify(state));
  await assert.rejects(session.project.load(await invalid.generateAsync({type: 'nodebuffer'})), /asset identity/);
  const legacy = await JSZip.loadAsync(await fs.readFile(path.join(fixtures, '_empty.sb2'))); const old = JSON.parse(await legacy.file('project.json').async('string'));
  old.info = {savedExtensions: [{extensionName: 'evil', javascriptURL: 'https://example.invalid/evil.js'}]}; legacy.file('project.json', JSON.stringify(old));
  await assert.rejects(readProject(await legacy.generateAsync({type: 'nodebuffer'})), /executable extensions.*denied/);
  old.info = {}; old.children.find(t => t.objName).scripts = [[0, 0, [['evil.run']]]]; legacy.file('project.json', JSON.stringify(old));
  await assert.rejects(readProject(await legacy.generateAsync({type: 'nodebuffer'})), /not approved|denied/);
  assert.equal(session.project.target().id, id);
  assert.deepEqual((await projectAssets(await session.snapshot())).assets, (await projectAssets(before)).assets);
}));

test('sprite3 export/import writes positional/output paths, exact assets and graph; main transaction provides undo', async () => withSession(async (session, dir) => {
  const target = session.project.target();
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  await session.execute(['block', 'add', 'motion_movesteps', '--inputs', '{"STEPS":31}', '--after', hat.id]);
  const file = path.join(dir, 'sprite.sprite3');
  await call(session, 'project', ['export-sprite'], {output: file});
  const {sprite, zip} = await readSpriteArchive(await fs.readFile(file));
  assert.equal(sprite.name, target.getName()); assert.equal(Object.values(sprite.blocks).filter(b => b.opcode).length, 2);
  for (const asset of target.getCostumes()) assert.deepEqual(await zip.file(asset.md5).async('nodebuffer'), Buffer.from(asset.asset.data));
  const imported = await call(session, 'project', ['import-sprite', file]); assert.notEqual(imported.id, target.id);
  await session.execute(['undo']); assert.equal(session.project.info().targets.length, 2);
  await assert.rejects(call(session, 'project', ['export-sprite', file], {out: path.join(dir, 'bad.sb3')}), /Unsupported option/);
  await assert.rejects(call(session, 'project', ['export-sprite', file]), /EEXIST/);
  const symlink = path.join(dir, 'linked.sprite3'); await fs.symlink(file, symlink);
  await assert.rejects(call(session, 'project', ['import-sprite', symlink]), /ELOOP|symlink/);
}));

test('frozen library categories/search are local; missing materials report exact path and explicit fetch', async () => temporary(async dir => {
  const library = new LibraryStore(dir);
  assert.equal((await library.entries('sprite')).length, 333);
  assert.equal((await library.entries('costume')).length, 859);
  assert.equal((await library.entries('sound')).length, 353);
  assert.equal((await library.entries('backdrop')).length, 85);
  const search = await library.browse('sprite', {query: 'cat', category: 'animals'});
  assert.ok(search.items.some(entry => /cat/i.test(entry.name)));
  assert.ok((await library.categories('sound')).categories.some(c => c.tag === 'loops' && c.count > 0));
  const costume = await library.select('costume', 'Abby-a');
  await assert.rejects(library.readAsset(costume.md5ext), error => error.message.includes(path.join(dir, costume.md5ext + '.br')) && error.message.includes('fetch-cli-library.js') && error.message.includes('no implicit network'));
  await assert.rejects(library.readAsset('../escape.svg'), /Invalid.*ID/);
  await fs.writeFile(path.join(dir, `${costume.md5ext}.br`), require('node:zlib').brotliCompressSync(Buffer.from('fake asset')));
  await assert.rejects(library.readAsset(costume.md5ext), /MD5\/SHA256 mismatch/);
  const external = path.join(dir, 'external'); await fs.writeFile(external, 'no');
  await fs.symlink(external, path.join(dir, '83a9787d4cb6f3b7632b4ddfebf74367.wav.br'));
  await assert.rejects(library.readAsset('83a9787d4cb6f3b7632b4ddfebf74367.wav'), /ELOOP/);
}));

test('atomic backpack persists every type across sessions and restore points preserve selected ID/monitor/asset IDs', async () => withSession(async (session, dir) => {
  const backpack = path.join(dir, 'backpack'), restore = path.join(dir, 'restore');
  await call(session, 'backpack', ['use', backpack]); await call(session, 'project', ['restore-use', restore]);
  await session.execute(['var', 'add', 'score', '7']); await session.execute(['monitor', 'add', 'score']);
  const hat = await session.execute(['block', 'add', 'event_whenflagclicked']);
  await session.execute(['block', 'add', 'data_setvariableto', '--fields', JSON.stringify({VARIABLE: ['score', session.project.target().variables[Object.keys(session.project.target().variables)[0]].id]}), '--inputs', '{"VALUE":42}', '--after', hat.id]);
  const {wav} = require('../src/commands');
  const soundFile = path.join(dir, 'tone.wav'); await fs.writeFile(soundFile, wav({length: 4, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array([0.1, -0.2, 0.3, 0])}));
  await session.execute(['sound', 'add', soundFile]);
  const selected = session.project.target().id; session.project.ensureAssetIds(session.project.target());
  const assetId = session.project.target().getCostumes()[0].cliId;
  const ids = {};
  for (const [type, selector] of [['project'], ['sprite'], ['block', hat.id], ['costume', assetId], ['sound', 'tone']]) {
    const result = await call(session, 'backpack', ['save', type, `${type} fixture`, ...(selector ? [selector] : [])]); ids[type] = result.id;
  }
  const point = await call(session, 'project', ['restore-save', 'before rename']);
  await session.execute(['sprite', 'rename', 'changed']);
  await call(session, 'project', ['restore', point.id]);
  assert.equal(session.project.target().id, selected); assert.equal(session.project.target().getName(), 'Sprite1');
  assert.equal(session.project.target().getCostumes()[0].cliId, assetId);
  assert.equal(Array.from(session.project.vm.runtime.getMonitorState().valueSeq())[0].targetId, selected);
  assert.equal((await call(session, 'backpack', ['list'])).items.length, 5);
  const other = new CommandSession();
  try {
    await other.execute(['new']); await call(other, 'backpack', ['use', backpack]);
    assert.equal((await call(other, 'backpack', ['list'])).items.length, 5);
    const current = other.project.target();
    await call(other, 'backpack', ['load', ids.costume]); assert.equal(other.project.target().getCostumes().length, 2);
    await call(other, 'backpack', ['load', ids.sound]); assert.equal(other.project.target().getSounds().length, 1);
    await call(other, 'backpack', ['load', ids.block]); assert.ok(Object.values(current.blocks._blocks).some(b => b.opcode === 'data_setvariableto'));
    await call(other, 'backpack', ['load', ids.sprite]); assert.equal(other.project.info().targets.length, 3);
    await call(other, 'backpack', ['load', ids.project]); assert.equal(other.project.target().id, selected);
    assert.equal(other.project.target().getCostumes()[0].cliId, assetId);
    await assert.rejects(call(other, 'backpack', ['load', '../escape']), /UUID/);
    const item = path.join(backpack, `${ids.sound}.backpack.zip`); const outside = path.join(dir, 'outside'); await fs.rename(item, outside); await fs.symlink(outside, item);
    await assert.rejects(call(other, 'backpack', ['load', ids.sound]), /ELOOP/);
  } finally {other.dispose();}
}));

test('approved loaded extensions persist in private metadata without unused-extension JSON hacks', async () => withSession(async session => {
  await session.project.vm.extensionManager.loadExtensionURL('pen');
  const zip = await JSZip.loadAsync(await session.snapshot());
  const state = JSON.parse(await zip.file('tw-cli-state.json').async('string'));
  assert.ok(state.extra.loadedExtensions.includes('pen'));
  await session.restore(await session.snapshot());
  assert.equal(session.project.vm.extensionManager.isExtensionLoaded('pen'), true);
  state.extra.loadedExtensions.push('https://example.invalid/evil.js'); zip.file('tw-cli-state.json', JSON.stringify(state));
  await assert.rejects(session.project.load(await zip.generateAsync({type: 'nodebuffer'})), /not approved/);
}));

test('Project safely reloads exact offline videoSensing/Gamepad reporter fixtures without DOM or capture', async () => {
  const zip = await JSZip.loadAsync(await blankProject()); const json = JSON.parse(await zip.file('project.json').async('string'));
  json.extensions = ['videoSensing', 'Gamepad']; json.targets[1].blocks = {
    pad: {opcode: 'Gamepad_axisValue', next: null, parent: null, inputs: {i: [1, [4, 1]], b: [1, [4, 1]]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0},
    motion: {opcode: 'videoSensing_videoOn', next: null, parent: null, inputs: {ATTRIBUTE: [1, [10, 'motion']], SUBJECT: [1, [10, 'Stage']]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 100}
  }; zip.file('project.json', JSON.stringify(json));
  const project = new Project();
  try {
    await project.load(await zip.generateAsync({type: 'nodebuffer'}));
    for (let i = 0; i < 2; i++) {
      assert.equal(project.vm.extensionManager.isExtensionLoaded('videoSensing'), true);
      assert.equal(project.vm.extensionManager.isExtensionLoaded('Gamepad'), true);
      assert.equal(typeof project.vm.runtime._primitives.Gamepad_axisValue, 'function');
      assert.equal(typeof project.vm.runtime._primitives.videoSensing_videoOn, 'function');
      assert.equal(project.audio.getLoudness(), -1);
      assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
      assert.throws(() => project.vm.runtime._linkSocketFactory(), /denied/);
      await project.load(await project.bytes());
    }
  } finally {project.dispose();}
});

test('library reads genuine frozen WAV bytes from an explicit cache and sound load survives project save', async () => withSession(async (session, dir) => {
  const cache = path.join(dir, 'library'); await fs.mkdir(cache);
  const source = await JSZip.loadAsync(await fs.readFile(path.join(fixtures, '_empty.sb2')));
  const bytes = await source.file('0.wav').async('nodebuffer'); const name = `${md5(bytes)}.wav`;
  await fs.writeFile(path.join(cache, name + '.br'), require('node:zlib').brotliCompressSync(bytes));
  const library = new LibraryStore(cache); assert.deepEqual(await library.readAsset(name), bytes);
  const entry = (await library.entries('sound')).find(entry => entry.md5ext === name); assert.ok(entry);
  await call(session, 'library', ['load', 'sound', entry.name], {dir: cache});
  const sound = session.project.target().getSounds()[0]; assert.deepEqual(Buffer.from(sound.asset.data), bytes);
  const saved = await projectAssets(await session.snapshot()); assert.deepEqual(saved.assets.get(name), bytes);
}));

test('installed frozen library loads sprite/costume/sound/backdrop with exact assets and reopen semantics', async t => withSession(async session => {
  const library = new LibraryStore();
  const selections = [['sprite', 'Abby'], ['costume', 'Abby-a'], ['sound', 'Meow'], ['backdrop', 'Arctic']];
  for (const [kind, name] of selections) {
    const descriptor = await library.select(kind, name);
    const assets = descriptor.md5ext ? [descriptor] : [...descriptor.costumes, ...descriptor.sounds];
    for (const asset of assets) {
      try {await library.readAsset(asset.md5ext);} catch (error) {
        if (error.message.startsWith('Missing frozen library asset:')) {t.skip(`actual library missing: ${asset.md5ext}`); return;}
        throw error;
      }
    }
    const result = await call(session, 'library', ['load', kind, name], kind === 'sprite' ? {} : {target: 'Sprite1'});
    const target = kind === 'backdrop' ? session.project.target('stage') : kind === 'sprite' ? session.project.target(result.id) : session.project.target('Sprite1');
    for (const asset of assets) {
      const loaded = [...target.getCostumes(), ...target.getSounds()].find(a => a.assetId === asset.assetId);
      assert.ok(loaded, `${kind}: ${asset.name}`);
      assert.deepEqual(Buffer.from(loaded.asset.data), await library.readAsset(asset.md5ext));
    }
  }
  const bytes = await session.snapshot(); const assets = (await projectAssets(bytes)).assets;
  await session.restore(bytes);
  assert.deepEqual((await projectAssets(await session.snapshot())).assets, assets);
  assert.ok(session.project.target('Abby').getCostumes().length >= 4);
}));

test('store payload checksum, malicious block graph and prototype keys cannot mutate a project', async () => withSession(async (session, dir) => {
  const store = new FileStore(path.join(dir, 'backpack'), 'backpack');
  const item = await store.save('block', 'malicious', Buffer.from(JSON.stringify({version: 1, variables: [], blocks: [
    {id: 'cycle', opcode: 'motion_movesteps', next: 'cycle', parent: null, inputs: {}, fields: {}, topLevel: true}
  ]})));
  const id = session.project.target().id;
  await assert.rejects(call(session, 'backpack', ['load', item.id], {dir: store.directory}), /Cyclic/);
  assert.equal(session.project.target().id, id);
  const archive = await JSZip.loadAsync(await fs.readFile(item.path)); archive.file('payload', 'tampered'); await fs.writeFile(item.path, await archive.generateAsync({type: 'nodebuffer'}));
  await assert.rejects(store.read(item.id), /checksum/);
  const linked = path.join(dir, 'linked-store'); await fs.symlink(store.directory, linked);
  await assert.rejects(new FileStore(linked, 'backpack').list(), /symlink/);
  const nested = path.join(dir, 'linked-parent'); await fs.symlink(dir, nested);
  await assert.rejects(new FileStore(path.join(nested, 'backpack'), 'backpack').list(), /symlink/);
  const zip = await JSZip.loadAsync(await session.snapshot()); const json = JSON.parse(await zip.file('project.json').async('string'));
  json.targets[1].variables = JSON.parse('{"__proto__":["bad",1]}'); zip.file('project.json', JSON.stringify(json));
  await assert.rejects(readProject(await zip.generateAsync({type: 'nodebuffer'})), /prototype/);
}));

test('router recognizes project/library/backpack specs and output is not project persistence', async () => withSession(async (session, dir) => {
  const result = await session.execute(['library', 'categories', 'sprite']); assert.equal(result.kind, 'sprite');
  const file = path.join(dir, 'result.sprite3');
  await session.execute(['project', 'export-sprite', '--output', file]); assert.ok((await fs.stat(file)).size > 0);
  assert.equal(session.project.file, null);
  await assert.rejects(session.execute(['project', 'export-sprite', '--out', path.join(dir, 'wrong.sb3')]), /not supported|Unsupported|Unknown|not allowed/);
}));

test('stable asset metadata survives rename/reorder/duplicate bytes and rejects cardinality corruption', async () => withSession(async session => {
  const target = session.project.target(), costume = target.getCostumes()[0];
  const duplicate = {...costume, name: 'duplicate bytes'}; target.addCostume(duplicate); session.project.ensureAssetIds(target);
  assert.notEqual(duplicate.cliId, costume.cliId); const ids = [costume.cliId, duplicate.cliId];
  target.sprite.costumes.reverse(); costume.name = 'renamed';
  await session.restore(await session.snapshot(), target.id);
  assert.deepEqual(session.project.target().getCostumes().map(c => c.cliId), ids.reverse());
  const zip = await JSZip.loadAsync(await session.snapshot()); const state = JSON.parse(await zip.file('tw-cli-state.json').async('string'));
  state.assets[target.id].costumes.pop(); zip.file('tw-cli-state.json', JSON.stringify(state));
  await assert.rejects(session.project.load(await zip.generateAsync({type: 'nodebuffer'})), /asset identity/);
}));

test('project fetch defaults deny and uses the shared downloader with exact grants, bounds and atomic verified output', async t => withSession(async (session, dir) => {
  const canonical = await fs.realpath(dir); const file = path.join(canonical, 'download.sb3');
  await assert.rejects(call(session, 'project', ['fetch', 'https://example.invalid/project.sb3', file]), /权限拒绝|deny/i);
  const bytes = await blankProject();
  const network = require('../src/network-policy');
  t.mock.method(network, 'fetchBytes', async (url, policy, bounds) => {
    policy.require('net', new URL(url).hostname);
    assert.equal(bounds.maxBytes, 65536); assert.equal(bounds.timeoutMs, 1000); assert.equal(bounds.httpsOnly, true);
    return bytes;
  });
  await call(session, 'project', ['fetch', 'https://example.invalid/project.sb3', file],
    {allow: 'net:example.invalid', 'max-bytes': '65536', 'timeout-ms': '1000'});
  assert.deepEqual((await projectAssets(await fs.readFile(file))).assets, (await projectAssets(bytes)).assets);
  assert.equal(session.project.file, null);
  await assert.rejects(call(session, 'project', ['fetch', 'https://else.invalid/p.sb3', file],
    {allow: 'net:example.invalid', 'max-bytes': '65536', 'timeout-ms': '1000'}), /权限拒绝/);
}));

test('shared downloader loopback denies unauthorized redirect host without process-wide network enable', async () => temporary(async dir => {
  const script = `const assert=require('node:assert/strict'),http=require('node:http');
    const {blankProject}=require(${JSON.stringify(path.resolve(__dirname, '../src/project'))});
    const io=require(${JSON.stringify(path.resolve(__dirname, '../src/project-io-commands'))});
    const {createPolicy}=require(${JSON.stringify(path.resolve(__dirname, '../src/permission-policy'))});
    const network=require(${JSON.stringify(path.resolve(__dirname, '../src/network-policy'))});
    (async()=>{const bytes=await blankProject();let redirected=false;
      const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'http://localhost:'+server.address().port+'/project'});res.end();}else{redirected=true;res.end(bytes);}});
      await new Promise(r=>server.listen(0,'127.0.0.1',r));network.install();
      try {const url='http://127.0.0.1:'+server.address().port;
        await assert.rejects(network.fetchBytes(url+'/project',createPolicy({},{}),{httpsOnly:false,timeoutMs:1000}),/权限拒绝/);
        const data=await network.fetchBytes(url+'/project',createPolicy({},{allow:'net:127.0.0.1'}),{httpsOnly:false,timeoutMs:1000});assert.deepEqual(data,bytes);
        redirected=false;await assert.rejects(network.fetchBytes(url+'/redirect',createPolicy({},{allow:'net:127.0.0.1'}),{httpsOnly:false,timeoutMs:1000}),/权限拒绝/);assert.equal(redirected,false);
        await assert.rejects(network.fetchBytes(url+'/project',createPolicy({},{allow:'net:127.0.0.1'}),{httpsOnly:false,maxBytes:1,timeoutMs:1000}),/限制/);
        assert.throws(()=>require('node:net').connect(server.address().port,'127.0.0.1'),/denied/);console.log('loopback exact authorization verified');
      }finally{await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const result = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /exact authorization verified/);
}));

test('standalone resource mode is selected before dev fallback without changing frozen validation', async () => {
  const resources = path.resolve(__dirname, '../resources');
  const exists = require('node:fs').existsSync;
  const installed = exists(path.join(resources, 'library-manifest.json')) && exists(path.join(resources, 'libraries/sprites.json'));
  const library = new LibraryStore(); assert.equal(library.resourceMode, installed);
  if (installed) {
    assert.equal(library.directory, path.join(resources, 'library'));
    assert.equal(library.guiRoot, path.join(resources, 'libraries'));
  }
  assert.equal((await library.manifest()).length, 1304);
  assert.equal((await library.entries('sprite')).length, 333);
});

test('fetch script rejects unbounded settings, arbitrary hosts/paths and network stays denied in normal imports', () => {
  const script = path.resolve(__dirname, '../scripts/fetch-cli-library.js');
  for (const args of [['--asset', '../escape'], ['--budget-ms', '600001'], ['--concurrency', '99']]) {
    const result = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', timeout: 10000}); assert.equal(result.status, 1);
  }
  assert.throws(() => require('node:net').connect(443, 'assets.scratch.mit.edu'), /denied/);
});
