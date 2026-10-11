'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {CommandSession} = require('../src/commands');
const moduleUnderTest = require('../src/block-commands');
const {checkedGraph, mutationDOM} = moduleUnderTest.helpers;

const withSession = async operation => {
  const session = new CommandSession(), temporaryRoot = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(temporaryRoot, 'tw-block-tools-'));
  try {await operation(session, dir);} finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
};
const projectJSON = session => session.project.vm.toJSON(null, {allowOptimization: false});
const valid = session => {
  for (const target of session.project.vm.runtime.targets.filter(item => item.isOriginal)) checkedGraph(target, session.project.vm.runtime);
};
const add = (session, opcode, options = []) => session.execute(['blocks', 'add', opcode, ...options]);
const resultSprite = async (session, name = 'Sprite1', compile = false) => {
  const result = await session.execute(['run', '--frames', '4', ...(compile ? ['--compile'] : [])]);
  assert.equal(result.noDOM, true);
  return result.targets.find(target => target.name === name);
};
const fixture = async (session, dir) => {
  await session.execute(['new']);
  const score = await session.execute(['var', 'add', 'score', '3']);
  const ping = await session.execute(['broadcast', 'add', 'ping']);
  const procedure = await session.execute(['blocks', 'procedure-add', 'move &amp;', '--params', '[{"name":"distance","type":"number"},{"name":"yes","type":"boolean"}]', '--warp', 'true']);
  const condition = await add(session, 'control_if', ['--after', procedure.id]);
  const yes = await add(session, 'argument_reporter_boolean', ['--fields', '{"VALUE":"yes"}', '--parent', condition.id, '--input', 'CONDITION']);
  const move = await add(session, 'motion_movesteps', ['--parent', condition.id, '--input', 'SUBSTACK']);
  const distance = await add(session, 'argument_reporter_string_number', ['--fields', '{"VALUE":"distance"}', '--parent', move.id, '--input', 'STEPS']);
  const hat = await add(session, 'event_whenflagclicked');
  const call = await session.execute(['blocks', 'procedure-call', 'move &amp;', '--values', '{"distance":12,"yes":true}', '--after', hat.id]);
  const broadcast = await add(session, 'event_broadcast', ['--after', call.id]);
  const menu = await add(session, 'event_broadcast_menu', ['--fields', JSON.stringify({BROADCAST_OPTION: ping.id}), '--parent', broadcast.id, '--input', 'BROADCAST_INPUT']);
  const receive = await add(session, 'event_whenbroadcastreceived', ['--fields', JSON.stringify({BROADCAST_OPTION: ping.id})]);
  await add(session, 'data_changevariableby', ['--fields', JSON.stringify({VARIABLE: score.id}), '--inputs', '{"VALUE":2}', '--after', receive.id]);
  const hidden = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":7}']);
  const reporter = await add(session, 'operator_add', ['--inputs', '{"NUM1":4,"NUM2":5}', '--parent', hidden.id, '--input', 'STEPS']);
  await session.execute(['comment', 'add', 'copied block comment', '--block', call.id]);
  const filename = path.join(dir, 'complex-input.sb3');
  await session.execute(['save', filename]); await session.execute(['open', filename]);
  valid(session);
  return {filename, score, ping, procedure, condition, yes, move, distance, hat, call, broadcast, menu, receive, hidden, reporter};
};

test('module exports complete registry contract, excludes subcommand from positional bounds', () => {
  assert.deepEqual(Object.keys(moduleUnderTest.specs), ['blocks']);
  for (const rule of Object.values(moduleUnderTest.specs.blocks)) {
    assert.ok(Array.isArray(rule.options)); assert.ok(Number.isInteger(rule.min)); assert.ok(rule.max >= rule.min);
  }
  assert.equal(moduleUnderTest.specs.blocks.switch.min, 2);
  assert.equal(moduleUnderTest.requiresProject('blocks', ['copy']), true);
  assert.equal(moduleUnderTest.isReadOnly('blocks', ['copy']), true);
  assert.equal(moduleUnderTest.isReadOnly('blocks', ['paste']), false);
  assert.ok(moduleUnderTest.booleanOptions.includes('single'));
  assert.deepEqual(mutationDOM({tagName: 'mutation', children: [], proccode: 'a &amp; b'}), {name: 'mutation', attribs: {proccode: 'a &amp;amp; b'}, children: []});
});

