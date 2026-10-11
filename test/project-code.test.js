'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {CommandSession} = require('../src/commands');
const code = require('../src/project-code');
const withSession = async operation => {
  const session = new CommandSession();
  try {await session.execute(['new']); await operation(session);} finally {session.dispose();}
};
const apply = (session, operations) => code.applyOperations(session, {version: 1, operations});
const add = (session, opcode, options = []) => session.execute(['blocks', 'add', opcode, ...options]);
const json = session => session.project.vm.toJSON(null, {allowOptimization: false});

test('structured read is indexed by default and script filter resolves all targets', async () => withSession(async session => {
  const first = await add(session, 'event_whenflagclicked');
  await add(session, 'motion_movesteps', ['--after', first.id, '--inputs', '{"STEPS":10}']);
  const index = await code.read(session.project);
  assert.equal(index.targets[1].scripts[0].body, undefined);
  const full = await code.read(session.project, {script: first.id});
  assert.equal(full.targets.length, 1); assert.equal(full.targets[0].scripts[0].body.length, 2);
  assert.match((await code.read(session.project, {script: first.id, format: 'text'})).text, /motion_movesteps/);
  assert.equal(code.find(session.project, '10')[0].opcode, 'math_number');
  assert.equal(code.find(session.project, '', {opcode: 'motion_movesteps'}).length, 1);
  await assert.rejects(code.read(session.project, {script: 'missing'}), {code: 'RESOURCE_NOT_FOUND'});
}));

test('lossless code replacement retains shadows, mutations, comments, IDs and assets', async () => withSession(async session => {
  const proc = await session.execute(['blocks', 'procedure-add', 'move &amp;', '--params', '[{"name":"distance","type":"number"},{"name":"ok","type":"boolean"}]', '--warp', 'true']);
  const move = await add(session, 'motion_movesteps', ['--after', proc.id, '--inputs', '{"STEPS":5}']);
  await add(session, 'operator_add', ['--parent', move.id, '--input', 'STEPS', '--inputs', '{"NUM1":2,"NUM2":3}']);
  const hat = await add(session, 'event_whenflagclicked');
  const call = await session.execute(['blocks', 'procedure-call', 'move &amp;', '--after', hat.id, '--values', '{"distance":5,"ok":true}']);
  await session.execute(['comment', 'add', 'native code comment', '--block', call.id]);
  const before = json(session), rev = code.revision(session.project), assets = session.project.vm.serializeAssets().map(asset => Buffer.from(asset.fileContent));
  const read = await code.read(session.project, {target: 'Sprite1'});
  for (const script of read.targets[0].scripts) {
    const result = await apply(session, [{op: 'script.replace', target: 'Sprite1', root: script.root, body: script.body}]);
    assert.equal(result.changed, false);
  }
  assert.equal(json(session), before); assert.equal(code.revision(session.project), rev);
  assert.deepEqual(session.project.vm.serializeAssets().map(asset => Buffer.from(asset.fileContent)), assets);
  assert.equal(code.find(session.project, 'native code comment').length, 1);
  code.validate(session.project);
}));

test('recipe nodes create nested control, expression, variables and custom procedure calls', async () => withSession(async session => {
  const variable = await session.execute(['var', 'add', 'score', '0']);
  await apply(session, [{op: 'procedure.define', target: 'Sprite1', name: 'act', params: [{name: 'distance', type: 'number'}], warp: true}]);
  const read = await code.read(session.project, {target: 'Sprite1'}), proc = read.targets[0].procedures[0];
  const prototype = session.project.target().blocks.getBlock(proc.id);
  const result = await apply(session, [{op: 'script.add', target: 'Sprite1', body: [
    {opcode: 'event_whenflagclicked'},
    {opcode: 'control_repeat', inputs: {TIMES: 2, SUBSTACK: [
      {opcode: 'data_changevariableby', fields: {VARIABLE: variable.id}, inputs: {VALUE: {opcode: 'operator_add', inputs: {NUM1: 1, NUM2: 2}}}},
      {opcode: 'procedures_call', mutation: prototype.mutation, inputs: {[proc.params[0].id]: 10}}
    ]}}
  ]}]);
  assert.equal(result.changed, true); assert.ok(Object.keys(result.idMap).length > 4); code.validate(session.project);
  const output = await session.execute(['run', '--frames', '4', '--seed', '1']);
  assert.equal(output.targets.find(target => target.name === 'Sprite1').variables.find(item => item.id === variable.id).value, 6);
}));

