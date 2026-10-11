'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const {CommandSession} = require('../src/commands');
const {revision} = require('../src/project-code');
const root = path.resolve(__dirname, '..');
const fixture = async operation => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-transaction-'));
  const session = new CommandSession();
  try {await operation(session, directory);} finally {session.dispose(); await fs.rm(directory, {recursive: true, force: true});}
};
const cli = (args, input) => spawnSync(process.execPath, [path.join(root, 'bin/tw.js'), ...args], {input, encoding: 'utf8', timeout: 30000});
const cliJSON = (args, input) => {
  const result = cli(args, input); assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout);
};

test('ordinary SB3 without CLI metadata has stable identities and revisions across independent processes', async () => fixture(async (session, directory) => {
  const source = path.join(directory, 'ordinary.sb3');
  const zip = await JSZip.loadAsync(await require('./helpers/demo-project').demoProject());
  zip.remove('tw-cli-state.json'); await fs.writeFile(source, await zip.generateAsync({type: 'nodebuffer'}));
  const first = cliJSON(['project', 'read', '--project', source, '--target', 'Sprite1']);
  const second = cliJSON(['project', 'read', '--project', source, '--target', 'Sprite1']);
  assert.deepEqual(second, first);
  const target = first.targets[0], move = target.scripts[0].body.find(node => node.opcode === 'motion_movesteps');
  const edit = JSON.stringify({version: 1, baseRevision: first.revision, operations: [
    {op: 'block.update', target: target.id, id: move.id, inputs: {STEPS: 19}}
  ]});
  assert.equal(cliJSON(['project', 'validate', '-', '--project', source], edit).valid, true);
  const output = path.join(directory, 'edited.sb3');
  cliJSON(['project', 'apply', '-', '--project', source, '--out', output], edit);
  const after = cliJSON(['project', 'read', '--project', output, '--target', target.id]);
  assert.equal(after.targets[0].id, target.id); assert.equal(after.targets[0].assets.costumes[0].id, target.assets.costumes[0].id);
  await session.open(output);
  assert.equal((await session.execute(['run', '--frames', '2'])).targets.find(target => target.name === 'Sprite1').x, 19);
}));

test('late source conflict before atomic commit preserves external bytes and rolls back batch', async () => fixture(async (session, directory) => {
  const source = path.join(directory, 'source.sb3'); await session.execute(['new', source]);
  const before = revision(session.project), hash = session.project.sourceHash;
  const bytes = session.project.bytes.bind(session.project);
  let serializations = 0;
  session.project.bytes = async () => {
    const result = await bytes();
    if (++serializations === 2) await fs.writeFile(source, 'changed during serialization');
    return result;
  };
  await assert.rejects(session.applyProjectEdits({version: 1, operations: [
    {op: 'command', command: 'sprite', args: ['set', 'x', '8']}
  ]}, {out: source}), {code: 'PROJECT_CONFLICT'});
  assert.equal(await fs.readFile(source, 'utf8'), 'changed during serialization');
  assert.equal(revision(session.project), before); assert.equal(session.project.sourceHash, hash);
  assert.equal(session.project.file, source); assert.equal(session.dirty, false); assert.equal(session.undoStack.length, 0);
}));

test('new one-shot command failures expose stable structured error codes', async () => fixture(async (session, directory) => {
  const demo = await require('./helpers/demo-project').writeDemoProject(path.join(directory, 'synthetic-demo.sb3'));
  const result = cli(['project', 'apply', '-', '--project', demo], '{}');
  assert.equal(result.status, 1); const error = JSON.parse(result.stdout);
  assert.equal(error.ok, false); assert.equal(error.errorInfo.code, 'INVALID_ARGUMENT');
}));

test('editing script may delete the selected sprite and commit the remaining stage', async () => fixture(async (session, directory) => {
  await session.execute(['new']);
  const script = path.join(directory, 'delete-selected.cjs'), output = path.join(directory, 'stage-only.sb3');
  await fs.writeFile(script, "module.exports = async project => project.batch([{op:'command',command:'sprite',args:['delete','--target','Sprite1']}]);");
  const result = await session.execute(['project', 'exec', script, '--out', output]);
  assert.equal(result.changed, true); assert.equal(session.project.vm.editingTarget.isStage, true);
  assert.equal(session.project.info().targets.length, 1);
  await session.open(output); assert.equal(session.project.info().targets.length, 1);
  assert.equal(session.project.vm.editingTarget.isStage, true);
}));

test('disposing a session kills its editing worker without reconstructing disposed state', async () => fixture(async (session, directory) => {
  await session.execute(['new']);
  const script = path.join(directory, 'wait.cjs');
  await fs.writeFile(script, 'module.exports = async () => new Promise(() => {});');
  const pending = session.execute(['project', 'exec', script]);
  const rejected = assert.rejects(pending);
  const deadline = Date.now() + 10000;
  while (!session.workers.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(session.workers.size, 1);
  session.dispose(); await rejected;
  assert.equal(session.workers.size, 0); assert.equal(session.disposed, true); assert.equal(session._batchDepth, 0);
  assert.equal(session.project.vm, null);
}));
