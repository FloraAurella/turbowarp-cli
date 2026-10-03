const adapters = require('./device-adapters');
const specs = require('./command-catalog').moduleSpecs['device-commands.js'];
const inputActions = new Set(['video-frame', 'loudness', 'gamepad', 'key', 'mouse', 'wheel', 'user-data', 'cloud']);
const requiresProject = (command, args) => inputActions.has(args[0]);
// Recording is queue-only. Applying even a frame-0 cloud/key/mouse event to the
// editor would mutate serialized variables or start hats without a transaction.
const isReadOnly = () => true;
const numeric = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value))) throw new Error(`${label} must be a finite number`);
  return Number(value);
};
const parseData = bytes => {
  if (Buffer.byteLength(bytes) > adapters.LIMITS.jsonBytes) throw new Error('Input JSON exceeds the 64 KiB limit');
  let parsed;
  try {parsed = JSON.parse(bytes.toString('utf8'));} catch {throw new Error('Expected data-only JSON, not executable code');}
  return parsed;
};
const needVM = session => {
  if (!session.project?.vm) throw new Error('Open a project before injecting device data');
  return session.project.vm;
};
const frameOf = options => options.frame === undefined ? 0 : numeric(options.frame, 'frame');
const summary = event => {
  const {base64, ...data} = event.data;
  if (base64) data.bytes = Buffer.byteLength(base64, 'base64');
  return {frame: event.frame ?? 0, device: event.device, data};
};
const exportJSON = async (options, value) => options.output ?
  adapters.writeOutput(options.output, Buffer.from(JSON.stringify(value, null, 2) + '\n'), options.force) : undefined;