test('real checked-in SB3 inspect/count/find, duplicate fresh IDs, reload and execute twice', async () => withSession(async (session, dir) => {
  const real = await require('./helpers/demo-project').writeDemoProject(path.join(dir, 'synthetic-demo.sb3'));
  await session.execute(['open', real]);
  const info = await session.execute(['blocks', 'inspect']);
  assert.equal((await session.execute(['blocks', 'count'])).blockCount, 2);
  assert.equal((await session.execute(['blocks', 'count', '--shadows'])).blockCount, 3);
  assert.equal((await session.execute(['blocks', 'find', '--opcode', 'motion_movesteps'])).length, 1);
  const snapshot = projectJSON(session), history = session.undoStack.length;
  await session.execute(['blocks', 'inspect', info.roots[0]]);
  assert.equal(projectJSON(session), snapshot); assert.equal(session.undoStack.length, history);
  const duplicated = await session.execute(['blocks', 'duplicate', info.roots[0], '--at', '100,200']);
  assert.equal(duplicated.count, 3);
  for (const [oldId, newId] of Object.entries(duplicated.idMap)) assert.notEqual(oldId, newId);
  assert.equal(session.project.target().blocks.getBlock(duplicated.id).x, 100);
  valid(session);
  const output = path.join(dir, 'duplicated.sb3'); await session.execute(['save', output]); await session.execute(['open', output]);
  assert.equal((await resultSprite(session)).x, 50); assert.equal((await resultSprite(session, 'Sprite1', true)).x, 50);
  valid(session); assert.equal(typeof globalThis.Blockly, 'undefined');
}));

test('complex SB3 procedure mutation, boolean arguments, obscured shadows and comments roundtrip in clipboard', async () => withSession(async (session, dir) => {
  const f = await fixture(session, dir);
  assert.equal((await resultSprite(session)).x, 12);
  const target = session.project.target(), hidden = target.blocks.getBlock(f.hidden.id).inputs.STEPS;
  assert.notEqual(hidden.block, hidden.shadow); assert.ok(target.blocks.getBlock(hidden.shadow).shadow);
  const clipboardFile = path.join(dir, 'clipboard.json');
  const copied = await session.execute(['blocks', 'copy', f.hat.id, clipboardFile]);
  assert.ok(copied.bundle.dependencies.length); assert.equal(copied.bundle.comments.length, 1);
  assert.ok(copied.bundle.blocks.some(block => block.opcode === 'procedures_prototype' && block.mutation.proccode === 'move &amp; %s %b'));
  const oldIds = new Set(copied.bundle.blocks.map(block => block.id));
  const pasted = await session.execute(['blocks', 'paste', clipboardFile, '--at', '300,200']);
  assert.equal(pasted.roots.length, 1, 'existing compatible procedure reused instead of duplicated');
  for (const id of Object.values(pasted.idMap)) assert.ok(!oldIds.has(id));
  assert.equal(Object.values(session.project.target().comments).filter(comment => comment.text === 'copied block comment').length, 2);
  await session.execute(['save', path.join(dir, 'complex-copy.sb3')]); await session.execute(['open', path.join(dir, 'complex-copy.sb3')]);
  const result = await resultSprite(session); assert.equal(result.x, 24);
  // Scratch broadcast hats restart the receiver when concurrent sends arrive.
  assert.equal(result.variables.find(item => item.id === f.score.id).value, 5);
  valid(session);
  const single = await session.execute(['blocks', 'duplicate', f.call.id, '--single']);
  assert.equal(session.project.target().blocks.getBlock(single.id).next, null);
  const hiddenCopy = await session.execute(['blocks', 'duplicate', f.hidden.id]);
  const descriptor = session.project.target().blocks.getBlock(hiddenCopy.id).inputs.STEPS;
  assert.notEqual(descriptor.block, descriptor.shadow); assert.ok(session.project.target().blocks.getBlock(descriptor.shadow).shadow);
  valid(session);
}));

