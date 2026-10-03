require('./native-environment');
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {TextDecoder} = require('node:util');
const {createCanvas, loadImage} = require('@napi-rs/canvas');

const LIMITS = Object.freeze({
  frameBytes: 4 * 1024 * 1024, audioBytes: 4 * 1024 * 1024, jsonBytes: 64 * 1024,
  replayBytes: 16 * 1024 * 1024, decodedBytes: 32 * 1024 * 1024, events: 4096,
  frame: 99999, pixels: 1920 * 1080, dimension: 2048, audioSeconds: 10,
  sampleRateMin: 8000, sampleRateMax: 192000, channels: 2, gamepads: 4,
  buttons: 32, axes: 16, socketMessages: 256, pipeTimeoutMS: 5000
});
const DEVICES = Object.freeze(['keyboard', 'mouse', 'mouseWheel', 'userData', 'cloud', 'video', 'loudness', 'gamepad', 'gamepad-mapping']);
const PERMISSIONS = Object.freeze({camera: 'deny', microphone: 'deny', network: 'deny', ble: 'deny', bt: 'deny', hid: 'deny'});
const HARDWARE = Object.freeze(['microbit', 'boost', 'ev3', 'wedo2', 'gdxfor', 'makeymakey']);
const ALIASES = Object.freeze({space: ' ', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  'left arrow': 'ArrowLeft', 'right arrow': 'ArrowRight', 'up arrow': 'ArrowUp', 'down arrow': 'ArrowDown', enter: 'Enter'});
const SPECIAL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Backspace', 'Delete', 'Shift',
  'CapsLock', 'ScrollLock', 'Control', 'Escape', 'Insert', 'Home', 'End', 'PageUp', 'PageDown']);
const fail = message => {throw new Error(message);};
const finite = (value, label, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be finite in ${min}..${max}`);
  return value;
};
const integer = (value, label, min, max) => {
  finite(value, label, min, max);
  if (!Number.isInteger(value)) fail(`${label} must be an integer`);
  return value;
};
const object = (value, keys, label) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain JSON object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptor, 'value')) fail(`Unknown or unsafe ${label} field ${String(key)}`);
  }
  return value;
};
const array = (value, label, max) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) fail(`${label} exceeds its plain JSON array limit`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail(`${label} must be a dense data-only array`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${label} must not contain holes/getters`);
  }
  return value;
};
const boolean = (value, label) => {if (typeof value !== 'boolean') fail(`${label} must be boolean`); return value;};
const assertDataOnly = (value, depth = 0) => {
  if (depth > 12) fail('Input JSON nesting exceeds 12');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {array(value, 'Input data array', LIMITS.buttons); for (const item of value) assertDataOnly(item, depth + 1); return;}
  if (!value || typeof value !== 'object') fail('Input must contain data only, not code/functions');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) fail('Input JSON object exceeds its field limit');
  object(value, keys.filter(key => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key)), 'input JSON');
  for (const item of Object.values(value)) assertDataOnly(item, depth + 1);
};
const text = (value, label, max) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`Invalid ${label}`);
  return value;
};
const normalizeKey = key => {
  text(key, 'keyboard key', 32);
  key = ALIASES[key] || key;
  if (!(key.length === 1 || SPECIAL_KEYS.has(key))) fail('Unsupported keyboard key');
  return key;
};
const decodeBase64 = (value, max) => {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(max / 3) * 4 || value.length % 4 ||
    /[^A-Za-z0-9+/=]/.test(value) || (value.indexOf('=') !== -1 && !/^={1,2}$/.test(value.slice(value.indexOf('='))))) fail('Invalid or oversized canonical base64 input');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) fail('Invalid or oversized canonical base64 input');
  return bytes;
};
const dimensions = (width, height) => {
  integer(width, 'image width', 1, LIMITS.dimension); integer(height, 'image height', 1, LIMITS.dimension);
  if (width * height > LIMITS.pixels) fail('Image exceeds the 2073600-pixel limit');
};
const crcTable = Uint32Array.from({length: 256}, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
};

// Inspect dimensions before invoking the native decoder, including compressed-image bombs.
const inspectImage = (bytes, expected) => {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.frameBytes) fail('Frame exceeds the 4 MiB byte limit');
  let format, width, height;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    format = 'png';
    let offset = 8, chunks = 0, ended = false, data = false;
    while (offset < bytes.length) {
      if (++chunks > 4096 || offset + 12 > bytes.length) fail('Invalid PNG chunks');
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) fail('Truncated PNG chunk');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('Invalid PNG CRC');
      if (chunks === 1 && (type !== 'IHDR' || length !== 13)) fail('PNG must begin with IHDR');
      if (type === 'IHDR') {
        if (chunks !== 1) fail('Duplicate PNG IHDR');
        width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
        dimensions(width, height);
        const depth = bytes[offset + 16], color = bytes[offset + 17];
        const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
        if (!depths[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20] > 1) fail('Unsupported PNG format');
      }
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('Animated PNG is not a single recorded frame');
      if (type === 'IDAT') data = true;
      if (type === 'IEND') {if (length || end !== bytes.length || !data) fail('Invalid PNG ending'); ended = true;}
      offset = end;
    }
    if (!ended) fail('PNG has no IEND');
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    format = 'jpeg';
    if (bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('JPEG must end with EOI');
    let offset = 2, scan = false;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) fail('Invalid JPEG marker');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218) {scan = true; break;}
      if (marker === 216 || marker === 217 || marker === 0) fail('Invalid JPEG structure');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length - 2) fail('Truncated JPEG segment');
      if ([192, 193, 194].includes(marker)) {
        if (width || length < 8 || bytes[offset + 2] !== 8 || ![1, 3].includes(bytes[offset + 7])) fail('Unsupported JPEG frame');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
        dimensions(width, height);
      } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) fail('Unsupported JPEG coding');
      offset += length;
    }
    if (!scan || !width) fail('JPEG is missing image dimensions or scan');
  } else fail('Only PNG/JPEG recorded frames are accepted (no SVG, URL or executable content)');
  if (expected && expected !== format) fail('Frame format does not match its bytes');
  return {format, width, height};
};

