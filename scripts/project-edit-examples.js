'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {CommandSession} = require('../src/commands');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runExample = async (mode, output) => {
  if (!['move', 'batch', 'procedure'].includes(mode)) throw new Error('Use project-edit-examples.js move|batch|procedure [new-output-directory]');
  const directory = output ? path.resolve(output) : await fs.mkdtemp(path.join(os.tmpdir(), `tw-project-${mode}-`));
  if (output) await fs.mkdir(directory); // Keep previous evidence: refuse existing directories.
  const transcript = [], session = new CommandSession();
  const source = path.join(directory, 'source.sb3'), changed = path.join(directory, 'changed.sb3');
  const command = args => {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/tw.js'), ...args],
      {cwd: directory, encoding: 'utf8', timeout: 45000, maxBuffer: 12 * 1024 * 1024});
    transcript.push({args, status: result.status, stdout: result.stdout, stderr: result.stderr});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    await session.execute(['new']);
    if (mode === 'procedure') {
      const definition = await session.execute(['blocks', 'procedure-add', 'advance', '--params', '[{"name":"distance","type":"number"}]']);
      const move = await session.execute(['blocks', 'add', 'motion_movesteps', '--after', definition.id]);
      await session.execute(['blocks', 'add', 'argument_reporter_string_number', '--fields', '{"VALUE":"distance"}', '--parent', move.id, '--input', 'STEPS']);
      const hat = await session.execute(['blocks', 'add', 'event_whenflagclicked']);
      await session.execute(['blocks', 'procedure-call', 'advance', '--values', '{"distance":12}', '--after', hat.id]);
    } else {
      const recipe = path.join(directory, 'initial-recipe.json');
      await fs.writeFile(recipe, JSON.stringify({version: 1, scripts: [[{opcode: 'event_whenflagclicked'}, {opcode: 'motion_movesteps', inputs: {STEPS: 10}}]]}));
      await session.execute(['script', 'apply', recipe]);
      if (mode === 'batch') {
        await session.execute(['sprite', 'add', 'Other']);
        await session.execute(['script', 'apply', recipe]);
      }
    }
    await session.execute(['save', source]);
    const sourceBefore = await fs.readFile(source);
    const read = command(['project', 'read', '--project', source, '--target', 'Sprite1']);
    await fs.writeFile(path.join(directory, 'read-before.json'), JSON.stringify(read, null, 2) + '\n');
    if (mode === 'move') {
      const nodes = [];
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.opcode === 'motion_movesteps') nodes.push(value);
        for (const child of Object.values(value)) visit(child);
      };
      visit(read.targets[0].scripts); assert.equal(nodes.length, 1);
      const document = {version: 1, baseRevision: read.revision, operations: [
        {op: 'block.update', target: 'Sprite1', id: nodes[0].id, inputs: {STEPS: 47}}
      ]};
      const edit = path.join(directory, 'edit.json'); await fs.writeFile(edit, JSON.stringify(document, null, 2) + '\n');
      assert.equal(command(['project', 'validate', edit, '--project', source]).valid, true);
      command(['project', 'apply', edit, '--project', source, '--out', changed]);
    } else {
      command(['project', 'exec', path.join(__dirname, 'project-edit-examples', `${mode}.js`), '--project', source, '--out', changed]);
    }
    assert.deepEqual(await fs.readFile(source), sourceBefore);
    const after = command(['project', 'read', '--project', changed, '--target', 'Sprite1']);
    await fs.writeFile(path.join(directory, 'read-after.json'), JSON.stringify(after, null, 2) + '\n');
    await session.execute(['open', changed]);
    const result = await session.execute(['run', '--frames', '4', '--seed', '1234']);
    const expected = mode === 'batch' ? {Sprite1: 31, Other: 57} : {Sprite1: mode === 'move' ? 47 : 30};
    for (const [name, x] of Object.entries(expected)) assert.equal(result.targets.find(target => target.name === name).x, x);
    if (mode === 'procedure') {
      const blocks = Object.values(session.project.target('Sprite1').blocks._blocks);
      const prototype = blocks.find(block => block.opcode === 'procedures_prototype');
      const call = blocks.find(block => block.opcode === 'procedures_call');
      assert.equal(prototype.mutation.proccode, 'advance-fast %s');
      assert.equal(call.mutation.proccode, prototype.mutation.proccode); assert.equal(call.mutation.warp, 'true');
    }
    const summary = {version: 1, mode, directory, verified: true, expectedPositions: expected,
      sourceSha256: hash(sourceBefore), outputSha256: hash(await fs.readFile(changed)),
      limits: ['native VM fixed-seed execution; official editor and full GUI acceptance not verified']};
    await fs.writeFile(path.join(directory, 'run-result.json'), JSON.stringify(result, null, 2) + '\n');
    await fs.writeFile(path.join(directory, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
    await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
    return summary;
  } catch (error) {
    await fs.writeFile(path.join(directory, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
    throw error;
  } finally {session.dispose();}
};
if (require.main === module) runExample(process.argv[2], process.argv[3])
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {runExample};
