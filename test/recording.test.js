'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {createCanvas} = require('@napi-rs/canvas');
const {CommandSession, validateCommand} = require('../src/commands');
const {blankProject} = require('../src/project');
const record = require('../src/record-commands');
const worker = require('../src/record-worker');
const GUI = path.resolve(__dirname, '../../desktop-master/node_modules/scratch-gui/src/addons/addons/mediarecorder/userscript.js');
const withSession = async fn => {
  const session = new CommandSession(), directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-record-')));
  try {await session.project.load(await blankProject()); session.dirty = false; await fn(session, directory);}
  finally {session.dispose(); await fs.rm(directory, {recursive: true, force: true});}
};
const manifestAt = async result => JSON.parse(await fs.readFile(result.manifest, 'utf8'));
const toneWave = (frequency = 440, duration = 1, amplitude = 0.25, rate = 44100) => {
  const samples = Math.round(duration * rate), pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * amplitude * 32767), i * 2);
  return worker.pcmWave(pcm, rate, 1);
};
const silenceWave = duration => worker.pcmWave(Buffer.alloc(Math.round(duration * 44100) * 2), 44100, 1);
const setMoveScript = target => {
  const block = (id, opcode, extra = {}) => ({id, opcode, next: null, parent: null, inputs: {}, fields: {}, topLevel: true, shadow: false, x: 0, y: 0, ...extra});
  target.blocks.createBlock(block('flag', 'event_whenflagclicked', {next: 'forever'}));
  target.blocks.createBlock(block('forever', 'control_forever', {parent: 'flag', topLevel: false, inputs: {SUBSTACK: {name: 'SUBSTACK', block: 'move', shadow: null}}}));
  target.blocks.createBlock(block('move', 'motion_changexby', {parent: 'forever', topLevel: false, inputs: {DX: {name: 'DX', block: 'amount', shadow: 'amount'}}}));
  target.blocks.createBlock(block('amount', 'math_number', {parent: 'move', topLevel: false, shadow: true, fields: {NUM: {name: 'NUM', value: '10'}}}));
};
const assertNotExists = async filename => assert.rejects(fs.stat(filename), {code: 'ENOENT'});
const assertMemoryBounded = memory => {
  assert.equal(memory.limitBytes, 512 * 1024 * 1024);
  assert.equal(memory.hostFontDiscovery, false); assert.equal(memory.canvasBootstrapFontFamilies, 0);
  assert.ok(memory.peakRSSBytes > 0 && memory.peakRSSBytes <= memory.limitBytes, `native peak ${memory.peakRSSBytes / 1048576} MiB`);
  assert.ok(memory.phases.length > 10 && memory.phases.length <= 80);
  assert.equal(memory.phases.at(-1).phase, 'disposed'); assert.equal(memory.phases.at(-1).fontFamilies, 0);
  for (const phase of memory.phases) assert.ok(phase.rssBytes <= memory.limitBytes && phase.peakRSSBytes <= memory.limitBytes);
};
const ffmpegGrants = `encoder:${record.DEFAULT_ENCODER},probe:${record.DEFAULT_PROBE}`;

// Tests of simulated projects / frozen code below are intentionally distinct
// from the two REAL native ffmpeg/digital-audio tests. No GUI claim is made.
test('six explicit option semantics and timer-before-delay match frozen source boundary', async () => {
  const source = await fs.readFile(GUI, 'utf8');
  for (const id of ['Seconds', 'Delay', 'Audio', 'Mic', 'Flag', 'Stop']) assert.ok(source.includes(`recordOption${id}Input`));
  assert.ok(source.indexOf('timeout = setTimeout(() => stopRecording(false), secs * 1000)') < source.indexOf('// Delay\n', source.indexOf('const startRecording')));
  assert.ok(source.includes('useStopSign: !recordOptionStopInput.disabled && recordOptionStopInput.checked'));
  const info = record.capabilities(); assert.equal(info.sixOptions.projectaudio.guiDefault, true); assert.equal(info.sixOptions.projectaudio.default, false);
  assert.equal(record.requiresProject('record', ['capabilities']), false); assert.equal(record.isReadOnly(), true);
  assert.equal(record.usesProjectTarget, false);
  assert.deepEqual(validateCommand(['record', 'start', '/tmp/new-output', '--waitflag', 'false']).args, ['start', '/tmp/new-output']);
  assert.throws(() => validateCommand(['record', 'start', '--out', 'project.sb3']), /not allowed/);
  assert.throws(() => record.configFor({delay: '1', duration: '1'}), /duration > delay/);
  assert.throws(() => record.configFor({'flag-frame': '899', duration: '1'}), /900-frame/);
  assert.equal(record.configFor({waitflag: 'false', stopOnStop: 'true'}).stopOnStop, false);
  assert.equal(record.configFor({duration: '0.56', fps: '25'}).durationFrames, 14);
});

