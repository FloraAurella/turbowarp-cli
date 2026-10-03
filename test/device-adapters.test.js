const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {Readable, PassThrough} = require('node:stream');
const {spawnSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const {createCanvas} = require('@napi-rs/canvas');
const ScratchStorage = require('@turbowarp/scratch-storage');
const NativeVM = require('../src/native-vm');
const {Project, blankProject} = require('../src/project');
const adapters = require('../src/device-adapters');
const commands = require('../src/device-commands');

const ioUtil = vm => ({target: vm.editingTarget, ioQuery(device, method, args = []) {return vm.runtime.ioDevices[device][method](...args);}});
const reporter = (vm, opcode, args = {}) => {
  const primitive = vm.runtime.getOpcodeFunction(opcode);
  assert.equal(typeof primitive, 'function', `real VM primitive ${opcode} must register`);
  return primitive(args, ioUtil(vm));
};
const frame = (format = 'png', offset = 0, width = 480, height = 360) => {
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  const data = context.createImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    const value = Math.round((Math.sin((x - offset) / 7) + Math.cos(y / 9) + 2) * 63);
    data.data[index] = value; data.data[index + 1] = 255 - value; data.data[index + 2] = 100; data.data[index + 3] = 255;
  }
  context.putImageData(data, 0, 0);
  return canvas.toBuffer(`image/${format}`);
};
const videoEvent = (bytes, at = 0, format = 'png') => ({frame: at, device: 'video', data: {format, base64: bytes.toString('base64')}});
const pcm = (value, samples = 4096) => {
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(value * 32768), index * 2);
  return bytes;
};
const wav = (bytes, sampleRate = 44100, channels = 1) => {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(bytes.length + 36, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
};
const attachOfflineAudio = async vm => {
  const {OfflineAudioContext} = await import('node-web-audio-api');
  const AudioEngine = require('scratch-audio/src/AudioEngine');
  const audio = new AudioEngine(new OfflineAudioContext(2, 44100, 44100));
  vm.attachAudioEngine(audio); return audio;
};
const withVM = async fn => {
  const vm = new NativeVM(); let replay, audio;
  try {
    vm.attachStorage(new ScratchStorage()); audio = await attachOfflineAudio(vm);
    adapters.registerOfflineExtensions(vm);
    await vm.loadProject(await blankProject());
    await fn(vm, value => {replay = value;});
  } finally {replay?.dispose(); adapters.disposeOfflineExtensions(vm); vm.clear(); vm.quit(); vm.runtime.removeAllListeners(); vm.removeAllListeners(); audio?.inputNode.disconnect();}
};
const withDirectory = async fn => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-device-'));
  try {await fn(dir);} finally {await fs.rm(dir, {recursive: true, force: true});}
};
const withSession = async fn => {
  const project = new Project(), session = {project, inputs: []};
  try {await project.load(await blankProject()); await fn(session);} finally {commands.dispose(session); adapters.disposeOfflineExtensions(project.vm); project.dispose();}
};
const block = (id, opcode, extra = {}) => ({id, opcode, inputs: {}, fields: {}, next: null, parent: null, shadow: false, topLevel: true, x: 0, y: 0, ...extra});
const runSteps = (vm, replay, count) => {
  const start = vm.runtime.currentMSecs; let elapsed = 0;
  vm.runtime.updateCurrentMSecs = () => {vm.runtime.currentMSecs = start + elapsed;};
  vm.greenFlag();
  for (let index = 0; index < count; index++) {elapsed = index * 1000 / 30; replay.applyFrame(index); vm.runtime._step();}
};

const cloudProjectFixture = async () => {
  const zip = await JSZip.loadAsync(await blankProject()), json = JSON.parse(await zip.file('project.json').async('string'));
  json.targets[0].variables.cloudScore = ['☁ score', 1, true];
  zip.file('project.json', JSON.stringify(json)); return zip.generateAsync({type: 'nodebuffer'});
};
const standardContents = async bytes => {
  const zip = await JSZip.loadAsync(bytes), entries = {};
  for (const name of Object.keys(zip.files).filter(name => name !== 'tw-cli-state.json').sort())
    if (!zip.files[name].dir) entries[name] = await zip.file(name).async('nodebuffer');
  return entries;
};
const inputProjectFixture = async () => {
  const zip = await JSZip.loadAsync(await blankProject()), json = JSON.parse(await zip.file('project.json').async('string'));
  const sprite = json.targets[1]; sprite.variables.motion = ['measuredMotion', 0]; sprite.variables.axis = ['measuredAxis', 0];
  sprite.variables.voice = ['measuredVoice', 0];
  json.extensions = ['videoSensing', 'Gamepad']; json.targets[0].videoState = 'on-flipped';
  sprite.blocks = {
    hat: {opcode: 'event_whenflagclicked', next: 'repeat', parent: null, inputs: {}, fields: {}, topLevel: true, shadow: false, x: 0, y: 0},
    repeat: {opcode: 'control_repeat', next: null, parent: 'hat', inputs: {TIMES: [1, [4, '8']], SUBSTACK: [2, 'setMotion']}, fields: {}, topLevel: false, shadow: false},
    setMotion: {opcode: 'data_setvariableto', next: 'setAxis', parent: 'repeat', inputs: {VALUE: [2, 'video']}, fields: {VARIABLE: ['measuredMotion', 'motion']}, topLevel: false, shadow: false},
    video: {opcode: 'videoSensing_videoOn', next: null, parent: 'setMotion', inputs: {ATTRIBUTE: [1, [10, 'motion']], SUBJECT: [1, [10, 'Stage']]}, fields: {}, topLevel: false, shadow: false},
    setAxis: {opcode: 'data_setvariableto', next: 'setVoice', parent: 'setMotion', inputs: {VALUE: [2, 'pad']}, fields: {VARIABLE: ['measuredAxis', 'axis']}, topLevel: false, shadow: false},
    pad: {opcode: 'Gamepad_axisValue', next: null, parent: 'setAxis', inputs: {b: [1, [4, '1']], i: [1, [4, '1']]}, fields: {}, topLevel: false, shadow: false},
    setVoice: {opcode: 'data_setvariableto', next: 'yield', parent: 'setAxis', inputs: {VALUE: [2, 'voice']}, fields: {VARIABLE: ['measuredVoice', 'voice']}, topLevel: false, shadow: false},
    voice: {opcode: 'sensing_loudness', next: null, parent: 'setVoice', inputs: {}, fields: {}, topLevel: false, shadow: false},
    yield: {opcode: 'control_wait', next: null, parent: 'setVoice', inputs: {DURATION: [1, [4, '0']]}, fields: {}, topLevel: false, shadow: false}
  };
  zip.file('project.json', JSON.stringify(json)); return zip.generateAsync({type: 'nodebuffer'});
};