test('share remaps local variables and process argument IDs, keeps broadcasts global; conflicts have explicit policies', async () => withSession(async (session, dir) => {
  const f = await fixture(session, dir);
  const second = await session.execute(['sprite', 'add', 'Other']);
  const score2 = await session.execute(['var', 'add', 'score', '99']);
  const copied = await session.execute(['blocks', 'share', f.hat.id, 'Other', '--target', 'Sprite1']);
  const other = session.project.target('Other');
  assert.ok(other.blocks.getScripts().length >= 2);
  const prototype = Object.values(other.blocks._blocks).find(block => block.opcode === 'procedures_prototype');
  const originalPrototype = session.project.target('Sprite1').blocks.getBlock(f.procedure.prototype);
  assert.notEqual(prototype.mutation.argumentids, originalPrototype.mutation.argumentids);
  assert.ok(copied.roots.every(id => other.blocks.getBlock(id)));
  const receiver = await session.execute(['blocks', 'share', f.receive.id, 'Other', '--target', 'Sprite1']);
  assert.equal(receiver.variableMap[f.score.id], score2.id);
  assert.equal(receiver.variableMap[f.ping.id], f.ping.id);
  const bundle = path.join(dir, 'receiver.json'); await session.execute(['blocks', 'copy', f.receive.id, bundle, '--target', 'Sprite1']);
  const renamed = await session.execute(['blocks', 'paste', bundle, '--target', 'Other', '--variables', 'rename']);
  assert.notEqual(renamed.variableMap[f.score.id], score2.id);
  assert.equal(other.variables[renamed.variableMap[f.score.id]].name, 'score2');
  const before = projectJSON(session);
  await assert.rejects(session.execute(['blocks', 'paste', bundle, '--target', 'Other', '--variables', 'error']), /conflict/);
  assert.equal(projectJSON(session), before);
  await session.execute(['save', path.join(dir, 'shared.sb3')]); await session.execute(['open', path.join(dir, 'shared.sb3')]);
  assert.equal((await resultSprite(session, 'Other')).x, 12);
  valid(session); assert.ok(second.id);
}));

test('connect/disconnect healing, single delete, cleanup and cycle/shape failure are graph-safe and undoable', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const hat = await add(session, 'event_whenflagclicked'), first = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":10}', '--after', hat.id]);
  const last = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":20}', '--after', first.id]);
  const before = projectJSON(session);
  await assert.rejects(session.execute(['blocks', 'connect', first.id, '--after', last.id]), /cycle/);
  assert.equal(projectJSON(session), before);
  const reporter = await add(session, 'operator_add', ['--inputs', '{"NUM1":1,"NUM2":2}']);
  await assert.rejects(session.execute(['blocks', 'connect', reporter.id, '--after', last.id]), /shape/);
  const conditional = await add(session, 'control_if');
  await assert.rejects(session.execute(['blocks', 'connect', reporter.id, '--parent', conditional.id, '--input', 'CONDITION']), /shape/);
  await session.execute(['blocks', 'disconnect', first.id, '--single', '--heal', '--at', '42,44']);
  assert.equal(session.project.target().blocks.getBlock(hat.id).next, last.id);
  assert.equal(session.project.target().blocks.getBlock(first.id).next, null);
  assert.equal(session.project.target().blocks.getBlock(first.id).x, 42);
  valid(session);
  await session.execute(['undo']); assert.equal(session.project.target().blocks.getBlock(hat.id).next, first.id);
  await session.execute(['blocks', 'delete', first.id, '--single']);
  assert.equal(session.project.target().blocks.getBlock(hat.id).next, last.id); assert.equal(session.project.target().blocks.getBlock(first.id), undefined);
  await session.execute(['blocks', 'cleanup', '--columns', '2', '--at', '40,50', '--gap', '100']);
  valid(session); assert.ok([40, 520].includes(session.project.target().blocks.getBlock(hat.id).x));
  const output = path.join(dir, 'heal.sb3'); await session.execute(['save', output]); await session.execute(['open', output]);
  assert.equal((await resultSprite(session)).x, 20);
  const numeric = await add(session, 'motion_setx', ['--inputs', '{"X":30}']);
  await session.execute(['blocks', 'connect', reporter.id, '--parent', numeric.id, '--input', 'X']);
  const input = session.project.target().blocks.getBlock(numeric.id).inputs.X; assert.ok(input.shadow);
  await session.execute(['blocks', 'disconnect', reporter.id]);
  const restored = session.project.target().blocks.getBlock(numeric.id).inputs.X; assert.equal(restored.block, restored.shadow);
  valid(session);
}));