test('actual offscreen PNG frame sequence/header/pixels manifest clock advances an independent non-dirty copy', {timeout: 30000}, async () => withSession(async (session, dir) => {
  setMoveScript(session.project.vm.editingTarget);
  const before = await session.project.bytes(), state = session.sessionState(), selected = session.project.vm.editingTarget.id;
  const output = path.join(dir, 'frames');
  const result = await session.execute(['record', 'start', output, '--duration', '0.5', '--fps', '10', '--seed', '123']);
  assert.equal(result.frames, 5); assert.equal(result.noDOM, true); assert.equal(result.projectChanged, false); assert.equal(session.dirty, false); assert.equal(session.undoStack.length, 0);
  assert.deepEqual(await session.project.bytes(), before); assert.deepEqual(session.sessionState(), state); assert.equal(session.project.vm.editingTarget.id, selected);
  const manifest = await manifestAt(result); assertMemoryBounded(manifest.memory); assert.equal(manifest.audio, null); assert.equal(manifest.timing.captureStartFrame, 0); assert.equal(manifest.timing.frameCount, 5);
  assert.equal(manifest.frames[0].simulationFrame, 0); assert.equal(manifest.frames[4].timeSeconds, 0.4);
  assert.notEqual(manifest.frames[0].pixelsSha256, manifest.frames[4].pixelsSha256);
  for (const frame of manifest.frames) {
    const bytes = await fs.readFile(path.join(output, frame.file)), verified = await worker.validatePNG(bytes, {width: 480, height: 360});
    assert.equal(verified.pixels, 480 * 360); assert.equal(verified.sha256, frame.sha256); assert.equal(verified.pixelsSha256, frame.pixelsSha256);
  }
  assert.equal(manifest.runtimeCopy.targets[1].x, 50); assert.equal(session.project.vm.editingTarget.x, 0);
  const corrupt = structuredClone(manifest); corrupt.dimensions.width = 999999;
  await fs.writeFile(result.manifest, JSON.stringify(corrupt));
  await assert.rejects(record.verifyDirectory(output, manifest.sourceProjectSha256, Date.now() + 3000), /header/);
  await fs.writeFile(result.manifest, JSON.stringify(manifest));
  assert.equal(session.workers.size, 0);
  const second = await session.execute(['record', 'start', path.join(dir, 'repeat'), '--duration', '0.5', '--fps', '10', '--seed', '123']);
  assert.deepEqual((await manifestAt(second)).frames.map(frame => frame.pixelsSha256), manifest.frames.map(frame => frame.pixelsSha256));
}));