test('module contract counts exclude action; IO never pretends to be SB3 persistence', async () => {
  assert.deepEqual(commands.specs.device['video-frame'], {min: 1, max: 1, options: ['project', 'frame', 'output', 'force', 'mirror']});
  assert.equal(commands.requiresProject('device', ['capabilities']), false);
  assert.equal(commands.requiresProject('device', ['loudness']), true);
  assert.equal(commands.isReadOnly('device', ['video-frame']), true);
  const {validateCommand} = require('../src/commands');
  assert.deepEqual(validateCommand(['device', 'wheel', '-12']).args, ['wheel', '-12']);
  assert.throws(() => validateCommand(['device', 'capabilities', '--out', 'bad.sb3']), /not allowed/);
  assert.throws(() => validateCommand(['device', 'loudness']), /expected 1/);
  const result = await commands.execute({inputs: []}, 'device', ['capabilities']);
  assert.equal(result.policy.default, 'deny'); assert.equal(result.policy.automaticEnumeration, false);
  assert.deepEqual(result.realdevice.hardware.map(item => item.extension), [...adapters.HARDWARE]);
  assert.equal(result.realdevice.hardware.every(item => item.connect === 'not-run'), true);
});

test('fixed/PCM/WAV loudness reaches actual sensing reporter and hat, not live microphone', async () => withVM(async (vm, own) => {
  const value = 0.25, expected = Math.round(Math.sqrt(value * 1.63) * 100);
  const events = [
    {device: 'loudness', data: {format: 's16le', base64: pcm(value).toString('base64'), sampleRate: 44100, channels: 1}},
    {frame: 1, device: 'loudness', data: {format: 'wav', base64: wav(pcm(value)).toString('base64')}},
    {frame: 2, device: 'loudness', data: {value: 88}}
  ];
  const replay = await adapters.createInputReplay(vm, events); own(replay);
  replay.applyFrame(0); assert.equal(reporter(vm, 'sensing_loudness'), expected);
  assert.equal(reporter(vm, 'sensing_loud'), true);
  assert.equal(reporter(vm, 'event_whengreaterthan', {WHENGREATERTHANMENU: 'loudness', VALUE: 50}), true);
  replay.applyFrame(1); assert.equal(reporter(vm, 'sensing_loudness'), expected);
  replay.applyFrame(2); assert.equal(reporter(vm, 'sensing_loudness'), 88);
  await replay.append({frame: 3, device: 'loudness', data: {format: 's16le', base64: pcm(0).toString('base64'), sampleRate: 44100, channels: 1}});
  replay.applyFrame(3); assert.equal(reporter(vm, 'sensing_loudness'), Math.round(Math.sqrt(value * 0.6 * 1.63) * 100));
  await replay.append({frame: 4, device: 'loudness', data: {value: 0}});
  replay.applyFrame(4); assert.equal(reporter(vm, 'sensing_loudness'), 0);
}));

test('video frames reach frozen optical flow and real reporter, mirror/resize and no polling', async () => withVM(async (vm, own) => {
  const first = frame(), second = frame('png', 2);
  const replay = await adapters.createInputReplay(vm, [videoEvent(first), videoEvent(second, 1)]); own(replay);
  assert.equal(vm.extensionManager.isExtensionLoaded('videoSensing'), true);
  assert.equal(vm.runtime.ext_videoSensing._loopInterval, undefined);
  replay.applyFrame(0);
  const sampled = vm.runtime.ioDevices.video.getFrame({dimensions: [20, 10], mirror: false});
  assert.equal(sampled.data.length, 20 * 10 * 4);
  const mirrored = vm.runtime.ioDevices.video.getFrame({dimensions: [20, 10], mirror: true});
  assert.deepEqual([...mirrored.data.subarray(0, 4)], [...sampled.data.subarray(19 * 4, 20 * 4)]);
  assert.equal(reporter(vm, 'videoSensing_videoOn', {ATTRIBUTE: 'motion', SUBJECT: 'Stage'}), -1); // upstream needs two frames
  replay.applyFrame(1);
  const motion = reporter(vm, 'videoSensing_videoOn', {ATTRIBUTE: 'motion', SUBJECT: 'Stage'});
  assert.ok(motion > 0, `motion must be measured from shifted pixels, got ${motion}`);
  const VideoMotion = require('scratch-vm/src/extensions/scratch3_video_sensing/library');
  const reference = new VideoMotion();
  const provider = new adapters.RecordedVideoProvider(); provider.enabled = true;
  provider.canvas = await adapters.decodeRecordedFrame(videoEvent(first).data); reference.addFrame(provider.getFrame().data);
  provider.canvas = await adapters.decodeRecordedFrame(videoEvent(second).data); reference.addFrame(provider.getFrame().data); reference.analyzeFrame();
  assert.equal(motion, reference.motionAmount);
  assert.equal(reporter(vm, 'videoSensing_videoOn', {ATTRIBUTE: 'direction', SUBJECT: 'Stage'}), reference.motionDirection);
  await replay.append(videoEvent(frame('jpeg', 4), 2, 'jpeg')); replay.applyFrame(2);
  assert.ok(Number.isFinite(reporter(vm, 'videoSensing_videoOn', {ATTRIBUTE: 'motion', SUBJECT: 'Stage'})));
}));

test('gamepad buttons/axes reach VM registered reporters and keyboard mapping, releases preserve other pads', async () => withVM(async (vm, own) => {
  const replay = await adapters.createInputReplay(vm, [{device: 'gamepad', data: {buttons: [true, 0.03, {value: 0.8, pressed: false}], axes: [0.8, -0.7]}}]); own(replay);
  replay.applyFrame(0);
  assert.equal(reporter(vm, 'Gamepad_gamepadConnected', {pad: 1}), true);
  assert.equal(reporter(vm, 'Gamepad_buttonDown', {b: 1, i: 1}), true);
  assert.equal(reporter(vm, 'Gamepad_buttonValue', {b: 2, i: 1}), 0);
  assert.equal(reporter(vm, 'Gamepad_axisValue', {b: 1, i: 1}), 0.8);
  assert.ok(reporter(vm, 'Gamepad_axisMagnitude', {axis: 1, pad: 1}) > 1);
  assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'space'}), true);
  assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'right arrow'}), true);
  await replay.append({frame: 1, device: 'gamepad', data: {index: 1, buttons: [true], axes: [0.05, 0.04]}});
  replay.applyFrame(1); assert.equal(reporter(vm, 'Gamepad_axisValue', {b: 1, i: 2}), 0);
  await replay.append({frame: 2, device: 'gamepad', data: {index: 0, buttons: [], axes: [], connected: false}});
  replay.applyFrame(2); assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'space'}), true);
  assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'right arrow'}), false);
  assert.throws(() => reporter(vm, 'Gamepad_rumble', {}), /denied/);
}));

