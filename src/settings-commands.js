const {atomicWrite} = require('./project');
const schema = {
  fps: {type: 'number', min: 1, max: 240, persisted: true},
  turbo: {type: 'boolean', persisted: true},
  interpolation: {type: 'boolean', persisted: true},
  fencing: {type: 'boolean', persisted: true},
  miscLimits: {type: 'boolean', persisted: true},
  maxClones: {type: 'integer', min: 0, max: 100000, persisted: true},
  highQuality: {type: 'boolean', persisted: true},
  highQualityPen: {type: 'boolean', persisted: true, alias: 'highQuality'},
  width: {type: 'integer', min: 1, max: 4096, persisted: true},
  height: {type: 'integer', min: 1, max: 4096, persisted: true},
  username: {type: 'string', maxLength: 256, persisted: false},
  volume: {type: 'number', min: 0, max: 100, persisted: false},
  compiler: {type: 'boolean', persisted: false},
  warpTimer: {type: 'boolean', persisted: false}
};
const specs = require('./command-catalog').moduleSpecs['settings-commands.js'];
const parse = (key, input) => {
  if (!Object.hasOwn(schema, key)) throw new Error(`Unknown setting ${key}`);
  const rule = schema[key];
  if (rule.type === 'boolean') {
    if (!['true', 'false', 'on', 'off'].includes(input)) throw new Error(`${key} must be true/false or on/off`);
    return input === 'true' || input === 'on';
  }
  if (rule.type === 'string') {
    if (input.length > rule.maxLength) throw new Error(`${key} is too long`);
    return input;
  }
  const number = Number(input);
  if (input === '' || !Number.isFinite(number) || rule.type === 'integer' && !Number.isInteger(number) ||
    number < rule.min || number > rule.max) throw new Error(`${key} must be ${rule.type} in ${rule.min}..${rule.max}`);
  return number;
};
const values = session => {
  const {vm, renderer, audio} = session.project;
  const runtime = vm.runtime;
  return {fps: runtime.frameLoop.framerate, turbo: runtime.turboMode, interpolation: runtime.interpolationEnabled,
    ...runtime.runtimeOptions, highQuality: renderer.useHighQualityRender,
    highQualityPen: renderer.useHighQualityRender,
    width: runtime.stageWidth, height: runtime.stageHeight,
    username: runtime.ioDevices.userData.getUsername(), volume: audio.inputNode.gain.value * 100,
    compiler: session.runtimeSettings?.compiler ?? false, warpTimer: session.runtimeSettings?.warpTimer ?? false};
};
const size = (session, width, height) => {
  if (width * height > 16000000) throw new Error('Stage exceeds 16-million-pixel limit');
  const {vm, renderer} = session.project;
  vm.setStageSize(width, height);
  renderer.resize(width, height);
  vm.storeProjectOptions();
  return {width, height};
};
const set = (session, key, value) => {
  const {vm, renderer, audio} = session.project;
  if (key === 'fps') vm.setFramerate(value);
  else if (key === 'turbo') vm.setTurboMode(value);
  else if (key === 'interpolation') vm.setInterpolation(value);
  else if (['fencing', 'miscLimits', 'maxClones'].includes(key)) vm.setRuntimeOptions({[key]: value});
  else if (key === 'highQuality') renderer.setUseHighQualityRender(value);
  else if (key === 'highQualityPen') renderer.setUseHighQualityRender(value);
  else if (key === 'width' || key === 'height') return size(session, key === 'width' ? value : vm.runtime.stageWidth, key === 'height' ? value : vm.runtime.stageHeight);
  else if (key === 'username') {
    const data = {username: value}; vm.postIOData('userData', data);
    session.inputs = session.inputs.filter(input => input.device !== 'userData');
    session.inputs.push({frame: 0, device: 'userData', data});
  } else if (key === 'volume') {
    audio.inputNode.gain.value = value / 100;
    session.runtimeSettings = {...session.runtimeSettings, volume: value};
  } else session.runtimeSettings = {...session.runtimeSettings, [key]: value};
  if (schema[key].persisted) vm.storeProjectOptions();
  return {key, value, persisted: schema[key].persisted};
};
const execute = async (session, command, args, options) => {
  const [action, key, input] = args;
  if (action === 'schema') return {schema};
  if (action === 'list') return {values: values(session), schema};
  if (action === 'get') {
    if (!Object.hasOwn(schema, key)) throw new Error(`Unknown setting ${key}`);
    return {key, value: values(session)[key], persisted: schema[key].persisted};
  }
  if (action === 'set') return set(session, key, parse(key, input));
  if (action === 'size') return size(session, parse('width', key), parse('height', input));
  if (action === 'store') {session.project.vm.storeProjectOptions(); return {stored: true};}
  if (action === 'reset') {
    const {vm, renderer} = session.project;
    vm.setFramerate(30); vm.setTurboMode(false); vm.setInterpolation(false);
    vm.setRuntimeOptions({fencing: true, miscLimits: true, maxClones: 300});
    renderer.setUseHighQualityRender(false);
    session.runtimeSettings = {}; set(session, 'username', ''); set(session, 'volume', 100);
    size(session, 480, 360); return {values: values(session)};
  }
  if (action === 'export') return atomicWrite(key, Buffer.from(JSON.stringify(values(session), null, 2)), options.force);
  throw new Error('Unknown settings action');
};
module.exports = {specs, requiresProject: (command, args) => args[0] !== 'schema',
  isReadOnly: (command, args) => ['list', 'schema', 'get', 'export'].includes(args[0]), execute};