const inspectAudio = (bytes, {format, sampleRate, channels}) => {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.audioBytes) fail('Audio exceeds the 4 MiB byte limit');
  let pcm = bytes;
  if (format === 'wav') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length) fail('Invalid RIFF/WAV size or signature');
    let offset = 12, description, data;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) fail('Truncated WAV chunk');
      const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + length;
      if (end + (length & 1) > bytes.length) fail('Truncated WAV payload');
      if (name === 'fmt ') {
        if (description || length !== 16) fail('Only one 16-byte PCM/float WAV fmt chunk is accepted');
        const encoding = bytes.readUInt16LE(offset + 8), bits = bytes.readUInt16LE(offset + 22);
        const decodedFormat = encoding === 1 && bits === 16 ? 's16le' : encoding === 3 && bits === 32 ? 'f32le' : null;
        if (!decodedFormat) fail('WAV must be signed 16-bit PCM or IEEE float32, little endian');
        description = {format: decodedFormat, channels: bytes.readUInt16LE(offset + 10), sampleRate: bytes.readUInt32LE(offset + 12)};
        const align = description.channels * bits / 8;
        if (bytes.readUInt16LE(offset + 20) !== align || bytes.readUInt32LE(offset + 16) !== align * description.sampleRate) fail('Invalid WAV block alignment or byte rate');
      }
      if (name === 'data') {if (data) fail('Duplicate WAV data chunk'); data = bytes.subarray(offset + 8, end);}
      offset = end + (length & 1);
    }
    if (!description || !data) fail('WAV requires fmt and data chunks');
    if (sampleRate !== undefined && sampleRate !== description.sampleRate || channels !== undefined && channels !== description.channels) fail('WAV metadata does not match the header');
    ({format, sampleRate, channels} = description); pcm = data;
  }
  if (!['s16le', 'f32le'].includes(format)) fail('Audio format must be wav/s16le/f32le');
  integer(sampleRate, 'PCM sampleRate', LIMITS.sampleRateMin, LIMITS.sampleRateMax);
  integer(channels, 'PCM channels', 1, LIMITS.channels);
  const stride = channels * (format === 's16le' ? 2 : 4), samples = pcm.length / stride;
  if (!Number.isInteger(samples) || !samples || samples / sampleRate > LIMITS.audioSeconds) fail('PCM must contain complete sample frames and be at most 10 seconds');
  if (format === 'f32le') for (let offset = 0; offset < pcm.length; offset += 4) finite(pcm.readFloatLE(offset), 'PCM float sample', -1, 1);
  return {format, sampleRate, channels, samples, pcm};
};
const monoSamples = audio => {
  const samples = new Float32Array(audio.samples), size = audio.format === 's16le' ? 2 : 4;
  for (let frame = 0; frame < audio.samples; frame++) {
    let sum = 0;
    for (let channel = 0; channel < audio.channels; channel++) {
      const offset = (frame * audio.channels + channel) * size;
      sum += size === 2 ? audio.pcm.readInt16LE(offset) / 32768 : audio.pcm.readFloatLE(offset);
    }
    samples[frame] = sum / audio.channels;
  }
  return samples;
};

// This synchronous contract is also used at the worker boundary. No paths or code in events.
const normalizeInput = event => {
  assertDataOnly(event);
  object(event, ['frame', 'device', 'data'], 'event');
  if (!DEVICES.includes(event.device)) fail(`Input device ${event.device} is denied or unsupported`);
  const frame = integer(event.frame === undefined ? 0 : event.frame, 'event frame', 0, LIMITS.frame);
  let data;
  switch (event.device) {
  case 'keyboard': {
    const source = object(event.data, ['key', 'isDown', 'keyCode'], 'keyboard');
    data = {key: normalizeKey(source.key), isDown: boolean(source.isDown, 'keyboard isDown')};
    if (source.keyCode !== undefined) data.keyCode = integer(source.keyCode, 'keyCode', 0, 65535);
    break;
  }
  case 'mouse': {
    const source = object(event.data, ['x', 'y', 'canvasWidth', 'canvasHeight', 'isDown', 'button', 'wasDragged'], 'mouse');
    data = {x: finite(source.x, 'mouse x', -1000000, 1000000), y: finite(source.y, 'mouse y', -1000000, 1000000),
      canvasWidth: finite(source.canvasWidth, 'canvasWidth', 1, 16384), canvasHeight: finite(source.canvasHeight, 'canvasHeight', 1, 16384)};
    if (source.isDown !== undefined) data.isDown = boolean(source.isDown, 'mouse isDown');
    if (source.button !== undefined) data.button = integer(source.button, 'mouse button', 0, 2);
    if (source.wasDragged !== undefined) data.wasDragged = boolean(source.wasDragged, 'wasDragged');
    break;
  }
  case 'mouseWheel': {
    const source = object(event.data, ['deltaY', 'deltaX'], 'mouseWheel');
    data = {deltaY: finite(source.deltaY, 'wheel deltaY', -10000, 10000)};
    if (source.deltaX !== undefined) data.deltaX = finite(source.deltaX, 'wheel deltaX', -10000, 10000);
    break;
  }
  case 'userData': data = {username: text(object(event.data, ['username'], 'userData').username, 'username', 128)}; break;
  case 'cloud': {
    const update = object(object(event.data, ['varUpdate'], 'cloud').varUpdate, ['name', 'value'], 'cloud varUpdate');
    const {validateName, validateValue} = require('./local-cloud');
    validateName(update.name); validateValue(update.value);
    data = {varUpdate: {name: update.name, value: update.value}};
    break;
  }
  case 'video': {
    const source = object(event.data, ['format', 'base64', 'mirror'], 'video');
    if (!['png', 'jpeg'].includes(source.format)) fail('Frame format must be png/jpeg');
    inspectImage(decodeBase64(source.base64, LIMITS.frameBytes), source.format);
    data = {format: source.format, base64: source.base64};
    if (source.mirror !== undefined) data.mirror = boolean(source.mirror, 'video mirror');
    break;
  }
  case 'loudness': {
    const source = object(event.data, ['value', 'format', 'base64', 'sampleRate', 'channels'], 'loudness');
    if (source.value !== undefined) {
      if (Object.keys(source).length !== 1) fail('Use either a fixed loudness value or recorded PCM/WAV');
      data = {value: finite(source.value, 'loudness value', 0, 100)};
    } else {
      inspectAudio(decodeBase64(source.base64, LIMITS.audioBytes), source);
      data = {format: source.format, base64: source.base64};
      if (source.sampleRate !== undefined) data.sampleRate = source.sampleRate;
      if (source.channels !== undefined) data.channels = source.channels;
    }
    break;
  }
  case 'gamepad-mapping': {
    const source = object(event.data, ['index', 'id', 'mapping'], 'gamepad-mapping');
    // The helper is a fixed local validator, not a user-specified module or gallery script.
    const {validateMapping} = require('./gamepad-mapping-commands');
    data = {index: integer(source.index, 'mapping index', 0, LIMITS.gamepads - 1), id: text(source.id, 'mapping gamepad id', 128),
      mapping: validateMapping(source.mapping)};
    break;
  }
  case 'gamepad': {
    const source = object(event.data, ['index', 'buttons', 'axes', 'connected', 'id'], 'gamepad');
    const index = integer(source.index === undefined ? 0 : source.index, 'gamepad index', 0, LIMITS.gamepads - 1);
    array(source.buttons, 'Gamepad buttons', LIMITS.buttons); array(source.axes, 'Gamepad axes', LIMITS.axes);
    const buttons = source.buttons.map(button => {
      if (typeof button === 'boolean') return {value: Number(button), pressed: button};
      if (typeof button === 'number') return {value: finite(button, 'button value', 0, 1), pressed: button > 0.5};
      object(button, ['value', 'pressed'], 'gamepad button');
      return {value: finite(button.value, 'button value', 0, 1), pressed: boolean(button.pressed, 'button pressed')};
    });
    data = {index, buttons, axes: source.axes.map(axis => finite(axis, 'axis value', -1, 1)),
      connected: source.connected === undefined ? true : boolean(source.connected, 'gamepad connected'),
      id: source.id === undefined ? `recorded-pad-${index}` : text(source.id, 'gamepad id', 128)};
    break;
  }
  }
  const result = {frame, device: event.device, data};
  const max = ['video', 'loudness'].includes(event.device) ? Math.ceil(LIMITS.frameBytes / 3) * 4 + 1024 : LIMITS.jsonBytes;
  if (Buffer.byteLength(JSON.stringify(result)) > max) fail('Input event exceeds its byte limit');
  return result;
};
const validateBatch = inputs => {
  array(inputs, 'Input queue (4096-event limit)', LIMITS.events);
  let bytes = 0;
  const result = inputs.map(input => {
    const event = normalizeInput(input);
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes > LIMITS.replayBytes) fail('Input queue exceeds the 16 MiB limit');
    return event;
  });
  return result;
};
const parseJSONL = bytes => {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > LIMITS.replayBytes) fail('Replay must be nonempty and at most 16 MiB');
  let source;
  try {source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {fail('Replay must be valid UTF-8');}
  const events = []; let last = -1, offset = 0, lineNumber = 0;
  while (offset < source.length) {
    if (++lineNumber > LIMITS.events * 2) fail('Replay exceeds the 8192-line limit, including empty lines');
    const newline = source.indexOf('\n', offset), end = newline === -1 ? source.length : newline;
    const line = source.slice(offset, end); offset = end + 1;
    if (!line.trim()) continue;
    if (events.length >= LIMITS.events) fail('Replay exceeds the 4096-event limit');
    let event;
    try {event = normalizeInput(JSON.parse(line));} catch (error) {throw new Error(`Replay line ${lineNumber}: ${error.message}`);}
    if (event.frame < last) fail(`Replay line ${lineNumber}: frames must be nondecreasing`);
    last = event.frame; events.push(event);
  }
  if (!events.length) fail('Replay has no events');
  return validateBatch(events);
};