test('key/mouse/wheel/userData/cloud use real VM IO, and JSONL frame order changes script results', async () => withVM(async (vm, own) => {
  const target = vm.editingTarget, stage = vm.runtime.getTargetForStage();
  stage.createVariable('cloud-id', '☁ score', '', true);
  const events = [
    {frame: 0, device: 'keyboard', data: {key: 'space', isDown: true}},
    {frame: 0, device: 'userData', data: {username: 'offline-user'}},
    {frame: 0, device: 'cloud', data: {varUpdate: {name: '☁ score', value: '123'}}},
    {frame: 0, device: 'mouse', data: {x: 260, y: 190, canvasWidth: 480, canvasHeight: 360, isDown: true, button: 2}},
    {frame: 1, device: 'mouseWheel', data: {deltaY: -1}},
    {frame: 2, device: 'keyboard', data: {key: 'space', isDown: false}}
  ];
  const parsed = adapters.parseJSONL(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'));
  const replay = await adapters.createInputReplay(vm, parsed); own(replay);
  target.blocks.createBlock(block('wheel-hat', 'event_whenkeypressed', {fields: {KEY_OPTION: {name: 'KEY_OPTION', value: 'up arrow'}}, next: 'move'}));
  target.blocks.createBlock(block('move', 'motion_movesteps', {parent: 'wheel-hat', topLevel: false, inputs: {STEPS: {name: 'STEPS', block: 'steps', shadow: 'steps'}}}));
  target.blocks.createBlock(block('steps', 'math_number', {parent: 'move', topLevel: false, shadow: true, fields: {NUM: {name: 'NUM', value: '7'}}}));
  replay.applyFrame(0);
  assert.equal(reporter(vm, 'sensing_username'), 'offline-user'); assert.equal(stage.variables['cloud-id'].value, '123');
  assert.equal(reporter(vm, 'sensing_mousex'), 20); assert.equal(reporter(vm, 'sensing_mousey'), -10);
  assert.equal(reporter(vm, 'sensing_mousedown'), true); assert.equal(vm.runtime.ioDevices.mouse.getButtonIsDown(2), true);
  assert.equal(target.x, 0); replay.applyFrame(1); vm.runtime._step(); assert.equal(target.x, 7);
  replay.applyFrame(2); assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'space'}), false);
  assert.throws(() => replay.applyFrame(1), /backwards/);
}));

test('append is atomic, single-owner, cumulative-bounded and restores offline guards on disposal', async () => withVM(async (vm, own) => {
  const original = vm.runtime.ioDevices.video.provider;
  const replay = await adapters.createInputReplay(vm); own(replay);
  await assert.rejects(adapters.createInputReplay(vm), /one input replay/);
  await assert.rejects(replay.appendMany([
    {device: 'keyboard', data: {key: 'a', isDown: true}},
    {device: 'network', data: {url: 'https://example.invalid'}}
  ]), /denied/);
  replay.applyFrame(0); assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'a'}), false);
  await replay.appendMany(Array.from({length: adapters.LIMITS.events}, () => ({device: 'userData', data: {username: 'bounded'}})));
  await assert.rejects(replay.append({device: 'keyboard', data: {key: 'a', isDown: true}}), /4096/);
  replay.applyFrame(0); assert.equal(reporter(vm, 'sensing_username'), 'bounded');
  replay.dispose(); replay.dispose();
  assert.equal(vm.runtime.ioDevices.video.provider, original);
  assert.throws(() => vm.runtime.getScratchLinkSocket('BLE'), /denied/);
  assert.throws(() => replay.applyFrame(0), /disposed/);
}));

test('D5 denies device enumeration, permission escalation, URLs, symlinks/FIFO/device paths and oversized data', async () => withDirectory(async dir => {
  for (const action of ['camera', 'microphone', 'scan', 'connect'])
    await assert.rejects(commands.execute({}, 'device', [action]), /denied/);
  await assert.rejects(commands.execute({}, 'device', ['permission', 'camera', 'allow']), /denied/);
  assert.equal((await commands.execute({}, 'device', ['permission', 'camera', 'deny'])).permission, 'deny');
  for (const input of ['https://example.invalid/file.png', 'file:///etc/passwd', '../escape.png', '/dev/zero', '/proc/self/mem', 'C:\\camera.png', '//server/share'])
    await assert.rejects(adapters.readFileBounded(input, 1024), /Unsafe|denied/);
  const file = path.join(dir, 'frame.png'); await fs.writeFile(file, frame('png', 0, 8, 8));
  const link = path.join(dir, 'symlink.png'); await fs.symlink(file, link);
  await assert.rejects(adapters.readFileBounded(link, 1024), /regular file/);
  const linkDir = path.join(dir, 'linked'); await fs.symlink(dir, linkDir);
  await assert.rejects(adapters.readFileBounded(path.join(linkDir, 'frame.png'), 1024), /Symlink parent/);
  const fifo = path.join(dir, 'pipe'); const made = spawnSync('mkfifo', [fifo], {timeout: 2000}); assert.equal(made.status, 0);
  await assert.rejects(adapters.readFileBounded(fifo, 1024), /regular file/);
  const big = path.join(dir, 'big.png'); const handle = await fs.open(big, 'w'); await handle.truncate(adapters.LIMITS.frameBytes + 1); await handle.close();
  await assert.rejects(adapters.readFileBounded(big, adapters.LIMITS.frameBytes), /limit/);
  assert.throws(() => adapters.parseJSONL(Buffer.from('\n'.repeat(adapters.LIMITS.events * 2 + 1))), /8192-line/);
  const invalid = [{device: 'ble', data: {}},  {device: 'video', data: {format: 'png', base64: 'A'.repeat(4), path: '/etc/passwd'}},
    {device: 'keyboard', data: {key: 'a', isDown: true, script: 'process.exit()'}},
    {device: 'gamepad', data: {buttons: [2], axes: []}}, {device: 'gamepad', data: {buttons: [], axes: [NaN]}},
    {frame: -1, device: 'userData', data: {username: ''}}, {frame: 0.5, device: 'userData', data: {username: ''}}];
  for (const event of invalid) assert.throws(() => adapters.normalizeInput(event));
  assert.throws(() => adapters.parseJSONL(Buffer.from('{"device":"keyboard","data":{"key":"a","isDown":true,"__proto__":{}}}\n')), /unsafe/);
  assert.throws(() => adapters.parseJSONL(Buffer.from([0xff])), /UTF-8/);
  assert.throws(() => adapters.parseJSONL(Buffer.from('{"frame":2,"device":"userData","data":{"username":"x"}}\n{"frame":1,"device":"userData","data":{"username":"y"}}')), /nondecreasing/);
  assert.throws(() => adapters.parseJSONL(Buffer.alloc(adapters.LIMITS.replayBytes + 1)), /16 MiB/);
}));