test('opcode switching remaps inputs, splits real branches, changes shadows, validates field/resource menus', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const hat = await add(session, 'event_whenflagclicked'), set = await add(session, 'motion_setx', ['--inputs', '{"X":30}', '--after', hat.id]);
  await session.execute(['blocks', 'switch', set.id, 'motion_changeyby']);
  assert.ok(session.project.target().blocks.getBlock(set.id).inputs.DY);
  assert.equal((await resultSprite(session)).y, 30);
  const before = projectJSON(session);
  await assert.rejects(session.execute(['blocks', 'switch', set.id, 'operator_equals']), /shape/); assert.equal(projectJSON(session), before);
  await assert.rejects(session.execute(['blocks', 'switch', set.id, 'motion_gotoxy']), /lacks input/); assert.equal(projectJSON(session), before);
  const say = await add(session, 'looks_say', ['--inputs', '{"MESSAGE":"hello"}']);
  await session.execute(['blocks', 'switch', say.id, 'looks_thinkforsecs']); assert.ok(session.project.target().blocks.getBlock(say.id).inputs.SECS);
  await session.execute(['blocks', 'switch', say.id, 'looks_think']); assert.equal(session.project.target().blocks.getBlock(say.id).inputs.SECS, undefined);
  const control = await add(session, 'control_if_else'), branch = await add(session, 'looks_hide', ['--parent', control.id, '--input', 'SUBSTACK2']);
  await session.execute(['blocks', 'switch', control.id, 'control_if']); assert.equal(session.project.target().blocks.getBlock(branch.id).topLevel, true);
  const value = await session.execute(['var', 'add', 'one', '0']), value2 = await session.execute(['var', 'add', 'two', '0']);
  const data = await add(session, 'data_setvariableto', ['--fields', JSON.stringify({VARIABLE: value.id}), '--inputs', '{"VALUE":"8"}']);
  await session.execute(['blocks', 'switch', data.id, 'data_changevariableby']);
  assert.equal(session.project.target().blocks.getBlock(session.project.target().blocks.getBlock(data.id).inputs.VALUE.shadow).opcode, 'math_number');
  await session.execute(['blocks', 'set-field', data.id, 'VARIABLE', value2.id]);
  assert.equal(session.project.target().blocks.getBlock(data.id).fields.VARIABLE.id, value2.id);
  await assert.rejects(session.execute(['blocks', 'set-field', data.id, 'VARIABLE', 'missing']), /Resource/);
  const costume = await add(session, 'looks_costume');
  assert.ok((await session.execute(['blocks', 'field-menu', costume.id, 'COSTUME'])).length);
  await assert.rejects(session.execute(['blocks', 'set-field', costume.id, 'COSTUME', 'missing']), /menu/);
  valid(session);
  await session.execute(['save', path.join(dir, 'switch.sb3')]); await session.execute(['open', path.join(dir, 'switch.sb3')]); assert.equal((await resultSprite(session)).y, 30);
}));

test('mutation changes are DOM-shaped, signatures synchronize calls and delete blocks used externally is refused', async () => withSession(async (session, dir) => {
  const f = await fixture(session, dir), events = [], container = session.project.target().blocks, change = container.changeBlock;
  container.changeBlock = function(event) {events.push(cloneEvent(event)); return change.call(this, event);};
  await session.execute(['blocks', 'procedure-edit', 'move &amp;', '--name', 'go &amp; & literal']);
  const mutations = events.filter(event => event.element === 'mutation');
  assert.ok(mutations.length >= 2); assert.ok(mutations.every(event => event.value.name === 'mutation' && event.value.attribs && Array.isArray(event.value.children)));
  assert.ok(Object.values(session.project.target().blocks._blocks).filter(block => block.opcode === 'procedures_call').every(block => block.mutation.proccode === 'go &amp; & literal %s %b'));
  assert.equal((await resultSprite(session)).x, 12);
  const before = projectJSON(session); await assert.rejects(session.execute(['blocks', 'procedure-delete', 'go &amp; & literal']), /used/); assert.equal(projectJSON(session), before);
  await assert.rejects(session.execute(['blocks', 'mutation', f.call.id, '{"tagName":"mutation","children":[],"proccode":"unsafe","argumentids":"[]"}']), /procedure-edit/);
  await assert.rejects(session.execute(['blocks', 'mutation', f.call.id, '{"tagName":"mutation","children":[],"blockinfo":"{}"}']), /denied/);
  valid(session);
}));
const cloneEvent = event => JSON.parse(JSON.stringify(event));

