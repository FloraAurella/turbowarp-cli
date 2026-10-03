const assert = require('node:assert/strict');
const {test} = require('node:test');
const AudioEngine = require('scratch-audio/src/AudioEngine');
const SoundPlayer = require('scratch-audio/src/SoundPlayer');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {createHash} = require('node:crypto');
const {edit} = require('../src/audio-editor');
const {wav, CommandSession} = require('../src/commands');
const promises = require('node:fs/promises');
const os = require('node:os');
const {blankProject} = require('../src/project');
const JSZip = require('@turbowarp/jszip');
const guiRoot = path.resolve(__dirname, '../../desktop-master/node_modules/scratch-gui/src/lib/audio');

const editBuffer = async (buffer, action, args = []) => {
  const {OfflineAudioContext} = await import('node-web-audio-api');
  const context = new OfflineAudioContext(1, 1, buffer.sampleRate);
  let updated;
  const target = {id: 'target', getSounds: () => [{name: 'fixture', soundId: 'fixture'}],
    sprite: {soundBank: {getSoundPlayer: () => ({buffer})}}};
  const session = {project: {audio: {audioContext: context}, vm: {
    setEditingTarget: id => assert.equal(id, target.id),
    updateSoundBuffer: (index, result, bytes) => {assert.equal(index, 0); updated = {buffer: result, bytes};}
  }}};
  const info = await edit(session, target, 0, action, args);
  return {info, ...updated};
};
const makeBuffer = async (length = 4410, channels = 1, rate = sampleRate, value = i => Math.sin(i / 17) * 0.2) => {
  const {OfflineAudioContext} = await import('node-web-audio-api');
  const context = new OfflineAudioContext(channels, length, rate);
  const buffer = context.createBuffer(channels, length, rate);
  for (let channel = 0; channel < channels; channel++) buffer.getChannelData(channel).set(
    Float32Array.from({length}, (_, i) => value(i, channel)));
  return buffer;
};
const closeSamples = (actual, expected, tolerance = 2e-6) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.ok(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) <= tolerance,
    `sample ${i}: ${actual[i]} vs ${expected[i]}`);
};

// Execute the *desktop's frozen* effect graph with a local context injection, not
// a browser/global shim. This catches adapter drift, not browser DSP differences.
const guiEffect = async (buffer, action) => {
  const {OfflineAudioContext} = await import('node-web-audio-api');
  const load = filename => {
    const full = path.join(guiRoot, filename);
    const source = fs.readFileSync(full, 'utf8').replace(/^import (\w+) from '([^']+)';$/gm, 'const $1 = require("$2");')
      .replace(/^export default (\w+);$/gm, 'module.exports = $1;');
    const compiled = new Module(full, module); compiled.filename = full; compiled.paths = Module._nodeModulePaths(guiRoot);
    compiled.require = request => load(request.slice(2));
    compiled.context = OfflineAudioContext;
    compiled._compile('const window = {OfflineAudioContext: module.context};\n' + source, full);
    return compiled.exports;
  };
  const Processor = load('audio-effects.js');
  const names = {louder: 'higher', softer: 'lower', 'fade-in': 'fade in', 'fade-out': 'fade out'};
  // SoundEditor constructs a mono AudioBufferPlayer from channel 0 before applying effects.
  const context = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const mono = context.createBuffer(1, buffer.length, buffer.sampleRate);
  mono.getChannelData(0).set(buffer.getChannelData(0));
  return new Promise(resolve => new Processor(mono, names[action] || action, 0, 1).process(resolve));
};

const sampleRate = 44100;
const render = async (volume, pan, pitch = 0) => {
  const {OfflineAudioContext} = await import('node-web-audio-api');
  const context = new OfflineAudioContext(2, sampleRate, sampleRate);
  const engine = new AudioEngine(context);
  const buffer = context.createBuffer(1, sampleRate, sampleRate);
  buffer.getChannelData(0).fill(0.25);
  const player = new SoundPlayer(engine, {id: 'constant', buffer});
  const bank = engine.createBank();
  bank.addSoundPlayer(player);
  try {
    const finished = bank.playSound({volume, soundEffects: {pitch, pan}}, player.id);
    const result = await context.startRendering();
    await finished;
    return result;
  } finally {
    bank.dispose();
    engine.inputNode.disconnect();
  }
};