test('PNG/JPEG header bombs, malformed samples/WAV, noncanonical base64 and queue memory limits fail closed', async () => withVM(async (vm, own) => {
  const small = frame('png', 0, 8, 8);
  assert.deepEqual(adapters.inspectImage(small), {format: 'png', width: 8, height: 8});
  assert.throws(() => adapters.inspectImage(Buffer.from('<svg><script>bad()</script></svg>')), /Only PNG/);
  assert.throws(() => adapters.inspectImage(small.subarray(0, small.length - 1)), /Truncated|Invalid/);
  const bomb = Buffer.from(small); bomb.writeUInt32BE(100000, 16); assert.throws(() => adapters.inspectImage(bomb), /CRC|width/);
  const jpeg = frame('jpeg', 0, 8, 8); assert.throws(() => adapters.inspectImage(jpeg.subarray(0, jpeg.length - 2)), /EOI/);
  assert.throws(() => adapters.normalizeInput({device: 'video', data: {format: 'jpeg', base64: small.toString('base64')}}), /match/);
  assert.throws(() => adapters.normalizeInput({device: 'video', data: {format: 'png', base64: 'Zh=='}}), /canonical/);
  assert.throws(() => adapters.inspectAudio(Buffer.alloc(3), {format: 's16le', sampleRate: 44100, channels: 1}), /complete/);
  assert.throws(() => adapters.inspectAudio(pcm(0, 80001), {format: 's16le', sampleRate: 8000, channels: 1}), /10 seconds/);
  assert.throws(() => adapters.inspectAudio(pcm(0), {format: 's16le', sampleRate: 44100, channels: 3}), /channels/);
  const badFloat = Buffer.alloc(4); badFloat.writeFloatLE(NaN); assert.throws(() => adapters.inspectAudio(badFloat, {format: 'f32le', sampleRate: 44100, channels: 1}), /finite/);
  const wave = wav(pcm(0)); const incorrect = Buffer.from(wave); incorrect.writeUInt32LE(9, 4);
  assert.throws(() => adapters.inspectAudio(incorrect, {format: 'wav'}), /size/);
  assert.throws(() => adapters.inspectAudio(wave, {format: 'wav', sampleRate: 48000}), /metadata/);
  const maxImage = createCanvas(1920, 1080).toBuffer('image/png');
  await assert.rejects(adapters.createInputReplay(vm, Array.from({length: 5}, (_, index) => videoEvent(maxImage, index))), /32 MiB/);
  const replay = await adapters.createInputReplay(vm); own(replay); replay.applyFrame(5);
  await assert.rejects(replay.append({frame: 4, device: 'keyboard', data: {key: 'x', isDown: true}}), /before/);
}));

test('explicit pipes are bounded, timeout-controlled and do not execute JavaScript fixtures', async () => {
  assert.deepEqual(await adapters.readPipeBounded(Readable.from([Buffer.from('abc')]), 3), Buffer.from('abc'));
  await assert.rejects(adapters.readPipeBounded(Readable.from([Buffer.alloc(4)]), 3), /byte limit/);
  const open = new PassThrough();
  try {await assert.rejects(adapters.readPipeBounded(open, 10, 20), /timed out/);} finally {open.destroy();}
  const tty = new PassThrough(); tty.isTTY = true;
  try {await assert.rejects(adapters.readPipeBounded(tty, 10), /non-TTY/);} finally {tty.destroy();}
  await assert.rejects(commands.execute({inputs: [], deviceInputStream: Readable.from(['process.exit(99)'])}, 'device', ['replay', '-'], {'validate-only': true}), /Replay line/);
});

test('file/pipe commands export JSONL, validate-only avoids mutation and failed exports retain VM state', async () => withDirectory(async dir => withSession(async session => {
  const image = path.join(dir, 'frame.png'), audio = path.join(dir, 'sensor.wav'), output = path.join(dir, 'events.jsonl');
  await fs.writeFile(image, frame()); await fs.writeFile(audio, wav(pcm(0.25)));
  const initial = await session.project.bytes(), originalProvider = session.project.vm.runtime.ioDevices.video.provider;
  const recorded = await commands.execute(session, 'device', ['loudness', audio]);
  assert.equal(recorded.appliedToEditor, false); assert.equal(reporter(session.project.vm, 'sensing_loudness'), -1);
  const queued = session.inputs.length;
  await fs.writeFile(output, 'exists');
  await assert.rejects(commands.execute(session, 'device', ['loudness', '99'], {output}), /EEXIST/);
  assert.equal(session.inputs.length, queued); assert.equal(reporter(session.project.vm, 'sensing_loudness'), -1);
  await commands.execute(session, 'device', ['video-frame', image], {frame: '1', output, force: true});
  assert.equal(session.project.vm.runtime.ioDevices.video.provider, originalProvider);
  assert.equal(originalProvider.videoReady, false); // No frame, including frame 0, is applied to the editor.
  const exported = adapters.parseJSONL(await fs.readFile(output)); assert.equal(exported[0].device, 'video'); assert.equal(exported[0].frame, 1);
  const count = session.inputs.length, before = session.project.vm.runtime.ioDevices.video.provider;
  const result = await commands.execute(session, 'device', ['replay', output], {'validate-only': true});
  assert.equal(result.validated, 1); assert.equal(result.executed, false); assert.equal(session.inputs.length, count);
  assert.equal(session.project.vm.runtime.ioDevices.video.provider, before);
  session.deviceInputStream = Readable.from([frame('jpeg', 0, 16, 16)]);
  await commands.execute(session, 'device', ['video-frame', '-']);
  assert.equal(session.project.vm.runtime.ioDevices.video.provider, originalProvider);
  assert.equal(originalProvider.videoReady, false);
  assert.equal(reporter(session.project.vm, 'sensing_loudness'), -1);
  const list = await commands.execute(session, 'device', ['input-list']); assert.equal(list.count, 3);
  assert.equal(list.events.every(event => !event.data.base64), true);
  await assert.rejects(commands.execute(session, 'device', ['key', 'a', 'down'], {out: path.join(dir, 'bad.sb3')}), /--output/);
  // Recording does not load extensions or apply IO; even private editor metadata stays unchanged.
  assert.deepEqual(await session.project.bytes(), initial);
  // Also check standard SB3 project/assets explicitly.
  const beforeZip = await JSZip.loadAsync(initial), afterZip = await JSZip.loadAsync(await session.project.bytes());
  const entries = Object.keys(beforeZip.files).filter(name => name !== 'tw-cli-state.json');
  assert.deepEqual(Object.keys(afterZip.files).filter(name => name !== 'tw-cli-state.json'), entries);
  for (const entry of entries) assert.deepEqual(await afterZip.file(entry).async('nodebuffer'), await beforeZip.file(entry).async('nodebuffer'));
})));