const exportEvents = async (options, events) => options.output ?
  adapters.writeOutput(options.output, Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')), options.force) : undefined;
const enqueue = async (session, events, options) => {
  const vm = needVM(session), normalized = adapters.validateBatch(events);
  const queue = [...(session.inputs || []), ...normalized];
  // Validate the complete cumulative queue, including cloud bindings and native
  // media decoding, without installing a provider or executing any editor IO.
  await adapters.validateRecordedInputs(vm, queue);
  const output = await exportEvents(options, normalized);
  session.inputs ||= [];
  session.inputs.push(...normalized);
  return {queued: normalized.length, queueLength: session.inputs.length, events: normalized.map(summary),
    appliedToEditor: false, timing: 'runtime-copy-only; frame is 0-based and applies before its runtime step', ...(output ? {output} : {})};
};
const execute = async (session, command, args, options = {}) => {
  if (command !== 'device' || !Object.hasOwn(specs.device, args[0])) throw new Error('Unknown device command/action');
  const [action, source, extra, buttonState] = args;
  if (options.out !== undefined) throw new Error('Device inputs are transient; use --output for data or save --out project.sb3 for the project');
  if (action === 'capabilities') {
    const result = adapters.capabilities(), output = await exportJSON(options, result);
    return {...result, ...(output ? {output} : {})};
  }
  if (action === 'permissions') {
    const result = {...adapters.capabilities().policy}, output = await exportJSON(options, result);
    return {...result, ...(output ? {output} : {})};
  }
  if (action === 'permission') {
    if (!Object.hasOwn(adapters.PERMISSIONS, source)) throw new Error('Unknown device permission');
    if (extra !== 'deny') throw new Error('Permission escalation is denied; this CLI does not enable live device/network access');
    return {resource: source, permission: 'deny', default: 'deny'};
  }
  if (['camera', 'microphone', 'scan', 'connect'].includes(action))
    throw new Error('Live camera/microphone, real BLE/BT/HID and network are denied; use recorded input/socket-mock. Realdevice acceptance is limited, manual-not-run');
  if (action === 'input-list') {
    const events = adapters.validateBatch(session.inputs || []), output = await exportEvents(options, events);
    return {events: events.map(summary), count: events.length, automaticEnumeration: false, ...(output ? {output} : {})};
  }
  if (action === 'socket-mock') {
    const result = await adapters.runSocketMock(session.project?.vm, source || 'BLE'), output = await exportJSON(options, result);
    return {...result, ...(output ? {output} : {})};
  }
  if (action === 'replay') {
    const events = adapters.parseJSONL(await adapters.readSource(source, adapters.LIMITS.replayBytes, session.deviceInputStream));
    if (options['validate-only']) {
      // Decode media without attaching providers, starting timers, or executing blocks.
      await adapters.validateRecordedInputs(session.project?.vm, events);
      const output = await exportEvents(options, events);
      return {validated: events.length, firstFrame: events[0].frame, lastFrame: events.at(-1).frame, executed: false,
        cloudBinding: session.project?.vm ? 'checked' : 'requires-project-on-injection', ...(output ? {output} : {})};
    }
    return enqueue(session, events, options);
  }
  const vm = needVM(session), frame = frameOf(options); let device, data;
  if (action === 'video-frame') {
    const bytes = await adapters.readSource(source, adapters.LIMITS.frameBytes, session.deviceInputStream);
    const {format} = adapters.inspectImage(bytes); device = 'video'; data = {format, base64: bytes.toString('base64')};
    if (options.mirror !== undefined) {
      if (!['true', 'false'].includes(options.mirror)) throw new Error('--mirror must be true/false');
      data.mirror = options.mirror === 'true';
    }
  } else if (action === 'loudness') {
    device = 'loudness';
    if (/^\d+(?:\.\d+)?$/.test(source)) {
      if (['format', 'sample-rate', 'channels'].some(name => options[name] !== undefined)) throw new Error('Fixed loudness values do not take PCM format options');
      data = {value: numeric(source, 'loudness')};
    } else {
      const bytes = await adapters.readSource(source, adapters.LIMITS.audioBytes, session.deviceInputStream);
      data = {format: options.format || 'wav', base64: bytes.toString('base64')};
      if (options['sample-rate'] !== undefined) data.sampleRate = numeric(options['sample-rate'], 'sample-rate');
      if (options.channels !== undefined) data.channels = numeric(options.channels, 'channels');
    }
  } else if (action === 'gamepad') {
    device = 'gamepad';
    data = parseData(source.trim().startsWith('{') ? Buffer.from(source) :
      await adapters.readSource(source, adapters.LIMITS.jsonBytes, session.deviceInputStream));
  } else if (action === 'key') {
    if (!['down', 'up'].includes(extra)) throw new Error('Key state must be down/up');
    device = 'keyboard'; data = {key: source, isDown: extra === 'down'};
  } else if (action === 'mouse') {
    if (buttonState !== undefined && !['down', 'up'].includes(buttonState)) throw new Error('Mouse state must be down/up');
    device = 'mouse'; data = {x: numeric(source, 'mouse x') + vm.runtime.stageWidth / 2,
      y: vm.runtime.stageHeight / 2 - numeric(extra, 'mouse y'), canvasWidth: vm.runtime.stageWidth, canvasHeight: vm.runtime.stageHeight};
    if (buttonState !== undefined) data.isDown = buttonState === 'down';
    if (options.button !== undefined) data.button = numeric(options.button, 'button');
  } else if (action === 'wheel') {device = 'mouseWheel'; data = {deltaY: numeric(source, 'deltaY'), deltaX: extra === undefined ? 0 : numeric(extra, 'deltaX')};}
  else if (action === 'user-data') {device = 'userData'; data = {username: source};}
  else if (action === 'cloud') {
    device = 'cloud'; let value;
    try {value = JSON.parse(extra);} catch {value = extra;}
    data = {varUpdate: {name: source, value}};
  }
  return enqueue(session, [{frame, device, data}], options);
};
// Capture only bounded JSON data, never VM/native handles or input streams.
// CommandSession also snapshots inputs; this hook preserves the module contract
// for direct capture/restore and validates media/controller records synchronously.
const captureState = session => {
  const inputs = session.inputs || []; adapters.validateBatch(inputs);
  return {version: 1, inputs: structuredClone(inputs)};
};
const restoreState = (session, state) => {
  if (state === undefined) return; // The core has already cleared/restored inputs on open/new.
  if (!state || state.version !== 1 || Object.keys(state).some(key => !['version', 'inputs'].includes(key)))
    throw new Error('Invalid transient device state');
  adapters.validateBatch(state.inputs);
  // Both snapshots describe the same queue. Preserve exact legacy shapes (e.g.
  // a missing frame), rather than canonicalizing a rollback into different data.
  // No restored event is applied to either editor VM.
  session.inputs = structuredClone(state.inputs);
};
const dispose = session => {session.inputs = [];}; // No editor provider/listener/native handles are owned.
module.exports = {specs, requiresProject, isReadOnly, execute, captureState, restoreState, dispose, booleanOptions: ['validate-only']};