test('waitflag/delay/stopOnStop/endstop semantics use clock frames, not wall sleeps or exhausted threads', {timeout: 30000}, async () => withSession(async (session, dir) => {
  setMoveScript(session.project.vm.editingTarget);
  const delayed = await session.execute(['record', 'start', path.join(dir, 'delayed'), '--duration', '0.6', '--delay', '0.2', '--fps', '10', '--flag-frame', '2']);
  const d = await manifestAt(delayed);
  assert.equal(d.timing.triggerFrame, 2); assert.equal(d.timing.captureStartFrame, 4); assert.equal(d.timing.frameCount, 4); assert.equal(d.timing.duration, 0.4);
  assert.equal(d.timing.durationIncludesDelay, true); assert.equal(d.frames[0].simulationFrame, 4); assert.equal(d.runtimeCopy.targets[1].x, 60);
  const stopped = await session.execute(['record', 'start', path.join(dir, 'stopped'), '--duration', '1', '--fps', '10', '--stop-frame', '3']);
  assert.equal(stopped.frames, 3); assert.equal(stopped.stopReason, 'PROJECT_STOP_ALL');
  const disabled = await session.execute(['record', 'start', path.join(dir, 'disabled'), '--duration', '0.6', '--fps', '10', '--stop-frame', '3', '--stopOnStop', 'false']);
  assert.equal(disabled.frames, 6); assert.equal(disabled.stopReason, 'duration');
  const idle = await session.execute(['record', 'start', path.join(dir, 'idle'), '--duration', '0.2', '--fps', '10', '--waitflag', 'false']);
  const i = await manifestAt(idle); assert.equal(i.runtimeCopy.targets[1].x, 0); assert.equal(i.options.stopOnStop, false); assert.equal(idle.frames, 2);
  const early = path.join(dir, 'stop-before-delay');
  await assert.rejects(session.execute(['record', 'start', early, '--duration', '1', '--delay', '0.5', '--fps', '10', '--stop-frame', '1']), /before its first frame/);
  await assertNotExists(early);
  await session.project.load(await blankProject());
  const exhausted = await session.execute(['record', 'start', path.join(dir, 'empty'), '--duration', '0.2', '--fps', '10']);
  assert.equal(exhausted.frames, 2); assert.equal(exhausted.stopReason, 'duration');
}));

test('actual native preRecorded decoding/sample-clock WAV mix including delay crop, source offset and microphone replacement', {timeout: 30000}, async () => withSession(async (session, dir) => {
  const a = path.join(dir, 'external.wav'), b = path.join(dir, 'mic.wav'), file = path.join(dir, 'soundfiles.json');
  const source = toneWave(440, 1, 0.25), mic = toneWave(880, 1, 0.125);
  await fs.writeFile(a, source); await fs.writeFile(b, mic);
  await fs.writeFile(file, JSON.stringify({version: 1, tracks: [
    {file: 'external.wav', role: 'external', start: 0, offset: 0.1, length: 0.8, gain: 1},
    {file: 'mic.wav', role: 'microphone', start: 0.2, offset: 0, length: 0.6, gain: 0.5}]}));
  const output = path.join(dir, 'mixed');
  await assert.rejects(session.execute(['record', 'start', output, '--soundfiles', file, '--microphonemix', 'true']), /权限拒绝 read/);
  await assertNotExists(output);
  const result = await session.execute(['record', 'start', output, '--duration', '0.8', '--delay', '0.2', '--fps', '10',
    '--microphonemix', 'true', '--soundfiles', file, '--allow', `read:${a},read:${b}`]);
  const manifest = await manifestAt(result), mixed = worker.inspectWave(await fs.readFile(path.join(output, 'audio.wav')));
  assert.equal(mixed.channels, 2); assert.equal(mixed.sampleRate, 44100); assert.equal(mixed.samples, Math.round(0.6 * 44100));
  assert.equal(manifest.audio.tracks.length, 2); assert.ok(manifest.audio.nonZeroSamples > 1000); assert.ok(manifest.audio.rms > 0.17);
  assert.equal(manifest.options.microphonemix, true); assert.equal(manifest.options.projectaudio, false);
  // Real PCM numerical expectation, independent of the native decoder/mixer.
  for (const index of [0, 1, 17, 100, 1000, 9999, 22050]) {
    const externalIndex = Math.round(0.3 * 44100) + index, micIndex = index;
    const expected = source.readInt16LE(44 + externalIndex * 2) / 32768 + mic.readInt16LE(44 + micIndex * 2) / 32768 * 0.5;
    const actual = mixed.pcm.readInt16LE(index * 4) / 32768;
    assert.ok(Math.abs(actual - expected) < 0.0001, `sample ${index}: ${actual} != ${expected}`);
    assert.equal(mixed.pcm.readInt16LE(index * 4), mixed.pcm.readInt16LE(index * 4 + 2));
  }
}));

