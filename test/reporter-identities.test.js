'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const {blankProject} = require('../src/project');
const {CommandSession} = require('../src/commands');
const {read, find} = require('../src/project-code');

const fixture = async run => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-reporter-id-'));
  const session = new CommandSession();
  try {
    const zip = await JSZip.loadAsync(await blankProject());
    const json = JSON.parse(await zip.file('project.json').async('string'));
    const stage = json.targets[0]; stage.name = '背景';
    stage.variables = {score: ['score', 7], other: ['other', 11]};
    stage.lists = {items: ['items', [1, 2]]};
    stage.blocks = {
      'variable-a': [12, 'score', 'score'],
      'variable-b': [12, 'score', 'score'],
      'variable-c': [12, 'score', 'score'],
      'list-a': [13, 'items', 'items'],
      'list-b': [13, 'items', 'items'],
      'positioned-a': [12, 'score', 'score', 10, 20],
      'positioned-b': [12, 'score', 'score', 10, 20],
      say: {opcode: 'looks_say', next: null, parent: null, inputs: {MESSAGE: [3, [12, 'score', 'score'], [10, 'text']]},
        fields: {}, shadow: false, topLevel: true, x: 30, y: 40}
    };
    stage.comments = {note: {blockId: 'variable-b', x: 5, y: 6, width: 100, height: 100, minimized: false, text: 'same-content reporter'}};
    zip.file('project.json', JSON.stringify(json));
    const source = path.join(dir, 'source.sb3');
    await fs.writeFile(source, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
    await run(session, dir, source, Object.keys(stage.blocks));
  } finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
};
const cliRead = file => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/tw.js'), 'project', 'read', '--project', file, '--target', 'stage'],
    {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};

test('identical detached compact reporters keep source IDs across independent reads, edits and saved-SB3 reloads', async () => fixture(async (session, dir, source, ids) => {
  await session.open(source);
  const stage = session.project.target('stage');
  for (const id of ids) assert.equal(stage.blocks.getBlock(id)?.id, id);
  assert.equal(stage.comments.note.blockId, 'variable-b');
  const first = cliRead(source), second = cliRead(source);
  assert.deepEqual(second, first);
  assert.equal(first.targets[0].scripts.length, ids.length);
  const reporter = first.targets[0].scripts.find(script => script.root === 'variable-b');
  assert.equal(reporter.body[0].commentData.id, 'note');
  const saved = path.join(dir, 'saved.sb3'); await session.save(saved);
  assert.deepEqual(cliRead(saved), first);
  await session.open(saved);
  assert.deepEqual(await read(session.project, {target: 'stage'}), first);
  const unchanged = await session.applyProjectEdits({version: 1, operations: [
    {op: 'script.replace', target: 'stage', root: reporter.root, body: reporter.body}
  ]});
  assert.equal(unchanged.changed, false); assert.equal(session.undoStack.length, 0);
  assert.equal(session.project.target('stage').comments.note.blockId, 'variable-b');
  assert.equal(find(session.project, '', {target: 'stage', opcode: 'data_variable'}).length, 6);
  assert.equal(find(session.project, '', {target: 'stage', opcode: 'data_listcontents'}).length, 2);
  const run = await session.execute(['run', '--frames', '1', '--seed', '1']);
  const variables = run.targets.find(target => target.isStage).variables;
  assert.equal(variables.find(variable => variable.id === 'score').value, 7);
  await session.applyProjectEdits({version: 1, baseRevision: first.revision, operations: [
    {op: 'block.update', target: 'stage', id: 'variable-b', fields: {VARIABLE: 'other'}}
  ]});
  const edited = path.join(dir, 'edited.sb3'); await session.save(edited);
  await session.open(edited);
  assert.equal(session.project.target('stage').blocks.getBlock('variable-b').fields.VARIABLE.id, 'other');
  for (const id of ['variable-a', 'variable-c']) assert.equal(session.project.target('stage').blocks.getBlock(id).fields.VARIABLE.id, 'score');
  assert.equal(session.project.target('stage').comments.note.blockId, 'variable-b');
  const archive = await JSZip.loadAsync(await fs.readFile(edited));
  const data = JSON.parse(await archive.file('project.json').async('string'));
  for (const id of ids) assert.ok(Object.hasOwn(data.targets[0].blocks, id));
}));

test('compact source entries with contradictory incoming connections are rejected explicitly', async () => fixture(async (session, dir, source) => {
  await session.open(source);
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  const json = JSON.parse(await zip.file('project.json').async('string'));
  json.targets[0].blocks.say.inputs.MESSAGE = [2, 'variable-a'];
  zip.file('project.json', JSON.stringify(json));
  const vm = session.project.vm;
  await assert.rejects(session.project.load(await zip.generateAsync({type: 'nodebuffer'})), /Standalone compact block variable-a is referenced by say/);
  assert.equal(session.project.vm, vm);
}));

test('duplicate persisted primitive IDs remain rejected without replacing the current project', async () => fixture(async (session, dir, source) => {
  await session.open(source);
  const zip = await JSZip.loadAsync(await session.project.bytes());
  const identity = JSON.parse(await zip.file('tw-cli-state.json').async('string'));
  const stage = session.project.target('stage'), slots = identity.blockInputs[stage.id];
  const keys = Object.keys(slots); assert.equal(keys.length, 2);
  slots[keys[1]] = slots[keys[0]];
  zip.file('tw-cli-state.json', JSON.stringify(identity));
  const vm = session.project.vm;
  await assert.rejects(session.project.load(await zip.generateAsync({type: 'nodebuffer'})), /Duplicate CLI block input identity/);
  assert.equal(session.project.vm, vm); assert.equal(session.project.file, source);
}));

test('conflicting comments on a compact reporter are rejected without losing the original project', async () => fixture(async (session, dir, source) => {
  await session.open(source);
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  const json = JSON.parse(await zip.file('project.json').async('string'));
  json.targets[0].comments.second = {...json.targets[0].comments.note, text: 'second attached comment'};
  zip.file('project.json', JSON.stringify(json));
  const vm = session.project.vm;
  await assert.rejects(session.project.load(await zip.generateAsync({type: 'nodebuffer'})), /Multiple comments attached to compact block: variable-b/);
  assert.equal(session.project.vm, vm);
  assert.equal(session.project.target('stage').comments.note.text, 'same-content reporter');
}));
