'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {fork, spawn, spawnSync} = require('node:child_process');
const policy = require('./permission-policy');
const adapters = require('./device-adapters');
const {readLocalFile} = require('./project');
const {PROTOCOL, LIMITS, checkConfig, inspectWave, validatePNG, sha256, assertTrackOverlap} = require('./record-worker');

const active = new WeakMap();
const DEFAULT_ENCODER = '/opt/homebrew/bin/ffmpeg';
const DEFAULT_PROBE = '/opt/homebrew/bin/ffprobe';
const specs = require('./command-catalog').moduleSpecs['record-commands.js'];
const requiresProject = (command, args) => args[0] === 'start';
const isReadOnly = () => true;
const bool = (value, fallback, name) => {
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`--${name} must be true/false`);
  return value === 'true';
};
const numeric = (value, fallback, name) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value))) throw new Error(`--${name} must be a finite number`);
  return Number(value);
};
const configFor = options => {
  const waitflag = bool(options.waitflag, true, 'waitflag');
  return checkConfig({duration: numeric(options.duration, 1, 'duration'), delay: numeric(options.delay, 0, 'delay'),
    fps: numeric(options.fps, 30, 'fps'), waitflag,
    flagFrame: options['flag-frame'] === undefined ? waitflag ? 0 : null : numeric(options['flag-frame'], null, 'flag-frame'),
    stopOnStop: bool(options.stopOnStop, true, 'stopOnStop'), stopFrame: numeric(options['stop-frame'], null, 'stop-frame'),
    projectaudio: bool(options.projectaudio, false, 'projectaudio'), microphonemix: bool(options.microphonemix, false, 'microphonemix'),
    ...(options.seed === undefined ? {} : {seed: numeric(options.seed, undefined, 'seed')}), answer: options.answer ?? ''});
};
const capabilities = () => ({mode: 'pure-offscreen-native', sixOptions: {
  duration: {default: 1, guiDefault: 30, semantics: 'simulation seconds including delay; actual video is captured after delay'},
  delay: {default: 0, semantics: 'pre-roll simulation; consumes duration, rounded upward to a frame boundary'},
  projectaudio: {default: false, guiDefault: true, supported: false, status: 'NOT_YET_SUPPORTED: strict whole-project clockOffline audio scheduling is not verified; fail-closed, no silent fallback'},
  microphonemix: {default: false, semantics: 'D7 permits explicit pre-recorded WAV microphone replacement; not live capture or realdevice acceptance'},
  waitflag: {default: true, semantics: 'wait for scheduled --flag-frame (default 0); false does not implicitly start green-flag scripts'},
  stopOnStop: {default: true, semantics: 'PROJECT_STOP_ALL only after PROJECT_START; disabled when waitflag=false; script exhaustion is not stop'}
}, formats: ['frames', 'mp4', 'webm'], limits: LIMITS,
  externalAudio: 'PCM16/float32 WAV -> verified native decode -> sample-clock stereo PCM16 -> actual encoder audio stream',
  defaults: {encoder: DEFAULT_ENCODER, probe: DEFAULT_PROBE, executableAuthorization: 'exact --allow encoder:/path,probe:/path; never PATH search'},
  physicalCapture: 'denied: no microphone, camera, HID/OS enumeration',
  acceptance: {digitalAudio: 'tested separately; does not establish whole-project sound scheduling', realGUI: 'not-run; no browser/Electron/MediaRecorder differential claim'}});