const safePath = filename => {
  if (typeof filename !== 'string' || !filename || filename.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(filename) ||
    /^[a-z][a-z0-9+.-]*:/i.test(filename) || filename.startsWith('//') || filename.startsWith('~') || /%(?:2e|2f|5c|00)/i.test(filename) || filename.split('/').includes('..')) fail('Unsafe input/output path; use an explicit local regular file');
  const full = path.resolve(filename);
  if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(full) || /^\/private\/(?:dev|proc|sys)(?:\/|$)/.test(full)) fail('Device and process paths are denied');
  return full;
};
const checkParents = async full => {
  let parent = path.dirname(full);
  for (;;) {
    try {
      const stat = await fs.lstat(parent);
      // macOS has these two system aliases. Other symlink parents fail closed.
      if (stat.isSymbolicLink()) {
        const allowed = process.platform === 'darwin' && ['/var', '/tmp'].includes(parent) &&
          await fs.realpath(parent) === `/private${parent}`;
        if (!allowed) fail('Symlink parent paths are denied');
      } else if (!stat.isDirectory()) fail('Input/output parent must be a directory');
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (parent === path.dirname(parent)) break;
    parent = path.dirname(parent);
  }
};
const readFileBounded = async (filename, max) => {
  const full = safePath(filename); await checkParents(full);
  const initial = await fs.lstat(full);
  if (!initial.isFile() || initial.isSymbolicLink()) fail('Input must be a regular file (no symlink, FIFO or device)');
  if (initial.size > max) fail(`Input exceeds the ${max}-byte limit`);
  let handle;
  try {
    handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > max || actual.ino !== initial.ino || actual.dev !== initial.dev) fail('Input changed or exceeds the byte limit');
    const buffer = Buffer.alloc(max + 1); let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > max) fail('Input grew beyond the byte limit');
    return buffer.subarray(0, offset);
  } finally {if (handle) await handle.close();}
};
const readPipeBounded = (stream, max, timeoutMS = LIMITS.pipeTimeoutMS) => new Promise((resolve, reject) => {
  if (!stream || stream.isTTY || stream.readableEnded || stream.destroyed) return reject(new Error('An explicit non-TTY input pipe is required'));
  const chunks = []; let size = 0, settled = false;
  const finish = (error, result) => {
    if (settled) return; settled = true;
    clearTimeout(timer); stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); stream.off('close', onClose);
    if (error) stream.pause();
    error ? reject(error) : resolve(result);
  };
  const onData = chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > max) return finish(new Error('Pipe exceeds the byte limit'));
    chunks.push(Buffer.from(bytes));
  };
  const onEnd = () => finish(null, Buffer.concat(chunks, size));
  const onError = error => finish(error);
  const onClose = () => {if (!stream.readableEnded) finish(new Error('Input pipe closed before EOF'));};
  const timer = setTimeout(() => finish(new Error('Input pipe timed out after 5 seconds')), timeoutMS);
  stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError); stream.once('close', onClose); stream.resume();
});
const readSource = async (filename, max, stream) => {
  if (filename !== '-') return readFileBounded(filename, max);
  if (!stream && process.argv.slice(2).includes('session')) fail('Data stdin cannot share the command-session stdin; use an explicit file');
  return readPipeBounded(stream || process.stdin, max);
};
const writeOutput = async (filename, bytes, force = false) => {
  const full = safePath(filename); await checkParents(full);
  try {const stat = await fs.lstat(full); if (!stat.isFile() || stat.isSymbolicLink()) fail('Output must be a regular file');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  return require('./project').atomicWrite(full, bytes, force);
};

class RecordedVideoProvider {
  constructor() {this.canvas = null; this.enabled = false; this.mirror = false;}
  enableVideo() {this.enabled = true; return Promise.resolve();}
  disableVideo() {this.enabled = false;}
  get videoReady() {return this.enabled && Boolean(this.canvas);}
  getFrame({dimensions: size = [480, 360], mirror = this.mirror, format = 'image-data'} = {}) {
    if (!this.videoReady) return null;
    if (!Array.isArray(size) || size.length !== 2) fail('Video dimensions must be [width,height]');
    dimensions(...size);
    if (!['image-data', 'canvas'].includes(format)) fail('Video output format must be image-data/canvas');
    const [width, height] = size, canvas = createCanvas(width, height), context = canvas.getContext('2d');
    if (mirror) {context.translate(width, 0); context.scale(-1, 1);}
    context.drawImage(this.canvas, 0, 0, width, height);
    return format === 'canvas' ? canvas : context.getImageData(0, 0, width, height);
  }
}

// Data-only reimplementation of the frozen Gamepad reporter semantics; no gallery script execution.
class RecordedGamepad {
  constructor() {this.pads = []; this.deadzone = 0.1;}
  update(data, frame) {
    const previous = this.pads[data.index];
    if (!data.connected) {this.pads[data.index] = null; return;}
    const pad = {...data, timestamp: frame, values: [], directions: []};
    for (let index = 0; index < data.axes.length; index += 2) {
      const x = data.axes[index], y = data.axes[index + 1] || 0, active = Math.hypot(x, y) > this.deadzone;
      let direction = (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360;
      if (!active) direction = previous?.directions[index] ?? 90;
      pad.values.push(active ? x : 0, active ? y : 0); pad.directions.push(direction, direction);
    }
    this.pads[data.index] = pad;
  }
  getPads(index) {return index === 'any' ? this.pads.filter(Boolean) : this.pads[Number(index) - 1] ? [this.pads[Number(index) - 1]] : [];}
  gamepadConnected({pad}) {return this.getPads(pad).length > 0;}
  buttonDown({b, i}) {return this.getPads(i).some(pad => b === 'any' ? pad.buttons.some(button => button.pressed) : Boolean(pad.buttons[Number(b) - 1]?.pressed));}
  buttonValue({b, i}) {return Math.max(0, ...this.getPads(i).map(pad => {const value = pad.buttons[Number(b) - 1]?.value || 0; return value < 0.05 ? 0 : value;}));}
  axisValue({b, i}) {return this.getPads(i).reduce((best, pad) => {const value = pad.values[Number(b) - 1] || 0; return Math.abs(value) > Math.abs(best) ? value : best;}, 0);}
  axisMagnitude({axis, pad}) {return Math.max(0, ...this.getPads(pad).map(item => Math.hypot(item.values[Number(axis) - 1] || 0, item.values[Number(axis)] || 0)));}
  axisDirection({axis, pad}) {
    const pads = this.getPads(pad); let best = 0, direction = 90;
    for (const item of pads) {
      const magnitude = Math.hypot(item.values[Number(axis) - 1] || 0, item.values[Number(axis)] || 0);
      if (magnitude > best) direction = item.directions[Number(axis) - 1] || 0;
      // Match the frozen implementation, which leaves greatestMagnitude at 0.
    }
    if (!best && pads.length) direction = [...pads].sort((a, b) => b.timestamp - a.timestamp)[0].directions[Number(axis) - 1] || 0;
    return direction;
  }
  setAxisDeadzone({DEADZONE}) {
    this.deadzone = finite(Number(DEADZONE), 'axis deadzone', 0, 1);
    for (const pad of [...this.pads]) if (pad) this.update(pad, pad.timestamp);
  }
  rumble() {fail('Physical gamepad/HID rumble is denied; recorded inputs have no actuator');}
}
const GAMEPAD_METHODS = ['gamepadConnected', 'buttonDown', 'buttonValue', 'axisValue', 'axisMagnitude', 'axisDirection', 'setAxisDeadzone', 'rumble'];
const PAD_BUTTON_KEYS = Object.freeze({0: ' ', 1: 'Enter', 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight'});
const OFFLINE_EXTENSION_IDS = Object.freeze(['videoSensing', 'Gamepad']);
const offlineBoundaries = new WeakMap();
const activeReplays = new WeakMap();
const setOwn = (object, key, value, restore) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  object[key] = value;
  restore.push(() => {if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key];});
};

const registerOfflineExtensions = vm => {
  if (!vm?.runtime?.ioDevices || !vm.extensionManager?.addBuiltinExtension) fail('A real VM extension manager is required');
  if (offlineBoundaries.has(vm)) return OFFLINE_EXTENSION_IDS;
  const runtime = vm.runtime, video = runtime.ioDevices.video, provider = new RecordedVideoProvider(), gamepad = new RecordedGamepad();
  const boundary = {provider, gamepad, loudness: -1, restores: [], oldSkin: video._skinId, oldDrawable: video._drawable, motion: null};
  offlineBoundaries.set(vm, boundary);
  const updatePreview = () => {
    const renderer = runtime.renderer;
    if (!renderer) return;
    if (!provider.videoReady || runtime.getTargetForStage()?.videoState === 'off') {
      if (video._drawable !== -1) renderer.updateDrawableVisible(video._drawable, false);
      return;
    }
    const frame = video.getFrame({dimensions: [480, 360]});
    if (video._skinId === -1) {
      video._skinId = renderer.createBitmapSkin(frame, 1);
      video._drawable = renderer.createDrawable(require('scratch-vm/src/engine/stage-layering').VIDEO_LAYER);
      renderer.updateDrawableSkinId(video._drawable, video._skinId);
      if (renderer.markSkinAsPrivate) renderer.markSkinAsPrivate(video._skinId);
      if (renderer.markDrawableAsNoninteractive) renderer.markDrawableAsNoninteractive(video._drawable);
    } else renderer.updateBitmapSkin(video._skinId, frame, 1);
    renderer.updateDrawableVisible(video._drawable, true);
    video.setPreviewGhost(runtime.getTargetForStage()?.videoTransparency ?? 50); runtime.requestRedraw();
  };
  boundary.updatePreview = updatePreview;
  setOwn(video, 'provider', provider, boundary.restores);
  setOwn(video, 'enableVideo', () => {provider.enabled = true; updatePreview(); return Promise.resolve(video);}, boundary.restores);
  setOwn(video, 'disableVideo', () => {provider.enabled = false; updatePreview();}, boundary.restores);
  setOwn(runtime, '_linkSocketFactory', () => fail('Real BLE/BT and ScratchLink network access are denied; use socket-mock fixtures'), boundary.restores);
  if (runtime.audioEngine) setOwn(runtime.audioEngine, 'getLoudness', () => boundary.loudness, boundary.restores);
  const Upstream = require('scratch-vm/src/extensions/scratch3_video_sensing');
  class OfflineVideoMotion extends Upstream {
    constructor(owner) {
      const eventNames = [owner.constructor.PROJECT_LOADED, owner.constructor.PROJECT_RUN_START];
      const previous = eventNames.map(name => new Set(owner.listeners(name)));
      super(owner);
      this.firstInstall = false; boundary.motion = this;
      eventNames.forEach((name, index) => {
        for (const listener of owner.listeners(name)) if (!previous[index].has(listener)) boundary.restores.push(() => owner.off(name, listener));
      });
    }
    _loop() {} // Recorded frames advance at the worker's frame boundary, never at wall-clock intervals.
    videoToggle(args) {
      const state = String(args.VIDEO_STATE);
      if (!['off', 'on', 'on-flipped'].includes(state)) fail('Video state must be off/on/on-flipped');
      this.globalVideoState = state; video.mirror = state === 'on'; provider.mirror = video.mirror;
      state === 'off' ? video.disableVideo() : video.enableVideo();
    }
    getInfo() {this.firstInstall = false; return super.getInfo();}
  }
  class OfflineGamepad extends RecordedGamepad {
    constructor() {super(); boundary.gamepad = this;}
    getInfo() {
      const ArgumentType = require('scratch-vm/src/extension-support/argument-type'), BlockType = require('scratch-vm/src/extension-support/block-type');
      const number = defaultValue => ({type: ArgumentType.NUMBER, defaultValue});
      const descriptions = {
        gamepadConnected: ['gamepad [pad] connected?', BlockType.BOOLEAN, {pad: number(1)}],
        buttonDown: ['button [b] on pad [i] pressed?', BlockType.BOOLEAN, {b: number(1), i: number(1)}],
        buttonValue: ['value of button [b] on pad [i]', BlockType.REPORTER, {b: number(1), i: number(1)}],
        axisValue: ['value of axis [b] on pad [i]', BlockType.REPORTER, {b: number(1), i: number(1)}],
        axisMagnitude: ['magnitude of axes [axis] on pad [pad]', BlockType.REPORTER, {axis: number(1), pad: number(1)}],
        axisDirection: ['direction of axes [axis] on pad [pad]', BlockType.REPORTER, {axis: number(1), pad: number(1)}],
        setAxisDeadzone: ['set axis deadzone to [DEADZONE]', BlockType.COMMAND, {DEADZONE: number(0.1)}],
        rumble: ['rumble strong [s] and weak [w] for [t] sec. on pad [i]', BlockType.COMMAND, {s: number(0.25), w: number(0.5), t: number(0.25), i: number(1)}]
      };
      return {id: 'Gamepad', name: 'Recorded Gamepad', blocks: GAMEPAD_METHODS.map(opcode => ({opcode,
        text: descriptions[opcode][0], blockType: descriptions[opcode][1], arguments: descriptions[opcode][2]}))};
    }
  }
  vm.extensionManager.addBuiltinExtension('videoSensing', OfflineVideoMotion);
  vm.extensionManager.addBuiltinExtension('Gamepad', OfflineGamepad);
  // Register factories before load. No extension is installed or serialized until explicitly needed.
  return OFFLINE_EXTENSION_IDS;
};
const disposeOfflineExtensions = vm => {
  const boundary = offlineBoundaries.get(vm); if (!boundary) return;
  const video = vm.runtime.ioDevices.video, renderer = vm.runtime.renderer;
  if (renderer && boundary.oldSkin === -1 && video._skinId !== -1) {
    renderer.destroyDrawable(video._drawable, require('scratch-vm/src/engine/stage-layering').VIDEO_LAYER);
    renderer.destroySkin(video._skinId); video._skinId = boundary.oldSkin; video._drawable = boundary.oldDrawable;
  }
  for (const restore of boundary.restores.reverse()) restore();
  boundary.provider.canvas = null; boundary.provider.enabled = false; offlineBoundaries.delete(vm);
};

const decodeRecordedFrame = async data => {
  const bytes = decodeBase64(data.base64, LIMITS.frameBytes), info = inspectImage(bytes, data.format);
  let image;
  try {image = await loadImage(bytes);} catch {fail('Cannot decode recorded PNG/JPEG frame');}
  if (image.width !== info.width || image.height !== info.height) fail('Decoded image dimensions differ from header');
  const canvas = createCanvas(info.width, info.height); canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
};
const prepareInput = async (vm, event) => {
  if (event.device === 'cloud' && vm) {
    const stage = vm.runtime.getTargetForStage(), update = event.data.varUpdate;
    if (!Object.values(stage?.variables || {}).some(variable => variable.isCloud && variable.name === update.name)) fail(`Cloud variable does not exist: ${update.name}`);
  }
  const result = {event, decodedBytes: 0};
  if (event.device === 'video') {
    const canvas = await decodeRecordedFrame(event.data);
    Object.assign(result, {canvas, decodedBytes: canvas.width * canvas.height * 4});
  }
  if (event.device === 'loudness' && event.data.value === undefined) {
    const audio = inspectAudio(decodeBase64(event.data.base64, LIMITS.audioBytes), event.data);
    Object.assign(result, {audio: {samples: monoSamples(audio), sampleRate: audio.sampleRate}, decodedBytes: audio.samples * 4});
  }
  return result;
};

const validateRecordedInputs = async (vm, inputs) => {
  const events = validateBatch(inputs); let decodedBytes = 0;
  for (const event of events) {
    const item = await prepareInput(vm, event); decodedBytes += item.decodedBytes;
    if (decodedBytes > LIMITS.decodedBytes) fail('Replay exceeds the 32 MiB decoded-media limit');
  }
  return events;
};

// Runtime execution boundary: this intentionally applies cloud updates and starts
// input hats on its VM. Recording commands must validate/queue instead, and only
// call this API for an isolated runtime copy, never the editor project VM.
const createInputReplay = async (vm, inputs = []) => {
  if (!vm?.runtime?.ioDevices || typeof vm.postIOData !== 'function') fail('A real VM with IO devices is required');
  if (activeReplays.has(vm)) fail('Only one input replay may own a VM; use append on the existing replay');
  const normalized = validateBatch(inputs), prepared = [];
  let bytes = normalized.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)) + 1, 0), decoded = 0, count = normalized.length;
  for (const event of normalized) {
    const item = await prepareInput(vm, event); decoded += item.decodedBytes;
    if (decoded > LIMITS.decodedBytes) fail('Replay exceeds the 32 MiB decoded-media limit');
    prepared.push(item);
  }
  const eventOrder = (a, b) => a.event.frame - b.event.frame ||
    Number(b.event.device === 'gamepad-mapping') - Number(a.event.device === 'gamepad-mapping');
  prepared.sort(eventOrder);
  // Decoding yields; another caller may have claimed this VM in the meantime.
  if (activeReplays.has(vm)) fail('Only one input replay may own a VM; use append on the existing replay');
  const ownsBoundary = !offlineBoundaries.has(vm);
  registerOfflineExtensions(vm);
  const runtime = vm.runtime, video = runtime.ioDevices.video, boundary = offlineBoundaries.get(vm), restores = [], provider = boundary.provider;
  if (runtime.ext_scratch3_sensing) {
    const cached = runtime.ext_scratch3_sensing._cachedLoudness, timestamp = runtime.ext_scratch3_sensing._cachedLoudnessTimestamp;
    restores.push(() => {runtime.ext_scratch3_sensing._cachedLoudness = cached; runtime.ext_scratch3_sensing._cachedLoudnessTimestamp = timestamp;});
  }
  const state = {lastFrame: -1, loudness: -1, permissions: PERMISSIONS, provider, get gamepad() {return boundary.gamepad;}};
  let disposed = false, tail = Promise.resolve(), sensor = null, lastRMS = 0, videoChanged = false, audioChanged = false;
  const directKeys = new Set(), padKeys = new Map(), mappings = new Map(), padMouseButtons = new Set(), directMouseButtons = new Set();
  const keyIdentity = key => key.length === 1 ? key.toUpperCase() : key;
  const cursor = {x: 0, y: 0}; let currentCursorFrame = -1;
  const ensureExtension = id => {
    if (!vm.extensionManager.isExtensionLoaded(id)) vm.extensionManager.loadExtensionIdSync(id);
    if (!runtime[`ext_${id}`]) fail(`Offline extension ${id} did not register`);
  };
  for (const event of normalized) {
    if (event.device === 'video') ensureExtension('videoSensing');
    if (event.device === 'gamepad') ensureExtension('Gamepad');
  }
  if (runtime.audioEngine) setOwn(runtime.audioEngine, 'getLoudness', () => state.loudness, restores);
  const postCursorMouse = data => vm.postIOData('mouse', {x: cursor.x + runtime.stageWidth / 2,
    y: runtime.stageHeight / 2 - cursor.y, canvasWidth: runtime.stageWidth, canvasHeight: runtime.stageHeight, ...data});
  const applyPadControls = (frame, moveCursor = true) => {
    const next = new Set(), mouseButtons = new Set(); let dx = 0, dy = 0;
    const deltaMS = currentCursorFrame < 0 ? 0 : Math.max(0, Math.min(1000, (frame - currentCursorFrame) * (runtime.currentStepTime || 1000 / 30)));
    for (const pad of boundary.gamepad.pads) {
      if (!pad) continue;
      const selected = mappings.get(pad.index), mapping = selected?.id === pad.id ? selected.mapping : null;
      if (!mapping) {
        for (const [index, key] of Object.entries(PAD_BUTTON_KEYS)) if (pad.buttons[index]?.pressed) next.add(key);
        if (pad.axes[0] < -0.5) next.add('ArrowLeft'); if (pad.axes[0] > 0.5) next.add('ArrowRight');
        if (pad.axes[1] < -0.5) next.add('ArrowUp'); if (pad.axes[1] > 0.5) next.add('ArrowDown');
        continue;
      }
      const {normalizeMappingEntry} = require('./gamepad-mapping-commands');
      const processEntry = (raw, value, isAxis) => {
        const entry = normalizeMappingEntry(raw, isAxis), positive = value >= entry.deadZone, negative = value <= -entry.deadZone;
        if (entry.type === 'key') {
          if (positive && entry.high) next.add(normalizeKey(entry.high));
          if (negative && entry.low) next.add(normalizeKey(entry.low));
        } else if (entry.type === 'mousedown') {
          if (positive || negative) mouseButtons.add(entry.button);
        } else if (entry.type === 'virtual_cursor' && (positive || negative)) {
          const direction = positive ? entry.high : entry.low;
          if (!direction) return;
          const multiplier = (Math.abs(value) - entry.deadZone) / (1 - entry.deadZone);
          const amount = multiplier ** 2 * entry.sensitivity * deltaMS;
          if (direction === '+x') dx += amount; if (direction === '-x') dx -= amount;
          if (direction === '+y') dy += amount; if (direction === '-y') dy -= amount;
        }
      };
      mapping.buttons.forEach((entry, index) => processEntry(entry, pad.buttons[index]?.value || 0, false));
      mapping.axes.forEach((entry, index) => processEntry(entry, pad.axes[index] || 0, true));
    }
    const effective = new Map([...next].map(key => [keyIdentity(key), key]));
    for (const [identity, key] of padKeys) if (!effective.has(identity) && !directKeys.has(identity)) vm.postIOData('keyboard', {key, isDown: false});
    for (const [identity, key] of effective) if (!padKeys.has(identity) && !directKeys.has(identity)) vm.postIOData('keyboard', {key, isDown: true});
    padKeys.clear(); for (const [identity, key] of effective) padKeys.set(identity, key);
    if (moveCursor && frame !== currentCursorFrame && (dx || dy)) {
      cursor.x = Math.max(-runtime.stageWidth / 2, Math.min(runtime.stageWidth / 2, cursor.x + dx));
      cursor.y = Math.max(-runtime.stageHeight / 2, Math.min(runtime.stageHeight / 2, cursor.y + dy));
      postCursorMouse({});
    }
    if (moveCursor) currentCursorFrame = frame;
    for (const button of padMouseButtons) if (!mouseButtons.has(button) && !directMouseButtons.has(button)) postCursorMouse({isDown: false, button});
    for (const button of mouseButtons) if (!padMouseButtons.has(button) && !directMouseButtons.has(button)) postCursorMouse({isDown: true, button});
    padMouseButtons.clear(); for (const button of mouseButtons) padMouseButtons.add(button);
  };
  const applyPrepared = item => {
    const {event, canvas, audio} = item, {device, data, frame} = event;
    if (device === 'video') {ensureExtension('videoSensing'); provider.canvas = canvas; provider.enabled = true; video.mirror = data.mirror ?? false; provider.mirror = video.mirror; videoChanged = true;}
    else if (device === 'loudness') {sensor = {audio, value: data.value, frame}; audioChanged = true;}
    else if (device === 'gamepad') {ensureExtension('Gamepad'); boundary.gamepad.update(data, frame);}
    else if (device === 'gamepad-mapping') mappings.set(data.index, data);
    else if (device === 'keyboard') {
      const identity = keyIdentity(data.key);
      data.isDown ? directKeys.add(identity) : directKeys.delete(identity);
      if (data.isDown || !padKeys.has(identity)) vm.postIOData(device, data);
    } else {
      if (device === 'mouse') {
        cursor.x = runtime.stageWidth * (data.x / data.canvasWidth - 0.5);
        cursor.y = -runtime.stageHeight * (data.y / data.canvasHeight - 0.5);
        if (data.isDown !== undefined) {
          const button = data.button ?? 0;
          data.isDown ? directMouseButtons.add(button) : directMouseButtons.delete(button);
          if (!data.isDown && padMouseButtons.has(button)) {const {isDown, ...position} = data; vm.postIOData(device, position); return;}
        }
      }
      vm.postIOData(device, data);
    }
  };
  const updateLoudness = frame => {
    if (!sensor) return;
    if (sensor.value !== undefined) {state.loudness = sensor.value; return;}
    const {samples, sampleRate} = sensor.audio;
    const offset = Math.floor((frame - sensor.frame) * (runtime.currentStepTime || 1000 / 30) / 1000 * sampleRate);
    const end = Math.min(samples.length, offset + 2048); let sum = 0;
    for (let index = offset; index < end; index++) sum += samples[index] ** 2;
    const rms = Math.max(end > offset ? Math.sqrt(sum / (end - offset)) : 0, lastRMS * 0.6);
    lastRMS = rms; state.loudness = Math.min(100, Math.round(Math.sqrt(rms * 1.63) * 100));
  };
  const replay = {
    state,
    append(event) {return replay.appendMany([event]);},
    appendMany(events) {
      const operation = async () => {
        if (disposed) fail('Input replay is disposed');
        const normalized = validateBatch(events), added = []; let nextBytes = bytes, nextDecoded = decoded;
        if (count + normalized.length > LIMITS.events) fail('Input replay exceeds the cumulative 4096-event limit');
        for (const event of normalized) {
          if (event.frame < state.lastFrame) fail('Cannot append an event before the current replay frame');
          nextBytes += Buffer.byteLength(JSON.stringify(event)) + 1;
          if (nextBytes > LIMITS.replayBytes) fail('Input replay exceeds the cumulative 16 MiB limit');
          const item = await prepareInput(vm, event); nextDecoded += item.decodedBytes;
          if (nextDecoded > LIMITS.decodedBytes) fail('Input replay exceeds the cumulative 32 MiB decoded-media limit');
          added.push(item);
        }
        if (disposed) fail('Input replay is disposed');
        if (normalized.some(event => event.frame < state.lastFrame)) fail('Cannot append an event before the current replay frame');
        for (const event of normalized) {
          if (event.device === 'video') ensureExtension('videoSensing');
          if (event.device === 'gamepad') ensureExtension('Gamepad');
        }
        prepared.push(...added); prepared.sort(eventOrder);
        count += normalized.length; bytes = nextBytes; decoded = nextDecoded;
        return normalized.length;
      };
      const result = tail.then(operation); tail = result.catch(() => {}); return result;
    },
    applyFrame(frame) {
      if (disposed) fail('Input replay is disposed');
      integer(frame, 'replay frame', 0, LIMITS.frame);
      if (frame < state.lastFrame) fail('Replay frames cannot move backwards');
      let applied = 0;
      while (prepared.length && prepared[0].event.frame <= frame) {applyPrepared(prepared.shift()); applied++;}
      applyPadControls(frame);
      if (frame !== state.lastFrame || audioChanged) {
        updateLoudness(frame);
        if (runtime.ext_scratch3_sensing) runtime.ext_scratch3_sensing._cachedLoudnessTimestamp = -Infinity;
      }
      if (frame !== state.lastFrame || videoChanged) {
        if (boundary.motion && provider.videoReady) boundary.motion.detect.addFrame(video.getFrame({dimensions: [480, 360]}).data);
        boundary.updatePreview();
      }
      videoChanged = false; audioChanged = false;
      state.lastFrame = frame; return applied;
    },
    dispose() {
      if (disposed) return;
      disposed = true; prepared.length = 0;
      for (const [identity, key] of padKeys) if (!directKeys.has(identity)) vm.postIOData('keyboard', {key, isDown: false});
      for (const button of padMouseButtons) if (!directMouseButtons.has(button)) postCursorMouse({isDown: false, button});
      mappings.clear();
      for (const restore of restores.reverse()) restore();
      provider.canvas = null; provider.enabled = false; boundary.loudness = -1;
      boundary.gamepad.pads = []; boundary.motion?.detect.reset(); boundary.updatePreview();
      if (ownsBoundary) disposeOfflineExtensions(vm);
      activeReplays.delete(vm);
    }
  };
  activeReplays.set(vm, replay);
  return replay;
};
const applyInput = async (vm, event) => {
  const normalized = normalizeInput(event), replay = activeReplays.get(vm) || await createInputReplay(vm);
  await replay.append(normalized); replay.applyFrame(normalized.frame); return replay;
};

