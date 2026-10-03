'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {CommandSession} = require('../src/commands');
const {errorInfo} = require('../src/errors');
const fixture = async operation => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-recipes-'));
  const session = new CommandSession();
  const write = async scripts => {
    const file = path.join(directory, 'recipe.json');
    await fs.writeFile(file, JSON.stringify({version: 1, scripts})); return file;
  };
  try {await session.execute(['new']); await operation(session, directory, write);}
  finally {session.dispose(); await fs.rm(directory, {recursive: true, force: true});}
};
const flag = {opcode: 'event_whenflagclicked'};
const move = steps => ({opcode: 'motion_movesteps', inputs: {STEPS: steps}});
const x = result => result.targets.find(target => !target.isStage).x;
const state = session => ({json: session.project.vm.toJSON(), selected: session.project.target().id,
  dirty: session.dirty, undo: session.undoStack.map(entry => entry.label), redo: session.redoStack.map(entry => entry.label),
  session: session.sessionState(), file: session.project.file});

test('recipe validate is read-only, apply is one transaction and persists node IDs', async () => fixture(async (s, dir, write) => {
  const file = await write([[flag, move(100), {opcode: 'looks_say', inputs: {MESSAGE: 'Hello'}}]]);
  await s.execute(['sprite', 'set', 'x', '-120']);
  const before = state(s);
  const validation = await s.execute(['script', 'validate', file]);
  assert.equal(validation.valid, true); assert.equal(validation.applied, false); assert.equal(validation.nodeCount, 3);
  assert.deepEqual(state(s), before);
  const applied = await s.execute(['script', 'apply', file]);
  assert.equal(applied.applied, true); assert.ok(applied.nodeMap['$.scripts[0][1]']);
  assert.equal(s.undoStack.length, before.undo.length + 1);
  assert.equal(x(await s.execute(['run', '--frames', '2', '--seed', '1234'])), -20);
  assert.equal(x(await s.execute(['info'])), -120);
  await s.execute(['undo']); assert.equal((await s.execute(['blocks', 'count'])).blockCount, 0);
  await s.execute(['redo']);
  const saved = path.join(dir, 'demo.sb3'); await s.execute(['save', saved]); await s.execute(['open', saved]);
  const blocks = await s.execute(['blocks', 'list']);
  assert.ok(blocks.blocks.some(block => block.id === applied.nodeMap['$.scripts[0][1]']));
  assert.equal(x(await s.execute(['run', '--frames', '2'])), -20);
}));

test('nested reporters, boolean literals, branches and loops run through the shared graph semantics', async () => fixture(async (s, dir, write) => {
  const file = await write([[flag, {opcode: 'control_repeat', inputs: {TIMES: 3, SUBSTACK: [
    {opcode: 'control_if_else', inputs: {CONDITION: {opcode: 'operator_gt', inputs: {OPERAND1: 2, OPERAND2: 1}},
      SUBSTACK: [move({opcode: 'operator_add', inputs: {NUM1: 2, NUM2: 3}})], SUBSTACK2: [move(99)]}},
    {opcode: 'control_if', inputs: {CONDITION: false, SUBSTACK: [move(99)]}}
  ]}}]]);
  const result = await s.execute(['script', 'apply', file]);
  assert.ok(result.nodeMap['$.scripts[0][1].inputs.SUBSTACK[0].inputs.CONDITION']);
  assert.equal(x(await s.execute(['run', '--frames', '10', '--seed', '1234'])), 15);
}));