const accessFor = (session, options, label) => {
  policy.assertData(options);
  let tokens = [];
  if (options.allow !== undefined) {
    if (typeof options.allow !== 'string' || !options.allow.trim()) throw new Error('--allow requires a comma list or JSON string array');
    tokens = options.allow.trim().startsWith('[') ? policy.parseJSON(options.allow) : options.allow.split(',').map(token => token.trim());
    if (!Array.isArray(tokens) || !tokens.every(token => typeof token === 'string') || tokens.length > 100 || new Set(tokens).size !== tokens.length)
      throw new Error('Invalid or duplicate exact --allow tokens');
  }
  const executables = [];
  const regular = tokens.filter(token => {
    const match = /^(encoder|probe):(.*)$/.exec(token);
    if (!match) return true;
    if (!path.isAbsolute(match[2])) throw new Error(`${match[1]} grant requires an exact absolute executable filename`);
    executables.push({type: match[1], path: policy.assertLocalPath(match[2])}); return false;
  });
  return {policy: policy.createPolicy(session, {...options, allow: regular.length ? JSON.stringify(regular) : undefined}, label), executables};
};
const authorizeExecutable = async (session, access, type, filename) => {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error(`--${type} requires an exact absolute executable filename, not PATH search`);
  const full = policy.assertLocalPath(filename), allowed = access.executables.some(grant => grant.type === type && grant.path === full);
  policy.record(session, {command: 'record start', capability: type, resource: full, allowed,
    reason: allowed ? 'This command only; exact executable path authorization, no shell and no OS sandbox claim' : `defaultsafe deny; requires --allow ${type}:${full}`});
  if (!allowed) throw new Error(`defaultsafe permission denied: --allow ${type}:${full} is required even for the system default`);
  // Homebrew bin entries are final-file symlinks. Permit only this explicitly
  // authorized final alias, pin its canonical file, and reject symlink parents.
  await policy.safePath(path.dirname(full), {directory: true});
  const aliasStat = await fs.lstat(full);
  if (!aliasStat.isFile() && !aliasStat.isSymbolicLink()) throw new Error('Encoder/probe must be a regular executable');
  const resolved = await fs.realpath(full); await policy.safePath(resolved);
  const stat = await fs.stat(resolved); await fs.access(resolved, constants.X_OK);
  if (!stat.isFile()) throw new Error('Encoder/probe must resolve to a regular executable');
  return {path: full, resolved, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs};
};
const pinExecutable = async executable => {
  if (await fs.realpath(executable.path) !== executable.resolved) throw new Error('Executable alias changed after authorization');
  const stat = await fs.stat(executable.resolved);
  if (!stat.isFile() || stat.dev !== executable.dev || stat.ino !== executable.ino || stat.size !== executable.size || stat.mtimeMs !== executable.mtimeMs)
    throw new Error('Executable changed after authorization');
};
const sanitizedEnv = () => {
  const env = {...process.env};
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'FFREPORT']) delete env[name];
  return env;
};
const kill = child => {
  if (!child?.pid) return;
  try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') child.kill('SIGKILL');}
  try {child.kill('SIGKILL');} catch {}
};
const register = (session, child) => {
  let processes = active.get(session); if (!processes) {processes = new Set(); active.set(session, processes);}
  processes.add(child); session.workers?.add(child);
  return () => {processes.delete(child); session.workers?.delete(child);};
};
const remainingMS = deadline => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Recording exceeded the 30-second wall-clock deadline');
  return remaining;
};
const processGuard = (child, deadline, fail) => {
  const timeout = setTimeout(() => fail(new Error('Recording subprocess exceeded the 30-second wall-clock deadline')), Math.max(1, deadline - Date.now()));
  const memory = setInterval(() => {
    // RSS is process-group aggregate, including descendants of explicit native
    // encoders. Native allocations do not fit inside V8's heap-size limit.
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,rss='], {encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024});
    if (result.error || result.status !== 0) return fail(new Error('Unable to verify subprocess RSS; fail-closed'));
    let rss = 0;
    for (const line of result.stdout.split('\n')) {
      const fields = line.trim().split(/\s+/).map(Number);
      if (fields.length === 3 && fields[1] === child.pid) rss += fields[2] * 1024;
    }
    if (rss > LIMITS.rssBytes) fail(new Error(`Recording subprocess group exceeds 512 MiB RSS (${Math.ceil(rss / 1024 / 1024)} MiB, pid ${child.pid}, ${path.basename(child.spawnfile)})`));
  }, 250);
  return () => {clearTimeout(timeout); clearInterval(memory);};
};
const runProcess = async (session, executable, args, deadline, maxBytes = 2 * 1024 * 1024) => {
  await pinExecutable(executable); remainingMS(deadline);
  return new Promise((resolve, reject) => {
    const child = spawn(executable.resolved, args, {shell: false, detached: true, env: sanitizedEnv(), stdio: ['ignore', 'pipe', 'pipe']});
    const unregister = register(session, child); let error, stdoutBytes = 0, stderrBytes = 0;
    const stdout = [], stderr = [];
    const fail = failure => {if (!error) error = failure; kill(child);};
    const clearGuard = processGuard(child, deadline, fail);
    child.stdout.on('data', chunk => {stdoutBytes += chunk.length; if (stdoutBytes > maxBytes) fail(new Error('Encoder/probe stdout exceeds its byte limit')); else stdout.push(chunk);});
    child.stderr.on('data', chunk => {stderrBytes += chunk.length; if (stderrBytes > maxBytes) fail(new Error('Encoder/probe stderr exceeds its byte limit')); else stderr.push(chunk);});
    child.once('error', fail);
    child.once('close', (code, signal) => {
      clearGuard(); unregister();
      if (error) reject(error);
      else if (code !== 0) reject(new Error(`Encoder/probe exited (${code ?? signal}): ${Buffer.concat(stderr).toString('utf8').slice(-3000)}`));
      else resolve({stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});
    });
  });
};
const runWorker = (session, data, deadline) => new Promise((resolve, reject) => {
  remainingMS(deadline);
  const child = fork(path.join(__dirname, 'record-worker.js'), [], {execPath: process.execPath,
    execArgv: ['--max-old-space-size=128', '--expose-gc'], detached: true,
    env: {...sanitizedEnv(), DISABLE_SYSTEM_FONTS_LOAD: '1'}, serialization: 'json', stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const unregister = register(session, child); let error, result, stderr = '', lastMemory, memorySamples = 0;
  const fail = failure => {
    if (!error) {
      if (lastMemory) failure.message += `; last phase ${lastMemory.phase}, RSS ${Math.ceil(lastMemory.rssBytes / 1048576)} MiB, native peak ${Math.ceil(lastMemory.peakRSSBytes / 1048576)} MiB`;
      error = failure;
    }
    kill(child);
  };
  const clearGuard = processGuard(child, deadline, fail);
  child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-4000);});
  child.once('error', fail);
  child.on('message', message => {
    if (message?.protocol === PROTOCOL && message.event === 'memory') {
      try {
        policy.assertData(message.data);
        if (++memorySamples > 80 || typeof message.data.phase !== 'string' || message.data.phase.length > 80 ||
          !['rssBytes', 'peakRSSBytes'].every(key => Number.isSafeInteger(message.data[key]) && message.data[key] >= 0))
          throw new Error('Invalid bounded memory phase trace');
        lastMemory = message.data;
        if (lastMemory.peakRSSBytes > LIMITS.rssBytes) throw new Error('Recording native RSS phase exceeds 512 MiB');
      } catch (failure) {fail(failure);}
      return;
    }
    if (!message || message.protocol !== PROTOCOL || typeof message.ok !== 'boolean') return fail(new Error('Invalid recording IPC protocol'));
    if (!message.ok) fail(new Error(message.error || 'Recording worker failed'));
    else result = message.result;
  });
  child.once('close', (code, signal) => {
    clearGuard(); unregister();
    if (error) reject(error);
    else if (code !== 0 || !result) reject(new Error(`Recording worker exited (${code ?? signal}): ${stderr}`));
    else resolve(result);
  });
  child.send(data, failure => {if (failure) fail(failure);});
});
const readTracks = async (access, options) => {
  const descriptions = [];
  if (options.soundfiles) {
    const bytes = await policy.readFile(access.policy, options.soundfiles, {explicit: true, maxBytes: 64 * 1024});
    const mapping = policy.parseJSON(bytes.toString('utf8'));
    if (!mapping || mapping.version !== 1 || !Array.isArray(mapping.tracks) || Object.keys(mapping).some(key => !['version', 'tracks'].includes(key)))
      throw new Error('soundfiles must be {version:1,tracks:[{file,role,start,offset,length?,gain}]}');
    for (const track of mapping.tracks) descriptions.push({track, explicit: false});
  }
  if (options['audio-track']) descriptions.push({track: {file: options['audio-track'], role: 'external'}, explicit: true});
  if (options['mic-track']) descriptions.push({track: {file: options['mic-track'], role: 'microphone'}, explicit: true});
  if (descriptions.length > LIMITS.tracks) throw new Error('At most 16 pre-recorded soundfiles');
  let total = 0; const tracks = [];
  for (const {track, explicit} of descriptions) {
    policy.assertData(track);
    if (!track || typeof track !== 'object' || Array.isArray(track) || Object.keys(track).some(key => !['file', 'role', 'start', 'offset', 'length', 'gain'].includes(key))) throw new Error('Unknown typed soundfiles track field');
    if (typeof track.file !== 'string') throw new Error('soundfiles track needs filename');
    // A JSON filename only authorizes the mapping itself, not anything named
    // inside it. Nested paths are resolved relative to that explicit mapping.
    const filename = path.isAbsolute(track.file) ? policy.assertLocalPath(track.file) :
      explicit ? policy.assertLocalPath(track.file) : path.join(path.dirname(policy.assertLocalPath(options.soundfiles)), track.file);
    policy.assertLocalPath(track.file);
    if (!['external', 'microphone'].includes(track.role ?? 'external')) throw new Error('Track role must be external/microphone');
    for (const key of ['start', 'offset', 'length', 'gain']) {
      const value = track[key]; if (value === undefined) continue;
      const maximum = key === 'gain' ? 4 : 30;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || key === 'length' && value === 0)
        throw new Error(`soundfiles ${key} must be a finite typed JSON number in ${key === 'length' ? '(0' : '[0'}..${maximum}]`);
    }
    const bytes = await policy.readFile(access.policy, filename, {explicit, maxBytes: LIMITS.audioBytes});
    inspectWave(bytes); total += bytes.length;
    if (total > LIMITS.audioBytes) throw new Error('Combined pre-recorded soundfiles exceed 16 MiB');
    tracks.push({file: filename, role: track.role ?? 'external', start: track.start ?? 0, offset: track.offset ?? 0,
      ...(track.length === undefined ? {} : {length: track.length}), gain: track.gain ?? 1,
      base64: bytes.toString('base64'), sha256: sha256(bytes)});
  }
  return tracks;
};
const verifyDirectory = async (directory, expectedProjectHash, deadline) => {
  await policy.safePath(directory, {directory: true});
  const readBounded = async (filename, maxBytes) => {
    remainingMS(deadline);
    await policy.safePath(filename);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Recording output file exceeds its byte limit');
    const bytes = await readLocalFile(filename, maxBytes);
    return bytes;
  };
  const manifestBytes = await readBounded(path.join(directory, 'manifest.json'), 2 * 1024 * 1024);
  if (manifestBytes.length > 2 * 1024 * 1024) throw new Error('Record manifest exceeds 2 MiB');
  const manifest = policy.parseJSON(manifestBytes.toString('utf8'));
  if (!manifest.complete || manifest.protocol !== PROTOCOL || !manifest.noDOM || manifest.sourceProjectSha256 !== expectedProjectHash ||
    !Array.isArray(manifest.frames) || !manifest.frames.length || manifest.frames.length > LIMITS.frames || manifest.timing.frameCount !== manifest.frames.length)
    throw new Error('Recording manifest verification failed');
  if (!manifest.memory || manifest.memory.hostFontDiscovery !== false || manifest.memory.canvasBootstrapFontFamilies !== 0 ||
    !Number.isSafeInteger(manifest.memory.peakRSSBytes) || manifest.memory.peakRSSBytes > LIMITS.rssBytes ||
    !Array.isArray(manifest.memory.phases) || manifest.memory.phases.length > 80 || manifest.memory.phases.at(-1)?.phase !== 'disposed')
    throw new Error('Recording native memory/cleanup verification failed');
  const names = new Set(['manifest.json', ...(manifest.audio ? ['audio.wav'] : [])]); let total = 0;
  for (const [index, frame] of manifest.frames.entries()) {
    remainingMS(deadline);
    const expectedName = `frame-${String(index).padStart(6, '0')}.png`;
    if (frame.file !== expectedName || frame.index !== index) throw new Error('Invalid PNG frame manifest order');
    const filename = path.join(directory, expectedName); await policy.safePath(filename);
    const bytes = await readBounded(filename, LIMITS.pngBytes); total += bytes.length;
    if (total > LIMITS.outputBytes) throw new Error('Recording output exceeds 256 MiB');
    const verified = await validatePNG(bytes, manifest.dimensions);
    if (verified.sha256 !== frame.sha256 || verified.pixelsSha256 !== frame.pixelsSha256 || verified.bytes !== frame.bytes) throw new Error('PNG bytes/pixels manifest verification failed');
    names.add(expectedName);
  }
  if (manifest.audio) {
    const bytes = await readBounded(path.join(directory, 'audio.wav'), LIMITS.audioBytes), wave = inspectWave(bytes);
    if (sha256(bytes) !== manifest.audio.sha256 || wave.samples !== manifest.audio.samples || wave.sampleRate !== 44100 || wave.channels !== 2)
      throw new Error('Output WAV sample/hash verification failed');
    total += bytes.length;
  }
  if (total !== manifest.outputBytes || total > LIMITS.outputBytes) throw new Error('Recording output byte count differs from manifest');
  for (const filename of await fs.readdir(directory)) if (!names.has(filename)) throw new Error('Unexpected recording output file');
  return manifest;
};
const probeMedia = async (session, probe, filename, manifest, format, deadline) => {
  const {stdout} = await runProcess(session, probe, ['-v', 'error', '-protocol_whitelist', 'file', '-count_frames',
    '-show_streams', '-show_format', '-of', 'json', filename], deadline);
  const data = policy.parseJSON(stdout.toString('utf8'));
  const videos = data.streams?.filter(stream => stream.codec_type === 'video') || [], audios = data.streams?.filter(stream => stream.codec_type === 'audio') || [];
  if (videos.length !== 1 || audios.length !== (manifest.audio ? 1 : 0)) throw new Error('ffprobe did not verify the expected video/audio streams');
  const video = videos[0], expectedCodec = format === 'mp4' ? 'h264' : 'vp9', duration = Number(data.format?.duration);
  const [numerator, denominator] = String(video.avg_frame_rate).split('/').map(Number), fps = numerator / denominator;
  if (video.codec_name !== expectedCodec || video.width !== manifest.dimensions.width || video.height !== manifest.dimensions.height ||
    Number(video.nb_read_frames) !== manifest.timing.frameCount || Math.abs(fps - manifest.timing.fps) > 1e-6 ||
    !Number.isFinite(duration) || Math.abs(duration - manifest.timing.duration) > Math.max(1 / fps, 0.06)) throw new Error('ffprobe video codec/dimensions/frame-count/duration verification failed');
  let audio = null;
  if (manifest.audio) {
    const stream = audios[0], codec = format === 'mp4' ? 'aac' : 'opus';
    if (stream.codec_name !== codec || Number(stream.channels) !== 2 || ![44100, 48000].includes(Number(stream.sample_rate))) throw new Error('ffprobe audio codec/sample metadata verification failed');
    audio = {codec: stream.codec_name, channels: Number(stream.channels), sampleRate: Number(stream.sample_rate), frames: Number(stream.nb_read_frames)};
  }
  return {video: {codec: video.codec_name, width: video.width, height: video.height, frameCount: Number(video.nb_read_frames), fps}, audio, duration};
};
const encodeMedia = async (session, encoder, probe, directory, manifest, format, deadline) => {
  if (manifest.dimensions.width % 2 || manifest.dimensions.height % 2) throw new Error('Encoded yuv420p requires even recording dimensions; use frames for an odd stage size');
  const version = await runProcess(session, encoder, ['-version'], deadline, 256 * 1024);
  if (!/^ffmpeg version /m.test(version.stdout.toString('utf8'))) throw new Error('Authorized encoder did not identify itself as ffmpeg');
  const probeVersion = await runProcess(session, probe, ['-version'], deadline, 256 * 1024);
  if (!/^ffprobe version /m.test(probeVersion.stdout.toString('utf8'))) throw new Error('Authorized probe did not identify itself as ffprobe');
  const filename = `recording.${format}`, full = path.join(directory, filename);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', '-filter_threads', '1',
    '-protocol_whitelist', 'file', '-framerate', String(manifest.timing.fps), '-start_number', '0', '-i', path.join(directory, 'frame-%06d.png')];
  if (manifest.audio) args.push('-threads', '1', '-protocol_whitelist', 'file', '-i', path.join(directory, 'audio.wav'));
  args.push('-map', '0:v:0'); if (manifest.audio) args.push('-map', '1:a:0');
  args.push('-frames:v', String(manifest.timing.frameCount), '-t', String(manifest.timing.duration), '-pix_fmt', 'yuv420p',
    '-c:v', format === 'mp4' ? 'libx264' : 'libvpx-vp9', '-threads', '1');
  if (format === 'mp4') args.push('-preset', 'ultrafast', '-crf', '18', '-movflags', '+faststart');
  else args.push('-deadline', 'realtime', '-cpu-used', '8', '-crf', '24', '-b:v', '0', '-row-mt', '0');
  if (manifest.audio) args.push('-c:a', format === 'mp4' ? 'aac' : 'libopus', '-b:a', '128k'); else args.push('-an');
  args.push('-fs', String(LIMITS.outputBytes), '-f', format === 'mp4' ? 'mp4' : 'webm', full);
  await runProcess(session, encoder, args, deadline);
  await policy.safePath(full); const stat = await fs.stat(full);
  if (!stat.size || stat.size > LIMITS.outputBytes) throw new Error('Encoded output size verification failed');
  const verified = await probeMedia(session, probe, full, manifest, format, deadline);
  if (manifest.audio) {
    // Verification includes real decoded digital samples, not just a nominal
    // audio stream. Decode to a bounded private raw file, then measure PCM RMS.
    const raw = path.join(directory, '.verify-audio.pcm');
    try {
      await runProcess(session, encoder, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1',
        '-protocol_whitelist', 'file', '-i', full, '-map', '0:a:0', '-t', String(manifest.timing.duration),
        '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 's16le', '-fs', String(LIMITS.audioBytes), raw], deadline);
      const bytes = await readLocalFile(raw, LIMITS.audioBytes);
      if (!bytes.length || bytes.length % 4 || bytes.length > LIMITS.audioBytes || Math.abs(bytes.length / 4 - manifest.audio.samples) > 2048)
        throw new Error('Encoded audio decoded sample count verification failed');
      let squares = 0, nonzero = 0;
      for (let i = 0; i < bytes.length; i += 2) {const value = bytes.readInt16LE(i) / 32768; squares += value * value; if (value) nonzero++;}
      const rms = Math.sqrt(squares / (bytes.length / 2));
      if (manifest.audio.rms > 0.0001 && (rms < manifest.audio.rms * 0.5 || rms > manifest.audio.rms * 1.8 || !nonzero)) throw new Error('Encoded audio is silent or digitally inconsistent with the pre-recorded mix');
      verified.audio.decoded = {samples: bytes.length / 4, rms, nonZeroSamples: nonzero};
    } finally {await fs.unlink(raw).catch(error => {if (error.code !== 'ENOENT') throw error;});}
  }
  return {file: filename, bytes: stat.size, sha256: sha256(await readLocalFile(full, LIMITS.outputBytes)), encoder: encoder.path, probe: probe.path,
    encoderResolved: encoder.resolved, probeResolved: probe.resolved, ffprobe: verified};
};
const execute = async (session, command, args, options = {}) => {
  policy.validateInvocation(specs, command, args, options);
  if (command !== 'record' || !Object.hasOwn(specs.record, args[0])) throw new Error('Unknown record action');
  const deadline = Date.now() + LIMITS.wallMS;
  const access = accessFor(session, options, `record ${args[0]}`);
  if (args[0] === 'capabilities') {
    const result = capabilities();
    if (options.output) result.output = await policy.writeFile(access.policy, options.output, Buffer.from(JSON.stringify(result, null, 2) + '\n'), {explicit: true});
    return result;
  }
  if (!session.project?.vm) throw new Error('Open a project before recording its independent runtime copy');
  if (args[1] && options.output) throw new Error('Use a directory filename or --output, not both');
  const output = args[1] || options.output;
  if (!output) throw new Error('record start requires an explicit output directory filename (--output or positional); never automatic downloads');
  const directory = policy.assertLocalPath(output), config = configFor(options), format = options.format ?? 'frames';
  if (!['frames', 'mp4', 'webm'].includes(format)) throw new Error('--format must be frames/mp4/webm');
  if (format === 'frames' && (options.encoder || options.probe)) throw new Error('frames does not execute encoders; remove --encoder/--probe');
  let encoder, probe;
  if (format !== 'frames') {
    encoder = await authorizeExecutable(session, access, 'encoder', options.encoder ?? DEFAULT_ENCODER);
    probe = await authorizeExecutable(session, access, 'probe', options.probe ?? DEFAULT_PROBE);
  }
  const tracks = await readTracks(access, options);
  if (config.microphonemix && !tracks.some(track => track.role === 'microphone')) throw new Error('--microphonemix true requires --mic-track filename or a microphone role in --soundfiles; live mic denied');
  if (!config.microphonemix && tracks.some(track => track.role === 'microphone')) throw new Error('Pre-recorded microphone replacement requires --microphonemix true');
  // Source WAV headers supply exact sample durations; a provably empty audio
  // window must fail before native decode, Project.load, directory or child.
  assertTrackOverlap(tracks, config);
  const bytes = await session.project.bytes();
  if (bytes.length > LIMITS.projectBytes) throw new Error('Record runtime copy exceeds the 32 MiB project limit');
  const inputs = adapters.validateBatch(session.inputs || []), hash = sha256(bytes);
  // Reserve exactly the explicit new directory. Its generated frames/manifest
  // are the declared outputs, not authority over existing unrelated files.
  access.policy.require('write', directory, {explicit: true});
  await policy.safePath(path.dirname(directory), {directory: true});
  let owned = false;
  try {
    await fs.mkdir(directory, {mode: 0o700}); owned = true;
    await runWorker(session, {protocol: PROTOCOL, project: bytes.toString('base64'), projectSha256: hash,
      config: Object.fromEntries(['duration', 'delay', 'fps', 'waitflag', 'flagFrame', 'stopOnStop', 'stopFrame', 'projectaudio', 'microphonemix', 'answer', 'seed']
        .filter(key => config[key] !== undefined).map(key => [key, config[key]])), inputs, tracks, directory}, deadline);
    const manifest = await verifyDirectory(directory, hash, deadline);
    // Hold the success marker until the optional encoder and all verifiers
    // finish; a partially encoded directory must not advertise completion.
    await fs.unlink(path.join(directory, 'manifest.json'));
    if (encoder) manifest.encoded = await encodeMedia(session, encoder, probe, directory, manifest, format, deadline);
    manifest.format = format;
    manifest.authorization = {outputDirectory: directory, executablePolicy: 'exact per-command grants; pinned realpath; no shell; not an OS sandbox',
      tracks: tracks.map(({file, role, sha256: digest}) => ({file, role, sha256: digest}))};
    remainingMS(deadline);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    return {directory, manifest: path.join(directory, 'manifest.json'), format, frames: manifest.timing.frameCount,
      duration: manifest.timing.duration, stopReason: manifest.timing.stopReason, noDOM: manifest.noDOM,
      projectChanged: false, audio: manifest.audio, memory: manifest.memory, ...(manifest.encoded ? {encoded: {...manifest.encoded, path: path.join(directory, manifest.encoded.file)}} : {}),
      warnings: ['GUI defaults differ: duration=1 (GUI=30), projectaudio=false (GUI=true). Whole-project audio is NOT_YET_SUPPORTED.',
        'Frozen source/digital output tests are not a real GUI MediaRecorder differential. OS capture is denied.']};
  } catch (error) {
    if (owned) await fs.rm(directory, {recursive: true, force: true});
    throw error;
  }
};
const dispose = session => {
  for (const child of active.get(session) || []) kill(child);
  active.delete(session);
};
module.exports = {specs, requiresProject, isReadOnly, execute, dispose, usesProjectTarget: false,
  capabilities, configFor, accessFor, authorizeExecutable, runProcess, runWorker, verifyDirectory, probeMedia,
  DEFAULT_ENCODER, DEFAULT_PROBE, LIMITS};