test('reporter return mutations, signature reorder and clipboard dependencies execute after SB3 reload', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const procedure = await session.execute(['blocks', 'procedure-add', 'answer', '--type', 'reporter', '--params', '[{"name":"a","type":"number"},{"name":"b","type":"number"}]']);
  const returnBlock = await add(session, 'procedures_return', ['--after', procedure.id]);
  const argument = await add(session, 'argument_reporter_string_number', ['--fields', '{"VALUE":"a"}', '--parent', returnBlock.id, '--input', 'VALUE']);
  const hat = await add(session, 'event_whenflagclicked'), move = await add(session, 'motion_movesteps', ['--after', hat.id]);
  const call = await session.execute(['blocks', 'procedure-call', 'answer', '--values', '{"a":33,"b":7}', '--parent', move.id, '--input', 'STEPS']);
  assert.equal((await resultSprite(session)).x, 33);
  await session.execute(['blocks', 'procedure-edit', 'answer', '--params', '[{"name":"b","type":"number"},{"name":"a","type":"number"}]']);
  assert.equal((await resultSprite(session)).x, 33);
  const copy = await session.execute(['blocks', 'duplicate', hat.id]); assert.ok(copy.id);
  await session.execute(['save', path.join(dir, 'returns.sb3')]); await session.execute(['open', path.join(dir, 'returns.sb3')]);
  assert.equal((await resultSprite(session)).x, 66); assert.equal((await resultSprite(session, 'Sprite1', true)).x, 66);
  await assert.rejects(session.execute(['blocks', 'delete', procedure.id]), /used/);
  const before = projectJSON(session); await assert.rejects(session.execute(['blocks', 'procedure-edit', 'answer', '--type', 'statement']), /shape/); assert.equal(projectJSON(session), before);
  assert.ok(session.project.target().blocks.getBlock(argument.id)); assert.ok(session.project.target().blocks.getBlock(call.id)); valid(session);
}));

test('menu resource references and sensing OBJECT/PROPERTY linkage survive serialize, while readonly target does not prune broadcasts', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const sense = await add(session, 'sensing_of');
  const menu = session.project.target().blocks.getBlock(sense.id).inputs.OBJECT.block;
  await session.execute(['blocks', 'set-field', menu, 'OBJECT', 'Sprite1']);
  assert.equal(session.project.target().blocks.getBlock(sense.id).fields.PROPERTY.value, 'x position');
  await session.execute(['blocks', 'set-field', menu, 'OBJECT', '_stage_']);
  assert.equal(session.project.target().blocks.getBlock(sense.id).fields.PROPERTY.value, 'backdrop #');
  const costume = await add(session, 'looks_switchcostumeto', ['--inputs', '{"COSTUME":"造型"}']);
  const costumeInput = session.project.target().blocks.getBlock(costume.id).inputs.COSTUME;
  assert.equal(costumeInput.block, costumeInput.shadow); assert.equal(session.project.target().blocks.getBlock(costumeInput.block).fields.COSTUME.value, '造型');
  const pending = await session.execute(['broadcast', 'add', 'unused-but-explicit']);
  const before = projectJSON(session), selected = session.project.vm.editingTarget.id;
  await session.execute(['blocks', 'count', '--target', 'stage']);
  await session.execute(['blocks', 'inspect', '--target', 'stage']);
  await session.execute(['addon', 'find', 'anything', '--target', 'stage']);
  assert.equal(projectJSON(session), before); assert.equal(session.project.vm.editingTarget.id, selected);
  assert.ok(session.project.vm.runtime.getTargetForStage().variables[pending.id]);
  const file = path.join(dir, 'resources.sb3'); await session.execute(['save', file]); await session.execute(['open', file]); valid(session);
}));

