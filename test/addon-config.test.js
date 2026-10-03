'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {CommandSession} = require('../src/commands');
const addonModule = require('../src/addon-commands');
const inventory = require('../docs/addons-inventory.json');
const {checkedGraph} = require('../src/block-commands').helpers;
const withSession = async operation => {
  const session = new CommandSession(), temporaryRoot = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(temporaryRoot, 'tw-addon-config-'));
  try {await operation(session, dir);} finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
};
const add = (session, opcode, options = []) => session.execute(['blocks', 'add', opcode, ...options]);
const snapshot = session => session.project.vm.toJSON(null, {allowOptimization: false});
const valid = session => session.project.vm.runtime.targets.filter(target => target.isOriginal).forEach(target => checkedGraph(target, session.project.vm.runtime));
const run = async session => (await session.execute(['run', '--frames', '4'])).targets;

test('addon module exposes project/config classification and every frozen manifest/setting/default/preset', async () => withSession(async (session, dir) => {
  assert.deepEqual(Object.keys(addonModule.specs), ['addon']);
  assert.equal(addonModule.requiresProject('addon', ['setting']), false);
  assert.equal(addonModule.requiresProject('addon', ['swap-scope']), true);
  assert.equal(addonModule.isReadOnly('addon', ['block-count']), true);
  assert.equal(addonModule.isReadOnly('addon', ['switch']), false);
  for (const rule of Object.values(addonModule.specs.addon)) assert.ok(Array.isArray(rule.options));
  const list = await session.execute(['addon', 'list']); assert.equal(list.length, 81);
  let settings = 0, presets = 0;
  for (const frozen of inventory.addons) {
    const current = await session.execute(['addon', 'inspect', frozen.id]);
    assert.equal(current.enabled, !!frozen.enabledByDefault); assert.equal(current.manifest.sha256, frozen.sha256);
    for (const setting of frozen.settings) {
      settings++; assert.deepEqual((await session.execute(['addon', 'setting', frozen.id, setting.id])).value, setting.default);
    }
    presets += (await session.execute(['addon', 'presets', frozen.id])).presets.length;
  }
  assert.equal(settings, 148); assert.equal(presets, 13);
  assert.equal(session.project.vm, null, 'reading addon config never loads a VM');
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('all81 enabled state and148 settings persist across processes in an explicit config; reset/presets validated', async () => withSession(async (session, dir) => {
  const config = path.join(dir, 'addons.json');
  await session.execute(['addon', 'reset', '--config', config]);
  for (const frozen of inventory.addons) {
    await session.execute(['addon', 'enabled', frozen.id, String(!frozen.enabledByDefault), '--config', config]);
    for (const setting of frozen.settings) {
      const value = setting.type === 'boolean' ? !setting.default : setting.type === 'select' ? setting.potentialValues.at(-1).id :
        setting.type === 'color' ? '#123abc' : setting.type === 'untranslated' ? '0.25' : setting.min ?? setting.default;
      await session.execute(['addon', 'setting', frozen.id, setting.id, String(value), '--config', config]);
      assert.deepEqual((await session.execute(['addon', 'setting', frozen.id, setting.id, '--config', config])).value, value);
      await session.execute(['addon', 'reset-setting', frozen.id, setting.id, '--config', config]);
      assert.deepEqual((await session.execute(['addon', 'setting', frozen.id, setting.id, '--config', config])).value, setting.default);
    }
    for (const preset of frozen.presets) {
      await session.execute(['addon', 'presets', frozen.id, preset.id, '--config', config]);
      const state = await session.execute(['addon', 'get', frozen.id, '--config', config]);
      for (const [key, value] of Object.entries(preset.values)) assert.deepEqual(state.settings[key], value);
    }
    await session.execute(['addon', 'reset', frozen.id, '--config', config]);
    assert.deepEqual((await session.execute(['addon', 'get', frozen.id, '--config', config])).settings,
      Object.fromEntries(frozen.settings.map(setting => [setting.id, setting.default])));
  }
  const second = spawnSync(process.execPath, ['-e', `const {CommandSession}=require(${JSON.stringify(path.join(__dirname, '../src/commands'))}); const s=new CommandSession(); s.execute(['addon','enabled','cat-blocks','true','--config',${JSON.stringify(config)}]).finally(()=>s.dispose()).catch(e=>{console.error(e);process.exitCode=1})`], {encoding: 'utf8', timeout: 30000});
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await session.execute(['addon', 'get', 'cat-blocks', '--config', config])).enabled, true);
  const file = JSON.parse(await fs.readFile(config, 'utf8'));
  assert.equal(Object.keys(file.addons).length, 81); assert.equal(file.format, 'tw-cli-addons');
  assert.equal(session.project.vm, null); assert.equal(typeof globalThis.indexedDB, 'undefined');
}));

test('type/range/color/select/text/prototype validation and config write refusal are safe with no fake DOM activation', async () => withSession(async (session, dir) => {
  const config = path.join(dir, 'addons.json');
  await assert.rejects(session.execute(['addon', 'enabled', 'cat-blocks', 'true']), /explicit --config/);
  await session.execute(['addon', 'reset', '--config', config]);
  const before = await fs.readFile(config, 'utf8');
  for (const args of [
    ['enabled', 'cat-blocks', 'yes'], ['setting', 'cat-blocks', 'watch', '1'],
    ['setting', 'custom-block-shape', 'paddingSize', '49'], ['setting', 'custom-block-shape', 'paddingSize', '201'],
    ['setting', 'custom-block-shape', 'paddingSize', '100.5'], ['setting', 'paint-snap', 'threshold', '0'],
    ['setting', 'paint-snap', 'threshold', '101'], ['setting', 'custom-menu-bar', 'menu-labels', 'anything'],
    ['setting', 'default-costume-editor-color', 'fill', 'red'], ['setting', 'default-costume-editor-color', 'fill', 'transparent'],
    ['setting', 'editor-number-arrow-keys', 'regularCustom', '123456789'], ['setting', 'cat-blocks', '__proto__', 'true'],
    ['enabled', '__proto__', 'true'], ['presets', 'custom-block-shape', 'missing']
  ]) {
    await assert.rejects(session.execute(['addon', ...args, '--config', config]));
    assert.equal(await fs.readFile(config, 'utf8'), before);
  }
  const visual = await session.execute(['addon', 'enabled', 'cat-blocks', 'true', '--config', config]);
  assert.equal(visual.semanticEffect, 'no semantic effect'); assert.equal(visual.domEnabled, false); assert.equal(visual.userscriptExecuted, false);
  await session.execute(['addon', 'setting', 'paint-snap', 'guide-color', 'transparent', '--config', config]);
  const content = JSON.parse(await fs.readFile(config, 'utf8')); content.addons['cat-blocks'].settings.watch = 'true';
  await fs.writeFile(config, JSON.stringify(content));
  await assert.rejects(session.execute(['addon', 'list', '--config', config]), /boolean/);
  const link = path.join(dir, 'symlink.json'); await fs.symlink(config, link);
  await assert.rejects(session.execute(['addon', 'reset', '--config', link]), /symlink|symbolic|ELOOP|unsafe.*path|ENOTDIR/i);
  await assert.rejects(session.execute(['addon', 'reset', '--config', path.join(dir, 'wrong.sb3')]), /SB3/);
}));

test('shared addon config reads reject leaf/parent symlinks, size overflow and recursive prototype keys without project/history changes', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const hat = await add(session, 'event_whenflagclicked');
  await session.execute(['blocks', 'move', hat.id, '80', '90']); await session.execute(['undo']);
  const state = () => ({json: snapshot(session), selected: session.project.vm.editingTarget.id, dirty: session.dirty,
    file: session.project.file, history: {undo: session.undoStack.map(entry => entry.label), redo: session.redoStack.map(entry => entry.label)}});
  const directory = path.join(dir, 'real-config'); await fs.mkdir(directory);
  const config = path.join(directory, 'addons.json'); await session.execute(['addon', 'reset', '--config', config]);
  const content = await fs.readFile(config, 'utf8'), before = state();
  const leaf = path.join(dir, 'addons-link.json'); await fs.symlink(config, leaf);
  const parent = path.join(dir, 'config-dir-link'); await fs.symlink(directory, parent);
  for (const filename of [leaf, path.join(parent, 'addons.json')]) {
    for (const args of [['addon', 'list'], ['addon', 'enabled', 'cat-blocks', 'true'], ['addon', 'initial-sprite']]) {
      await assert.rejects(session.execute([...args, '--config', filename]), /symlink|symbolic|ELOOP|unsafe.*path|ENOTDIR/i);
      assert.deepEqual(state(), before); assert.equal(await fs.readFile(config, 'utf8'), content);
    }
  }
  const oversized = path.join(dir, 'large-config.json');
  const handle = await fs.open(oversized, 'wx'); try {await handle.truncate(2 * 1024 * 1024 + 1);} finally {await handle.close();}
  for (const filename of [oversized, directory]) {
    await assert.rejects(session.execute(['addon', 'list', '--config', filename]), /regular|bytes|size|limit/i); assert.deepEqual(state(), before);
  }
  const forbidden = path.join(dir, 'prototype-config.json');
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const data = JSON.parse(content); data.addons['cat-blocks'].settings.watch = JSON.parse(`{"${key}":{"polluted":true}}`);
    await fs.writeFile(forbidden, JSON.stringify(data));
    await assert.rejects(session.execute(['addon', 'list', '--config', forbidden]), /prototype/i); assert.deepEqual(state(), before);
  }
  assert.equal({}.polluted, undefined);
  const boundary = path.join(dir, 'boundary-config.json'), bytes = Buffer.from(content);
  await fs.writeFile(boundary, Buffer.concat([bytes, Buffer.alloc(2 * 1024 * 1024 - bytes.length, 0x20)]));
  assert.equal((await session.execute(['addon', 'list', '--config', boundary])).length, 81); assert.deepEqual(state(), before);
}));

