'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {fork} = require('node:child_process');
const {createProject, openProject} = require('..');
const {blankProject, readProject} = require('../src/project');

const temporary = async fn => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-sdk-'));
  try {await fn(dir);} finally {await fs.rm(dir, {recursive: true, force: true});}
};
const archiveTarget = async file => (await readProject(await fs.readFile(file))).json.targets.find(target => !target.isStage);

test('public package SDK edits sequentially in one batch and reopens saved SB3', async () => temporary(async dir => {
  assert.deepEqual(Object.keys(require('..')).sort(), ['createProject', 'openProject']);
  assert.equal(require('..').createSDK, undefined);
  const project = await createProject();
  const output = path.join(dir, 'edited.sb3');
  try {
    const target = project.target('Sprite1');
    const result = await project.batch(async () => {
      await target.variables.add('score', 4);
      await target.variables.set('score', 12);
      await target.lists.add('history', ['first']);
      await target.lists.append('history', 'second');
      await target.procedures.define({name: 'compute', type: 'reporter', params: [{name: 'n', type: 'number'}]});
      const current = await target.read();
      assert.equal(current.targets[0].name, 'Sprite1');
      await assert.rejects(project.save(output), error => error.code === 'BATCH_COMMAND_DENIED');
      await assert.rejects(project.batch([], {out: output}), error => error.code === 'BATCH_COMMAND_DENIED');
    });
    assert.equal(result.changed, true);
    assert.equal((await project.validate()).valid, true);
    const assetId = (await target.read()).targets[0].assets.costumes[0].id;
    await target.assets.costumes.rename(assetId, 'renamed costume');
    await target.assets.costumes.reorder(assetId, 0);
    const saved = await project.save(output);
    assert.equal(saved.path, output);
    const sprite = await archiveTarget(output);
    assert.deepEqual(Object.values(sprite.variables), [['score', 12]]);
    assert.deepEqual(Object.values(sprite.lists), [['history', ['first', 'second']]]);
    const reopened = await openProject(output);
    try {assert.equal((await reopened.read()).revision, (await project.read()).revision);} finally {reopened.dispose();}
    await assert.rejects(project.save(path.join(dir, 'bad.txt')), /sb3/);
    await assert.rejects(project.save(), error => error.code === 'INVALID_ARGUMENT');
  } finally {project.dispose();}
}));

test('SDK candidate validation and callback failure preserve live content', async () => temporary(async dir => {
  const project = await createProject();
  try {
    const before = (await project.read()).revision;
    const document = {version: 1, baseRevision: before, operations: [
      {type: 'command', command: 'var', args: ['add', 'temporary', '1', '--target', 'Sprite1']}
    ]};
    assert.equal((await project.validate(document)).valid, true);
    assert.equal((await project.read()).revision, before);
    await assert.rejects(project.batch(async () => {
      await project.target('Sprite1').variables.add('temporary', 1);
      throw new Error('user callback failed');
    }), /user callback failed/);
    assert.equal((await project.read()).revision, before);
    const result = await project.batch(document);
    assert.equal(result.changed, true);
    await assert.rejects(project.batch(document), error => error.code === 'PROJECT_CONFLICT');
    const output = path.join(dir, 'result.sb3');
    await project.save(output);
    assert.deepEqual(Object.values((await archiveTarget(output)).variables), [['temporary', 1]]);
  } finally {project.dispose();}
  assert.throws(() => project.target('Sprite1'), error => error.code === 'SESSION_DISPOSED');
  project.dispose();
}));

const runWorker = (bytes, scriptPath) => new Promise((resolve, reject) => {
  const child = fork(path.join(__dirname, '../src/project-exec-worker.js'), [], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let stdout = '', stderr = '', response;
  child.stdout.on('data', bytes => {stdout += bytes;});
  child.stderr.on('data', bytes => {stderr += bytes;});
  const timer = setTimeout(() => {child.kill(); reject(new Error('Editing worker timeout'));}, 20000);
  child.on('error', reject);
  child.on('message', value => {response = value;});
  child.on('exit', code => {clearTimeout(timer); if (response) resolve({response, stdout, stderr, code}); else reject(new Error(`Worker exited ${code}: ${stderr}`));});
  child.send({bytes: bytes.toString('base64'), scriptPath});
});

test('exec worker loads CommonJS and ESM scripts, redirects stdout, and commits only successful callbacks', async () => temporary(async dir => {
  const bytes = await blankProject();
  for (const ext of ['cjs', 'mjs', 'js']) {
    const scriptPath = path.join(dir, `edit.${ext}`);
    const declaration = ext === 'mjs' ? 'export default' : 'module.exports =';
    await fs.writeFile(scriptPath, `${declaration} async project => {
      console.log('editing'); process.stdout.write('direct output\\n');
      await project.target('Sprite1').variables.add('score', 9);
    };`);
    const {response, stdout, stderr, code} = await runWorker(bytes, scriptPath);
    assert.equal(code, 0); assert.equal(stdout, ''); assert.match(stderr, /editing/); assert.match(stderr, /direct output/);
    assert.equal(response.ok, true);
    const sprite = (await readProject(Buffer.from(response.bytes, 'base64'))).json.targets.find(target => !target.isStage);
    assert.deepEqual(Object.values(sprite.variables), [['score', 9]]);
  }
  const failing = path.join(dir, 'fail.cjs');
  await fs.writeFile(failing, "module.exports = async project => { await project.target('Sprite1').variables.add('score', 1); throw new Error('script failed'); };\n");
  const failed = (await runWorker(bytes, failing)).response;
  assert.equal(failed.ok, false); assert.match(failed.error.message, /script failed/); assert.equal(failed.bytes, undefined);
  const saving = path.join(dir, 'save.cjs');
  const output = path.join(dir, 'forbidden.sb3');
  await fs.writeFile(saving, `module.exports = async project => { await project.batch([], {out: ${JSON.stringify(output)}}); };\n`);
  assert.equal((await runWorker(bytes, saving)).response.error.code, 'BATCH_COMMAND_DENIED');
  await assert.rejects(fs.stat(output), {code: 'ENOENT'});
}));