test('block update preserves literal identity and accepts nested expression code', async () => withSession(async session => {
  const move = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":7}']);
  const shadow = session.project.target().blocks.getBlock(move.id).inputs.STEPS.shadow;
  await apply(session, [{op: 'block.update', target: 'Sprite1', id: move.id, inputs: {STEPS: 12}}]);
  assert.equal(session.project.target().blocks.getBlock(move.id).inputs.STEPS.shadow, shadow);
  await apply(session, [{op: 'block.update', target: 'Sprite1', id: move.id, inputs: {STEPS: {opcode: 'operator_add', inputs: {NUM1: 2, NUM2: 3}}}}]);
  const input = session.project.target().blocks.getBlock(move.id).inputs.STEPS;
  assert.equal(session.project.target().blocks.getBlock(input.block).opcode, 'operator_add');
  code.validate(session.project);
}));

test('revision, resource reference and denied batch commands return stable locations', async () => withSession(async session => {
  const variable = await session.execute(['var', 'add', 'score', '1']);
  const block = await add(session, 'data_setvariableto', ['--fields', JSON.stringify({VARIABLE: variable.id}), '--inputs', '{"VALUE":2}']);
  const rev = code.revision(session.project);
  await apply(session, [{op: 'block.update', target: 'Sprite1', id: block.id, inputs: {VALUE: 3}}]);
  await assert.rejects(code.applyOperations(session, {version: 1, baseRevision: rev, operations: []}), {code: 'PROJECT_CONFLICT'});
  await assert.rejects(apply(session, [{op: 'command', command: 'var', args: ['delete', variable.id]}]), error => {
    assert.equal(error.code, 'RESOURCE_IN_USE'); assert.equal(error.details.operation, 0); assert.equal(error.details.references[0].id, block.id); return true;
  });
  for (const command of [['save', 'x.sb3'], ['runtime', 'start'], ['project', 'fetch', '1'], ['var', 'set', variable.id, '3', '--out', 'x.sb3']]) {
    assert.throws(() => code.assertBatchCommand(command), {code: 'NOT_SUPPORTED'});
  }
  assert.throws(() => code.validateDocument({version: 1, operations: [{op: 'block.update', id: block.id, inpits: {VALUE: 4}}]}), {code: 'INVALID_ARGUMENT'});
  const circular = {version: 1, operations: []}; circular.extra = circular;
  assert.throws(() => code.validateDocument(circular), {code: 'INVALID_ARGUMENT'});
}));

test('procedure signature synchronizes calls and deletion reports external references', async () => withSession(async session => {
  await apply(session, [{type: 'procedure.define', target: 'Sprite1', name: 'do', params: [{name: 'x', type: 'number'}]}]);
  const hat = await add(session, 'event_whenflagclicked');
  const call = await session.execute(['blocks', 'procedure-call', 'do', '--after', hat.id]);
  await apply(session, [{type: 'procedure.update', target: 'Sprite1', name: 'do', newName: 'act', params: [{name: 'x', type: 'number'}, {name: 'ready', type: 'boolean'}], warp: true}]);
  assert.equal(session.project.target().blocks.getBlock(call.id).mutation.proccode, 'act %s %b');
  await assert.rejects(apply(session, [{type: 'procedure.delete', target: 'Sprite1', name: 'act'}]), error => {
    assert.equal(error.code, 'RESOURCE_IN_USE'); assert.equal(error.details.references[0].id, call.id); return true;
  });
  code.validate(session.project);
}));

test('new invalid opcodes are refused while existing raw nodes roundtrip losslessly', async () => withSession(async session => {
  await assert.rejects(apply(session, [{op: 'script.add', target: 'Sprite1', body: [{opcode: 'motion_unknown'}]}]), {code: 'NOT_SUPPORTED'});
  const target = session.project.target();
  target.blocks.createBlock({id: 'raw', opcode: 'motion_unknown', inputs: {}, fields: {}, next: null, parent: null, shadow: false, topLevel: true, x: 20, y: 30});
  const read = await code.read(session.project, {script: 'raw'});
  assert.equal(read.diagnostics[0].code, 'RAW_OPCODE');
  const before = json(session);
  await apply(session, [{op: 'script.replace', target: target.id, root: 'raw', body: read.targets[0].scripts[0].body}]);
  assert.equal(json(session), before);
}));

test('approved offline video and Gamepad extensions expose schemas and roundtrip', async () => withSession(async session => {
  for (const extension of ['videoSensing', 'Gamepad']) await session.execute(['ext', 'load', extension]);
  const schemas = (await session.execute(['blocks', 'schema'])).blocks;
  assert.equal(schemas.filter(item => item.opcode.startsWith('videoSensing_')).length, 4);
  assert.equal(schemas.filter(item => item.opcode.startsWith('Gamepad_')).length, 8);
  const video = schemas.find(item => item.opcode.startsWith('videoSensing_') && item.shape === 'statement');
  await apply(session, [{op: 'script.add', target: 'Sprite1', body: [{opcode: video.opcode}]}]);
  const full = await code.read(session.project, {target: 'Sprite1'}), script = full.targets[0].scripts[0];
  assert.deepEqual(full.diagnostics, []);
  const before = json(session);
  await apply(session, [{op: 'script.replace', target: 'Sprite1', root: script.root, body: script.body}]);
  assert.equal(json(session), before);
}));