test('device cloud and replay are queue-only: clean editor exports 1 while actual runtime/watch receives 99', async () => withDirectory(async dir => {
  const {CommandSession} = require('../src/commands'), session = new CommandSession();
  const input = path.join(dir, 'cloud.sb3'), output = path.join(dir, 'export.sb3'), replayFile = path.join(dir, 'cloud.jsonl');
  await fs.writeFile(input, await cloudProjectFixture());
  try {
    await session.execute(['open', input]);
    const originalVM = session.project.vm, before = await standardContents(await session.project.bytes());
    const reply = await session.execute(['device', 'cloud', '☁ score', '99']);
    assert.equal(reply.appliedToEditor, false); assert.equal(session.dirty, false); assert.equal(session.undoStack.length, 0);
    assert.equal(originalVM.runtime.getTargetForStage().variables.cloudScore.value, 1);
    assert.equal(originalVM.runtime.ioDevices.cloud.provider, null);
    await session.execute(['project', 'export', output]);
    assert.deepEqual(await standardContents(await fs.readFile(output)), before);
    const run = await session.execute(['run', '--frames', '1', '--watch', '☁ score', '--target', 'stage']);
    assert.equal(run.watch.samples[0].value, 99);
    assert.equal(run.targets.find(target => target.isStage).variables.find(variable => variable.name === '☁ score').value, 99);
    assert.equal(session.project.vm, originalVM); assert.equal(session.dirty, false);
    assert.deepEqual(await standardContents(await session.project.bytes()), before);
    await fs.writeFile(replayFile, JSON.stringify({frame: 0, device: 'cloud', data: {varUpdate: {name: '☁ score', value: 77}}}) + '\n');
    await session.execute(['device', 'replay', replayFile]);
    assert.equal(originalVM.runtime.getTargetForStage().variables.cloudScore.value, 1);
    const replayRun = await session.execute(['run', '--frames', '1', '--watch', '☁ score', '--target', 'stage']);
    assert.equal(replayRun.watch.samples[0].value, 77); assert.equal(session.dirty, false);
    assert.deepEqual(await standardContents(await session.project.bytes()), before);
    const queue = structuredClone(session.inputs), provider = originalVM.runtime.ioDevices.video.provider;
    await assert.rejects(session.execute(['device', 'cloud', '☁ missing', '99']), /does not exist/);
    assert.deepEqual(session.inputs, queue); assert.equal(originalVM.runtime.ioDevices.video.provider, provider);
    assert.deepEqual(await standardContents(await session.project.bytes()), before);
  } finally {session.dispose();}
  const requests = [
    {command: 'open', args: [input]}, {command: 'device', args: ['cloud', '☁ score', '99']},
    {command: 'project', args: ['export', output, '--force']}, {command: 'info', args: []},
    {command: 'run', args: ['--frames', '1', '--watch', '☁ score', '--target', 'stage']}, {command: 'quit', args: []}
  ];
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'],
    {input: requests.map((request, id) => JSON.stringify({id, ...request})).join('\n') + '\n', encoding: 'utf8', timeout: 10000});
  assert.equal(cli.status, 0, cli.stderr); assert.doesNotMatch(cli.stderr, /Unsaved changes/);
  const replies = cli.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, requests.length); for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(replies[3].result.dirty, false); assert.equal(replies[4].result.watch.samples[0].value, 99);
  assert.equal(replies.at(-1).result.closed, true);
  const exported = await JSZip.loadAsync(await fs.readFile(output));
  assert.equal(JSON.parse(await exported.file('project.json').async('string')).targets[0].variables.cloudScore[1], 1);
}));

test('all device events only queue: keys/mouse/wheel/mappings neither change editor IO nor start hats/threads', async () => withDirectory(async dir => {
  const {CommandSession} = require('../src/commands'), session = new CommandSession();
  const input = path.join(dir, 'hats.sb3'); await fs.writeFile(input, await cloudProjectFixture());
  try {
    await session.execute(['open', input]);
    const vm = session.project.vm, target = vm.editingTarget;
    for (const [id, opcode, key] of [['key-hat', 'event_whenkeypressed', 'space'], ['wheel-hat', 'event_whenkeypressed', 'up arrow'], ['map-hat', 'event_whenkeypressed', 'z'], ['click-hat', 'event_whenthisspriteclicked', null]]) {
      target.blocks.createBlock(block(id, opcode, {next: `${id}-move`, ...(key ? {fields: {KEY_OPTION: {name: 'KEY_OPTION', value: key}}} : {})}));
      target.blocks.createBlock(block(`${id}-move`, 'motion_movesteps', {parent: id, topLevel: false,
        inputs: {STEPS: {name: 'STEPS', block: `${id}-num`, shadow: `${id}-num`}}}));
      target.blocks.createBlock(block(`${id}-num`, 'math_number', {parent: `${id}-move`, topLevel: false, shadow: true, fields: {NUM: {name: 'NUM', value: '9'}}}));
    }
    const before = await standardContents(await session.project.bytes()), provider = vm.runtime.ioDevices.video.provider;
    let keys = 0; const onKey = () => keys++; vm.runtime.on('KEY_PRESSED', onKey);
    const calls = [
      ['device', 'key', 'space', 'down'], ['device', 'mouse', '0', '0', 'down'], ['device', 'wheel', '-1'],
      ['device', 'gamepad', '{"index":0,"id":"recorded-pad-0","buttons":[true],"axes":[0.8,0]}'],
      ['device', 'user-data', 'offline-user'], ['device', 'loudness', '60'], ['device', 'cloud', '☁ score', '99']
    ];
    for (const call of calls) assert.equal((await session.execute(call)).appliedToEditor, false);
    const eventFile = path.join(dir, 'mixed.jsonl');
    const events = [videoEvent(frame('png', 0, 8, 8)),
      {frame: 0, device: 'gamepad-mapping', data: {index: 0, id: 'recorded-pad-0', mapping: {buttons: [{type: 'key', high: 'z'}], axes: []}}}];
    await fs.writeFile(eventFile, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await session.execute(['device', 'replay', eventFile]);
    assert.equal(session.inputs.length, calls.length + events.length);
    assert.equal(keys, 0); assert.equal(vm.runtime.threads.length, 0);
    assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'space'}), false);
    assert.equal(reporter(vm, 'sensing_mousedown'), false); assert.equal(reporter(vm, 'sensing_mousex'), 0);
    assert.equal(reporter(vm, 'sensing_username'), ''); assert.equal(reporter(vm, 'sensing_loudness'), -1);
    assert.equal(vm.runtime.ioDevices.video.provider, provider); assert.equal(provider.videoReady, false);
    assert.equal(vm.extensionManager.isExtensionLoaded('Gamepad'), false); assert.equal(vm.extensionManager.isExtensionLoaded('videoSensing'), false);
    assert.equal(vm.runtime.getTargetForStage().variables.cloudScore.value, 1);
    vm.runtime._step(); assert.equal(target.x, 0); assert.equal(vm.runtime.threads.length, 0);
    assert.equal(session.dirty, false); assert.equal(session.undoStack.length, 0);
    assert.deepEqual(await standardContents(await session.project.bytes()), before);
    vm.runtime.off('KEY_PRESSED', onKey);
    session.inputs = Array.from({length: adapters.LIMITS.events}, () => ({device: 'userData', data: {username: 'bounded'}}));
    await assert.rejects(session.execute(['device', 'key', 'space', 'down']), /4096/);
    assert.equal(keys, 0); assert.equal(session.inputs.length, adapters.LIMITS.events);
    assert.deepEqual(await standardContents(await session.project.bytes()), before);
  } finally {session.dispose();}
}));

