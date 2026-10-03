'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const {spawn} = require('node:child_process');

const runExample = async (mode, output) => {
  if (!['basic', 'input', 'debug'].includes(mode)) throw new Error('Use agent-example.js basic|input|debug [new-output-directory]');
  const directory = output ? path.resolve(output) : await fs.mkdtemp(path.join(os.tmpdir(), `tw-agent-${mode}-`));
  if (output) await fs.mkdir(directory); // Deliberately refuse existing output directories.
  const root = path.resolve(__dirname, '..'), transcript = [];
  const child = spawn(process.execPath, [path.join(root, 'bin/tw.js'), 'session', '--jsonl'], {cwd: directory, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = readline.createInterface({input: child.stdout});
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', bytes => {stderr = (stderr + bytes).slice(-1024 * 1024);});
  const closed = new Promise((resolve, reject) => {child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));});
  // Handle startup failure even when it precedes a pending request.
  closed.catch(() => {});
  const request = async (command, args = [], expected = true) => {
    const message = {id: transcript.length + 1, command, args};
    child.stdin.write(JSON.stringify(message) + '\n');
    let timer;
    try {
      const line = await Promise.race([iterator.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Example command timed out: ${command}`)), 35000);
      })]);
      assert.equal(line.done, false, stderr);
      const reply = JSON.parse(line.value);
      transcript.push({request: message, reply});
      assert.equal(reply.id, message.id); assert.equal(reply.ok, expected, JSON.stringify(reply));
      return expected ? reply.result : reply.errorInfo;
    } finally {clearTimeout(timer);}
  };
  const sprite = result => result.targets.find(target => target.name === '小猫');
  try {
    const help = await request('help', ['script', '--json']); assert.ok(help.commands.some(item => item.action === 'apply'));
    const capabilities = await request('capabilities', ['--json']); assert.ok(capabilities.implemented.some(item => item.id === 'script-recipes'));
    const info = await request('blocks', ['schema', 'motion_movesteps']); assert.equal(info.inputs.STEPS.type, 'value');
    await request('new');
    await request('library', ['load', 'sprite', 'Cat 2']);
    await request('sprite', ['select', 'Sprite1']); await request('sprite', ['delete']);
    await request('sprite', ['select', 'Cat 2']); await request('sprite', ['rename', '小猫']);
    await request('sprite', ['set', 'x', '-120']);
    const recipe = path.join(__dirname, 'recipes', mode === 'input' ? 'input.json' : 'basic.json');
    const validation = await request('script', ['validate', recipe]); assert.equal(validation.applied, false);
    const applied = await request('script', ['apply', recipe]); assert.equal(applied.applied, true);
    await request('save', ['demo.sb3']); await request('open', ['demo.sb3']);
    const before = await fs.readFile(path.join(directory, 'demo.sb3'));
    if (mode === 'input') {
      await request('device', ['key', 'space', 'down', '--frame', '0']);
      await request('device', ['input-list', '--output', 'inputs.jsonl']);
      await request('open', ['demo.sb3']); await request('device', ['replay', 'inputs.jsonl']);
      const result = await request('run', ['--frames', '3', '--seed', '1234', '--trace', '100', '--out', 'result.png']);
      assert.equal(sprite(result).y, 40); assert.equal(sprite(result).x, -120);
      assert.equal(sprite(await request('info')).y, 0);
    } else if (mode === 'debug') {
      const error = await request('sprite', ['set', 'x', 'not-a-number'], false); assert.equal(error.code, 'INVALID_ARGUMENT');
      await request('sprite', ['set', 'x', '-120']); await request('save');
      await request('runtime', ['start', '--paused', '--no-compile', '--seed', '1234', '--trace', '100']);
      const blockId = applied.nodeMap['$.scripts[0][1]'];
      await request('runtime', ['breakpoint', 'add', blockId]);
      const paused = await request('runtime', ['step', '--frames', '2']); assert.equal(sprite(paused).x, -120);
      const hits = await request('runtime', ['breakpoint', 'hits']); assert.equal(hits.entries[0].blockId, blockId);
      const stepped = await request('runtime', ['step']); assert.equal(sprite(stepped).x, -20);
      const trace = await request('runtime', ['trace', 'get', '--limit', '10']); assert.equal(trace.entries[0].opcode, 'motion_movesteps');
      await request('runtime', ['stop']);
      const finalRun = await request('run', ['--frames', '2', '--seed', '1234', '--out', 'result.png']);
      assert.equal(sprite(finalRun).x, -20); assert.equal(sprite(await request('info')).x, -120);
    } else {
      const result = await request('run', ['--frames', '2', '--seed', '1234', '--trace', '100', '--out', 'result.png']);
      assert.equal(sprite(result).x, -20); assert.equal(sprite(await request('info')).x, -120);
    }
    const image = await require('../src/record-worker').validatePNG(await fs.readFile(path.join(directory, 'result.png')),
      {width: 480, height: 360});
    // Debug explicitly saves its correction; other modes must leave disk bytes unchanged.
    if (mode !== 'debug') assert.deepEqual(await fs.readFile(path.join(directory, 'demo.sb3')), before);
    await request('quit'); child.stdin.end();
    const exit = await closed; assert.equal(exit.code, 0, stderr);
    const summary = {schemaVersion: 1, mode, directory, verified: true, commands: transcript.length,
      expectedErrors: transcript.filter(item => !item.reply.ok).length, image,
      files: ['demo.sb3', 'result.png', 'transcript.json', 'verification.json', 'stderr.log']};
    await fs.writeFile(path.join(directory, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
    await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
    await fs.writeFile(path.join(directory, 'stderr.log'), stderr);
    return summary;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed.catch(() => {});
  }
};
if (require.main === module) {
  if (process.argv.length > 4) {console.error('Use agent-example.js basic|input|debug [new-output-directory]'); process.exitCode = 1;}
  else runExample(process.argv[2], process.argv[3]).then(result => console.log(JSON.stringify(result)))
    .catch(error => {console.error(error); process.exitCode = 1;});
}
module.exports = {runExample};