test('fresh or changed field descriptors validate choices and numeric values', async () => withSession(async session => {
  await assert.rejects(apply(session, [{op: 'script.add', target: 'Sprite1', body: [{opcode: 'control_stop',
    fields: {STOP_OPTION: {name: 'STOP_OPTION', value: 'invalid stop choice'}}}]}]), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT'); assert.match(error.details.path, /fields\.STOP_OPTION$/); return true;
  });
  await assert.rejects(apply(session, [{op: 'script.add', target: 'Sprite1', body: [{opcode: 'motion_movesteps', inputs: {
    STEPS: {opcode: 'math_number', shadow: true, fields: {NUM: {name: 'NUM', value: 'not a number'}}}
  }}]}]), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT'); assert.match(error.details.path, /fields\.NUM$/); return true;
  });
  const move = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":9}']);
  const before = json(session), full = await code.read(session.project, {script: move.id});
  const body = full.targets[0].scripts[0].body;
  body[0].inputs.STEPS.block.fields.NUM.value = 'invalid replacement';
  body[0].inputs.STEPS.shadow.fields.NUM.value = 'invalid replacement';
  await assert.rejects(apply(session, [{op: 'script.replace', target: 'Sprite1', root: move.id, body}]), {code: 'INVALID_ARGUMENT'});
  assert.equal(json(session), before);
  const shadow = session.project.target().blocks.getBlock(move.id).inputs.STEPS.shadow;
  session.project.target().blocks.getBlock(shadow).fields.NUM.value = 'historical unusual literal';
  const legacy = await code.read(session.project, {script: move.id});
  const preserved = await apply(session, [{op: 'script.replace', target: 'Sprite1', root: move.id, body: legacy.targets[0].scripts[0].body}]);
  assert.equal(preserved.changed, false);
}));

test('native input IDs and full structured read survive SB3 compression and reload', async () => withSession(async session => {
  await apply(session, [{op: 'script.add', target: 'Sprite1', body: [
    {opcode: 'event_whenflagclicked'},
    {opcode: 'motion_movesteps', inputs: {STEPS: 7}},
    {opcode: 'motion_changeyby', inputs: {DY: {opcode: 'operator_add', inputs: {NUM1: 2, NUM2: 3}}}},
    {opcode: 'motion_changexby', inputs: {DX: {block: {id: 'explicit-math-shadow', opcode: 'math_number', shadow: true, fields: {NUM: {name: 'NUM', value: '11'}}},
      shadow: {id: 'explicit-math-shadow', opcode: 'math_number', shadow: true, fields: {NUM: {name: 'NUM', value: '11'}}}}}}
  ]}]);
  const before = await code.read(session.project, {target: 'Sprite1'}), bytes = await session.project.bytes();
  const afterSession = new CommandSession();
  try {
    await afterSession.project.load(bytes);
    const after = await code.read(afterSession.project, {target: 'Sprite1'});
    assert.deepEqual(after, before);
    const replaced = await apply(afterSession, [{op: 'script.replace', target: 'Sprite1', root: after.targets[0].scripts[0].root, body: after.targets[0].scripts[0].body}]);
    assert.equal(replaced.changed, false);
    assert.equal(replaced.revision, before.revision);
  } finally {afterSession.dispose();}
}));

test('ordinary compressed SB3 exposes identical input IDs across independent reads', async () => {
  const first = new CommandSession(), second = new CommandSession();
  try {
    const bytes = await require('./helpers/demo-project').demoProject();
    await first.project.load(bytes); await second.project.load(bytes);
    const before = await code.read(first.project, {target: 'Sprite1'}), after = await code.read(second.project, {target: 'Sprite1'});
    assert.deepEqual(after, before);
    const script = before.targets[0].scripts[0];
    const result = await apply(first, [{op: 'script.replace', target: 'Sprite1', root: script.root, body: script.body}]);
    assert.equal(result.changed, false);
  } finally {first.dispose(); second.dispose();}
});

test('explicit primitive identity changes count as project revision changes', async () => withSession(async session => {
  const move = await add(session, 'motion_movesteps', ['--inputs', '{"STEPS":9}']);
  const read = await code.read(session.project, {script: move.id}), body = read.targets[0].scripts[0].body, serialized = json(session);
  body[0].inputs.STEPS.block.id = 'new-explicit-shadow-id';
  body[0].inputs.STEPS.shadow.id = 'new-explicit-shadow-id';
  const result = await apply(session, [{op: 'script.replace', target: 'Sprite1', root: move.id, body}]);
  assert.equal(json(session), serialized, 'Scratch compression omits the primitive ID');
  assert.equal(result.changed, true);
  assert.notEqual(result.revision, read.revision);
}));