const freezeJSON = value => {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freezeJSON(child); Object.freeze(value);}
  return value;
};
const SOCKET_FIXTURES = freezeJSON({
  BLE: Object.freeze([
    {jsonrpc: '2.0', method: 'didDiscoverPeripheral', params: {peripheralId: 'fixture-ble', name: 'Recorded micro:bit', rssi: -42}},
    {jsonrpc: '2.0', method: 'characteristicDidChange', params: {serviceId: 61445,
      characteristicId: '5261da01-fa7e-42ab-850b-7c80220097cc', message: 'ABn/9gEAAQAAAQ==', encoding: 'base64'}}
  ]),
  BT: Object.freeze([
    {jsonrpc: '2.0', method: 'didDiscoverPeripheral', params: {peripheralId: 'fixture-bt', name: 'Recorded EV3', rssi: -42}},
    {jsonrpc: '2.0', method: 'didReceiveMessage', params: {message: 'AQIDBA==', encoding: 'base64'}}
  ])
});
const validateSocketMessage = message => {
  // Bound stringify before copying; JSON-RPC messages never contain executable callbacks.
  const visit = (value, depth = 0) => {
    if (depth > 12) fail('Socket message nesting exceeds 12');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {if (Buffer.byteLength(value) > LIMITS.jsonBytes) fail('Socket message string is oversized'); return;}
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {array(value, 'Socket array', 1024); for (const item of value) visit(item, depth + 1); return;}
    object(value, Object.keys(value || {}).filter(key => !['__proto__', 'prototype', 'constructor'].includes(key)), 'socket JSON');
    if (Object.keys(value).length > 64) fail('Socket object is oversized');
    for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(message);
  const bytes = JSON.stringify(message);
  if (Buffer.byteLength(bytes) > LIMITS.jsonBytes) fail('Socket message exceeds the 64 KiB limit');
  const result = JSON.parse(bytes);
  object(result, ['jsonrpc', 'id', 'method', 'params', 'result', 'error'], 'JSON-RPC');
  if (result.jsonrpc !== '2.0') fail('Socket message requires JSON-RPC 2.0');
  if (result.method !== undefined) text(result.method, 'JSON-RPC method', 64);
  if (result.id !== undefined && result.id !== null && !(Number.isSafeInteger(result.id) || typeof result.id === 'string' && result.id.length <= 128)) fail('Invalid JSON-RPC id');
  return result;
};
class MockScratchLinkSocket {
  constructor(type) {
    if (!Object.hasOwn(SOCKET_FIXTURES, type)) fail('ScratchLink mock type must be BLE/BT');
    this.type = type; this.messages = []; this.received = []; this.opened = false; this.generation = 0; this.realdevice = false;
  }
  setOnOpen(fn) {this.onOpen = fn;}
  setOnClose(fn) {this.onClose = fn;}
  setOnError(fn) {this.onError = fn;}
  setHandleMessage(fn) {this.handleMessage = fn;}
  isOpen() {return this.opened;}
  open() {
    if (![this.onOpen, this.onClose, this.onError, this.handleMessage].every(fn => typeof fn === 'function')) fail('Set all mock socket handlers before open');
    if (this.opened) fail('Mock socket is already open');
    this.opened = true; this.onOpen();
  }
  close() {if (!this.opened) return; this.opened = false; this.generation++; this.onClose();}
  receive(message) {
    const parsed = validateSocketMessage(message), generation = this.generation;
    if (!this.opened) fail('Mock socket is closed');
    if (this.received.length >= LIMITS.socketMessages) fail('Mock socket received-message limit reached');
    this.received.push(parsed);
    queueMicrotask(() => {if (this.opened && generation === this.generation) this.handleMessage(parsed);});
  }
  sendMessage(message) {
    if (!this.opened) fail('Mock socket is closed');
    const parsed = validateSocketMessage(message);
    if (this.messages.length >= LIMITS.socketMessages) fail('Mock socket sent-message limit reached');
    const methods = ['discover', 'connect', 'read', 'write', 'startNotifications', 'stopNotifications', 'send', 'ping'];
    if (parsed.method !== undefined && !methods.includes(parsed.method)) fail('ScratchLink method is denied by the fixture mock');
    this.messages.push(parsed);
    if (parsed.method === undefined) return;
    if (parsed.id !== undefined && parsed.id !== null) this.receive({jsonrpc: '2.0', id: parsed.id, result: parsed.method === 'ping' ? 42 : null});
    if (parsed.method === 'discover') this.receive(SOCKET_FIXTURES[this.type][0]);
    if (['read', 'startNotifications'].includes(parsed.method) || this.type === 'BT' && parsed.method === 'send') this.receive(SOCKET_FIXTURES[this.type][1]);
  }
}
const createMockSocketFactory = () => {
  const sockets = [];
  const factory = type => {
    if (sockets.length >= 16) fail('Mock socket factory exceeds the 16-socket limit');
    const socket = new MockScratchLinkSocket(type); sockets.push(socket); return socket;
  };
  factory.sockets = sockets; factory.dispose = () => {for (const socket of sockets) socket.close();};
  return factory;
};
const runSocketMock = async (vm, type = 'BLE') => {
  const factory = createMockSocketFactory(), previous = vm?.runtime?._linkSocketFactory;
  if (vm) vm.runtime.configureScratchLinkSocketFactory(factory);
  try {
    const socket = vm ? vm.runtime.getScratchLinkSocket(type) : factory(type);
    const Transport = require(type === 'BLE' ? 'scratch-vm/src/io/ble' : 'scratch-vm/src/io/bt');
    // The live constructors use window timers. Exercise their frozen message parser without a DOM shim or scanning.
    const peer = Object.create(Transport.prototype), calls = [], runtimeEvents = [], sensorMessages = [];
    Object.assign(peer, {_requestID: 0, _openRequests: {}, _availablePeripherals: {}, _discoverTimeoutID: null,
      _runtime: {constructor: {PERIPHERAL_LIST_UPDATE: 'PERIPHERAL_LIST_UPDATE'}, emit: (name, data) => runtimeEvents.push({name, data})},
      _characteristicDidChangeCallback: message => sensorMessages.push(message), _messageCallback: data => sensorMessages.push(data.message)});
    peer._sendMessage = message => socket.sendMessage(message);
    peer.didReceiveCall = (method, params) => {calls.push({method, params}); return Transport.prototype.didReceiveCall.call(peer, method, params);};
    socket.setOnOpen(() => {}); socket.setOnClose(() => {}); socket.setOnError(error => {throw error;});
    socket.setHandleMessage(message => peer._handleMessage(message)); socket.open();
    await peer.sendRemoteRequest('discover', {});
    await peer.sendRemoteRequest('connect', {peripheralId: `fixture-${type.toLowerCase()}`});
    const method = type === 'BLE' ? 'read' : 'send';
    await peer.sendRemoteRequest(method, type === 'BLE' ? {serviceId: 61445, characteristicId: 'fixture', startNotifications: true} : {message: 'AQIDBA==', encoding: 'base64'});
    await new Promise(resolve => setImmediate(resolve));
    return {mode: 'mock', type, realdevice: {status: 'limited', connected: false, acceptance: 'manual-not-run'},
      calls, runtimeEvents, sensorMessages, sent: socket.messages, received: socket.received};
  } finally {factory.dispose(); if (vm) {if (previous === undefined) delete vm.runtime._linkSocketFactory; else vm.runtime.configureScratchLinkSocketFactory(previous);}}
};
const capabilities = () => ({
  policy: {default: 'deny', permissions: {...PERMISSIONS}, automaticEnumeration: false, executableExtensions: 'deny'},
  inputs: [...DEVICES], limits: {...LIMITS},
  offline: {video: 'PNG/JPEG -> VM video provider + frozen videoSensing motion', loudness: 'PCM/WAV -> audioEngine.getLoudness',
    gamepad: 'data-only Gamepad reporters + fixed keyboard mapping', replay: '0-based frame JSONL, no file references inside events',
    socket: 'fixed BLE/BT JSON-RPC message factory fixtures'},
  realdevice: {status: 'limited', acceptance: 'manual-not-run', hardware: HARDWARE.map(extension => ({extension, scan: 'not-run', connect: 'not-run', sensors: 'not-run', output: 'not-run'})),
    camera: 'not-captured', microphone: 'not-captured', gamepadHID: 'not-enumerated', bleBT: 'no native transport implemented'}
});

module.exports = {LIMITS, DEVICES, PERMISSIONS, HARDWARE, normalizeKey, normalizeInput, validateInput: normalizeInput,
  validateBatch, parseJSONL, inspectImage, inspectAudio, decodeRecordedFrame, readSource, readFileBounded, readPipeBounded, writeOutput,
  RecordedVideoProvider, RecordedGamepad, OFFLINE_EXTENSION_IDS, registerOfflineExtensions, disposeOfflineExtensions,
  createInputReplay, validateRecordedInputs, applyInput, SOCKET_FIXTURES, MockScratchLinkSocket,
  createMockSocketFactory, runSocketMock, capabilities};