test('variable, list, broadcast and costume menus resolve names and stable IDs', async () => fixture(async (s, dir, write) => {
  const score = await s.execute(['var', 'add', '得分', '0']);
  await s.execute(['list', 'add', '背包', '[]']); await s.execute(['broadcast', 'add', '开始']);
  const file = await write([[flag,
    {opcode: 'data_changevariableby', fields: {VARIABLE: '得分'}, inputs: {VALUE: 7}},
    {opcode: 'data_addtolist', fields: {LIST: '背包'}, inputs: {ITEM: '钥匙'}},
    {opcode: 'event_broadcast', inputs: {BROADCAST_INPUT: '开始'}},
    {opcode: 'looks_switchcostumeto', inputs: {COSTUME: '造型'}}
  ]]);
  await s.execute(['script', 'apply', file]);
  const result = await s.execute(['run', '--frames', '3', '--seed', '1234']);
  const vars = result.targets.find(t => !t.isStage).variables;
  assert.equal(vars.find(v => v.name === '得分').value, 7);
  assert.deepEqual(vars.find(v => v.name === '背包').value, ['钥匙']);
  const id = (await s.execute(['var', 'list'])).find(v => v.name === '得分').id;
  await s.execute(['script', 'validate', await write([[flag, {opcode: 'data_setvariableto', fields: {VARIABLE: id}, inputs: {VALUE: 2}}]])]);
  assert.ok(score);
  const schema = await s.execute(['blocks', 'schema', 'data_setvariableto']);
  assert.ok(schema.fields.VARIABLE.menu.some(item => item.id === id));
  const costumeMenu = await s.execute(['blocks', 'schema', 'looks_costume']);
  const costumeID = costumeMenu.fields.COSTUME.menu.find(item => item.value === '造型').id;
  assert.ok(costumeID);
  await s.execute(['script', 'validate', await write([[flag, {opcode: 'looks_switchcostumeto', inputs: {COSTUME: costumeID}}]])]);
  const stageID = s.project.vm.runtime.getTargetForStage().id;
  await s.execute(['script', 'validate', await write([[flag, move({opcode: 'sensing_of', fields: {PROPERTY: 'volume'}, inputs: {OBJECT: stageID}})]])]);
}));

test('invalid recipe paths, incompatible connections and unsupported code leave session state intact', async () => fixture(async (s, dir, write) => {
  await s.execute(['input', 'key', 'space', 'down']);
  const before = state(s);
  const cases = [
    [[flag, {opcode: 'motion_movesteps', inputs: {TYPO: 3}}], '$.scripts[0][1].inputs.TYPO'],
    [[flag, {opcode: 'evil_run'}], '$.scripts[0][1].opcode'],
    [[flag, {opcode: 'operator_add', inputs: {NUM1: 1, NUM2: 2}}], '$.scripts[0][1]'],
    [[flag, {opcode: 'data_setvariableto', fields: {VARIABLE: 'missing'}, inputs: {VALUE: 1}}], '$.scripts[0][1].fields.VARIABLE'],
    [[flag, {opcode: 'procedures_call'}], '$.scripts[0][1].opcode'],
    [[flag, {opcode: 'motion_movesteps', code: 'process.exit()'}], '$.scripts[0][1].code'],
    [[flag, move({opcode: 'math_number', fields: {NUM: {unsafe: 'value'}}})], '$.scripts[0][1].inputs.STEPS.fields.NUM']
  ];
  for (const [script, expected] of cases) {
    const file = await write([script]);
    for (const action of ['validate', 'apply']) {
      await assert.rejects(s.execute(['script', action, file]), error => {assert.equal(errorInfo(error).details.path, expected); return true;});
      assert.deepEqual(state(s), before);
    }
  }
  const protectedFile = path.join(dir, 'occupied.sb3'); await fs.writeFile(protectedFile, 'sentinel');
  await assert.rejects(s.execute(['script', 'apply', await write([[flag, move(10)]]), '--out', protectedFile]), /EEXIST/);
  assert.deepEqual(state(s), before); assert.equal(await fs.readFile(protectedFile, 'utf8'), 'sentinel');
}));

test('validate --project preserves the existing dirty VM, runtime, selection, history and input queue', async () => fixture(async (s, dir, write) => {
  const project = path.join(dir, 'disk.sb3'); await s.execute(['save', project]);
  await s.execute(['sprite', 'set', 'x', '80']); await s.execute(['input', 'key', 'space', 'down']);
  await s.execute(['runtime', 'start', '--paused']);
  const before = state(s), vm = s.project.vm, runtime = s.runtimeController;
  const file = await write([[flag, move(25)]]);
  const result = await s.execute(['script', 'validate', file, '--project', project]);
  assert.equal(result.valid, true); assert.deepEqual(state(s), before); assert.equal(s.project.vm, vm); assert.equal(s.runtimeController, runtime);
  await assert.rejects(s.execute(['script', 'validate', await write([[{opcode: 'evil_run'}]]), '--project', project]));
  assert.deepEqual(state(s), before); assert.equal(s.project.vm, vm);
  await s.execute(['runtime', 'stop']);
}));