const average = channel => {
  let total = 0;
  for (let i = 22050; i < 33075; i++) total += channel[i];
  return total / 11025;
};

for (const [volume, pan] of [[100, 0], [50, 0], [100, -100], [100, 100]]) {
  test(`native offline Scratch audio: volume=${volume}, pan=${pan}`, {timeout: 10000}, async () => {
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
    const result = await render(volume, pan);
    assert.equal(result.numberOfChannels, 2);
    assert.equal(result.sampleRate, sampleRate);
    assert.equal(result.length, sampleRate);
    const angle = ((pan + 100) / 200) * Math.PI / 2;
    const gains = pan === 0 ? [1, 1] : [Math.cos(angle), Math.sin(angle)];
    const expected = gains.map(gain => 0.25 * volume / 100 * gain);
    for (let channel = 0; channel < 2; channel++) {
      const data = result.getChannelData(channel);
      assert.ok(data.every(Number.isFinite));
      const measured = average(data);
      // Scratch applies exponential smoothing; the comparison window begins after settling.
      assert.ok(Math.abs(measured - expected[channel]) < 0.0001,
        `channel ${channel}: measured ${measured}, expected ${expected[channel]}`);
    }
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
  });
}

test('native offline Scratch pitch +120 doubles playback rate and halves sound duration', {timeout: 10000}, async () => {
  const result = await render(100, 0, 120);
  for (let channel = 0; channel < 2; channel++) {
    const samples = result.getChannelData(channel);
    assert.ok(Math.abs(samples[11025] - 0.25) < 0.0001);
    assert.ok(Math.abs(samples[33075]) < 0.0001);
  }
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof window, 'undefined');
});