test('projectaudio gaps/unsupported formats/no overlap fail closed, never produce success silent fallback or capture OS mic', {timeout: 30000}, async () => withSession(async (session, dir) => {
  for (const args of [['--projectaudio', 'true'], ['--microphonemix', 'true'], ['--duration', '30', '--fps', '60']]) {
    const output = path.join(dir, `denied-${args[0].slice(2)}`);
    await assert.rejects(session.execute(['record', 'start', output, ...args]), /NOT_YET_SUPPORTED|requires|900-frame/); await assertNotExists(output);
  }
  const audio = path.join(dir, 'short.wav'); await fs.writeFile(audio, toneWave(440, 0.1));
  const file = path.join(dir, 'no-overlap.json'); await fs.writeFile(file, JSON.stringify({version: 1, tracks: [{file: audio, start: 2}]}));
  const output = path.join(dir, 'no-overlap');
  let childRegistrations = 0;
  const registerChild = session.workers.add.bind(session.workers);
  session.workers.add = child => {childRegistrations++; return registerChild(child);};
  try {
    // A provably empty window is a data error, not a race against native RSS.
    // Prove no worker/native Project is started for this rejected source.
    await assert.rejects(session.execute(['record', 'start', output, '--soundfiles', file, '--duration', '0.2', '--allow', `read:${audio}`]), /no source samples/);
    assert.equal(childRegistrations, 0); assert.equal(session.workers.size, 0);
  } finally {session.workers.add = registerChild;}
  await assertNotExists(output);
  const mp3 = path.join(dir, 'bad.mp3'); await fs.writeFile(mp3, 'not WAV');
  await assert.rejects(session.execute(['record', 'start', path.join(dir, 'mp3'), '--audio-track', mp3]), /RIFF WAV/);
  const silent = path.join(dir, 'silent.wav'); await fs.writeFile(silent, silenceWave(0.2));
  const result = await session.execute(['record', 'start', path.join(dir, 'real-source-silence'), '--duration', '0.2', '--audio-track', silent]);
  assert.equal(result.audio.silentSource, true); assert.equal(result.audio.nonZeroSamples, 0); assert.equal(result.audio.tracks.length, 1);
  const target = session.project.vm.editingTarget;
  target.blocks.createBlock({id: 'blocking', opcode: 'sound_playuntildone', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0});
  const unsupported = path.join(dir, 'blocking');
  await assert.rejects(session.execute(['record', 'start', unsupported]), /sound_playuntildone.*offline audio timing/); await assertNotExists(unsupported);
}));

test('safe gamepad-mapping/device input replay participates in actual offscreen recording copy', {timeout: 30000}, async () => withSession(async (session, dir) => {
  await session.execute(['gamepad', 'create', 'pad', '--buttons', '1', '--axes', '0']);
  await session.execute(['gamepad', 'set-button', '0', '{"type":"key","high":"z"}']);
  await session.execute(['block', 'add', 'event_whenkeypressed', '--fields', '{"KEY_OPTION":"z"}']);
  const hat = Object.values(session.project.vm.editingTarget.blocks._blocks).find(block => block.opcode === 'event_whenkeypressed');
  await session.execute(['block', 'add', 'motion_changexby', '--inputs', '{"DX":19}', '--after', hat.id]);
  await session.execute(['device', 'gamepad', '{"id":"pad","index":0,"buttons":[1],"axes":[]}']);
  const before = await session.project.bytes();
  const result = await session.execute(['record', 'start', path.join(dir, 'pad-frames'), '--duration', '0.1', '--fps', '10']);
  assert.equal((await manifestAt(result)).runtimeCopy.targets[1].x, 19); assert.deepEqual(await session.project.bytes(), before);
}));