test('device capture/restore retains recorded sensors and controller mappings across undo/rollback without editor providers', async () => withDirectory(async dir => {
  const {CommandSession} = require('../src/commands'), session = new CommandSession();
  const input = path.join(dir, 'sensors.sb3'), other = path.join(dir, 'other.sb3'), eventsFile = path.join(dir, 'recorded.jsonl');
  await fs.writeFile(input, await cloudProjectFixture()); await fs.writeFile(other, await blankProject());
  const events = [videoEvent(frame('png', 0, 8, 8)),
    {device: 'loudness', data: {format: 'wav', base64: wav(pcm(0.25)).toString('base64')}},
    {device: 'gamepad-mapping', data: {index: 0, id: 'restore-pad', mapping: {buttons: [{type: 'key', high: 'z'}], axes: []}}},
    {device: 'gamepad', data: {index: 0, id: 'restore-pad', buttons: [true], axes: [0.6, 0]}},
    {device: 'cloud', data: {varUpdate: {name: '☁ score', value: 99}}}];
  await fs.writeFile(eventsFile, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  try {
    await session.execute(['open', input]); await session.execute(['device', 'replay', eventsFile]);
    await session.execute(['gamepad', 'select-controller', 'restore-pad']);
    session.inputs.push({device: 'userData', data: {username: 'legacy-no-frame'}});
    const before = await standardContents(await session.project.bytes()), inputs = structuredClone(session.inputs), state = commands.captureState(session);
    assert.equal(Object.hasOwn(state.inputs.at(-1), 'frame'), false);
    const controllerState = await session.execute(['gamepad', 'show']);
    const detached = {}; commands.restoreState(detached, state); assert.deepEqual(detached.inputs, inputs);
    detached.inputs[0].data.base64 = 'invalid'; assert.notEqual(state.inputs[0].data.base64, 'invalid');
    const originalVM = session.project.vm, originalProvider = originalVM.runtime.ioDevices.video.provider;
    await session.execute(['sprite', 'set', 'x', '41']); await session.execute(['undo']);
    assert.notEqual(session.project.vm, originalVM); assert.equal(originalProvider.videoReady, false);
    assert.deepEqual(session.inputs, inputs); assert.deepEqual(await standardContents(await session.project.bytes()), before);
    assert.deepEqual(await session.execute(['gamepad', 'show']), controllerState);
    const vm = session.project.vm, provider = vm.runtime.ioDevices.video.provider;
    assert.equal(provider.videoReady, false); assert.equal(reporter(vm, 'sensing_loudness'), -1); assert.equal(vm.runtime.threads.length, 0);
    await session.transaction('intentional device rollback', async () => {
      session.project.vm.editingTarget.setXY(92, 0);
      await session.execute(['device', 'loudness', '9']);
      throw new Error('rollback fixture');
    }).then(() => assert.fail('transaction must reject'), error => assert.match(error.message, /rollback fixture/));
    assert.deepEqual(session.inputs, inputs); assert.deepEqual(await session.execute(['gamepad', 'show']), controllerState);
    assert.deepEqual(await standardContents(await session.project.bytes()), before);
    await session.execute(['save', path.join(dir, 'restored.sb3')]); assert.equal(session.dirty, false);
    const restoredVM = session.project.vm;
    await assert.rejects(session.execute(['device', 'cloud', '☁ missing', '1', '--project', other]), /does not exist/);
    assert.equal(session.project.vm, restoredVM); assert.equal(session.dirty, false);
    assert.deepEqual(session.inputs, inputs); assert.equal(Object.hasOwn(session.inputs.at(-1), 'frame'), false);
    assert.deepEqual(await session.execute(['gamepad', 'show']), controllerState);
    assert.deepEqual(await standardContents(await session.project.bytes()), before);
    const runtimeCopy = new Project(); let replay;
    try {
      await runtimeCopy.load(await session.project.bytes());
      replay = await adapters.createInputReplay(runtimeCopy.vm, session.inputs); replay.applyFrame(0);
      assert.equal(reporter(runtimeCopy.vm, 'sensing_loudness'), 64);
      assert.equal(reporter(runtimeCopy.vm, 'Gamepad_axisValue', {b: 1, i: 1}), 0.6);
      assert.equal(reporter(runtimeCopy.vm, 'sensing_keypressed', {KEY_OPTION: 'z'}), true);
      assert.equal(runtimeCopy.vm.runtime.getTargetForStage().variables.cloudScore.value, 99);
      assert.equal(session.project.vm.runtime.getTargetForStage().variables.cloudScore.value, 1);
      assert.deepEqual(await standardContents(await session.project.bytes()), before);
    } finally {replay?.dispose(); runtimeCopy.dispose();}
    // Open/new intentionally clear nonpersistent input/controller metadata, not replay it into the replacement editor.
    await session.execute(['open', input, '--force']); assert.deepEqual(session.inputs, []);
    assert.equal((await session.execute(['gamepad', 'show'])).controllers.length, 0);
    assert.equal(session.project.vm.runtime.getTargetForStage().variables.cloudScore.value, 1);
    const freshProvider = session.project.vm.runtime.ioDevices.video.provider;
    assert.equal(freshProvider.videoReady, false); assert.equal(session.project.vm.runtime.threads.length, 0);
    commands.restoreState(session, undefined); assert.equal(session.project.vm.runtime.ioDevices.video.provider, freshProvider);
  } finally {session.dispose();}
}));

test('typed mapping changes real VM keys/mouse hats and frame-time cursor, without OS polling', async () => withVM(async (vm, own) => {
  const events = [
    {frame: 0, device: 'gamepad', data: {buttons: [true, true], axes: [0.5, 1], id: 'recorded-pad-0'}},
    {frame: 0, device: 'gamepad-mapping', data: {index: 0, id: 'recorded-pad-0', mapping: {
      buttons: [{type: 'key', high: 'z'}, {type: 'mousedown', button: 2}],
      axes: [{type: 'key', high: 'd', low: 'a', deadZone: 0.5}, {type: 'virtual_cursor', high: '+x', low: '-x', sensitivity: 0.6, deadZone: 0.2}]
    }}}
  ];
  const target = vm.editingTarget;
  target.blocks.createBlock(block('map-hat', 'event_whenkeypressed', {fields: {KEY_OPTION: {name: 'KEY_OPTION', value: 'z'}}, next: 'move-map'}));
  target.blocks.createBlock(block('move-map', 'motion_movesteps', {parent: 'map-hat', topLevel: false, inputs: {STEPS: {name: 'STEPS', block: 'map-num', shadow: 'map-num'}}}));
  target.blocks.createBlock(block('map-num', 'math_number', {parent: 'move-map', topLevel: false, shadow: true, fields: {NUM: {name: 'NUM', value: '11'}}}));
  const replay = await adapters.createInputReplay(vm, events); own(replay);
  vm.greenFlag(); replay.applyFrame(0); vm.runtime._step();
  assert.equal(target.x, 11); assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'z'}), true);
  assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'd'}), true); // inclusive exact threshold
  assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'space'}), false);
  assert.equal(vm.runtime.ioDevices.mouse.getButtonIsDown(2), true);
  assert.equal(reporter(vm, 'sensing_mousex'), 0); replay.applyFrame(1); assert.equal(reporter(vm, 'sensing_mousex'), 20);
  replay.applyFrame(1); assert.equal(reporter(vm, 'sensing_mousex'), 20); // same frame never double moves
  await replay.append({frame: 2, device: 'gamepad', data: {buttons: [false, false], axes: [-0.5, 0]}});
  replay.applyFrame(2); assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'a'}), true);
  assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'd'}), false); assert.equal(vm.runtime.ioDevices.mouse.getButtonIsDown(2), false);
  await replay.appendMany([
    {frame: 3, device: 'keyboard', data: {key: 'A', isDown: true}},
    {frame: 3, device: 'mouse', data: {x: 240, y: 180, canvasWidth: 480, canvasHeight: 360, button: 2, isDown: true}},
    {frame: 3, device: 'gamepad', data: {buttons: [], axes: [], connected: false}}
  ]);
  replay.applyFrame(3);
  assert.equal(reporter(vm, 'sensing_keypressed', {KEY_OPTION: 'a'}), true); // VM key identity is case-insensitive
  assert.equal(vm.runtime.ioDevices.mouse.getButtonIsDown(2), true);
  assert.throws(() => adapters.normalizeInput({device: 'gamepad-mapping', data: {index: 0, id: 'x', mapping: {buttons: [{type: 'eval', code: 'exit'}], axes: []}}}), /Unknown|type/);
  assert.throws(() => adapters.normalizeInput({device: 'gamepad', data: {buttons: Array(1), axes: []}}), /dense/);
}));

