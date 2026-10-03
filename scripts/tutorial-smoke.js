const fs = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const JSZip = require('@turbowarp/jszip');

const main = async () => {
  const root = path.resolve(__dirname, '..');
  const base = path.join(root, 'examples');
  await fs.mkdir(base, {recursive: true});
  const out = await fs.mkdtemp(path.join(base, 'verified-'));
  const cli = path.join(root, 'tw');
  const transcript = [];
  const run = args => {
    const result = spawnSync(cli, args, {cwd: out, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024});
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    const value = JSON.parse(result.stdout.trim()); transcript.push({argv: args, exitCode: result.status, result: value});
    return value;
  };
  const created = run(['new', 'demo.sb3']);
  const edited = run(['script', 'demo', '25', '--project', 'demo.sb3', '--out', 'demo.sb3']);
  const runtime = run(['run', '--project', 'demo.sb3', '--frames', '2', '--out', 'result.png']);
  assert.equal(runtime.targets.find(target => target.name === 'Sprite1').x, 25);
  run(['package', 'demo.html', '--project', 'demo.sb3']);
  run(['package', 'demo.zip', '--project', 'demo.sb3']);
  const info = run(['info', '--project', 'demo.sb3']);
  assert.equal(info.targets.find(target => target.name === 'Sprite1').x, 0);
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(out, 'demo.sb3')));
  assert.ok(zip.file('tw-cli-state.json'));
  const trace = run(['run', '--project', 'demo.sb3', '--frames', '2', '--seed', '1234', '--trace', '100']);
  assert.ok(trace.trace.entries.some(entry => entry.opcode === 'motion_movesteps'));
  const library = run(['library', 'status']); assert.equal(library.available, 1304); assert.equal(library.missing, 0);
  const search = run(['library', 'search', 'sprite', 'Cat', '--limit', '5']); assert.ok(search.items.length > 0);
  run(['library', 'load', 'sprite', search.items[0].name, '--project', 'demo.sb3', '--out', 'with-cat.sb3']);
  const {tokenize} = require('../bin/tw');
  const commands = [
    'open demo.sb3', 'settings size 640 480', 'settings set fps 60',
    'asset blank costume drawing --mode vector --width 100 --height 80',
    `paint rectangle drawing --spec '{"x":5,"y":5,"width":30,"height":20,"fill":"#00ff00"}'`,
    'asset export costume drawing drawing.svg', 'render drawing.png',
    'font add-builtin Pixel MyPixel', 'font measure MyPixel Hello --size 24',
    'font render MyPixel Hello --size 24 --width 200 --height 60 --output font.png',
    'var add 得分 5', 'monitor add 得分', 'monitors mode 得分 slider', 'monitors range 得分 0 100',
    'input key space down', 'device loudness 64 --frame 0', 'device input-list --output inputs.jsonl',
    'save tutorial.sb3', 'runtime start --paused --no-compile --seed 1234 --trace 100',
    'runtime step --frames 2', 'runtime status', 'runtime trace get --limit 20', 'runtime stop',
    `pack set app.windowTitle 'Tutorial Game'`, 'pack build tutorial.html',
    'record start recorded-frames --duration 0.2 --fps 10 --projectaudio false', 'quit'
  ].map((line, index) => {const [command, ...args] = tokenize(line); return {id: index + 1, command, args};});
  const session = spawnSync(cli, ['session', '--jsonl'], {cwd: out, input: commands.map(request => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024});
  assert.equal(session.status, 0, session.stderr);
  const replies = session.stdout.trim().split('\n').map(line => JSON.parse(line)); assert.equal(replies.length, commands.length);
  for (const [index, reply] of replies.entries()) {
    assert.equal(reply.ok, true, JSON.stringify({request: commands[index], reply}));
    transcript.push({request: commands[index], reply});
  }
  const {loadImage} = require('@napi-rs/canvas');
  const drawing = await loadImage(await fs.readFile(path.join(out, 'drawing.png')));
  assert.equal(drawing.width, 640); assert.equal(drawing.height, 480);
  const recordManifest = JSON.parse(await fs.readFile(path.join(out, 'recorded-frames/manifest.json')));
  assert.equal(recordManifest.timing.frameCount, 2); assert.equal(recordManifest.noDOM, true);
  const {runExample} = require('./agent-example');
  const agentExamples = [];
  for (const mode of ['basic', 'input', 'debug']) agentExamples.push(await runExample(mode, path.join(out, 'agent-' + mode)));
  const manifest = {directory: out, commands: transcript.length, agentExamples, targetXAfterRun: 25, editorXAfterRun: 0,
    traceEntries: trace.trace.entries.length, libraryAssets: library.available,
    noDOM: runtime.noDOM && recordManifest.noDOM, recordingFrames: recordManifest.timing.frameCount,
    files: ['demo.sb3', 'result.png', 'demo.html', 'demo.zip', 'with-cat.sb3', 'drawing.svg', 'drawing.png', 'font.png',
      'inputs.jsonl', 'tutorial.sb3', 'tutorial.html', 'recorded-frames/manifest.json']};
  await fs.writeFile(path.join(out, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
  await fs.writeFile(path.join(out, 'verification.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
};
main().catch(error => {console.error(error); process.exitCode = 1;});