test('recipe limits reject deeply nested JSON and oversized or symlinked input without side effects', async () => fixture(async (s, dir, write) => {
  let nested = move(1);
  for (let i = 0; i < 70; i++) nested = {opcode: 'control_repeat', inputs: {TIMES: 1, SUBSTACK: [nested]}};
  const before = state(s);
  await assert.rejects(s.execute(['script', 'validate', await write([[flag, nested]])]), /nesting/);
  const huge = path.join(dir, 'huge.json'); await fs.writeFile(huge, Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(s.execute(['script', 'validate', huge]), error => {assert.match(error.message, /bytes/); assert.equal(errorInfo(error).code, 'INVALID_ARGUMENT'); return true;});
  const alias = path.join(dir, 'alias.json'); await fs.symlink(await write([[flag, move(1)]]), alias);
  await assert.rejects(s.execute(['script', 'apply', alias]), /ELOOP/);
  assert.deepEqual(state(s), before);
}));

test('dependent sensing menus preserve explicit properties and nested menu nodes run', async () => fixture(async (s, dir, write) => {
  await s.execute(['var', 'add', 'stageScore', '12', '--target', 'stage']);
  const file = await write([[flag, move({opcode: 'sensing_of', fields: {PROPERTY: 'stageScore'}, inputs: {
    OBJECT: {opcode: 'sensing_of_object_menu', fields: {OBJECT: '_stage_'}}
  }}), {opcode: 'looks_switchcostumeto', inputs: {COSTUME: {opcode: 'looks_costume', fields: {COSTUME: '造型'}}}}]]);
  assert.equal((await s.execute(['blocks', 'schema', 'looks_costume'])).recipeSupported, true);
  await s.execute(['script', 'apply', file]);
  assert.equal(x(await s.execute(['run', '--frames', '3'])), 12);
  await assert.rejects(s.execute(['script', 'validate', await write([[flag, move({opcode: 'sensing_of',
    fields: {PROPERTY: 'missing'}, inputs: {OBJECT: '_stage_'}})]])]), error => {
    assert.equal(errorInfo(error).details.path, '$.scripts[0][1].inputs.STEPS.fields.PROPERTY'); return true;
  });
}));

test('ambiguous resource names fail at their node while stable IDs resolve', async () => fixture(async (s, dir, write) => {
  await s.execute(['var', 'add', 'score', '0', '--target', 'stage']);
  const local = await s.execute(['var', 'add', 'score', '0']);
  const recipe = selector => [[flag, {opcode: 'data_setvariableto', fields: {VARIABLE: selector}, inputs: {VALUE: 3}}]];
  const before = state(s);
  await assert.rejects(s.execute(['script', 'apply', await write(recipe('score'))]), error => {
    const info = errorInfo(error); assert.equal(info.code, 'RESOURCE_AMBIGUOUS');
    assert.equal(info.details.path, '$.scripts[0][1].fields.VARIABLE'); return true;
  });
  assert.deepEqual(state(s), before);
  assert.equal((await s.execute(['script', 'validate', await write(recipe(local.id))])).valid, true);
}));

test('failed apply --project restores the original live session and protected output', async () => fixture(async (s, dir, write) => {
  const project = path.join(dir, 'disk.sb3'); await s.execute(['save', project]);
  await s.execute(['input', 'key', 'space', 'down']); await s.execute(['runtime', 'start', '--paused']);
  const before = state(s), vm = s.project.vm, runtime = s.runtimeController;
  const output = path.join(dir, 'protected.sb3'); await fs.writeFile(output, 'sentinel');
  await assert.rejects(s.execute(['script', 'apply', await write([[flag, move(10)]]), '--project', project, '--out', output]), error => {
    assert.equal(errorInfo(error).code, 'OUTPUT_EXISTS'); return true;
  });
  assert.deepEqual(state(s), before); assert.equal(s.project.vm, vm); assert.equal(s.runtimeController, runtime);
  assert.equal(await fs.readFile(output, 'utf8'), 'sentinel'); await s.execute(['runtime', 'stop']);
}));

test('malformed envelopes and prototype keys report precise paths without writes', async () => fixture(async (s, dir, write) => {
  const file = await write([[flag, move(1)]]), before = state(s);
  for (const [value, expected] of [
    [{version: 2, scripts: [[flag]]}, '$.version'], [{version: 1, scripts: [[flag]], extra: true}, '$.extra'],
    [JSON.parse('{"version":1,"scripts":[[{"opcode":"event_whenflagclicked","inputs":{"__proto__":{}}}]]}'), '$.scripts[0][0].inputs.__proto__']
  ]) {
    await fs.writeFile(file, JSON.stringify(value));
    const listing = await fs.readdir(dir);
    await assert.rejects(s.execute(['script', 'validate', file]), error => {
      assert.equal(errorInfo(error).code, 'INVALID_ARGUMENT'); assert.equal(errorInfo(error).details.path, expected); return true;
    });
    assert.deepEqual(state(s), before); assert.deepEqual(await fs.readdir(dir), listing);
  }
}));