test('CLI JSONL worker replay reads sensor events at frame boundaries and survives project save/reload', async () => withDirectory(async dir => {
  const projectFile = path.join(dir, 'sensors.sb3'), saved = path.join(dir, 'saved.sb3'), eventsFile = path.join(dir, 'sensors.jsonl');
  await fs.writeFile(projectFile, await inputProjectFixture());
  const events = [...Array.from({length: 8}, (_, index) => videoEvent(frame('png', index * 2), index)),
    {frame: 0, device: 'loudness', data: {format: 'wav', base64: wav(pcm(0.25, 16000)).toString('base64')}},
    {frame: 2, device: 'loudness', data: {value: 81}},
    {frame: 0, device: 'gamepad', data: {buttons: [true], axes: [0.75, 0]}}];
  events.sort((a, b) => a.frame - b.frame);
  await fs.writeFile(eventsFile, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const requests = [
    {command: 'open', args: [projectFile]}, {command: 'device', args: ['replay', eventsFile]},
    {command: 'run', args: ['--frames', '8', '--fps', '30', '--watch', 'measuredVoice']},
    {command: 'save', args: [saved]}, {command: 'open', args: [saved]},
    {command: 'device', args: ['replay', eventsFile]}, {command: 'run', args: ['--frames', '8', '--fps', '30', '--compile']},
    {command: 'quit', args: []}
  ];
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'],
    {input: requests.map((request, id) => JSON.stringify({id, ...request})).join('\n') + '\n', encoding: 'utf8', timeout: 20000});
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, requests.length, result.stdout);
  for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply));
  for (const index of [2, 6]) {
    const run = replies[index].result, sprite = run.targets.find(target => target.name === 'Sprite1');
    const value = name => sprite.variables.find(variable => variable.name === name).value;
    assert.equal(run.noDOM, true); assert.ok(value('measuredMotion') > 0, `run ${index}: ${JSON.stringify(run)}`); assert.equal(value('measuredAxis'), 0.75); assert.equal(value('measuredVoice'), 81);
  }
  assert.equal(replies[2].result.watch.samples[0].value, 64);
  assert.equal(replies[2].result.watch.samples[2].value, 81);
  // The real launcher can consume a data pipe in one-shot mode without sharing session stdin.
  const pipe = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'device', 'replay', '-', '--validate-only'],
    {input: await fs.readFile(eventsFile), encoding: 'utf8', timeout: 10000});
  assert.equal(pipe.status, 0, pipe.stderr); assert.equal(JSON.parse(pipe.stdout).validated, events.length);
  const shared = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'],
    {input: JSON.stringify({command: 'device', args: ['replay', '-', '--validate-only']}) + '\n', encoding: 'utf8', timeout: 5000});
  assert.equal(shared.status, 0); assert.match(JSON.parse(shared.stdout).error, /cannot share/);
}));

test('persistent runtime append keeps one media provider and exposes actual voice/gamepad reporters after frame steps', async () => withDirectory(async dir => {
  const projectFile = path.join(dir, 'append.sb3'); await fs.writeFile(projectFile, await inputProjectFixture());
  const requests = [
    {command: 'open', args: [projectFile]},
    {command: 'runtime', args: ['start', '--paused', '--fps', '30']},
    {command: 'runtime', args: ['input', JSON.stringify(videoEvent(frame()))]},
    {command: 'runtime', args: ['input', JSON.stringify({device: 'loudness', data: {value: 37}})]},
    {command: 'runtime', args: ['input', JSON.stringify({device: 'gamepad', data: {buttons: [], axes: [0.6, 0]}})]},
    {command: 'runtime', args: ['step', '--frames', '1']},
    {command: 'runtime', args: ['input', JSON.stringify(videoEvent(frame('png', 2), 1))]},
    {command: 'runtime', args: ['input', JSON.stringify({device: 'loudness', data: {value: 93}})]},
    {command: 'runtime', args: ['input', JSON.stringify({device: 'gamepad', data: {buttons: [], axes: [-0.8, 0]}})]},
    {command: 'runtime', args: ['step', '--frames', '2']},
    {command: 'runtime', args: ['stop']}, {command: 'quit', args: []}
  ];
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'],
    {input: requests.map((request, id) => JSON.stringify({id, ...request})).join('\n') + '\n', encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply));
  const value = (reply, name) => reply.result.targets.find(target => target.name === 'Sprite1').variables.find(variable => variable.name === name).value;
  assert.equal(value(replies[5], 'measuredVoice'), 37); assert.equal(value(replies[5], 'measuredAxis'), 0.6);
  assert.equal(value(replies[9], 'measuredVoice'), 93); assert.equal(value(replies[9], 'measuredAxis'), -0.8);
  // At least two frames were received and retained by the same frozen optical-flow provider.
  assert.notEqual(value(replies[9], 'measuredMotion'), -1);
  assert.equal(replies[9].result.noDOM, true);
}));

test('default guards never access media/gamepad/network callbacks during media load or mock', () => {
  const source = `const assert=require('node:assert/strict');
    const base=${JSON.stringify(path.join(__dirname, '..'))};
    require(base+'/src/network-policy').install();
    let attempts=0; const denied=()=>{attempts++;throw new Error('unexpected live device');};
    Object.defineProperty(global,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:denied,enumerateDevices:denied},getGamepads:denied}});
    global.WebSocket=class{constructor(){denied();}};
    const {Project}=require(base+'/src/project'); const a=require(base+'/src/device-adapters');
    (async()=>{const p=new Project();let replay;try{await p.load(Buffer.from(${JSON.stringify('PLACEHOLDER')},'base64'));
      replay=await a.createInputReplay(p.vm,[{device:'loudness',data:{value:55}},{device:'gamepad',data:{buttons:[true],axes:[0.6,0]}}]);
      replay.applyFrame(0);assert.equal(p.vm.runtime.audioEngine.getLoudness(),55);
      await p.vm.runtime.ioDevices.video.enableVideo();p.vm.runtime.ioDevices.video.disableVideo();
      await a.runSocketMock(p.vm,'BLE');await a.runSocketMock(p.vm,'BT');
      assert.throws(()=>p.vm.runtime.getScratchLinkSocket('BLE'),/denied/);assert.throws(()=>require('node:net').connect(1,'127.0.0.1'),/denied/);
      assert.throws(()=>require('node:dgram').createSocket('udp4'),/denied/);await assert.rejects(fetch('https://example.invalid'),/denied/);
      assert.equal(attempts,0);assert.equal(typeof document,'undefined');assert.equal(typeof window,'undefined');
      process.stdout.write('no-capture-no-network');}finally{replay?.dispose();p.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});`;
  // Fixture bytes are supplied below by a synchronous ZIP generation child, without saving any project file.
  const generated = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../src/project'))}).blankProject().then(b=>process.stdout.write(b.toString('base64')))`], {encoding: 'utf8', timeout: 5000});
  assert.equal(generated.status, 0, generated.stderr);
  const result = spawnSync(process.execPath, ['-e', source.replace('PLACEHOLDER', generated.stdout)], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'no-capture-no-network');
});