test('equivalence index records concrete commands for counts/find/rename/position/layer/variables and all pending4', async () => withSession(async session => {
  const index = await session.execute(['addon', 'commands']); assert.equal(index.length, 81);
  for (const id of ['block-count', 'find-bar', 'rename-broadcasts', 'initialise-sprite-position', 'move-to-top-layer', 'variable-manager', ...inventory.pendingUnconfirmed]) {
    const entry = index.find(item => item.id === id); assert.ok(entry.commands.length, id);
    assert.equal(entry.implementation, 'explicit-semantic-commands'); assert.equal(entry.domEnabled, false); assert.equal(entry.userscriptExecuted, false);
  }
  assert.equal(index.find(item => item.id === 'blocks2image').implementation, 'configuration-only-actions-not-implemented');
  await session.execute(['new']); const hat = await add(session, 'event_whenflagclicked'); await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":10}', '--after', hat.id]);
  assert.equal((await session.execute(['addon', 'block-count'])).blockCount, 2);
  assert.equal((await session.execute(['addon', 'find', 'motion', '--kind', 'blocks'])).length, 1);
  assert.equal((await session.execute(['addon', 'find', '造型', '--kind', 'costumes'])).length, 1);
  await session.execute(['addon', 'initial-sprite', '--x', '12', '--y', '-15']); assert.equal(session.project.target().x, 12); assert.equal(session.project.target().y, -15);
  await session.execute(['sprite', 'add', 'Other']);
  await session.execute(['addon', 'move-layer', 'front', '--target', 'Sprite1']);
  assert.ok(session.project.target('Sprite1').getLayerOrder() > session.project.target('Other').getLayerOrder());
  valid(session);
}));

