'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const {CommandSession, validateCommand} = require('../src/commands');
const {Project, blankProject, readProject} = require('../src/project');
const adapters = require('../src/device-adapters');
const mapping = require('../src/gamepad-mapping-commands');
const GUI_ROOT = path.resolve(__dirname, '../../desktop-master/node_modules/scratch-gui/src/addons/addons/gamepad');
const withSession = async fn => {
  const session = new CommandSession(), directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mapping-')));
  try {await session.project.load(await blankProject()); session.dirty = false; await fn(session, directory);}
  finally {session.dispose(); await fs.rm(directory, {recursive: true, force: true});}
};
const keyEntry = high => JSON.stringify({type: 'key', high});
const guiOracle = async () => {
  const source = await fs.readFile(path.join(GUI_ROOT, 'gamepadlib.js'), 'utf8');
  // Execute the actual frozen PURE mapping functions in a local CommonJS
  // module. No user data is executable and no browser/GUI is bootstrapped.
  const first = source.indexOf('const defaultAxesMappings = '), end = source.indexOf('const defaultHints = ');
  assert.ok(first > 0 && end > first);
  const filename = path.join(GUI_ROOT, 'gamepadlib.js'), compiled = new Module(filename, module);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(GUI_ROOT);
  compiled._compile(`${source.slice(first, end)}\nmodule.exports={GamepadData,prepareAxisMappingForExport,prepareButtonMappingForExport};`, filename);
  return compiled.exports;
};
const guiParser = async () => {
  const source = await fs.readFile(path.join(GUI_ROOT, 'userscript.js'), 'utf8');
  const start = source.indexOf('  const GAMEPAD_CONFIG_MAGIC = '), end = source.indexOf('\n  GamepadLib.setConsole', start);
  assert.ok(start > 0 && end > start);
  const compiled = new Module(path.join(GUI_ROOT, 'userscript.js'), module);
  compiled._compile(`module.exports=function(vm){const console={warn(){}};${source.slice(start, end)}return {findOptionsComment,parseOptionsComment};};`, compiled.id);
  return compiled.exports;
};

test('command contracts counts exclude action and gamepad --target is controller, not sprite', () => {
  assert.equal(mapping.usesProjectTarget, false);
  assert.deepEqual(validateCommand(['gamepad', 'set-button', '0', keyEntry('z'), '--target', 'pad-1']).args, ['set-button', '0', keyEntry('z')]);
  assert.throws(() => validateCommand(['gamepad', 'set-axis', '0']), /expected 2/);
  assert.throws(() => validateCommand(['gamepad', 'create', '--out', 'x.sb3']), /not allowed/);
  assert.equal(mapping.isReadOnly('gamepad', ['show']), true);
});

test('generated mappings and export transforms match actual frozen gamepadlib pure functions', async () => withSession(async session => {
  const oracle = await guiOracle(), vm = session.project.vm;
  for (const used of [[], [' '], ['w', 'a', 's', 'd', 'z', 'p', 'q'], ['ArrowUp', 'ArrowLeft', ' ', 'Enter', 'r'], ['z', 'x']]) {
    const target = vm.editingTarget; target.blocks.deleteAllBlocks();
    used.forEach((key, index) => target.blocks.createBlock({id: `key-${index}`, opcode: 'event_whenkeypressed', next: null, parent: null, inputs: {},
      fields: {KEY_OPTION: {name: 'KEY_OPTION', value: {' ': 'space', ArrowUp: 'up arrow', ArrowLeft: 'left arrow', Enter: 'enter'}[key] || key}},
      topLevel: true, shadow: false, x: 0, y: 0}));
    for (const [buttons, axes] of [[16, 4], [2, 2], [20, 6], [0, 0]]) {
      const data = new oracle.GamepadData({buttons: Array(buttons), axes: Array(axes)}, {getHints: () => ({usedKeys: new Set(used)})});
      const expected = {axes: data.axesMappings.map(oracle.prepareAxisMappingForExport), buttons: data.buttonMappings.map(oracle.prepareButtonMappingForExport)};
      assert.deepEqual(mapping.generateMapping(vm, buttons, axes), expected);
    }
  }
}));

test('typed JSON rejects executable/prototype/nonfinite and wrong-type mapping fields', () => {
  const bad = [JSON.parse('{"buttons":[{"type":"key","high":"z","__proto__":{}}],"axes":[]}'),
    {buttons: [{type: 'key', high: 'space'}], axes: []}, {buttons: [{type: 'key', high: 'z', execute: 'process.exit()'}], axes: []},
    {buttons: [], axes: [{type: 'key', high: 'd', low: 'a', deadZone: '0.5'}]},
    {buttons: [], axes: [{type: 'virtual_cursor', high: '+x', low: '-x', deadZone: 1}]},
    {buttons: [{type: 'mousedown', button: -1}], axes: []}, {buttons: [], axes: [{type: 'key', deadZone: NaN}]},
    {buttons: Array(33).fill({type: 'key', high: 'z'}), axes: []}];
  for (const value of bad) assert.throws(() => mapping.validateMapping(value));
  assert.deepEqual(mapping.normalizeMappingEntry({type: 'virtual_cursor', high: '+x'}, false),
    {type: 'virtual_cursor', high: '+x', low: null, sensitivity: 10, deadZone: 0.5});
  assert.deepEqual(mapping.validateMapping({buttons: [{type: 'mousedown'}], axes: [{type: 'key'}]}),
    {axes: [{type: 'key', high: '', low: '', deadZone: 0.5}], buttons: [{type: 'mousedown', button: 0}]});
});