test('ScratchLink mock implements fixed factory/JSON-RPC messages with no WebSocket or real BLE claims', async () => withVM(async vm => {
  for (const type of ['BLE', 'BT']) {
    const result = await adapters.runSocketMock(vm, type);
    assert.equal(result.mode, 'mock'); assert.equal(result.realdevice.connected, false); assert.equal(result.realdevice.status, 'limited');
    assert.equal(result.calls[0].method, 'didDiscoverPeripheral');
    assert.equal(result.calls[1].method, type === 'BLE' ? 'characteristicDidChange' : 'didReceiveMessage');
    assert.deepEqual(result.sent.map(message => message.method), ['discover', 'connect', type === 'BLE' ? 'read' : 'send']);
    assert.equal(result.runtimeEvents[0].name, 'PERIPHERAL_LIST_UPDATE');
    assert.equal(result.sensorMessages.length, 1);
    assert.equal(result.sensorMessages[0], adapters.SOCKET_FIXTURES[type][1].params.message);
  }
  const factory = adapters.createMockSocketFactory(), socket = factory('BLE');
  assert.throws(() => socket.open(), /handlers/);
  socket.setOnOpen(() => {}); socket.setOnClose(() => {}); socket.setOnError(() => {}); socket.setHandleMessage(() => {}); socket.open();
  assert.throws(() => socket.sendMessage({jsonrpc: '2.0', method: 'eval', params: {code: 'x'}}), /denied/);
  for (let index = 0; index < adapters.LIMITS.socketMessages; index++) socket.sendMessage({jsonrpc: '2.0', result: null});
  assert.throws(() => socket.sendMessage({jsonrpc: '2.0', result: null}), /limit/);
  assert.throws(() => socket.receive({jsonrpc: '2.0', params: {x: 'a'.repeat(adapters.LIMITS.jsonBytes + 1)}}), /oversized/);
  factory.dispose(); assert.equal(socket.isOpen(), false);
  assert.throws(() => vm.runtime.getScratchLinkSocket('BLE'), /denied/);
}));

test('safe media builtin factories load, save, reload and execute blocks without browser/capture globals', async () => {
  const zip = await JSZip.loadAsync(await blankProject()), json = JSON.parse(await zip.file('project.json').async('string'));
  const sprite = json.targets[1]; sprite.variables.motion = ['measuredMotion', 0]; sprite.variables.axis = ['measuredAxis', 0];
  json.extensions = ['videoSensing', 'Gamepad']; json.targets[0].videoState = 'on-flipped';
  sprite.blocks = {
    hat: {opcode: 'event_whenflagclicked', next: 'repeat', parent: null, inputs: {}, fields: {}, topLevel: true, shadow: false, x: 0, y: 0},
    repeat: {opcode: 'control_repeat', next: 'setMotion', parent: 'hat', inputs: {TIMES: [1, [4, '2']], SUBSTACK: [2, 'yield']}, fields: {}, topLevel: false, shadow: false},
    yield: {opcode: 'control_wait', next: null, parent: 'repeat', inputs: {DURATION: [1, [4, '0']]}, fields: {}, topLevel: false, shadow: false},
    setMotion: {opcode: 'data_setvariableto', next: 'setAxis', parent: 'repeat', inputs: {VALUE: [2, 'video']}, fields: {VARIABLE: ['measuredMotion', 'motion']}, topLevel: false, shadow: false},
    video: {opcode: 'videoSensing_videoOn', next: null, parent: 'setMotion', inputs: {ATTRIBUTE: [1, [10, 'motion']], SUBJECT: [1, [10, 'Stage']]}, fields: {}, topLevel: false, shadow: false},
    setAxis: {opcode: 'data_setvariableto', next: null, parent: 'setMotion', inputs: {VALUE: [2, 'pad']}, fields: {VARIABLE: ['measuredAxis', 'axis']}, topLevel: false, shadow: false},
    pad: {opcode: 'Gamepad_axisValue', next: null, parent: 'setAxis', inputs: {b: [1, [4, '1']], i: [1, [4, '1']]}, fields: {}, topLevel: false, shadow: false}
  };
  zip.file('project.json', JSON.stringify(json));
  let bytes = await zip.generateAsync({type: 'nodebuffer'});
  for (let pass = 0; pass < 2; pass++) {
    const vm = new NativeVM(); let replay, audio;
    try {
      vm.attachStorage(new ScratchStorage()); audio = await attachOfflineAudio(vm);
      adapters.registerOfflineExtensions(vm);
      await vm.loadProject(bytes);
      assert.equal(vm.extensionManager.isExtensionLoaded('videoSensing'), true);
      assert.equal(vm.extensionManager.isExtensionLoaded('Gamepad'), true);
      assert.equal(vm.runtime.ext_videoSensing._loopInterval, undefined);
      vm.editingTarget.variables.motion.value = 0; vm.editingTarget.variables.axis.value = 0;
      replay = await adapters.createInputReplay(vm, [...Array.from({length: 8}, (_, index) => videoEvent(frame('png', index * 2), index)),
        {frame: 0, device: 'gamepad', data: {buttons: [], axes: [0.75, 0]}}]);
      runSteps(vm, replay, 8);
      assert.ok(vm.editingTarget.variables.motion.value > 0, `motion ${vm.editingTarget.variables.motion.value}, threads ${vm.runtime.threads.map(thread => thread.peekStack()).join(',')}, detector ${vm.runtime.ext_videoSensing.detect.motionAmount}`);
      assert.equal(vm.editingTarget.variables.axis.value, 0.75);
      assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
      const saved = new JSZip(); saved.file('project.json', vm.toJSON(null, {allowOptimization: false}));
      for (const asset of vm.serializeAssets()) saved.file(asset.fileName, asset.fileContent);
      bytes = await saved.generateAsync({type: 'nodebuffer'});
    } finally {replay?.dispose(); adapters.disposeOfflineExtensions(vm); vm.clear(); vm.quit(); vm.runtime.removeAllListeners(); audio?.inputNode.disconnect();}
  }
});