test('broadcast rename/merge updates ID+name on every target and survives real SB3 reload execution and undo', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const old = await session.execute(['broadcast', 'add', 'old']);
  const hat = await add(session, 'event_whenflagclicked'), send = await add(session, 'event_broadcast', ['--after', hat.id]);
  await add(session, 'event_broadcast_menu', ['--fields', JSON.stringify({BROADCAST_OPTION: old.id}), '--parent', send.id, '--input', 'BROADCAST_INPUT']);
  await session.execute(['sprite', 'add', 'Receiver']);
  const receive = await add(session, 'event_whenbroadcastreceived', ['--fields', JSON.stringify({BROADCAST_OPTION: old.id})]);
  await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":20}', '--after', receive.id]);
  await session.execute(['addon', 'rename-broadcast', old.id, 'renamed']);
  assert.equal(session.project.vm.runtime.getTargetForStage().variables[old.id].value, 'renamed');
  assert.equal((await run(session)).find(target => target.name === 'Receiver').x, 20);
  // Unreferenced broadcasts are omitted by VM SB3 serialization and may be
  // removed during sprite import, so create the destination at merge time.
  const destination = await session.execute(['broadcast', 'add', 'new']);
  const merge = await session.execute(['addon', 'rename-broadcast', old.id, 'NEW']); assert.equal(merge.merged, true); assert.equal(merge.id, destination.id);
  assert.equal(session.project.vm.runtime.getTargetForStage().variables[old.id], undefined);
  for (const target of session.project.vm.runtime.targets.filter(item => item.isOriginal)) for (const block of Object.values(target.blocks._blocks)) if (block.fields.BROADCAST_OPTION) {
    assert.equal(block.fields.BROADCAST_OPTION.id, destination.id); assert.equal(block.fields.BROADCAST_OPTION.value, 'new');
  }
  const file = path.join(dir, 'broadcast.sb3'); await session.execute(['save', file]); await session.execute(['open', file]);
  assert.equal((await run(session)).find(target => target.name === 'Receiver').x, 20); valid(session);
}));

