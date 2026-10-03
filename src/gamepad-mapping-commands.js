'use strict';
const crypto = require('node:crypto');
const policy = require('./permission-policy');
const adapters = require('./device-adapters');
const {resourceError} = require('./errors');

const GAMEPAD_CONFIG_MAGIC = ' // _gamepad_';
const HEADER = 'Gamepad configuration';
const MAX = Object.freeze({buttons: 32, axes: 16, controllers: 4, jsonBytes: 64 * 1024});
const states = new WeakMap();
const specs = require('./command-catalog').moduleSpecs['gamepad-mapping-commands.js'];
const number = (value, name, min, max, integral = false) => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || integral && !Number.isInteger(n))
    throw new Error(`${name} must be ${integral ? 'an integer' : 'finite'} in ${min}..${max}`);
  return n;
};
const boolean = (value, name) => {
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true/false`);
  return value === 'true';
};
const object = (value, fields, name) => {
  policy.assertData(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a plain typed JSON object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`Unknown ${name} field ${key}`);
  return value;
};
const keyValue = value => {
  if (value === null || value === '' || value === undefined) return value === undefined ? '' : value;
  if (typeof value !== 'string') throw new Error('Mapping key must be a KeyboardEvent.key string or null');
  // Keep the frozen GUI KeyboardEvent.key spelling; aliases are not exported.
  const normalized = adapters.normalizeKey(value);
  if (normalized !== value) throw new Error(`Use KeyboardEvent.key ${JSON.stringify(normalized)}, not ${JSON.stringify(value)}`);
  return value;
};
const cursorValue = value => {
  if (value === null || value === '' || value === undefined) return value === undefined ? '' : value;
  if (!['+x', '-x', '+y', '-y'].includes(value)) throw new Error('Cursor direction must be +x/-x/+y/-y or null');
  return value;
};
const dataNumber = (value, name, min, max, integral = false) => {
  if (typeof value !== 'number') throw new Error(`${name} must be a typed JSON number`);
  return number(value, name, min, max, integral);
};
const normalizeMappingEntry = (value, isAxis = false) => {
  object(value, ['type', 'high', 'low', 'deadZone', 'button', 'sensitivity'], 'mapping');
  if (typeof isAxis !== 'boolean') throw new Error('isAxis must be boolean');
  const deadZone = value.deadZone === undefined ? 0.5 : dataNumber(value.deadZone, 'deadZone', 0, 1);
  if (value.type === 'key') {
    if (value.button !== undefined || value.sensitivity !== undefined) throw new Error('key mapping has mouse-only fields');
    return {type: 'key', high: keyValue(value.high), low: isAxis ? keyValue(value.low) : null, deadZone};
  }
  if (value.type === 'mousedown') {
    if (value.high !== undefined || value.low !== undefined || value.sensitivity !== undefined) throw new Error('mousedown mapping has key/cursor-only fields');
    return {type: 'mousedown', button: value.button === undefined ? 0 : dataNumber(value.button, 'mouse button', 0, 2, true), deadZone};
  }
  if (value.type === 'virtual_cursor') {
    if (value.button !== undefined) throw new Error('virtual_cursor mapping has mouse-button field');
    if (deadZone === 1) throw new Error('Cursor deadZone must be below 1');
    return {type: 'virtual_cursor', high: cursorValue(value.high), low: isAxis ? cursorValue(value.low) : null,
      sensitivity: value.sensitivity === undefined ? 10 : dataNumber(value.sensitivity, 'sensitivity', 0, 100), deadZone};
  }
  throw new Error('Mapping type must be key/mousedown/virtual_cursor (no executable JS)');
};
const validateMapping = value => {
  object(value, ['buttons', 'axes'], 'gamepad mapping');
  for (const [name, limit] of [['buttons', MAX.buttons], ['axes', MAX.axes]])
    if (!Array.isArray(value[name]) || value[name].length > limit) throw new Error(`Mapping ${name} must be an array of at most ${limit} entries`);
  const result = {
    axes: value.axes.map(entry => normalizeMappingEntry(entry, true)),
    buttons: value.buttons.map(entry => {
      const normalized = normalizeMappingEntry(entry, false);
      // Frozen editor.export deliberately omits these fields for buttons.
      delete normalized.low; delete normalized.deadZone; return normalized;
    })
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX.jsonBytes) throw new Error('Mapping exceeds 64 KiB');
  return result;
};
const findOptionsComment = vm => Object.values(vm?.runtime.getTargetForStage()?.comments || {})
  .find(comment => typeof comment.text === 'string' && comment.text.includes(GAMEPAD_CONFIG_MAGIC)) || null;
const parseOptionsComment = vm => {
  const comment = findOptionsComment(vm);
  if (!comment) return {comment: null, mapping: null, error: null};
  const line = comment.text.split('\n').find(value => value.endsWith(GAMEPAD_CONFIG_MAGIC));
  if (!line) return {comment, mapping: null, error: 'Gamepad comment does not contain valid magic suffix line'};
  try {
    if (Buffer.byteLength(line) > MAX.jsonBytes) throw new Error('Gamepad comment exceeds 64 KiB');
    const mapping = validateMapping(policy.parseJSON(line.slice(0, -GAMEPAD_CONFIG_MAGIC.length)));
    return {comment, mapping, error: null};
  } catch (error) {return {comment, mapping: null, error: `Invalid gamepad comment: ${error.message}`};}
};
const usedKeys = vm => {
  const keys = new Set();
  // The frozen script includes the stage twice; Set ordering still stays stable.
  for (const target of [vm.runtime.getTargetForStage(), ...vm.runtime.targets].filter(target => target.isOriginal)) {
    for (const block of Object.values(target.blocks._blocks)) {
      if (!['event_whenkeypressed', 'sensing_keyoptions'].includes(block.opcode) || block.opcode === 'sensing_keyoptions' && !block.parent) continue;
      const raw = block.fields.KEY_OPTION?.value;
      if (typeof raw !== 'string') continue;
      const special = {'right arrow': 'ArrowRight', 'up arrow': 'ArrowUp', 'left arrow': 'ArrowLeft', 'down arrow': 'ArrowDown', enter: 'Enter', space: ' '};
      keys.add(special[raw] || raw.toLowerCase().charAt(0));
    }
  }
  return keys;
};
const emptyEntry = () => ({type: 'key', high: null, low: null});
const pad = (entries, length) => Array.from({length}, (_, index) => structuredClone(entries[index] || emptyEntry()));
const generateMapping = (vm, buttons = 16, axes = 4, imported = null, empty = false) => {
  if (empty) return validateMapping({buttons: pad([], buttons), axes: pad([], axes)});
  if (imported) return validateMapping({buttons: pad(imported.buttons, buttons), axes: pad(imported.axes, axes)});
  const keys = usedKeys(vm), arrows = ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft'].some(key => keys.has(key));
  const wasd = keys.has('w') && keys.has('s') || keys.has('a') && keys.has('d');
  const used = new Set(wasd ? ['w', 'a', 's', 'd'] : []), pause = ['p', 'q', 'r'];
  const actionKeys = [' ', 'Enter', 'e', 'f', 'z', 'x', 'c', ...[...keys].filter(key => key.length === 1 && !pause.includes(key))];
  const find = list => {for (const key of list) if (keys.has(key) && !used.has(key)) {used.add(key); return key;} return null;};
  const action = [arrows && keys.has('ArrowUp') ? 'ArrowUp' : wasd && keys.has('w') ? 'w' : find(actionKeys), find(actionKeys), find(actionKeys), find(actionKeys)];
  if (action[0] && !action[1] && !action[2] && !action[3]) action.fill(action[0]);
  if (action[0] && action[1] && !action[2] && !action[3]) {action[2] = action[0]; action[3] = action[1];}
  const b = action.map(high => ({type: 'key', high}));
  for (let i = 4; i < 8; i++) b[i] = {type: 'mousedown'};
  b[9] = {type: 'key', high: find(pause)}; b[8] = {type: 'key', high: find(pause)};
  b[10] = emptyEntry(); b[11] = emptyEntry();
  ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].forEach((key, i) => {b[12 + i] = {type: 'key', high: arrows || !wasd ? key : ['w', 's', 'a', 'd'][i]};});
  const cursor = [{type: 'virtual_cursor', high: '+x', low: '-x', sensitivity: 0.6, deadZone: 0.2},
    {type: 'virtual_cursor', high: '-y', low: '+y', sensitivity: 0.6, deadZone: 0.2}];
  const movement = (high, low) => ({type: 'key', high, low, deadZone: 0.5});
  const firstAxes = wasd ? [movement('d', 'a'), movement('s', 'w')] : arrows ?
    [movement('ArrowRight', 'ArrowLeft'), movement('ArrowDown', 'ArrowUp')] : cursor;
  return validateMapping({buttons: pad(b, buttons), axes: pad(axes === 4 ? [...firstAxes, ...cursor] : [], axes)});
};
const requireVM = session => {
  if (!session.project?.vm) throw new Error('Open a project before editing gamepad mappings');
  return session.project.vm;
};
const initialState = session => {
  const vm = requireVM(session), parsed = parseOptionsComment(vm);
  const state = {controllers: [], selected: null, store: false};
  const events = adapters.validateBatch(session.inputs || []).sort((a, b) => a.frame - b.frame);
  // Controller metadata comes solely from explicitly queued recorded input, never OS discovery.
  for (const event of events) {
    if (event.device !== 'gamepad') continue;
    const data = event.data, index = data.index ?? 0;
    if (data.connected === false) {state.controllers = state.controllers.filter(controller => controller.index !== index); continue;}
    const controller = {id: data.id || `recorded-pad-${index}`, index,
      mapping: generateMapping(vm, data.buttons.length, data.axes.length, parsed.mapping)};
    const old = state.controllers.findIndex(item => item.index === index);
    if (old < 0) state.controllers.push(controller); else state.controllers[old] = controller;
  }
  for (const event of events) {
    if (event.device !== 'gamepad-mapping') continue;
    const controller = state.controllers.find(item => item.index === event.data.index);
    if (controller) controller.mapping = validateMapping(event.data.mapping);
  }
  state.selected = state.controllers[0]?.index ?? null;
  return state;
};
const stateFor = session => {
  const vm = requireVM(session), current = states.get(session);
  return current?.vm === vm ? current.state : initialState(session);
};
const resolveController = (state, selector) => {
  if (selector === undefined) selector = state.selected;
  const matches = state.controllers.filter(controller => controller.id === selector || String(controller.index) === String(selector));
  if (matches.length !== 1) throw resourceError(matches.length, 'Controller not found or ambiguous; create or select a recorded controller first', selector);
  return matches[0];
};
const storeMappings = (vm, mapping) => {
  const stage = vm.runtime.getTargetForStage(), existing = findOptionsComment(vm);
  const text = `${HEADER}\n${JSON.stringify(validateMapping(mapping))}${GAMEPAD_CONFIG_MAGIC}`;
  if (existing) existing.text = text;
  else stage.createComment(crypto.randomUUID(), null, text, 50, 50, 350, 150, false);
  vm.runtime.emitProjectChanged(); if (vm.editingTarget === stage) vm.emitWorkspaceUpdate();
};
const mappingEvent = (controller, frame = 0) => ({frame, device: 'gamepad-mapping',
  data: {index: controller.index, id: controller.id, mapping: validateMapping(controller.mapping)}});
const prepareQueue = async (session, controllers, frame) => {
  const vm = requireVM(session), indices = new Set(controllers.map(item => item.index));
  const old = (session.inputs || []).filter(event => !(event.device === 'gamepad-mapping' && event.frame === frame && indices.has(event.data.index)));
  const events = controllers.map(controller => mappingEvent(controller, frame));
  const queue = adapters.validateBatch([...old, ...events]);
  await adapters.validateRecordedInputs(vm, events);
  return queue;
};
const captureState = session => {
  const current = states.get(session);
  return current?.vm === session.project?.vm ? structuredClone(current.state) : undefined;
};
const restoreState = (session, value) => {
  if (value === undefined || !session.project?.vm) {states.delete(session); return;}
  policy.assertData(value);
  states.set(session, {vm: session.project.vm, state: structuredClone(value)});
};
const requiresProject = () => true;
const isReadOnly = (command, args, options = {}, session) => {
  if (['show', 'export'].includes(args[0])) return true;
  if (!session?.project?.vm) return args[0] !== 'store';
  if (args[0] === 'store') return args[1] === 'false' && !findOptionsComment(session.project.vm);
  // Reset intentionally unchecks storage, without deleting the old frozen comment.
  if (args[0] === 'reset') return true;
  return !stateFor(session).store;
};
const execute = async (session, command, args, options = {}) => {
  policy.validateInvocation(specs, command, args, options);
  if (command !== 'gamepad' || !Object.hasOwn(specs.gamepad, args[0])) throw new Error('Unknown gamepad mapping action');
  const [action, source, json] = args, vm = requireVM(session);
  policy.assertData(options);
  const access = policy.createPolicy(session, options, `gamepad ${action}`);
  const current = stateFor(session), next = structuredClone(current), parsed = parseOptionsComment(vm);
  if (action === 'show') {
    const selected = options.target !== undefined ? resolveController(current, options.target) : current.controllers.find(item => item.index === current.selected);
    const result = {mode: 'recorded-data-only', selected: selected?.id ?? null, selectedIndex: selected?.index ?? null,
      storeInProject: current.store, controllers: current.controllers, storedMapping: parsed.mapping,
      commentId: parsed.comment?.id ?? null, commentError: parsed.error, physicalEnumeration: false,
      realGUI: 'not-run; frozen source/parser comparison only'};
    if (options.output) result.output = await policy.writeFile(access, options.output, Buffer.from(JSON.stringify(result, null, 2) + '\n'), {explicit: true, force: options.force});
    return structuredClone(result);
  }
  if (action === 'export') {
    if (source && options.output) throw new Error('Use filename or --output, not both');
    const filename = source || options.output, controller = resolveController(current, options.target), mapping = validateMapping(controller.mapping);
    const output = filename ? await policy.writeFile(access, filename, Buffer.from(JSON.stringify(mapping, null, 2) + '\n'), {explicit: true, force: options.force}) : undefined;
    return {mapping, controller: controller.id, ...(output ? {output} : {})};
  }
  let changedControllers = [], commentWrite = false, commentRemove = false;
  const frame = number(options.frame ?? '0', 'frame', 0, adapters.LIMITS.frame, true);
  if (action === 'create') {
    const available = [0, 1, 2, 3].find(index => !next.controllers.some(controller => controller.index === index));
    const index = number(options.index ?? String(available ?? 4), 'controller index', 0, 3, true);
    const id = source || `recorded-pad-${index}`;
    if (!id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Invalid controller ID');
    if (next.controllers.some(item => item.index === index || item.id === id)) throw new Error('Controller ID/index already exists');
    const buttons = number(options.buttons ?? '16', 'buttons', 0, MAX.buttons, true), axes = number(options.axes ?? '4', 'axes', 0, MAX.axes, true);
    const controller = {id, index, mapping: generateMapping(vm, buttons, axes, parsed.mapping, options.empty === undefined ? false : boolean(options.empty, '--empty'))};
    next.controllers.push(controller); next.selected ??= index; changedControllers = [controller];
    commentWrite = next.store;
  } else if (action === 'select-controller') {
    next.selected = resolveController(next, source).index; commentWrite = next.store;
  } else if (action === 'store') {
    next.store = boolean(source, 'store');
    if (next.store) {resolveController(next); commentWrite = true;} else commentRemove = !!parsed.comment;
  } else if (action === 'reset') {
    const selected = options.target === undefined ? next.controllers : [resolveController(next, options.target)];
    if (!selected.length) throw new Error('No recorded controller to reset');
    for (const controller of selected) controller.mapping = generateMapping(vm, controller.mapping.buttons.length, controller.mapping.axes.length,
      parsed.mapping, options.empty === undefined ? false : boolean(options.empty, '--empty'));
    changedControllers = selected; next.store = false;
  } else {
    const controller = resolveController(next, options.target);
    if (action === 'import') {
      const bytes = source.trim().startsWith('{') ? Buffer.from(source) : await policy.readFile(access, source, {explicit: true, maxBytes: MAX.jsonBytes});
      if (bytes.length > MAX.jsonBytes) throw new Error('Mapping exceeds 64 KiB');
      const imported = validateMapping(policy.parseJSON(bytes.toString('utf8')));
      controller.mapping = generateMapping(vm, controller.mapping.buttons.length, controller.mapping.axes.length, imported);
    } else {
      const name = action === 'set-button' ? 'buttons' : 'axes', axis = name === 'axes';
      const index = number(source, `${name} index`, 0, controller.mapping[name].length - 1, true);
      const entry = policy.parseJSON(json);
      // Buttons cannot persist thresholds: frozen export intentionally drops them.
      if (!axis && (entry.low !== undefined || entry.deadZone !== undefined)) throw new Error('Button low/deadZone are omitted by frozen export; configure axis thresholds instead');
      controller.mapping[name][index] = normalizeMappingEntry(entry, axis);
      controller.mapping = validateMapping(controller.mapping);
    }
    changedControllers = [controller]; commentWrite = next.store;
  }
  if (action === 'store' && next.store || action === 'select-controller') {
    // A freshly loaded project may have a selected metadata controller but no
    // queued override yet; store/select must prepare its canonical mapping too.
    const controller = resolveController(next);
    if (!changedControllers.includes(controller)) changedControllers.push(controller);
  }
  // Validate the entire candidate before touching input queues/comments/session state.
  const queue = changedControllers.length ? await prepareQueue(session, changedControllers, frame) : null;
  const selected = next.controllers.find(item => item.index === next.selected);
  if (commentWrite && selected) storeMappings(vm, selected.mapping);
  if (commentRemove) {
    delete vm.runtime.getTargetForStage().comments[parsed.comment.id];
    vm.runtime.emitProjectChanged(); if (vm.editingTarget.isStage) vm.emitWorkspaceUpdate();
  }
  if (queue) session.inputs = queue;
  states.set(session, {vm, state: next});
  return {action, controller: selected?.id ?? null, selectedIndex: next.selected, storeInProject: next.store,
    projectChanged: commentWrite || commentRemove, queuedMappingEvents: changedControllers.length,
    mapping: selected ? validateMapping(selected.mapping) : null,
    realdevice: 'recorded data only; HID/OS capture denied'};
};
const dispose = session => {states.delete(session);};
module.exports = {specs, requiresProject, isReadOnly, execute, usesProjectTarget: false, captureState, restoreState, dispose,
  GAMEPAD_CONFIG_MAGIC, MAX, validateMapping, normalizeMappingEntry, findOptionsComment, parseOptionsComment, generateMapping, mappingEvent};
