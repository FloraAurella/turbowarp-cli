'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const {CommandSession} = require('../src/commands');
const {errorInfo} = require('../src/errors');
const {writeDemoProject} = require('./helpers/demo-project');
const root = path.resolve(__dirname, '..');
const cli = (args, input) => spawnSync(process.execPath, [path.join(root, 'bin/tw.js'), ...args],
  {input, encoding: 'utf8', timeout: 45000, maxBuffer: 12 * 1024 * 1024});
const cliJSON = (args, input) => {
  const result = cli(args, input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const fixture = async operation => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tw-project-agent-'));
  const session = new CommandSession();
  const demo = path.join(directory, 'synthetic-demo.sb3');
  try {await writeDemoProject(demo); await session.execute(['open', demo]); await operation(session, directory, demo);}
  finally {session.dispose(); await fs.rm(directory, {recursive: true, force: true});}
};
const write = async (directory, document) => {
  const file = path.join(directory, 'edit.json');
  await fs.writeFile(file, JSON.stringify(document)); return file;
};
const state = session => ({json: session.project.vm.toJSON(null, {allowOptimization: false}),
  selected: session.project.vm.editingTarget?.id, file: session.project.file, dirty: session.dirty,
  undo: session.undoStack.map(entry => entry.label), redo: session.redoStack.map(entry => entry.label),
  session: session.sessionState()});
const moveId = session => Object.values(session.project.target('Sprite1').blocks._blocks)
  .find(block => block.opcode === 'motion_movesteps').id;
const editMove = (id, value, baseRevision) => ({version: 1, ...(baseRevision ? {baseRevision} : {}),
  operations: [{op: 'block.update', target: 'Sprite1', id, inputs: {STEPS: value}}]});
const expectCode = code => error => {assert.equal(errorInfo(error).code, code, error.stack); return true;};
const spriteX = result => result.targets.find(target => target.name === 'Sprite1').x;
const assetEntries = async file => {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const entries = {};
  for (const name of Object.keys(zip.files).sort()) if (!zip.files[name].dir && !['project.json', 'tw-cli-state.json'].includes(name)) {
    entries[name] = (await zip.files[name].async('nodebuffer')).toString('base64');
  }
  return entries;
};

test('native read exposes editable locations and text, find returns stable IDs', async () => fixture(async session => {
  const overview = await session.execute(['project', 'read']);
  assert.equal(overview.version, 1); assert.match(overview.revision, /^[a-f0-9]{64}$/);
  const sprite = overview.targets.find(target => target.name === 'Sprite1');
  assert.ok(sprite.scripts.length); assert.equal(sprite.scripts[0].body, undefined);
  assert.ok(sprite.assets); assert.ok(Array.isArray(sprite.variables));
  const detailed = await session.execute(['project', 'read', '--target', 'Sprite1']);
  assert.ok(detailed.targets[0].scripts[0].body.length);
  const found = await session.execute(['project', 'find', 'motion_movesteps']);
  assert.ok(JSON.stringify(found).includes(moveId(session)));
  const text = await session.execute(['project', 'read', '--target', 'Sprite1', '--format', 'text']);
  assert.match(text.text, /Sprite1/); assert.ok(text.text.includes(moveId(session)));
}));

test('validate against another SB3 preserves dirty session, selection, history and runtime state', async () => fixture(async (session, directory, demo) => {
  await session.execute(['sprite', 'set', 'x', '-100']);
  await session.execute(['device', 'key', 'space', 'down', '--frame', '0']);
  await session.execute(['runtime', 'start', '--paused', '--no-compile', '--seed', '1234']);
  const before = state(session);
  const file = await write(directory, editMove(moveId(session), 50));
  const report = await session.execute(['project', 'validate', file, '--project', demo]);
  assert.equal(report.valid, true);
  assert.deepEqual(state(session), before);
  await session.execute(['runtime', 'stop']);
}));

test('apply validates revision, saves once, preserves assets and reloads real changed behavior', async () => fixture(async (session, directory, demo) => {
  const before = await session.execute(['project', 'read']);
  const id = moveId(session), file = await write(directory, editMove(id, 47, before.revision));
  const output = path.join(directory, 'changed.sb3');
  const applied = await session.execute(['project', 'apply', file, '--out', output]);
  assert.equal(session.undoStack.length, 1); assert.equal(session.dirty, false);
  assert.ok(JSON.stringify(applied).includes(output));
  assert.deepEqual(await assetEntries(output), await assetEntries(demo));
  await session.execute(['open', output]);
  assert.equal(moveId(session), id);
  assert.equal(spriteX(await session.execute(['run', '--frames', '3', '--seed', '1234'])), 47);
  assert.equal(spriteX(await session.execute(['run', '--frames', '3', '--seed', '1234', '--compile'])), 47);
}));

test('batch failure and refused overwrite restore project, file, selection and history', async () => fixture(async (session, directory) => {
  const before = state(session), output = path.join(directory, 'exists.sb3');
  await fs.writeFile(output, 'keep this file');
  let file = await write(directory, {version: 1, operations: [
    ...editMove(moveId(session), 60).operations,
    {op: 'block.update', target: 'Sprite1', id: 'missing', inputs: {STEPS: 3}}
  ]});
  await assert.rejects(session.execute(['project', 'apply', file, '--out', output]));
  assert.deepEqual(state(session), before);
  file = await write(directory, editMove(moveId(session), 60));
  await assert.rejects(session.execute(['project', 'apply', file, '--out', output]), expectCode('OUTPUT_EXISTS'));
  assert.deepEqual(state(session), before); assert.equal(await fs.readFile(output, 'utf8'), 'keep this file');
}));

test('stale revision and external in-place source changes reject even with force', async () => fixture(async (session, directory, demo) => {
  const source = path.join(directory, 'source.sb3'); await fs.copyFile(demo, source);
  await session.execute(['open', source]);
  const file = await write(directory, editMove(moveId(session), 40, '0'.repeat(64)));
  const before = state(session);
  await assert.rejects(session.execute(['project', 'apply', file]), expectCode('PROJECT_CONFLICT'));
  assert.deepEqual(state(session), before);
  await write(directory, editMove(moveId(session), 40));
  const external = Buffer.concat([await fs.readFile(source), Buffer.from('external modification')]);
  await fs.writeFile(source, external);
  await assert.rejects(session.execute(['project', 'apply', file, '--out', source, '--force']), expectCode('PROJECT_CONFLICT'));
  assert.deepEqual(state(session), before); assert.deepEqual(await fs.readFile(source), external);
}));

test('100 small operations have one snapshot, undo record and save; record sequential timings', async t => fixture(async (session, directory, demo) => {
  let snapshots = 0, saves = 0;
  const snapshot = session.snapshot.bind(session);
  const save = session.save.bind(session);
  session.snapshot = () => {snapshots++; return snapshot();};
  session.save = (...args) => {saves++; return save(...args);};
  const document = {version: 1, operations: Array.from({length: 100}, (_, index) => editMove(moveId(session), index + 1).operations[0])};
  const file = await write(directory, document);
  const output = path.join(directory, 'batch.sb3');
  const started = performance.now();
  await session.execute(['project', 'apply', file, '--out', output]);
  const batchMilliseconds = performance.now() - started;
  assert.equal(snapshots, 1); assert.equal(saves, 1); assert.equal(session.undoStack.length, 1);
  const same = await write(directory, editMove(moveId(session), 100));
  const history = session.undoStack.length;
  const bytes = await fs.readFile(output), stat = await fs.stat(output);
  await session.execute(['project', 'apply', same, '--out', output, '--force']);
  assert.equal(session.undoStack.length, history); assert.equal(saves, 1);
  assert.deepEqual(await fs.readFile(output), bytes); assert.equal((await fs.stat(output)).mtimeMs, stat.mtimeMs);
  const sequential = new CommandSession();
  try {
    await sequential.execute(['open', demo]);
    const id = moveId(sequential), start = performance.now();
    for (let value = 1; value <= 100; value++) await sequential.applyProjectEdits(editMove(id, value));
    const sequentialMilliseconds = performance.now() - start;
    t.diagnostic(JSON.stringify({operations: 100, batchMilliseconds, sequentialMilliseconds,
      batchIncludesFinalSave: true, sequentialIncludesFinalSave: false, speedupRequirement: null}));
    assert.equal(spriteX(await sequential.execute(['run', '--frames', '3', '--seed', '1234'])), 100);
  } finally {sequential.dispose();}
}));

test('CLI supports stdin edits, requires explicit output and JSONL retains ownership of stdin', async () => fixture(async (session, directory, demo) => {
  const document = editMove(moveId(session), 35), output = path.join(directory, 'stdin.sb3');
  cliJSON(['project', 'validate', '-', '--project', demo], JSON.stringify(document));
  cliJSON(['project', 'apply', '-', '--project', demo, '--out', output], JSON.stringify(document));
  assert.equal(cli(['project', 'apply', '-', '--project', demo], JSON.stringify(document)).status, 1);
  const input = [{id: 1, command: 'open', args: [demo]},
    {id: 2, command: 'project', args: ['validate', '-']},
    {id: 3, command: 'project', args: ['read']}, {id: 4, command: 'quit', args: []}].map(JSON.stringify).join('\n') + '\n';
  const result = cli(['session', '--jsonl'], input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 4); assert.equal(replies[1].ok, false);
  assert.equal(replies[1].errorInfo.code, 'INVALID_ARGUMENT'); assert.equal(replies[2].ok, true);
}));

test('native structured script replacement is lossless for comments, procedure mutations and obscured shadows', async () => fixture(async (session, directory) => {
  const procedure = await session.execute(['blocks', 'procedure-add', 'advance', '--params', '[{"name":"distance","type":"number"},{"name":"enabled","type":"boolean"}]']);
  const condition = await session.execute(['blocks', 'add', 'control_if', '--after', procedure.id]);
  await session.execute(['blocks', 'add', 'argument_reporter_boolean', '--fields', '{"VALUE":"enabled"}', '--parent', condition.id, '--input', 'CONDITION']);
  const move = await session.execute(['blocks', 'add', 'motion_movesteps', '--parent', condition.id, '--input', 'SUBSTACK']);
  await session.execute(['blocks', 'add', 'argument_reporter_string_number', '--fields', '{"VALUE":"distance"}', '--parent', move.id, '--input', 'STEPS']);
  const top = await session.execute(['blocks', 'add', 'motion_movesteps', '--inputs', '{"STEPS":7}']);
  await session.execute(['blocks', 'add', 'operator_add', '--inputs', '{"NUM1":4,"NUM2":5}', '--parent', top.id, '--input', 'STEPS']);
  await session.execute(['comment', 'add', 'retained comment', '--block', top.id]);
  const before = state(session);
  const read = await session.execute(['project', 'read', '--target', 'Sprite1']);
  const operations = read.targets[0].scripts.map(script => ({op: 'script.replace', target: 'Sprite1', root: script.root, body: script.body}));
  const file = await write(directory, {version: 1, baseRevision: read.revision, operations});
  await session.execute(['project', 'apply', file]);
  assert.equal(state(session).json, before.json); assert.deepEqual(state(session).undo, before.undo);
}));

test('reporter procedures and same-name resources roundtrip with stable IDs and executable calls', async () => fixture(async (session, directory) => {
  const local = await session.execute(['var', 'add', 'score', '3', '--target', 'Sprite1']);
  const global = await session.execute(['var', 'add', 'score', '99', '--target', 'stage']);
  const procedure = await session.execute(['blocks', 'procedure-add', 'answer', '--type', 'reporter', '--params', '[{"name":"a","type":"number"},{"name":"b","type":"number"}]']);
  const returned = await session.execute(['blocks', 'add', 'procedures_return', '--after', procedure.id]);
  const sum = await session.execute(['blocks', 'add', 'operator_add', '--parent', returned.id, '--input', 'VALUE']);
  for (const [name, input] of [['a', 'NUM1'], ['b', 'NUM2']]) await session.execute(['blocks', 'add', 'argument_reporter_string_number',
    '--fields', JSON.stringify({VALUE: name}), '--parent', sum.id, '--input', input]);
  await session.execute(['blocks', 'procedure-call', 'answer', '--values', '{"a":33,"b":7}', '--parent', moveId(session), '--input', 'STEPS']);
  const read = await session.execute(['project', 'read', '--target', 'Sprite1']);
  assert.equal(read.targets[0].procedures.find(item => item.id === procedure.prototype).type, 'reporter');
  assert.equal(read.targets[0].variables.find(item => item.name === 'score').id, local.id);
  const stageRead = await session.execute(['project', 'read', '--target', 'stage']);
  assert.equal(stageRead.targets[0].variables.find(item => item.name === 'score').id, global.id); assert.notEqual(global.id, local.id);
  const before = state(session);
  const file = await write(directory, {version: 1, baseRevision: read.revision, operations: read.targets[0].scripts
    .map(script => ({op: 'script.replace', target: 'Sprite1', root: script.root, body: script.body}))});
  await session.execute(['project', 'apply', file]);
  const after = state(session);
  // Block dictionary insertion order can change while the graph and history stay identical.
  assert.deepEqual({...after, json: JSON.parse(after.json)}, {...before, json: JSON.parse(before.json)});
  const output = path.join(directory, 'returns.sb3'); await session.execute(['save', output]); await session.execute(['open', output]);
  assert.equal(spriteX(await session.execute(['run', '--frames', '4', '--seed', '1234'])), 40);
}));

test('old v1 recipes still append scripts and native batch rejects external commands atomically', async () => fixture(async (session, directory) => {
  const recipe = path.join(directory, 'recipe.json');
  await fs.writeFile(recipe, JSON.stringify({version: 1, scripts: [[{opcode: 'event_whenflagclicked'}, {opcode: 'motion_movesteps', inputs: {STEPS: 5}}]]}));
  const roots = session.project.target('Sprite1').blocks.getScripts().length;
  await session.execute(['script', 'apply', recipe]);
  assert.equal(session.project.target('Sprite1').blocks.getScripts().length, roots + 1);
  const before = state(session);
  const file = await write(directory, {version: 1, operations: [{op: 'command', command: 'save', args: [path.join(directory, 'forbidden.sb3')]}]});
  await assert.rejects(session.execute(['project', 'apply', file]));
  assert.deepEqual(state(session), before); await assert.rejects(fs.stat(path.join(directory, 'forbidden.sb3')), {code: 'ENOENT'});
}));

test('native scripts allocate IDs, reject invalid shapes and report referenced resources', async () => fixture(async (session, directory) => {
  const score = await session.execute(['var', 'add', 'score', '0']);
  const before = state(session);
  const invalid = await write(directory, {version: 1, operations: [{op: 'script.add', target: 'Sprite1', body: [
    {opcode: 'event_whenflagclicked'}, {opcode: 'operator_add', inputs: {NUM1: 1, NUM2: 2}}
  ]}]});
  await assert.rejects(session.execute(['project', 'apply', invalid]), error => {
    const info = errorInfo(error); assert.equal(info.details.operation, 0); assert.match(info.details.path, /^\$\.operations\[0\]/); return true;
  });
  assert.deepEqual(state(session), before);
  const document = {version: 1, operations: [{op: 'script.add', target: 'Sprite1', body: [
    {opcode: 'event_whenflagclicked'}, {opcode: 'data_setvariableto', fields: {VARIABLE: score.id}, inputs: {VALUE: 9}}
  ]}]};
  await session.execute(['project', 'apply', await write(directory, document)]);
  const roots = await session.execute(['project', 'read', '--target', 'Sprite1']);
  const added = roots.targets[0].scripts.find(script => script.body.some(node => node.opcode === 'data_setvariableto'));
  assert.ok(added.root); assert.ok(added.body.every(node => typeof node.id === 'string'));
  const referenced = state(session);
  await assert.rejects(session.execute(['project', 'apply', await write(directory, {version: 1, operations: [
    {op: 'command', command: 'var', args: ['delete', score.id, '--target', 'Sprite1']}
  ]})]), error => {
    const info = errorInfo(error); assert.equal(info.code, 'RESOURCE_IN_USE'); assert.equal(info.details.operation, 0);
    assert.ok(info.details.references.some(ref => ref.opcode === 'data_setvariableto')); return true;
  });
  assert.deepEqual(state(session), referenced);
  await session.execute(['project', 'apply', await write(directory, {version: 1, operations: [
    {op: 'script.delete', target: 'Sprite1', root: added.root},
    {op: 'command', command: 'var', args: ['delete', score.id, '--target', 'Sprite1']}
  ]})]);
  assert.equal(session.project.target('Sprite1').blocks.getScripts().length, 1);
  assert.equal(session.project.target('Sprite1').variables[score.id], undefined);
}));

test('native procedures synchronize signatures and prevent deletion of referenced definitions', async () => fixture(async (session, directory) => {
  await session.execute(['project', 'apply', await write(directory, {version: 1, operations: [
    {op: 'procedure.define', target: 'Sprite1', name: 'advance', params: [{name: 'distance', type: 'number'}]},
    {op: 'command', command: 'blocks', args: ['procedure-call', 'advance', '--values', '{"distance":12}', '--target', 'Sprite1']}
  ]})]);
  const before = state(session);
  await assert.rejects(session.execute(['project', 'apply', await write(directory, {version: 1, operations: [
    {op: 'procedure.delete', target: 'Sprite1', name: 'advance'}
  ]})]), error => {
    const info = errorInfo(error); assert.equal(info.code, 'RESOURCE_IN_USE'); assert.equal(info.details.operation, 0);
    assert.ok(info.details.references.some(ref => ref.opcode === 'procedures_call')); return true;
  });
  assert.deepEqual(state(session), before);
  await session.execute(['project', 'apply', await write(directory, {version: 1, operations: [
    {op: 'procedure.update', target: 'Sprite1', name: 'advance', newName: 'advance fast', warp: true,
      params: [{name: 'distance', type: 'number'}, {name: 'extra', type: 'number', default: 5}]}
  ]})]);
  const blocks = Object.values(session.project.target('Sprite1').blocks._blocks);
  const prototype = blocks.find(block => block.opcode === 'procedures_prototype');
  const call = blocks.find(block => block.opcode === 'procedures_call');
  assert.equal(call.mutation.proccode, 'advance fast %s %s');
  assert.deepEqual(call.mutation, prototype.mutation);
  assert.deepEqual(Object.keys(call.inputs), JSON.parse(prototype.mutation.argumentids));
}));

test('public SDK and exec produce equivalent edits; throwing scripts never save', async () => fixture(async (session, directory, demo) => {
  const {openProject} = require('..');
  const project = await openProject(demo);
  const sdkOutput = path.join(directory, 'sdk.sb3'), execOutput = path.join(directory, 'exec.sb3');
  try {
    await project.batch(async edit => {await edit.target('Sprite1').blocks.update(moveId(session), {inputs: {STEPS: 63}});});
    await project.save(sdkOutput);
  } finally {await project.dispose();}
  const script = path.join(directory, 'edit.js');
  await fs.writeFile(script, `module.exports = async project => { console.log('editor diagnostic'); process.stdout.write('direct output diagnostic\\n'); await project.target('Sprite1').blocks.update(${JSON.stringify(moveId(session))}, {inputs:{STEPS:63}}); };\n`);
  const executed = cli(['project', 'exec', script, '--project', demo, '--out', execOutput]);
  assert.equal(executed.status, 0, executed.stdout + executed.stderr); assert.doesNotThrow(() => JSON.parse(executed.stdout));
  assert.match(executed.stderr, /editor diagnostic/); assert.match(executed.stderr, /direct output diagnostic/);
  await session.execute(['open', sdkOutput]); const sdkRun = await session.execute(['run', '--frames', '3', '--seed', '1234']);
  await session.execute(['open', execOutput]); const execRun = await session.execute(['run', '--frames', '3', '--seed', '1234']);
  assert.equal(spriteX(sdkRun), 63); assert.equal(spriteX(execRun), 63);
  const failed = path.join(directory, 'failed.sb3');
  await fs.writeFile(script, `module.exports = async project => { await project.target('Sprite1').blocks.update(${JSON.stringify(moveId(session))},{inputs:{STEPS:999}}); throw Error('abort deliberately'); };\n`);
  assert.equal(cli(['project', 'exec', script, '--project', demo, '--out', failed]).status, 1);
  await assert.rejects(fs.stat(failed), {code: 'ENOENT'});
}));

for (const mode of ['move', 'batch', 'procedure']) test(`project editing ${mode} example creates evidence and verifies saved SB3`, async () => {
  const result = await require('../scripts/project-edit-examples').runExample(mode);
  try {
    assert.equal(result.verified, true); assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(result.outputSha256, /^[a-f0-9]{64}$/);
    const transcript = JSON.parse(await fs.readFile(path.join(result.directory, 'transcript.json'), 'utf8'));
    assert.ok(transcript.some(item => item.args[0] === 'project' && ['apply', 'exec'].includes(item.args[1])));
    assert.ok(transcript.every(item => item.status === 0));
    assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'verification.json'), 'utf8')).verified, true);
  } finally {await fs.rm(result.directory, {recursive: true, force: true});}
});