test('pending swap-local-global keeps values, IDs, references and monitor state; refuses unsafe cross-target/local/cloud conversion', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const variable = await session.execute(['var', 'add', 'score', '7']);
  const monitor = await session.execute(['monitor', 'add', 'score']);
  const hat = await add(session, 'event_whenflagclicked'); await add(session, 'data_changevariableby', ['--fields', JSON.stringify({VARIABLE: variable.id}), '--inputs', '{"VALUE":3}', '--after', hat.id]);
  const result = await session.execute(['addon', 'swap-scope', variable.id, 'global']); assert.equal(result.id, variable.id);
  assert.equal(session.project.vm.runtime.getTargetForStage().variables[variable.id].value, 7); assert.equal(session.project.target().variables[variable.id], undefined);
  assert.equal(session.project.vm.runtime.getMonitorState().get(monitor.id).targetId, null);
  assert.equal((await run(session)).find(target => target.isStage).variables.find(item => item.id === variable.id).value, 10);
  await session.execute(['addon', 'swap-scope', variable.id, 'local']);
  assert.equal(session.project.target().variables[variable.id].value, 7);
  assert.equal(session.project.vm.runtime.getMonitorState().get(monitor.id).targetId, session.project.target().id);
  const file = path.join(dir, 'scope.sb3'); await session.execute(['save', file]); await session.execute(['open', file]);
  assert.equal((await run(session)).find(target => target.name === 'Sprite1').variables.find(item => item.id === variable.id).value, 10);
  await session.execute(['addon', 'swap-scope', variable.id, 'global']);
  await session.execute(['sprite', 'add', 'Other']); await add(session, 'data_variable', ['--fields', JSON.stringify({VARIABLE: variable.id})]);
  const before = snapshot(session);
  await assert.rejects(session.execute(['addon', 'swap-scope', variable.id, 'local', '--target', 'Sprite1']), /other targets/); assert.equal(snapshot(session), before);
  await assert.rejects(session.execute(['addon', 'swap-scope', variable.id, 'local', '--target', 'stage']), /Stage/); assert.equal(snapshot(session), before);
  await assert.rejects(session.execute(['addon', 'swap-scope', variable.id, 'local', '--cloud', 'true']), /global scalar/); assert.equal(snapshot(session), before);
  valid(session);
}));

test('pending devtools replaces references, cleans unused locals/orphans only with flags, copy/cut/paste and undo', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const one = await session.execute(['var', 'add', 'one', '1']), two = await session.execute(['var', 'add', 'two', '2']);
  await session.execute(['list', 'add', 'unused', '[1,2]']);
  const hat = await add(session, 'event_whenflagclicked'), change = await add(session, 'data_changevariableby', ['--fields', JSON.stringify({VARIABLE: one.id}), '--inputs', '{"VALUE":5}', '--after', hat.id]);
  const orphan = await add(session, 'operator_add', ['--inputs', '{"NUM1":1,"NUM2":2}']);
  await session.execute(['addon', 'replace-variable', one.id, two.id]);
  assert.equal(session.project.target().blocks.getBlock(change.id).fields.VARIABLE.id, two.id);
  const noDeletes = await session.execute(['addon', 'cleanup-plus']); assert.equal(noDeletes.removedBlocks.length, 0); assert.equal(noDeletes.removedVariables.length, 0);
  await session.execute(['addon', 'cleanup-plus', '--delete-orphans', '--delete-unused']);
  assert.equal(session.project.target().blocks.getBlock(orphan.id), undefined); assert.equal(session.project.target().variables[one.id], undefined); assert.ok(session.project.target().variables[two.id]);
  assert.equal((await run(session)).find(target => target.name === 'Sprite1').variables.find(item => item.id === two.id).value, 7);
  await session.execute(['undo']); assert.ok(session.project.target().blocks.getBlock(orphan.id));
  const file = path.join(dir, 'single.json'); await session.execute(['addon', 'copy-single', change.id, '--output', file]);
  const cut = await session.execute(['addon', 'cut-single', change.id]); assert.ok(cut.bundle); assert.equal(session.project.target().blocks.getBlock(change.id), undefined);
  const paste = await session.execute(['addon', 'paste-at', file, '--at', '100,200']); assert.ok(paste.id); assert.equal(session.project.target().blocks.getBlock(paste.id).x, 100);
  valid(session);
}));