test('vendored GUI audio sources match manifest and frozen desktop bytes', () => {
  const vendor = path.resolve(__dirname, '../vendor/scratch-gui-audio');
  const upstream = JSON.parse(fs.readFileSync(path.join(vendor, 'UPSTREAM.json')));
  for (const [file, hash] of Object.entries(upstream.sha256)) {
    const bytes = fs.readFileSync(path.join(vendor, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, file);
    assert.deepEqual(bytes, fs.readFileSync(path.join(guiRoot, file)), file);
  }
});

for (const action of ['reverse', 'louder', 'softer', 'faster', 'slower', 'echo', 'robot', 'fade-in', 'fade-out', 'mute']) {
  test(`editor ${action}: waveform matches frozen GUI graph, preserving input and encoding samples`, {timeout: 10000}, async () => {
    const input = await makeBuffer(); const original = input.getChannelData(0).slice();
    const {buffer, bytes, info} = await editBuffer(input, action);
    const oracle = await guiEffect(input, action);
    assert.equal(buffer.sampleRate, sampleRate);
    assert.equal(buffer.numberOfChannels, 1);
    assert.equal(info.samples, buffer.length);
    closeSamples(buffer.getChannelData(0), oracle.getChannelData(0));
    assert.deepEqual(input.getChannelData(0), original, 'undo input must not be mutated');
    assert.deepEqual(Buffer.from(bytes), wav(buffer));
    const ratio = 2 ** (4 / 12);
    const length = action === 'echo' ? Math.floor(input.length + 0.75 * sampleRate) : action === 'faster' ?
      Math.floor(input.length / ratio) : action === 'slower' ? Math.floor(input.length * ratio) : input.length;
    assert.equal(buffer.length, length);
    if (action === 'reverse') closeSamples(buffer.getChannelData(0), original.slice().reverse(), 0);
    if (action === 'mute') closeSamples(buffer.getChannelData(0), new Float32Array(input.length), 0);
    if (action === 'louder' || action === 'softer') closeSamples(buffer.getChannelData(0),
      original.map(value => value * (action === 'louder' ? 1.25 : 0.75)));
    if (action === 'fade-in' || action === 'fade-out') closeSamples(buffer.getChannelData(0),
      original.map((value, i) => value * (action === 'fade-in' ? i / input.length : 1 - i / input.length)));
  });
}

test('editor stereo effects and trim use channel zero, not an implicit stereo downmix', async () => {
  const input = await makeBuffer(4410, 2, sampleRate, (i, channel) => channel ? -0.4 : 0.2);
  const {buffer: louder} = await editBuffer(input, 'louder');
  closeSamples(louder.getChannelData(0), new Float32Array(input.length).fill(0.25));
  const {buffer: trimmed} = await editBuffer(input, 'trim', [0.01, 0.04]);
  assert.equal(trimmed.numberOfChannels, 1);
  closeSamples(trimmed.getChannelData(0), input.getChannelData(0).slice(441, 1764), 0);
});

test('editor rejects a sub-sample trim and keeps one-sample GUI effects as no-ops', async () => {
  const input = await makeBuffer();
  await assert.rejects(editBuffer(input, 'trim', [0, 0.1 / sampleRate]), /sample/i);
  const single = await makeBuffer(1, 1, sampleRate, () => 0.125);
  for (const action of ['echo', 'faster', 'reverse', 'mute']) {
    const result = await editBuffer(single, action);
    assert.equal(result.info.samples, 1);
    assert.equal(result.info.unchanged, true);
    assert.equal(result.buffer, undefined, 'GUI does not submit a one-sample effect');
  }
});

test('echo impulse train has exact delay/decay/tail plus explicitly native compressor lookahead', async () => {
  const input = await makeBuffer(4410, 1, sampleRate, i => i === 0 ? 0.01 : 0);
  const {buffer} = await editBuffer(input, 'echo');
  const data = buffer.getChannelData(0);
  const impulses = Array.from(data).flatMap((value, index) => Math.abs(value) > 1e-7 ? [[index, value]] : []);
  assert.deepEqual(impulses.map(([index]) => index), [384, 11409, 22434, 33459]);
  // The GUI uses the browser's compressor. Its lookahead/makeup gain is not a
  // portable Web Audio oracle; these pin node-web-audio-api 2.2.0 only.
  assert.ok(Math.abs(impulses[0][1] - 0.008535913191735744) < 1e-7);
  for (let i = 1; i < impulses.length; i++) {
    assert.ok(Math.abs(impulses[i][1] / impulses[i - 1][1] - (i === 1 ? 0.75 : 0.3)) < 1e-6);
  }
  closeSamples(data, await guiEffect(input, 'echo').then(result => result.getChannelData(0)));
});

test('sound commands preserve PCM through edit/undo/redo/reload and render real volume/pan/pitch samples', async () => {
  const dir = await promises.mkdtemp(path.join(os.tmpdir(), 'tw-m2-audio-'));
  const session = new CommandSession();
  try {
    const input = await makeBuffer(sampleRate, 1, sampleRate, i => i < 11025 ? 0.1 : i < 33075 ? 0.25 : -0.2);
    const asset = wav(input), id = createHash('md5').update(asset).digest('hex');
    const zip = await JSZip.loadAsync(await blankProject());
    const json = JSON.parse(await zip.file('project.json').async('string'));
    json.targets[1].sounds = [{name: 'fixture', assetId: id, md5ext: `${id}.wav`, dataFormat: 'wav', rate: sampleRate, sampleCount: input.length}];
    zip.file(`${id}.wav`, asset); zip.file('project.json', JSON.stringify(json));
    await session.project.load(await zip.generateAsync({type: 'nodebuffer'}));
    const stored = () => {
      const target = session.project.target('Sprite1'), sound = target.getSounds()[0];
      return {sound, buffer: target.sprite.soundBank.getSoundPlayer(sound.soundId).buffer};
    };
    const original = stored().buffer.getChannelData(0).slice();
    await session.execute(['sound', 'effect', 'fixture', 'reverse']);
    closeSamples(stored().buffer.getChannelData(0), original.slice().reverse(), 0);
    await session.execute(['undo']); closeSamples(stored().buffer.getChannelData(0), original, 0);
    await session.execute(['redo']); closeSamples(stored().buffer.getChannelData(0), original.slice().reverse(), 1 / 32767);
    await session.execute(['undo']);
    await session.project.load(await session.project.bytes());
    closeSamples(stored().buffer.getChannelData(0), original, 0);
    for (const [volume, pan, pitch] of [[50, 0, 0], [100, -100, 0], [100, 100, 0], [100, 0, 120]]) {
      const file = path.join(dir, `${volume}-${pan}-${pitch}.wav`);
      await session.execute(['sound', 'render', 'fixture', file, '--volume', String(volume), '--pan', String(pan), '--pitch', String(pitch)]);
      const bytes = await promises.readFile(file);
      assert.equal(bytes.readUInt16LE(22), 2); assert.equal(bytes.readUInt32LE(24), sampleRate);
      assert.equal(bytes.length, 44 + sampleRate * (pitch ? 1 : 1.25) * 4);
      const frame = Math.floor(sampleRate * (pitch ? 0.2 : 0.4)), offset = 44 + frame * 4;
      const expected = [pan === 100 ? 0 : 0.25 * volume / 100, pan === -100 ? 0 : 0.25 * volume / 100];
      for (let channel = 0; channel < 2; channel++) {
        const actual = bytes.readInt16LE(offset + channel * 2) / 32767;
        assert.ok(Math.abs(actual - expected[channel]) < 0.0001, `${volume}/${pan}/${pitch}: channel ${channel}`);
        const silentFrame = pitch ? Math.floor(sampleRate * 0.8) : sampleRate + 100;
        assert.equal(bytes.readInt16LE(44 + silentFrame * 4 + channel * 2), 0);
      }
    }
  } finally {session.dispose(); await promises.rm(dir, {recursive: true, force: true});}
});

test('editor rendering promise failures reject immediately rather than leaking or timing out', async t => {
  const {OfflineAudioContext} = await import('node-web-audio-api');
  const input = await makeBuffer();
  t.mock.method(OfflineAudioContext.prototype, 'startRendering', () => Promise.reject(new Error('fixture render failure')));
  await assert.rejects(editBuffer(input, 'robot'), /fixture render failure/);
});

test('PCM16 WAV headers, clipping and stereo interleaving match GUI wav-encoder byte-for-byte', async () => {
  const values = [-2, -1, -0.5, -1 / 32768, 0, 1 / 32767, 0.5, 1, 2];
  const buffer = await makeBuffer(values.length, 2, 22050, (i, channel) => values[channel ? values.length - 1 - i : i]);
  const bytes = wav(buffer);
  const encoder = require('../../desktop-master/node_modules/wav-encoder');
  const oracle = encoder.encode.sync({sampleRate: buffer.sampleRate, channelData: [buffer.getChannelData(0), buffer.getChannelData(1)]});
  assert.deepEqual(bytes, Buffer.from(oracle));
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE'); assert.equal(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.equal(bytes.readUInt32LE(16), 16); assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 2); assert.equal(bytes.readUInt32LE(24), 22050);
  assert.equal(bytes.readUInt32LE(28), 88200); assert.equal(bytes.readUInt16LE(32), 4); assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString('ascii', 36, 40), 'data'); assert.equal(bytes.readUInt32LE(40), values.length * 4);
  const pcm = [-32768, -32768, -16384, -1, 0, 1, 16384, 32767, 32767];
  for (let i = 0; i < values.length; i++) {
    assert.equal(bytes.readInt16LE(44 + i * 4), pcm[i]);
    assert.equal(bytes.readInt16LE(46 + i * 4), pcm[values.length - 1 - i]);
  }
});
