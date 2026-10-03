const {RuntimeController} = require('./runtime-controller');
const {normalizeInput} = require('./device-adapters');

const specs = require('./command-catalog').moduleSpecs['runtime-commands.js'];
const booleanOptions = ['paused', 'no-compile'];
const requiresProject = (command, args) => command === 'runtime' && args[0] === 'start';
const integer = (value, name, min, max) => {
  const number = typeof value === 'number' ? value : Number(value);
  if (value === '' || value === undefined || !Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return number;
};
const action = (args, allowed, fallback) => {
  const selected = args[0] ?? fallback;
  if (!allowed.includes(selected)) throw new Error(`Use ${allowed.join('/')}`);
  return selected;
};
const count = (args, expected, name) => {if (args.length !== expected) throw new Error(`Invalid arguments for runtime ${name}`);};
const inputEvent = (session, args, options) => {
  const device = args[0]; let event;
  if (device.startsWith('{')) {count(args, 1, 'input'); try {event = JSON.parse(device);} catch {throw new Error('Input must be a JSON event');}}
  else if (device === 'key') {
    count(args, 3, 'input key'); if (!['down', 'up'].includes(args[2])) throw new Error('Key state must be down/up');
    event = {device: 'keyboard', data: {key: args[1], isDown: args[2] === 'down'}};
  } else if (device === 'mouse') {
    if (args.length < 3 || args.length > 4) throw new Error('Use runtime input mouse X Y [down/up]');
    if (args[3] !== undefined && !['down', 'up'].includes(args[3])) throw new Error('Mouse state must be down/up');
    const x = Number(args[1]), y = Number(args[2]);
    if (args[1] === '' || args[2] === '' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Mouse coordinates must be finite numbers');
    const runtime = session.runtimeController.lastStatus;
    const width = runtime.stage?.width ?? session.project?.vm?.runtime.stageWidth ?? 480;
    const height = runtime.stage?.height ?? session.project?.vm?.runtime.stageHeight ?? 360;
    event = {device: 'mouse', data: {x: x + width / 2, y: height / 2 - y, canvasWidth: width, canvasHeight: height}};
    if (args[3] !== undefined) event.data.isDown = args[3] === 'down';
  } else if (device === 'wheel') {
    count(args, 3, 'input wheel'); event = {device: 'mouseWheel', data: {deltaX: Number(args[1]), deltaY: Number(args[2])}};
  } else if (device === 'username') {count(args, 2, 'input username'); event = {device: 'userData', data: {username: args[1]}};}
  else throw new Error('Use runtime input key/mouse/wheel/username or a validated JSON event');
  if (options.button !== undefined) {
    if (event.device !== 'mouse') throw new Error('--button is only valid for mouse input');
    event.data.button = integer(options.button, 'mouse button', 0, 2);
  }
  if (options.frame !== undefined) {
    if (event.frame !== undefined) throw new Error('Use JSON frame or --frame, not both');
    event.frame = integer(options.frame, 'input frame', 0, 99999);
  }
  // A missing frame is assigned by the worker when this serial command arrives;
  // a cached controller status may already be behind a running frame.
  const normalized = normalizeInput(event);
  if (event.frame === undefined) delete normalized.frame;
  return normalized;
};

const preflight = (session, command, args, options = {}) => {
  if (command !== 'runtime' || args[0] !== 'start') return;
  count(args.slice(1), 0, 'start');
  if (session.runtimeController && !session.runtimeController.closed) throw new Error('Runtime already exists; runtime stop before starting another copy');
  if (options.compile && options['no-compile']) throw new Error('Use --compile or --no-compile, not both');
  for (const key of ['compile', 'no-compile', 'turbo', 'paused']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`--${key} must be boolean`);
  if (options.fps !== undefined) integer(options.fps, 'fps', 1, 240);
  if (options.seed !== undefined) integer(options.seed, 'seed', 0, 0xffffffff);
  if (options.trace !== undefined) {
    integer(options.trace, 'trace capacity', 1, 10000);
    const compiled = options['no-compile'] ? false : options.compile ?? (options.project ? false : session.runtimeSettings?.compiler) ?? false;
    if (compiled) throw new Error('Block trace requires interpreter mode (start without --compile)');
  }
  if (options['max-frames'] !== undefined) integer(options['max-frames'], 'max frames', 1, 100000);
  if (options.lifetime !== undefined) integer(options.lifetime, 'lifetime seconds', 1, 3600);
  if (options.answer !== undefined && (typeof options.answer !== 'string' || options.answer.length > 10000)) throw new Error('answer must be text (max 10000 characters)');
  for (const key of ['watch', 'target']) if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key] || options[key].length > 256)) throw new Error(`Invalid --${key} selector`);
  if (options.target !== undefined && options.watch === undefined) throw new Error('runtime start --target requires --watch');
};