test('session-only create/set/controller switch never dirty; store writes stage magic comment and real parser/save/reload preserves it', async () => withSession(async (session, dir) => {
  const vm = session.project.vm, stage = vm.runtime.getTargetForStage(), selectedSprite = vm.editingTarget.id;
  stage.createComment('ordinary', null, 'A note to preserve', 1, 2, 100, 80, true);
  await session.execute(['gamepad', 'create', 'pad-a', '--buttons', '2', '--axes', '2']);
  await session.execute(['gamepad', 'create', 'pad-b', '--index', '1', '--buttons', '2', '--axes', '2']);
  await session.execute(['gamepad', 'set-button', '0', keyEntry('z'), '--target', 'pad-a']);
  await session.execute(['gamepad', 'set-button', '0', keyEntry('x'), '--target', 'pad-b']);
  await session.execute(['gamepad', 'select-controller', 'pad-b']);
  assert.equal(session.dirty, false); assert.equal(session.undoStack.length, 0); assert.equal(vm.editingTarget.id, selectedSprite);
  assert.equal(mapping.findOptionsComment(vm), null);
  await session.execute(['gamepad', 'store', 'true']);
  assert.equal(session.dirty, true); assert.equal(session.undoStack.length, 1);
  const comment = mapping.findOptionsComment(vm);
  assert.equal(comment.blockId, null); assert.equal(comment.x, 50); assert.equal(comment.y, 50); assert.equal(comment.width, 350); assert.equal(comment.height, 150); assert.equal(comment.minimized, false);
  assert.ok(comment.text.endsWith(' // _gamepad_'));
  const parser = await guiParser();
  assert.deepEqual(parser(vm).parseOptionsComment(), mapping.parseOptionsComment(vm).mapping);
  assert.equal(parser(vm).parseOptionsComment().buttons[0].high, 'x');
  const filename = path.join(dir, 'stored.sb3'); await session.save(filename);
  await session.execute(['gamepad', 'select-controller', 'pad-a']);
  assert.equal(session.dirty, true); assert.equal(mapping.parseOptionsComment(vm).mapping.buttons[0].high, 'z');
  assert.equal(mapping.findOptionsComment(vm).id, comment.id); assert.equal(stage.comments.ordinary.text, 'A note to preserve');
  await session.execute(['undo']);
  assert.equal(mapping.parseOptionsComment(session.project.vm).mapping.buttons[0].high, 'x');
  assert.equal((await session.execute(['gamepad', 'show'])).selected, 'pad-b');
  await session.execute(['redo']);
  assert.equal(mapping.parseOptionsComment(session.project.vm).mapping.buttons[0].high, 'z');
  assert.equal((await session.execute(['gamepad', 'show'])).selected, 'pad-a');
  await session.save(filename);
  const parsedProject = await readProject(await fs.readFile(filename));
  assert.equal(Object.values(parsedProject.json.targets[0].comments).filter(comment => comment.text.includes(mapping.GAMEPAD_CONFIG_MAGIC)).length, 1);
  const reload = new Project();
  try {
    await reload.load(await fs.readFile(filename));
    assert.deepEqual(parser(reload.vm).parseOptionsComment(), mapping.parseOptionsComment(reload.vm).mapping);
    const fresh = {project: reload, inputs: []}; await mapping.execute(fresh, 'gamepad', ['create', 'reloaded'], {buttons: '2', axes: '2'});
    const shown = await mapping.execute(fresh, 'gamepad', ['show']);
    assert.equal(shown.controllers[0].mapping.buttons[0].high, 'z'); assert.equal(shown.storeInProject, false);
  } finally {reload.dispose();}
}));

test('frozen first-comment and exact suffix parsing boundary is preserved without evaluating data', async () => withSession(async session => {
  const stage = session.project.vm.runtime.getTargetForStage(), parser = await guiParser();
  stage.createComment('first', null, 'invalid // _gamepad_ followed by text', 0, 0, 100, 100, false);
  stage.createComment('second', null, '{"buttons":[],"axes":[]} // _gamepad_', 0, 0, 100, 100, false);
  assert.equal(parser(session.project.vm).parseOptionsComment(), null); assert.equal(mapping.parseOptionsComment(session.project.vm).mapping, null);
  assert.match(mapping.parseOptionsComment(session.project.vm).error, /suffix/);
  stage.comments.first.text = '{"buttons":[],"axes":[]} // _gamepad_ ';
  assert.equal(mapping.parseOptionsComment(session.project.vm).mapping, null);
  stage.comments.first.text = 'header\n{"buttons":[],"axes":[]} // _gamepad_';
  assert.deepEqual(parser(session.project.vm).parseOptionsComment(), {buttons: [], axes: []});
  assert.deepEqual(mapping.parseOptionsComment(session.project.vm).mapping, {axes: [], buttons: []});
}));