test('variable manager newline list/scalar edits and rename preserve all references and are rollback-safe', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const value = await session.execute(['var', 'add', 'value', '7']), list = await session.execute(['list', 'add', 'lines', '[]']);
  const reporter = await add(session, 'data_variable', ['--fields', JSON.stringify({VARIABLE: value.id})]);
  await session.execute(['addon', 'set-variable', value.id, 'hello']);
  await session.execute(['addon', 'set-list', list.id, 'a\nb\n']);
  assert.deepEqual(session.project.target().variables[list.id].value, ['a', 'b', '']);
  await session.execute(['addon', 'rename-variable', value.id, 'renamed']); assert.equal(session.project.target().blocks.getBlock(reporter.id).fields.VARIABLE.value, 'renamed');
  assert.equal((await session.execute(['addon', 'variables', 'rename'])).length, 1);
  const before = snapshot(session); await assert.rejects(session.execute(['addon', 'set-variable', list.id, 'oops']), /set-list/); assert.equal(snapshot(session), before);
  await session.execute(['save', path.join(dir, 'vars.sb3')]); await session.execute(['open', path.join(dir, 'vars.sb3')]);
  assert.equal(session.project.target().variables[value.id].value, 'hello'); assert.deepEqual(session.project.target().variables[list.id].value, ['a', 'b', '']); valid(session);
}));

test('pending paint-snap delegates reviewed move/scale with config threshold and persists SVG through SB3 reload', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const target = session.project.target(), costume = target.getCostumes()[0];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect id="moving" x="20" y="20" width="10" height="10" fill="red"/><rect id="peer" x="60" y="20" width="20" height="10" fill="blue"/></svg>';
  session.project.vm.updateSvg(0, svg, costume.rotationCenterX, costume.rotationCenterY);
  const config = path.join(dir, 'snap.json'); await session.execute(['addon', 'reset', '--config', config]);
  await session.execute(['addon', 'setting', 'paint-snap', 'pageEdges', 'false', '--config', config]);
  await session.execute(['addon', 'setting', 'paint-snap', 'pageAxes', 'false', '--config', config]);
  await session.execute(['addon', 'setting', 'paint-snap', 'pageCenter', 'false', '--config', config]);
  await session.execute(['addon', 'setting', 'paint-snap', 'objectEdges', 'false', '--config', config]);
  await session.execute(['addon', 'setting', 'paint-snap', 'objectMidlines', 'false', '--config', config]);
  const result = await session.execute(['addon', 'snap-move', '0', 'moving', '41', '0', '--config', config]);
  assert.ok(result);
  const afterMove = session.project.target().getCostumes()[0].asset.decodeText();
  assert.notEqual(afterMove, svg); assert.ok(/translate|matrix/.test(afterMove));
  await session.execute(['addon', 'snap-scale', '0', 'moving', '1.9', '1', '--config', config, '--spec', '{"handle":"right","shift":true}']);
  const finalSVG = session.project.target().getCostumes()[0].asset.decodeText(); assert.notEqual(finalSVG, afterMove);
  const before = snapshot(session); await assert.rejects(session.execute(['addon', 'snap-move', '0', '#missing', '1', '1', '--config', config])); assert.equal(snapshot(session), before);
  const file = path.join(dir, 'snapped.sb3'); await session.execute(['save', file]); await session.execute(['open', file]);
  assert.equal(session.project.target().getCostumes()[0].asset.decodeText(), finalSVG);
  assert.equal((await session.execute(['addon', 'get', 'paint-snap', '--config', config])).domEnabled, false);
}));