test('exact filenames defaultsafe executable grants, symlink/input/prototype/header/pixels and no overwrite are enforced', {timeout: 30000}, async () => withSession(async (session, dir) => {
  const output = path.join(dir, 'existing'); await fs.mkdir(output); await fs.writeFile(path.join(output, 'keep'), 'keep');
  await assert.rejects(session.execute(['record', 'start', output]), /EEXIST/); assert.equal(await fs.readFile(path.join(output, 'keep'), 'utf8'), 'keep');
  await assert.rejects(session.execute(['record', 'start', path.join(dir, 'encoded'), '--format', 'mp4']), /defaultsafe permission denied/);
  await assert.rejects(session.execute(['record', 'start', path.join(dir, 'relative'), '--format', 'mp4', '--encoder', 'ffmpeg']), /exact absolute/);
  await assert.rejects(session.execute(['record', 'start', path.join(dir, 'net'), '--audio-track', 'https://invalid/audio.wav']), /不安全本地路径/);
  const a = path.join(dir, 'audio.wav'); await fs.writeFile(a, toneWave()); const link = path.join(dir, 'alias.wav'); await fs.symlink(a, link);
  await assert.rejects(session.execute(['record', 'start', path.join(dir, 'link'), '--audio-track', link]), /符号链接/);
  const json = path.join(dir, 'unsafe.json'); await fs.writeFile(json, '{"version":1,"tracks":[],"__proto__":{}}');
  await assert.rejects(session.execute(['record', 'start', path.join(dir, 'proto'), '--soundfiles', json]), /prototype/);
  const png = createCanvas(8, 8).toBuffer('image/png');
  await worker.validatePNG(png, {width: 8, height: 8});
  await assert.rejects(worker.validatePNG(png, {width: 9, height: 8}), /header/);
  const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16); await assert.rejects(worker.validatePNG(bomb), /CRC|width/);
  await assert.rejects(worker.validatePNG(png.subarray(0, png.length - 1)), /Truncated|Invalid/);
  const changed = path.join(dir, 'modified'); const result = await session.execute(['record', 'start', changed, '--duration', '0.1', '--fps', '10']);
  const m = await manifestAt(result); await fs.writeFile(path.join(changed, 'frame-000000.png'), png);
  await assert.rejects(record.verifyDirectory(changed, m.sourceProjectSha256, Date.now() + 3000), /header|verification/);
}));