test('reset unchecks auto-store but leaves frozen comment; disabling store removes only first magic comment', async () => withSession(async session => {
  await session.execute(['gamepad', 'create', 'a']); await session.execute(['gamepad', 'set-button', '0', keyEntry('z')]);
  await session.execute(['gamepad', 'store', 'true']); const saved = mapping.findOptionsComment(session.project.vm).text;
  session.dirty = false; const history = session.undoStack.length;
  await session.execute(['gamepad', 'reset', '--empty', 'true']);
  assert.equal(session.dirty, false); assert.equal(session.undoStack.length, history);
  assert.equal(mapping.findOptionsComment(session.project.vm).text, saved);
  assert.equal((await session.execute(['gamepad', 'show'])).storeInProject, false);
  await session.execute(['gamepad', 'set-button', '0', keyEntry('x')]);
  assert.equal(mapping.findOptionsComment(session.project.vm).text, saved);
  await session.execute(['gamepad', 'store', 'false']);
  assert.equal(session.dirty, true); assert.equal(mapping.findOptionsComment(session.project.vm), null);
}));

test('invalid mutations/export refusal are atomic and mapping events reach real replay key/mouse IO', async () => withSession(async (session, dir) => {
  await session.execute(['gamepad', 'create', 'mapped', '--buttons', '2', '--axes', '2']);
  await session.execute(['gamepad', 'set-button', '0', keyEntry('z')]);
  await session.execute(['gamepad', 'set-button', '1', '{"type":"mousedown","button":2}']);
  await session.execute(['gamepad', 'set-axis', '0', '{"type":"key","high":"d","low":"a","deadZone":0.25}']);
  const before = mapping.captureState(session), inputs = structuredClone(session.inputs);
  await assert.rejects(session.execute(['gamepad', 'set-button', '0', '{"type":"key","high":"z","deadZone":0.1}']), /omitted/);
  assert.deepEqual(mapping.captureState(session), before); assert.deepEqual(session.inputs, inputs);
  const filename = path.join(dir, 'mapping.json'); await fs.writeFile(filename, 'keep');
  await assert.rejects(session.execute(['gamepad', 'export', filename]), /EEXIST/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'keep'); assert.deepEqual(mapping.captureState(session), before);
  await session.execute(['gamepad', 'export', filename, '--force']);
  await session.execute(['gamepad', 'import', filename]);
  const events = [...session.inputs, {frame: 0, device: 'gamepad', data: {index: 0, id: 'mapped', buttons: [1, 1], axes: [0.7, 0]}},
    {frame: 1, device: 'gamepad', data: {index: 0, id: 'mapped', buttons: [0, 0], axes: [0, 0]}}];
  const replay = await adapters.createInputReplay(session.project.vm, events);
  try {
    replay.applyFrame(0);
    const io = session.project.vm.runtime.ioDevices;
    assert.equal(io.keyboard.getKeyIsDown('z'), true); assert.equal(io.keyboard.getKeyIsDown('d'), true);
    assert.equal(io.mouse.getButtonIsDown(2), true); assert.equal(io.keyboard.getKeyIsDown('space'), false);
    replay.applyFrame(1); assert.equal(io.keyboard.getKeyIsDown('z'), false); assert.equal(io.mouse.getButtonIsDown(2), false);
  } finally {replay.dispose();}
  assert.equal(session.dirty, false); assert.equal(session.undoStack.length, 0);
}));

test('capture/restore hooks preserve controller and store state across failed core transaction, with no custom history', async () => withSession(async session => {
  await session.execute(['gamepad', 'create', 'first']); await session.execute(['gamepad', 'create', 'second']);
  await session.execute(['gamepad', 'store', 'true']);
  const state = session.sessionState(), comment = mapping.findOptionsComment(session.project.vm).text;
  await assert.rejects(session.transaction('test rollback', async () => {
    await mapping.execute(session, 'gamepad', ['select-controller', 'second']);
    throw new Error('intentional fail');
  }), /intentional fail/);
  assert.deepEqual(session.sessionState(), state); assert.equal(mapping.findOptionsComment(session.project.vm).text, comment);
  mapping.restoreState(session, undefined); assert.equal(mapping.captureState(session), undefined);
  assert.equal((await mapping.execute(session, 'gamepad', ['show'])).storeInProject, false);
  assert.equal(CommandSession.HISTORY_LIMIT, 99);
}));