test('shared clipboard reads reject leaf/parent symlinks, oversized files and prototype keys without changing project/history', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  const hat = await add(session, 'event_whenflagclicked');
  await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":5}', '--after', hat.id]);
  const bundle = (await session.execute(['blocks', 'copy', hat.id])).bundle;
  await session.execute(['blocks', 'move', hat.id, '80', '90']); await session.execute(['undo']);
  const state = () => ({json: projectJSON(session), selected: session.project.vm.editingTarget.id, dirty: session.dirty,
    file: session.project.file, history: {undo: session.undoStack.map(entry => entry.label), redo: session.redoStack.map(entry => entry.label)}});
  const directory = path.join(dir, 'real-clipboard'); await fs.mkdir(directory);
  const real = path.join(directory, 'clipboard.json'); await fs.writeFile(real, JSON.stringify(bundle));
  const leaf = path.join(dir, 'clipboard-link.json'); await fs.symlink(real, leaf);
  const parent = path.join(dir, 'clipboard-dir-link'); await fs.symlink(directory, parent);
  const oversized = path.join(dir, 'too-large.json');
  const handle = await fs.open(oversized, 'wx'); try {await handle.truncate(32 * 1024 * 1024 + 1);} finally {await handle.close();}
  const forbidden = path.join(dir, 'prototype.json');
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const malicious = cloneEvent(bundle); malicious.source.unused = JSON.parse(`{"${key}":{"polluted":true}}`);
    await fs.writeFile(forbidden, JSON.stringify(malicious));
    const before = state(); await assert.rejects(session.execute(['blocks', 'paste', forbidden]), /prototype/i); assert.deepEqual(state(), before);
  }
  for (const filename of [leaf, path.join(parent, 'clipboard.json'), oversized, directory]) {
    const before = state();
    await assert.rejects(session.execute(['blocks', 'import', filename]), /symlink|symbolic|ELOOP|unsafe.*path|ENOTDIR|regular|bytes|size|limit/i);
    assert.deepEqual(state(), before);
  }
  assert.equal(await fs.readFile(real, 'utf8'), JSON.stringify(bundle)); assert.equal({}.polluted, undefined);
  // A valid clipboard larger than4 MiB is still accepted: retain the existing
  // 32 MiB limit rather than silently inheriting the general JSON parser cap.
  const boundary = path.join(dir, 'boundary.json'), text = Buffer.from(JSON.stringify(bundle));
  const output = await fs.open(boundary, 'wx');
  try {
    await output.writeFile(text);
    const whitespace = Buffer.alloc(1024 * 1024, 0x20); let remaining = 32 * 1024 * 1024 - text.length;
    while (remaining > 0) {const length = Math.min(remaining, whitespace.length); await output.writeFile(whitespace.subarray(0, length)); remaining -= length;}
  } finally {await output.close();}
  const pasted = await session.execute(['blocks', 'paste', boundary]); assert.ok(pasted.id); valid(session);
}));

test('clipboard hostile imports and output overwrite failures leave project/history intact; cut heals only single', async () => withSession(async (session, dir) => {
  await session.execute(['new']); const hat = await add(session, 'event_whenflagclicked'), first = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":10}', '--after', hat.id]);
  const last = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":20}', '--after', first.id]);
  const bundle = (await session.execute(['blocks', 'copy', hat.id])).bundle, file = path.join(dir, 'malicious.json');
  for (const mutate of [
    value => {value.blocks[0].next = 'missing';},
    value => {value.blocks[0].opcode = 'evil_run';},
    value => {value.blocks[0].inputs.WRONG = {name: 'WRONG', block: null, shadow: null};},
    value => {value.blocks[1].next = value.blocks[0].id; value.blocks[0].parent = value.blocks[1].id; value.blocks[0].topLevel = false;},
    value => {value.blocks.push(value.blocks[0]);},
    value => {value.extensionURLs = {evil: 'file:///tmp/evil.js'};}
  ]) {
    const malicious = cloneEvent(bundle); mutate(malicious); await fs.writeFile(file, JSON.stringify(malicious));
    const before = projectJSON(session), history = session.undoStack.length;
    await assert.rejects(session.execute(['blocks', 'paste', file]));
    assert.equal(projectJSON(session), before); assert.equal(session.undoStack.length, history);
  }
  const occupied = path.join(dir, 'occupied.json'); await fs.writeFile(occupied, 'KEEP');
  const before = projectJSON(session);
  await assert.rejects(session.execute(['blocks', 'cut', first.id, occupied, '--single']), /EEXIST/); assert.equal(projectJSON(session), before);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'KEEP');
  await assert.rejects(session.execute(['blocks', 'export', hat.id, path.join(dir, 'wrong.sb3')]), /JSON/);
  const cut = await session.execute(['blocks', 'cut', first.id, '--single']); assert.equal(cut.bundle.blocks.find(block => block.id === first.id).next, null);
  assert.equal(session.project.target().blocks.getBlock(hat.id).next, last.id);
  await session.execute(['undo']);
  await session.execute(['blocks', 'cut', first.id]); assert.equal(session.project.target().blocks.getBlock(last.id), undefined);
  assert.equal(session.project.target().blocks.getBlock(hat.id).next, null);
  await session.execute(['blocks', 'paste']); valid(session);
}));
