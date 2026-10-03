'use strict';
require('./native-environment');
const bootstrapMemory = process.memoryUsage();
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {createCanvas, loadImage, GlobalFonts} = require('@napi-rs/canvas');
const canvasMemory = process.memoryUsage();
const canvasFontFamilyCount = GlobalFonts.families.length;
const adapters = require('./device-adapters');
const {Project, readProject, MAX_PROJECT_BYTES} = require('./project');
const {assertData, safePath} = require('./permission-policy');

const PROTOCOL = 'tw-record-v1';
const LIMITS = Object.freeze({wallMS: 30000, frames: 900, rssBytes: 512 * 1024 * 1024,
  outputBytes: 256 * 1024 * 1024, projectBytes: Math.min(MAX_PROJECT_BYTES, 32 * 1024 * 1024),
  audioBytes: 16 * 1024 * 1024, decodedAudioBytes: 32 * 1024 * 1024, tracks: 16, audioSeconds: 30,
  sampleRate: 44100, channels: 2, pngBytes: adapters.LIMITS.frameBytes, pixels: adapters.LIMITS.pixels});
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const framesForSeconds = (seconds, fps) => {
  const product = seconds * fps, nearest = Math.round(product);
  return Math.abs(product - nearest) <= Number.EPSILON * Math.max(1, Math.abs(product)) * 8 ? nearest : Math.ceil(product);
};
const finite = (value, name, min, max, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value))
    throw new Error(`${name} must be ${integer ? 'an integer' : 'finite'} in ${min}..${max}`);
  return value;
};
const createMemoryTrace = emit => {
  const phases = []; let sampledPeakRSS = 0, peakRSS = 0;
  const record = (phase, frame, memory = process.memoryUsage(), includeFamilies = false) => {
    sampledPeakRSS = Math.max(sampledPeakRSS, memory.rss);
    // Node reports maxRSS in KiB on all supported platforms, including macOS.
    // This native high-water mark covers synchronous calls between samples.
    peakRSS = Math.max(sampledPeakRSS, process.resourceUsage().maxRSS * 1024);
    const sample = {phase, ...(frame === undefined ? {} : {frame}), rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers,
      peakRSSBytes: peakRSS, ...(includeFamilies ? {fontFamilies: GlobalFonts.families.length} : {})};
    if (phases.length < 80) {phases.push(sample); emit?.(sample);}
    if (peakRSS > LIMITS.rssBytes) throw new Error(`Record worker exceeded 512 MiB RSS at ${phase} (native peak ${Math.ceil(peakRSS / 1048576)} MiB)`);
    return sample;
  };
  return {record, summary: () => ({limitBytes: LIMITS.rssBytes, sampledPeakRSSBytes: sampledPeakRSS, peakRSSBytes: peakRSS,
    hostFontDiscovery: false, canvasBootstrapFontFamilies: canvasFontFamilyCount, phases})};
};
const trackWindow = track => {
  if (!track || typeof track !== 'object' || !['external', 'microphone'].includes(track.role)) throw new Error('Track requires an external/microphone role');
  const bytes = Buffer.from(track.base64, 'base64');
  if (bytes.length > LIMITS.audioBytes || bytes.toString('base64') !== track.base64 || sha256(bytes) !== track.sha256) throw new Error('Track canonical base64/hash verification failed');
  const wave = inspectWave(bytes);
  finite(track.start, 'track start', 0, 30); finite(track.offset, 'track offset', 0, 30); finite(track.gain, 'track gain', 0, 4);
  if (track.length !== undefined) finite(track.length, 'track length', 1 / 192000, 30);
  if (track.offset >= wave.duration) throw new Error('Track offset is outside source audio');
  const length = track.length ?? wave.duration - track.offset;
  if (track.offset + length > wave.duration + 1 / wave.sampleRate) throw new Error('Track length exceeds its pre-recorded source');
  return {start: track.start, length, gain: track.gain};
};
const assertTrackOverlap = (tracks, config) => {
  if (!tracks.length) return;
  const captureStart = config.delayFrames / config.fps;
  const captureEnd = config.durationFrames / config.fps;
  const maxSamples = Math.round((captureEnd - captureStart) * LIMITS.sampleRate);
  const overlap = tracks.some(track => {
    const {start, length} = trackWindow(track);
    const first = Math.max(0, Math.round((start - captureStart) * LIMITS.sampleRate));
    const end = Math.min(maxSamples, Math.round((start + length - captureStart) * LIMITS.sampleRate));
    return end > first;
  });
  if (!overlap) throw new Error('Requested audio has no source samples inside the captured interval; refusing a silent fallback before native worker startup');
};
const checkConfig = value => {
  assertData(value);
  const keys = ['duration', 'delay', 'fps', 'waitflag', 'flagFrame', 'stopOnStop', 'stopFrame', 'projectaudio', 'microphonemix', 'seed', 'answer'];
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown record option ${key}`);
  finite(value.duration, 'duration', 1 / 60, 30); finite(value.delay, 'delay', 0, 30);
  finite(value.fps, 'fps', 1, 60, true);
  for (const key of ['waitflag', 'stopOnStop', 'projectaudio', 'microphonemix']) if (typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (value.projectaudio) throw new Error('NOT_YET_SUPPORTED: whole-project audio cannot be strictly clockOffline scheduled; use --projectaudio false and explicit external pre-recorded WAV tracks. No silent fallback.');
  if (value.flagFrame !== null) finite(value.flagFrame, 'flag-frame', 0, LIMITS.frames - 1, true);
  if (value.waitflag && value.flagFrame === null) throw new Error('waitflag requires a scheduled flag-frame');
  if (value.stopFrame !== null) finite(value.stopFrame, 'stop-frame', 0, LIMITS.frames - 1, true);
  if (value.seed !== undefined) finite(value.seed, 'seed', 0, 0xffffffff, true);
  if (typeof value.answer !== 'string' || Buffer.byteLength(value.answer) > 65536) throw new Error('answer must be text of at most 64 KiB');
  const durationFrames = framesForSeconds(value.duration, value.fps), delayFrames = framesForSeconds(value.delay, value.fps);
  const triggerFrame = value.waitflag ? value.flagFrame : 0;
  if (delayFrames >= durationFrames) throw new Error('Delay consumes the duration (frozen GUI timer-before-delay); choose duration > delay with at least one output frame');
  if (triggerFrame + durationFrames > LIMITS.frames) throw new Error('Recording simulation exceeds the 900-frame limit including flag wait and delay');
  return {...value, stopOnStop: value.waitflag && value.stopOnStop, durationFrames, delayFrames, triggerFrame,
    captureStartFrame: triggerFrame + delayFrames, endFrame: triggerFrame + durationFrames};
};
const inspectWave = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > LIMITS.audioBytes ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw new Error('Pre-recorded soundfiles must be bounded RIFF WAV PCM16/float32; MP3/real microphone capture is not yet supported');
  let info, data, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Truncated WAV chunk');
    const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end + (size & 1) > bytes.length) throw new Error('Truncated WAV payload');
    if (name === 'fmt ') {
      if (info || size !== 16) throw new Error('WAV must have one 16-byte PCM/float fmt chunk');
      const encoding = bytes.readUInt16LE(offset + 8), channels = bytes.readUInt16LE(offset + 10), rate = bytes.readUInt32LE(offset + 12), bits = bytes.readUInt16LE(offset + 22);
      if (!(encoding === 1 && bits === 16 || encoding === 3 && bits === 32)) throw new Error('WAV encoding must be PCM16 or float32');
      finite(channels, 'WAV channels', 1, 2, true); finite(rate, 'WAV sample rate', 8000, 192000, true);
      const stride = channels * bits / 8;
      if (bytes.readUInt16LE(offset + 20) !== stride || bytes.readUInt32LE(offset + 16) !== stride * rate) throw new Error('Invalid WAV alignment/byte rate');
      info = {channels, sampleRate: rate, bits, stride};
    }
    if (name === 'data') {if (data) throw new Error('Duplicate WAV data chunk'); data = bytes.subarray(offset + 8, end);}
    offset = end + (size & 1);
  }
  if (!info || !data || !data.length || data.length % info.stride) throw new Error('WAV requires complete nonempty fmt/data samples');
  const samples = data.length / info.stride;
  if (samples / info.sampleRate > LIMITS.audioSeconds) throw new Error('Pre-recorded track exceeds 30 seconds');
  if (info.bits === 32) for (let i = 0; i < data.length; i += 4) finite(data.readFloatLE(i), 'WAV float sample', -1, 1);
  return {...info, samples, duration: samples / info.sampleRate, pcm: data};
};
const decodeTracks = async (tracks, check) => {
  if (!Array.isArray(tracks) || tracks.length > LIMITS.tracks) throw new Error('At most 16 data-only pre-recorded tracks are accepted');
  const {OfflineAudioContext} = await import('node-web-audio-api');
  let decodedBytes = 0, encodedBytes = 0;
  const output = [];
  for (const track of tracks) {
    assertData(track);
    for (const key of Object.keys(track)) if (!['file', 'role', 'start', 'offset', 'length', 'gain', 'base64', 'sha256'].includes(key)) throw new Error('Unknown pre-recorded track field');
    if (!['external', 'microphone'].includes(track.role) || typeof track.file !== 'string') throw new Error('Track requires a filename and external/microphone role');
    finite(track.start, 'track start', 0, 30); finite(track.offset, 'track offset', 0, 30);
    finite(track.gain, 'track gain', 0, 4); if (track.length !== undefined) finite(track.length, 'track length', 1 / 192000, 30);
    if (typeof track.base64 !== 'string' || track.base64.length > Math.ceil(LIMITS.audioBytes / 3) * 4) throw new Error('Invalid track base64 size');
    const bytes = Buffer.from(track.base64, 'base64');
    if (bytes.toString('base64') !== track.base64 || sha256(bytes) !== track.sha256) throw new Error('Track canonical base64/hash verification failed');
    encodedBytes += bytes.length; if (encodedBytes > LIMITS.audioBytes) throw new Error('Combined pre-recorded files exceed 16 MiB');
    const wave = inspectWave(bytes);
    if (track.offset >= wave.duration) throw new Error('Track offset is outside source audio');
    const length = track.length ?? wave.duration - track.offset;
    if (track.offset + length > wave.duration + 1 / wave.sampleRate) throw new Error('Track length exceeds its pre-recorded source');
    decodedBytes += wave.samples * wave.channels * 4;
    if (decodedBytes > LIMITS.decodedAudioBytes) throw new Error('Decoded pre-recorded tracks exceed 32 MiB');
    check?.();
    // Genuine native decode, not a mock/silent placeholder. Decode at the source
    // sample rate; the mixer below resamples deterministically by sample index.
    const context = new OfflineAudioContext(wave.channels, 1, wave.sampleRate);
    const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (buffer.sampleRate !== wave.sampleRate || buffer.numberOfChannels !== wave.channels || buffer.length !== wave.samples) throw new Error('Decoded WAV sample metadata differs from its header');
    // Copy out of the native AudioBuffer: channel views otherwise outlive its
    // Rust allocation when the decoder buffer/context is collected mid-run.
    const channels = Array.from({length: buffer.numberOfChannels}, (_, index) => new Float32Array(buffer.getChannelData(index)));
    output.push({file: track.file, role: track.role, start: track.start, offset: track.offset, length, gain: track.gain,
      sha256: track.sha256, sampleRate: wave.sampleRate, sourceSamples: wave.samples, channels});
    check?.();
  }
  return output;
};
const pcmWave = (pcm, sampleRate = LIMITS.sampleRate, channels = LIMITS.channels) => {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};
const mixTracks = (tracks, captureStart, duration) => {
  const rate = LIMITS.sampleRate, channels = LIMITS.channels, samples = Math.round(duration * rate);
  finite(samples, 'output audio samples', 1, rate * 30, true);
  const pcm = Buffer.alloc(samples * channels * 2);
  let sumSquares = 0, peak = 0, nonZeroSamples = 0, clippedSamples = 0;
  const metadata = tracks.map(track => ({file: track.file, role: track.role, start: track.start, offset: track.offset,
    length: track.length, gain: track.gain, sha256: track.sha256, sampleRate: track.sampleRate, sourceSamples: track.sourceSamples,
    channelCount: track.channels.length, overlapSamples: 0}));
  // start is relative to the recording trigger, not to first captured video.
  // Quantize boundaries to the output sample clock, then linearly resample.
  const prepared = tracks.map(track => ({track, start: Math.round((track.start - captureStart) * rate),
    end: Math.round((track.start + track.length - captureStart) * rate)}));
  for (let i = 0; i < samples; i++) {
    const sums = [0, 0];
    for (let j = 0; j < prepared.length; j++) {
      const {track, start, end} = prepared[j];
      if (i < start || i >= end) continue;
      const position = (track.offset + (i - start) / rate) * track.sampleRate;
      const left = Math.floor(position), alpha = position - left;
      if (left >= track.sourceSamples) continue;
      metadata[j].overlapSamples++;
      for (let channel = 0; channel < channels; channel++) {
        const source = track.channels[Math.min(channel, track.channels.length - 1)], right = Math.min(left + 1, source.length - 1);
        sums[channel] += (source[left] * (1 - alpha) + source[right] * alpha) * track.gain;
      }
    }
    for (let channel = 0; channel < channels; channel++) {
      const value = sums[channel]; if (!Number.isFinite(value)) throw new Error('Audio mixing generated a nonfinite sample');
      if (Math.abs(value) > 1) clippedSamples++;
      const clipped = Math.max(-1, Math.min(1, value)), integer = Math.round(clipped * (clipped < 0 ? 32768 : 32767));
      pcm.writeInt16LE(integer, (i * channels + channel) * 2);
      const actual = integer / (integer < 0 ? 32768 : 32767);
      if (integer) nonZeroSamples++; peak = Math.max(peak, Math.abs(actual)); sumSquares += actual * actual;
    }
  }
  if (tracks.length && !metadata.some(track => track.overlapSamples > 0)) throw new Error('Requested audio has no source samples inside the captured interval; refusing a silent fallback');
  const bytes = pcmWave(pcm);
  return {bytes, info: {file: 'audio.wav', encoding: 'pcm_s16le', sampleRate: rate, channels, samples,
    duration: samples / rate, peak, rms: Math.sqrt(sumSquares / (samples * channels)), nonZeroSamples, clippedSamples,
    silentSource: nonZeroSamples === 0, sha256: sha256(bytes), tracks: metadata,
    scheduling: 'external prerecorded tracks only; sample-clock linear interpolation; no project audio/mic capture'}};
};
const sourceImageDimensions = bytes => {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('Malformed project JPEG header');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if (marker === 218 || marker === 217) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) throw new Error('Truncated project JPEG header');
      if ([192, 193, 194].includes(marker) && size >= 8) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += size;
    }
  }
  throw new Error('NOT_YET_SUPPORTED: recording costumes require bounded PNG/JPEG or local SVG; GIF/BMP pixel decode is not verified');
};
const preflightProject = async parsed => {
  const width = parsed.json.meta?.stageWidth ?? 480, height = parsed.json.meta?.stageHeight ?? 360;
  finite(width, 'stage width', 1, 2048, true); finite(height, 'stage height', 1, 2048, true);
  if (width * height > LIMITS.pixels) throw new Error('Recording stage exceeds PNG pixel limit');
  let decodedBytes = 0, soundBytes = 0;
  for (const target of parsed.json.targets) {
    for (const costume of target.costumes || []) {
      const filename = costume.md5ext || `${costume.assetId}.${costume.dataFormat}`;
      const entry = Object.values(parsed.zip.files).find(item => !item.dir && (item.name === filename || item.name.split('/').pop() === filename));
      const bytes = await entry.async('nodebuffer');
      if (bytes.length > LIMITS.pngBytes) throw new Error('Recording costume exceeds 4 MiB source limit');
      if (costume.dataFormat === 'svg') {
        // Current NativeRenderer parses/resolves local SVG, never browser
        // extension code. Bound source bytes before its own SVG checks.
        if (bytes.length > 1024 * 1024) throw new Error('Recording SVG exceeds 1 MiB');
        decodedBytes += LIMITS.pixels * 4;
      } else {
        const [w, h] = sourceImageDimensions(bytes);
        finite(w, 'costume width', 1, 2048, true); finite(h, 'costume height', 1, 2048, true);
        if (w * h > LIMITS.pixels) throw new Error('Recording costume exceeds PNG pixel limit before native decode');
        decodedBytes += w * h * 4;
      }
      if (decodedBytes > 64 * 1024 * 1024) throw new Error('Recording decoded costume budget exceeds 64 MiB');
    }
    for (const sound of target.sounds || []) {
      const filename = sound.md5ext || `${sound.assetId}.${sound.dataFormat}`;
      const entry = Object.values(parsed.zip.files).find(item => !item.dir && (item.name === filename || item.name.split('/').pop() === filename));
      const bytes = await entry.async('nodebuffer'); soundBytes += bytes.length;
      if (soundBytes > LIMITS.audioBytes) throw new Error('Project sound assets exceed record 16 MiB budget');
      const wave = inspectWave(bytes); decodedBytes += wave.samples * wave.channels * 4;
      if (decodedBytes > 96 * 1024 * 1024) throw new Error('Recording project decoded media exceeds 96 MiB');
    }
    for (const block of Object.values(target.blocks || {})) {
      if (['sound_playuntildone', 'music_playNoteForBeats', 'music_playDrumForBeats', 'music_restForBeats'].includes(block.opcode))
        throw new Error(`NOT_YET_SUPPORTED: ${block.opcode} depends on unverified whole-project offline audio timing; external tracks do not silently replace its scheduler`);
    }
  }
};
const validatePNG = async (bytes, expected) => {
  const header = adapters.inspectImage(bytes, 'png');
  if (expected && (header.width !== expected.width || header.height !== expected.height)) throw new Error('PNG header does not match recording dimensions');
  let image;
  try {image = await loadImage(bytes);} catch {throw new Error('PNG pixels could not be decoded');}
  if (image.width !== header.width || image.height !== header.height) throw new Error('PNG decoded pixels differ from header');
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
  try {
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    return {...header, bytes: bytes.length, sha256: sha256(bytes), pixelsSha256: sha256(pixels), pixels: pixels.length / 4};
  } finally {
    // Release the decoded Skia surface now, not only after a V8 GC cycle. The
    // returned manifest contains hashes/counts, never a reference to pixels.
    canvas.width = 1; canvas.height = 1;
    image.onload = null; image.onerror = null;
  }
};
const recording = async input => {
  require('./network-policy').install();
  const began = performance.now(), project = new Project(); let replay, manifest, completed = false;
  const emitMemory = phase => {
    if (require.main === module && process.connected) process.send({protocol: PROTOCOL, event: 'memory', data: phase});
  };
  const memory = createMemoryTrace(emitMemory);
  const {NativeRenderer: fonts} = require('./native-renderer');
  // Instrument only this short-lived trusted process. No core files or global
  // registry are patched: the same font method is invoked, then restored.
  const originalSetFonts = fonts.prototype.setCustomFonts;
  let fontPass = 0;
  fonts.prototype.setCustomFonts = function (data) {
    const pass = fontPass++;
    memory.record(`native-fonts-${pass}-before`, undefined, process.memoryUsage(), true);
    const result = originalSetFonts.call(this, data);
    memory.record(`native-fonts-${pass}-after`, undefined, process.memoryUsage(), true);
    return result;
  };
  const check = () => {
    if (performance.now() - began > LIMITS.wallMS) throw new Error('Record worker exceeded the 30-second wall-clock deadline');
    if (process.memoryUsage().rss > LIMITS.rssBytes) throw new Error('Record worker exceeded 512 MiB RSS');
  };
  try {
    memory.record('bootstrap', undefined, bootstrapMemory);
    memory.record('canvas-require', undefined, canvasMemory);
    memory.record('modules-loaded', undefined, process.memoryUsage(), true);
    if (canvasFontFamilyCount !== 0) throw new Error('Host font discovery was not disabled before record worker canvas initialization');
    if (input.protocol !== PROTOCOL || typeof input.project !== 'string' || input.project.length > Math.ceil(LIMITS.projectBytes / 3) * 4) throw new Error('Invalid recording worker protocol/project size');
    const bytes = Buffer.from(input.project, 'base64');
    if (bytes.toString('base64') !== input.project || sha256(bytes) !== input.projectSha256) throw new Error('Record project copy hash mismatch');
    await safePath(input.directory, {directory: true});
    if ((await fs.readdir(input.directory)).length) throw new Error('Recording worker requires an empty reserved output directory');
    const config = checkConfig(input.config);
    assertTrackOverlap(input.tracks || [], config);
    memory.record('archive-preflight-before');
    let parsed = await readProject(bytes);
    await preflightProject(parsed); parsed = null;
    global.gc?.(); check(); memory.record('archive-preflight-after');
    const tracks = await decodeTracks(input.tracks || [], check);
    memory.record('native-audio-decoded');
    if (config.microphonemix && !tracks.some(track => track.role === 'microphone')) throw new Error('microphonemix requires an explicit pre-recorded mic-track, never live mic');
    if (!config.microphonemix && tracks.some(track => track.role === 'microphone')) throw new Error('microphone tracks require --microphonemix true');
    memory.record('project-load-before');
    await project.load(bytes);
    memory.record('project-load-after', undefined, process.memoryUsage(), true);
    // Project.load validates/deserializes a separate archive. Its temporary
    // ZIP and SVG native buffers need not coexist with capture pixel buffers.
    global.gc?.(); check(); memory.record('project-load-gc');
    const vm = project.vm, runtime = vm.runtime;
    adapters.registerOfflineExtensions(vm);
    vm.setCompilerOptions({enabled: false}); vm.setTurboMode(false); vm.setFramerate(config.fps); vm.setInterpolation(false);
    // Prepare all input media and approved provider factories before greenFlag.
    replay = await adapters.createInputReplay(vm, input.inputs || []);
    memory.record('input-replay-prepared');
    let elapsed = 0;
    runtime.updateCurrentMSecs = () => {runtime.currentMSecs = elapsed;}; runtime.currentMSecs = 0;
    runtime.ioDevices.clock.resetProjectTimer();
    if (config.seed !== undefined) {
      let state = config.seed >>> 0;
      Math.random = () => {state = state + 0x6D2B79F5 >>> 0; let n = Math.imul(state ^ state >>> 15, state | 1);
        n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296;};
    }
    const questions = [];
    runtime.on('QUESTION', question => {
      if (questions.length >= 256 || Buffer.byteLength(String(question)) > 65536) throw new Error('Recorded questions exceed resource limit');
      questions.push(String(question)); runtime.emit('ANSWER', config.answer);
    });
    const width = project.renderer.canvas.width, height = project.renderer.canvas.height;
    if (width * height > LIMITS.pixels || width > 2048 || height > 2048) throw new Error('Recording dimensions exceed PNG pixel/header limits');
    const frames = []; let outputBytes = 0, stopped = false, armed = false, stopReason = 'duration', simulatedFrames = 0;
    const onStop = () => {if (armed && config.stopOnStop) stopped = true;};
    // Green flag internally calls stopAll before PROJECT_START. Arm only AFTER
    // that synthetic stop so it cannot cancel the first output frame.
    runtime.on('PROJECT_STOP_ALL', onStop);
    for (let frame = 0; frame < config.endFrame; frame++) {
      const sampleFrame = frame === 0 || frame === 3 || (frame + 1) % 120 === 0 || frame === config.endFrame - 1;
      if (sampleFrame) memory.record('frame-before', frame);
      check(); elapsed = frame * 1000 / config.fps;
      if (frame === config.flagFrame) {armed = false; vm.greenFlag(); armed = frame >= config.triggerFrame;}
      if (frame === config.triggerFrame) armed = true;
      if (frame === config.stopFrame) vm.stopAll();
      if (stopped) {stopReason = 'PROJECT_STOP_ALL'; break;}
      replay.applyFrame(frame);
      // One interpreter sweep per frame, retaining the real warp-loop guard.
      // Avoid making ordinary loop iteration counts depend on renderer speed.
      let budgetChecks = 0; runtime.sequencer.timer.timeElapsed = () => budgetChecks++ * runtime.currentStepTime;
      runtime._step(); await new Promise(resolve => setImmediate(resolve)); simulatedFrames = frame + 1;
      if (frame >= config.captureStartFrame) {
        const png = project.renderer.png();
        if (sampleFrame) memory.record('frame-native-png', frame);
        const verified = await validatePNG(png, {width, height});
        if (sampleFrame) memory.record('frame-verified', frame);
        outputBytes += png.length; if (outputBytes > LIMITS.outputBytes) throw new Error('Recording output exceeds 256 MiB');
        const filename = `frame-${String(frames.length).padStart(6, '0')}.png`;
        await fs.writeFile(path.join(input.directory, filename), png, {flag: 'wx', mode: 0o600});
        frames.push({index: frames.length, file: filename, simulationFrame: frame,
          timeSeconds: frames.length / config.fps, simulationSeconds: frame / config.fps, ...verified});
      }
      if ((frame + 1) % 4 === 0) global.gc?.();
      if (sampleFrame) memory.record('frame-after-release', frame);
      if (stopped) {stopReason = 'PROJECT_STOP_ALL'; break;}
    }
    armed = false; runtime.off('PROJECT_STOP_ALL', onStop);
    if (!frames.length) throw new Error('Recording ended before its first frame (stop/delay); no success manifest is emitted');
    const duration = frames.length / config.fps;
    let audio = null;
    if (tracks.length) {
      const mixed = mixTracks(tracks, config.delayFrames / config.fps, duration); audio = mixed.info;
      outputBytes += mixed.bytes.length;
      if (outputBytes > LIMITS.outputBytes) throw new Error('Recording output exceeds 256 MiB');
      await fs.writeFile(path.join(input.directory, audio.file), mixed.bytes, {flag: 'wx', mode: 0o600});
    }
    check();
    manifest = {version: 1, protocol: PROTOCOL, complete: true, backend: 'NativeVM/NativeRenderer; no DOM, no browser, no MediaRecorder',
      sourceProjectSha256: sha256(bytes), options: config,
      timing: {fps: config.fps, duration, frameCount: frames.length, simulatedFrames, triggerFrame: config.triggerFrame,
        captureStartFrame: config.captureStartFrame, endExclusiveFrame: frames.at(-1).simulationFrame + 1,
        stopReason, durationIncludesDelay: true, threadExhaustionIsStop: false, frameSampling: 'after input and runtime step; frame zero is included'},
      dimensions: {width, height}, frames, audio, outputBytes, questions,
      noDOM: typeof document === 'undefined' && typeof window === 'undefined', limits: LIMITS,
      capabilities: {projectaudio: 'not-yet-supported: fail-closed', microphone: 'D7 pre-recorded replacement permitted; live mic capture denied; no realdevice claim',
        realGUI: 'not-run; tests compare frozen source/parser and digital media, not GUI capture'},
      runtimeCopy: {targets: project.info().targets, threads: runtime.threads.length}};
    memory.record('output-ready'); completed = true;
  } finally {
    try {
      try {replay?.dispose();} finally {
        try {if (project.vm) adapters.disposeOfflineExtensions(project.vm);} finally {project.dispose();}
      }
      global.gc?.();
      memory.record('disposed', undefined, process.memoryUsage(), true);
      if (completed) check();
    } finally {fonts.prototype.setCustomFonts = originalSetFonts;}
  }
  // Native cleanup is part of success: include its real RSS high-water mark
  // and reject its peak before publishing a completed manifest.
  manifest.memory = memory.summary();
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (manifestBytes.length > 2 * 1024 * 1024) throw new Error('Record manifest exceeds 2 MiB');
  await fs.writeFile(path.join(input.directory, 'manifest.json'), manifestBytes, {flag: 'wx', mode: 0o600});
  return {manifest: 'manifest.json', frames: manifest.frames.length, duration: manifest.timing.duration, noDOM: manifest.noDOM};
};
if (require.main === module) {
  const watchdog = setTimeout(() => process.exit(124), LIMITS.wallMS);
  process.once('disconnect', () => process.exit(1));
  process.once('message', async input => {
    try {
      const result = await recording(input); clearTimeout(watchdog);
      process.send({protocol: PROTOCOL, ok: true, result}, () => process.exit(0));
    } catch (error) {
      clearTimeout(watchdog);
      if (process.connected) process.send({protocol: PROTOCOL, ok: false, error: error.message}, () => process.exit(1));
      else process.exit(1);
    }
  });
}
module.exports = {PROTOCOL, LIMITS, checkConfig, inspectWave, decodeTracks, pcmWave, mixTracks, validatePNG, recording, sha256,
  assertTrackOverlap, createMemoryTrace};