test('REAL system ffmpeg + ffprobe encode MP4 and WebM and verify frame count and non-silent decoded digital audio', {timeout: 60000}, async () => withSession(async (session, dir) => {
  await fs.access(record.DEFAULT_ENCODER); await fs.access(record.DEFAULT_PROBE);
  const audio = path.join(dir, 'tone.wav'); await fs.writeFile(audio, toneWave(440, 0.4, 0.25));
  for (const format of ['mp4', 'webm']) {
    const result = await session.execute(['record', 'start', path.join(dir, format), '--duration', '0.4', '--fps', '10',
      '--audio-track', audio, '--format', format, '--allow', ffmpegGrants]);
    const manifest = await manifestAt(result), probe = manifest.encoded.ffprobe;
    assertMemoryBounded(manifest.memory);
    assert.equal(probe.video.frameCount, 4); assert.equal(probe.video.width, 480); assert.equal(probe.video.height, 360);
    assert.equal(probe.video.codec, format === 'mp4' ? 'h264' : 'vp9'); assert.equal(probe.audio.codec, format === 'mp4' ? 'aac' : 'opus');
    assert.ok(probe.audio.decoded.nonZeroSamples > 1000); assert.ok(probe.audio.decoded.rms > 0.12);
    assert.ok(Math.abs(probe.audio.decoded.rms - manifest.audio.rms) < 0.025);
    assert.ok(manifest.encoded.bytes > 1000); assert.equal(session.dirty, false); assert.equal(session.workers.size, 0);
    // A second independently invoked real ffprobe confirms persisted media,
    // not a mocked child response or a nominal stream-only assertion.
    const independent = spawnSync(record.DEFAULT_PROBE, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', result.encoded.path],
      {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
    assert.equal(independent.status, 0); const streams = JSON.parse(independent.stdout).streams;
    assert.equal(Number(streams.find(stream => stream.codec_type === 'video').nb_read_frames), 4); assert.equal(streams.filter(stream => stream.codec_type === 'audio').length, 1);
  }
}));

test('bounded memory trace refuses an injected over-cap byte sample without relaxing the 512 MiB ceiling', () => {
  const memory = worker.createMemoryTrace();
  const actual = process.memoryUsage();
  assert.throws(() => memory.record('over-cap-allocation', 0, {...actual, rss: worker.LIMITS.rssBytes + 1}), /exceeded 512 MiB RSS.*over-cap-allocation/);
  assert.ok(memory.summary().peakRSSBytes > worker.LIMITS.rssBytes);
  const bounded = worker.createMemoryTrace();
  for (let i = 0; i < 100; i++) bounded.record('bounded-samples', i, actual);
  assert.equal(bounded.summary().phases.length, 80);
});

test('repeat long frames and MP4/WebM stress keeps native peak bounded through fonts, frame allocation and disposal', {timeout: 120000}, async t => withSession(async (session, dir) => {
  await session.execute(['font', 'add-builtin', 'Pixel', 'MyPixel']);
  await session.execute(['settings', 'size', '640', '480']);
  const svg = path.join(dir, 'font.svg');
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="90"><rect width="280" height="90" fill="#fff"/><text x="8" y="36" font-family="MyPixel" font-size="26">Pinned Glyph 123</text><text x="8" y="68" font-family="Serif" font-size="22">Frozen fallback</text></svg>');
  await session.execute(['costume', 'add', svg]);
  await session.execute(['costume', 'use', path.basename(svg, '.svg')]);
  const expected = await worker.validatePNG(session.project.renderer.png(), {width: 640, height: 480});
  const bytes = await session.project.bytes(), audio = path.join(dir, 'tone.wav');
  await fs.writeFile(audio, toneWave(440, 2, 0.25));
  const rows = [];
  // Fixed runs, not retry-until-green: two 240-frame captures, then two complete
  // codec cycles with real audio, ffprobe and decoded PCM numerical checks.
  const formats = ['frames', 'frames', 'mp4', 'webm', 'mp4', 'webm'];
  for (const [index, format] of formats.entries()) {
    const args = ['record', 'start', path.join(dir, `stress-${index}`), '--format', format, '--duration', format === 'frames' ? '8' : '1', '--fps', '30'];
    if (format !== 'frames') args.push('--audio-track', audio, '--allow', ffmpegGrants);
    const result = await session.execute(args), manifest = await manifestAt(result);
    assertMemoryBounded(manifest.memory);
    assert.equal(manifest.timing.frameCount, format === 'frames' ? 240 : 30);
    assert.equal(manifest.frames[0].pixelsSha256, expected.pixelsSha256); assert.equal(manifest.frames.at(-1).pixelsSha256, expected.pixelsSha256);
    const loaded = manifest.memory.phases.find(phase => phase.phase === 'project-load-after');
    assert.ok(loaded.fontFamilies >= 7, 'pinned/custom native font registry must really load');
    const released = manifest.memory.phases.filter(phase => phase.phase === 'frame-after-release');
    if (format === 'frames') {
      const baseline = released.find(phase => phase.frame === 119), final = released.at(-1);
      assert.ok(final.rssBytes - baseline.rssBytes < 24 * 1024 * 1024,
        `120 additional frames retained ${(final.rssBytes - baseline.rssBytes) / 1048576} MiB native RSS`);
    }
    if (format !== 'frames') {
      assert.equal(manifest.encoded.ffprobe.video.frameCount, 30); assert.ok(manifest.encoded.ffprobe.audio.decoded.rms > 0.12);
    }
    assert.equal(session.workers.size, 0); assert.deepEqual(await session.project.bytes(), bytes);
    rows.push({format, frames: result.frames, loadMiB: +(loaded.rssBytes / 1048576).toFixed(2),
      frameFinalMiB: +(released.at(-1).rssBytes / 1048576).toFixed(2),
      disposedMiB: +(manifest.memory.phases.at(-1).rssBytes / 1048576).toFixed(2),
      peakMiB: +(manifest.memory.peakRSSBytes / 1048576).toFixed(2)});
  }
  t.diagnostic('fixed native allocation stress ' + JSON.stringify(rows));
}));

test('bounded process deadline kills its process group and dispose terminates in-flight recording children', {timeout: 10000}, async () => withSession(async (session, dir) => {
  const sleep = await fs.realpath('/bin/sleep'), stat = await fs.stat(sleep), executable = {path: sleep, resolved: sleep, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs};
  const start = Date.now();
  await assert.rejects(record.runProcess(session, executable, ['10'], Date.now() + 100), /wall-clock/);
  assert.ok(Date.now() - start < 2000); assert.equal(session.workers.size, 0);
  const pending = record.runProcess(session, executable, ['10'], Date.now() + 5000);
  // Wait for registration, not an unbounded fixed sleep.
  for (let i = 0; !session.workers.size && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.workers.size, 1); record.dispose(session);
  await assert.rejects(pending, /exited/); assert.equal(session.workers.size, 0);
}));