const execute = async (session, command, args, options = {}) => {
  preflight(session, command, args, options);
  if (command !== 'runtime') throw new Error(`Unknown runtime command ${command}`);
  const [name, ...rest] = args;
  if (name === 'start') {
    count(rest, 0, 'start');
    if (!session.project?.vm) throw new Error('Open a project before runtime start');
    if (options.compile && options['no-compile']) throw new Error('Use --compile or --no-compile, not both');
    const prior = session.runtimeController;
    if (prior && !prior.closed) throw new Error('Runtime already exists; runtime stop before starting another copy');
    const settings = Object.fromEntries(['compiler', 'warpTimer', 'volume'].filter(key => session.runtimeSettings?.[key] !== undefined)
      .map(key => [key, session.runtimeSettings[key]]));
    const payload = {
      fps: options.fps === undefined ? session.project.vm.runtime.frameLoop.framerate : integer(options.fps, 'fps', 1, 240),
      compile: options['no-compile'] ? false : options.compile ?? settings.compiler ?? false,
      turbo: options.turbo ?? session.project.vm.runtime.turboMode,
      paused: !!options.paused, runtimeSettings: settings, inputs: session.inputs || [], cloudFile: session.project.cloudFile
    };
    if (options.seed !== undefined) payload.seed = integer(options.seed, 'seed', 0, 0xffffffff);
    if (options.watch !== undefined) {payload.watch = options.watch; payload.target = options.target;}
    else if (options.target !== undefined) throw new Error('runtime start --target requires --watch');
    if (options.trace !== undefined) payload.traceLimit = integer(options.trace, 'trace capacity', 1, 10000);
    if (options['max-frames'] !== undefined) payload.maxFrames = integer(options['max-frames'], 'max frames', 1, 100000);
    if (options.lifetime !== undefined) payload.lifetimeMS = integer(options.lifetime, 'lifetime seconds', 1, 3600) * 1000;
    if (options.answer !== undefined) payload.answer = options.answer;
    const bytes = await session.project.bytes();
    const controller = new RuntimeController(); session.runtimeController = controller;
    try {return await controller.start(bytes, payload);} catch (error) {controller.dispose(); throw error;}
  }
  const controller = session.runtimeController;
  if (name === 'stop') {count(rest, 0, 'stop'); return controller ? controller.stop() : {state: 'stopped'};}
  if (name === 'status' && (!controller || controller.closed)) {count(rest, 0, 'status'); return controller?.lastStatus || {state: 'not-started'};}
  if (!controller || controller.closed) throw new Error('No persistent runtime; runtime start first');
  if (['pause', 'resume', 'status', 'clones'].includes(name)) {count(rest, 0, name); return controller.request(name);}
  if (name === 'step') {
    if (rest.length > 1) throw new Error('Use runtime step [count] or --frames N');
    const data = {};
    if (rest.length) data.count = integer(rest[0], 'block steps', 1, 10000);
    if (options.frames !== undefined) data.frames = integer(options.frames, 'frame steps', 1, 10000);
    if (options.thread !== undefined) data.threadId = options.thread;
    return controller.request('step', data);
  }
  if (name === 'input') return controller.request('input', {event: inputEvent(session, rest, options)});
  if (name === 'answer') {
    count(rest, 1, 'answer'); const data = {text: rest[0]};
    if (options.frame !== undefined) data.frame = integer(options.frame, 'answer frame', 0, 99999);
    if (options.question !== undefined) data.questionId = integer(options.question, 'question ID', 1, Number.MAX_SAFE_INTEGER);
    return controller.request('answer', data);
  }
  if (name === 'watch') {
    const selected = action(rest, ['add', 'remove', 'list', 'samples', 'clear'], 'list');
    count(rest, ['add', 'remove'].includes(selected) ? 2 : rest.length ? 1 : 0, 'watch');
    const data = {action: selected};
    if (['add', 'remove'].includes(selected)) {data.selector = rest[1]; if (options.target !== undefined) data.target = options.target;}
    else if (options.target !== undefined) throw new Error('--target is only valid for watch add/remove');
    if (options.limit !== undefined) data.limit = integer(options.limit, 'watch sample limit', 1, 10000);
    return controller.request('watch', data);
  }
  if (name === 'trace') {
    const selected = action(rest, ['on', 'off', 'get', 'events', 'clear'], 'get'); count(rest, rest.length ? 1 : 0, 'trace');
    const data = {action: selected};
    if (options.limit !== undefined) data.limit = integer(options.limit, 'trace limit', 1, 10000);
    if (options.since !== undefined) data.since = integer(options.since, 'trace sequence', 0, Number.MAX_SAFE_INTEGER);
    return controller.request('trace', data);
  }
  if (name === 'breakpoint') {
    const selected = action(rest, ['add', 'remove', 'list', 'hits', 'clear'], 'list');
    count(rest, ['add', 'remove'].includes(selected) ? 2 : rest.length ? 1 : 0, 'breakpoint');
    const data = {action: selected};
    if (['add', 'remove'].includes(selected)) {data.blockId = rest[1]; if (options.target !== undefined) data.target = options.target;}
    else if (options.target !== undefined) throw new Error('--target is only valid for breakpoint add/remove');
    if (options.limit !== undefined) data.limit = integer(options.limit, 'hit log limit', 1, 10000);
    if (options.since !== undefined) data.since = integer(options.since, 'hit sequence', 0, Number.MAX_SAFE_INTEGER);
    return controller.request('breakpoint', data);
  }
  throw new Error(`Unknown runtime action ${name}`);
};
const dispose = session => {session.runtimeController?.dispose();};

module.exports = {specs, booleanOptions, requiresProject, mutates: false, preflight, execute, dispose};
