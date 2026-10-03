'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {atomicWrite, readLocalFile, rejectPrototypeKeys} = require('./project');
const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;
const mutationAdapter = require('scratch-vm/src/engine/mutation-adapter');

const specs = require('./command-catalog').moduleSpecs['block-commands.js'];
const booleanOptions = ['single', 'heal', 'shadows'];
const readActions = new Set(['schema', 'list', 'inspect', 'count', 'find', 'copy', 'export', 'field-menu']);
const {CommandError, resourceError} = require('./errors');
const clone = value => JSON.parse(JSON.stringify(value));
const uid = () => crypto.randomUUID();
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};
const jsonObject = (value, label) => object(typeof value === 'string' ? JSON.parse(value) : value, label);
const number = (value, label = 'Coordinate') => {
  if (value === undefined || value === '' || !Number.isFinite(Number(value))) throw new Error(`${label} must be finite`);
  return Number(value);
};
const bool = value => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('Expected true/false');
};
const coordinate = (value, fallback) => {
  if (value === undefined) return fallback;
  const parts = String(value).split(',');
  if (parts.length !== 2) throw new Error('Position must be x,y');
  return {x: number(parts[0]), y: number(parts[1])};
};
const mode = options => {
  if (options.single && options.mode && options.mode !== 'single') throw new Error('Conflicting --single and --mode');
  const result = options.single ? 'single' : options.mode || 'stack';
  if (!['single', 'stack'].includes(result)) throw new Error('Mode must be stack/single');
  return result;
};
const newBlock = (opcode, extra = {}) => ({id: uid(), opcode, inputs: {}, fields: {}, next: null,
  parent: null, shadow: false, topLevel: true, x: 0, y: 0, ...extra});

// Read frozen declarations as data. No require/eval of Blockly (nor of addon JS).
// Only argument/connection declarations are extracted; renderers and callbacks never run.
const {frozenSchemas} = require('./block-schema');

const schema = (block, runtime) => {
  if (block.opcode === 'procedures_call' || block.opcode === 'procedures_prototype') {
    const mutation = validateMutation(block.mutation, block.opcode);
    const ids = JSON.parse(mutation.argumentids);
    const types = [...mutation.proccode.matchAll(/%([sb])/g)].map(item => item[1]);
    return {shape: block.opcode === 'procedures_prototype' ? 'prototype' : mutation.return === '2' ? 'boolean' : mutation.return === '1' ? 'value' : 'statement',
      fields: {}, inputs: Object.fromEntries(ids.map((id, index) => [id, block.opcode === 'procedures_prototype' ? 'argument' : types[index] === 'b' ? 'boolean' : 'value']))};
  }
  if (block.opcode === 'procedures_definition') return {shape: 'hat', fields: {}, inputs: {custom_block: 'prototype'}};
  const core = frozenSchemas().get(block.opcode);
  if (core) return {...core, shape: block.opcode === 'control_stop' && block.mutation?.hasnext === 'true' ? 'statement' : core.shape};
  const approved = block.opcode.startsWith('pen_') || block.opcode.startsWith('music_');
  const definition = approved && runtime?.getBlocksJSON().find(item => item.type === block.opcode);
  if (!definition) throw new Error(`Unknown/unloaded opcode or unavailable input shape: ${block.opcode}`);
  const inputs = {}, fields = {};
  for (const key of Object.keys(definition).filter(key => /^args\d+$/.test(key))) {
    for (const arg of definition[key]) {
      if (arg.type === 'input_value') inputs[arg.name] = arg.check === 'Boolean' ? 'boolean' : 'value';
      else if (arg.type === 'input_statement') inputs[arg.name] = 'statement';
      else if (arg.name && arg.type.startsWith('field_')) fields[arg.name] = {type: arg.type, choices: Array.isArray(arg.options) ? arg.options.map(item => item[1]) : []};
    }
  }
  return {inputs, fields, shape: definition.output === 'Boolean' ? 'boolean' : Object.hasOwn(definition, 'output') ? 'value' :
    Object.hasOwn(definition, 'previousStatement') ? Object.hasOwn(definition, 'nextStatement') ? 'statement' : 'end' : 'hat'};
};
const mutationDOM = (mutation, depth = 0) => {
  if (depth > 32) throw new Error('Mutation nesting exceeds32');
  object(mutation, 'Mutation');
  const attributes = {};
  for (const [key, value] of Object.entries(mutation)) {
    if (key === 'tagName' || key === 'children') continue;
    if (/^blockinfo$/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Dynamic executable/prototype mutation attributes are denied');
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Mutation attribute ${key} must be scalar`);
    // mutationAdapter decodes HTML even for a parsed DOM. Escape once to preserve literal &amp; etc.
    attributes[key] = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  if (mutation.children !== undefined && !Array.isArray(mutation.children)) throw new Error('Mutation children must be an array');
  if (typeof mutation.tagName !== 'string' || !/^[\w-]+$/.test(mutation.tagName)) throw new Error('Mutation requires a valid tagName');
  return {name: mutation.tagName, attribs: attributes, children: (mutation.children || []).map(child => mutationDOM(child, depth + 1))};
};
const validateMutation = (mutation, opcode) => {
  const normalized = mutationAdapter(mutationDOM(mutation));
  if (normalized.tagName !== 'mutation') throw new Error('Root mutation tagName must be mutation');
  if (['procedures_call', 'procedures_prototype'].includes(opcode)) {
    if (typeof normalized.proccode !== 'string' || !normalized.proccode.trim()) throw new Error('Procedure mutation requires proccode');
    let ids;
    try {ids = JSON.parse(normalized.argumentids);} catch {throw new Error('Procedure mutation argumentids must be JSON');}
    const placeholders = [...normalized.proccode.matchAll(/%([sb])/g)];
    if (!Array.isArray(ids) || ids.length !== placeholders.length || ids.length > 128 || ids.some(id => typeof id !== 'string' || !id || ['__proto__', 'constructor', 'prototype'].includes(id)) || new Set(ids).size !== ids.length) {
      throw new Error('Procedure argumentids do not match signature');
    }
    for (const key of ['argumentnames', 'argumentdefaults']) {
      if (normalized[key] !== undefined) {
        let list;
        try {list = JSON.parse(normalized[key]);} catch {throw new Error(`${key} must be JSON`);}
        if (!Array.isArray(list) || list.length !== ids.length) throw new Error(`${key} does not match signature`);
      } else if (opcode === 'procedures_prototype') throw new Error(`Procedure prototype requires ${key}`);
    }
    if (normalized.warp !== undefined && !['true', 'false'].includes(normalized.warp)) throw new Error('Mutation warp must be true/false');
    if (normalized.return !== undefined && !['0', '1', '2'].includes(normalized.return)) throw new Error('Mutation return must be 0/1/2');
  }
  return normalized;
};
const edges = block => [...new Set([block.next, ...Object.values(block.inputs).flatMap(input => [input.block, input.shadow])].filter(Boolean))];
const graphOf = target => new Map(Object.values(target.blocks._blocks).map(block => [block.id, clone(block)]));
const get = (graph, id) => {
  const block = graph.get(id);
  if (!block) throw new Error(`Block not found: ${id}`);
  return block;
};
const checkConnection = (parent, child, input, runtime) => {
  const from = schema(parent, runtime), to = schema(child, runtime);
  if (input === undefined) {
    if (!['hat', 'statement'].includes(from.shape) || !['statement', 'end'].includes(to.shape)) throw new Error('Incompatible next/previous block shape');
  } else {
    const type = from.inputs[input];
    if (!type) throw new Error(`Input ${input} does not exist on ${parent.opcode}`);
    if (type === 'statement' ? !['statement', 'end'].includes(to.shape) : type === 'boolean' ? to.shape !== 'boolean' :
      type === 'prototype' ? child.opcode !== 'procedures_prototype' : type === 'argument' ? !child.opcode.startsWith('argument_reporter_') : !['value', 'boolean'].includes(to.shape)) {
      throw new Error(`Incompatible input shape for ${parent.opcode}.${input}: ${to.shape}`);
    }
  }
};
const validateGraph = (graph, runtime, shapes = true) => {
  if (graph.size > 100000) throw new Error('Block graph exceeds 100000 blocks');
  const incoming = new Map();
  for (const [id, block] of graph) {
    if (typeof id !== 'string' || !id || ['__proto__', 'constructor', 'prototype'].includes(id) || block.id !== id || typeof block.opcode !== 'string') throw new Error('Invalid block identity/opcode');
    object(block.inputs, 'Block inputs'); object(block.fields, 'Block fields');
    if (typeof block.shadow !== 'boolean' || typeof block.topLevel !== 'boolean') throw new Error(`Invalid shadow/topLevel for ${id}`);
    if (block.next === undefined || block.parent === undefined) throw new Error(`Block ${id} requires parent/next (null if absent)`);
    if (block.mutation) validateMutation(block.mutation, block.opcode);
    const info = shapes ? schema(block, runtime) : null;
    for (const [name, field] of Object.entries(block.fields)) if (!field || field.name !== name || !['string', 'number', 'boolean'].includes(typeof field.value)) throw new Error(`Invalid field descriptor ${id}.${name}`);
    if (info) {
      for (const name of Object.keys(block.inputs)) if (!Object.hasOwn(info.inputs, name)) throw new Error(`Input ${name} does not exist on ${block.opcode}`);
      for (const name of Object.keys(block.fields)) if (!Object.hasOwn(info.fields, name)) throw new Error(`Field ${name} does not exist on ${block.opcode}`);
    }
    const own = (childId, input) => {
      if (childId === null || childId === undefined) return;
      const child = get(graph, childId);
      if (child.parent !== id || child.topLevel) throw new Error(`Broken parent/topLevel at ${childId}`);
      if (incoming.has(childId) && incoming.get(childId) !== `${id}:${input ?? '<next>'}`) throw new Error(`Multiple owners for block ${childId}`);
      incoming.set(childId, `${id}:${input ?? '<next>'}`);
      if (shapes) checkConnection(block, child, input, runtime);
    };
    own(block.next);
    for (const [name, input] of Object.entries(block.inputs)) {
      object(input, 'Input descriptor');
      if (input.name !== name || input.block === undefined || input.shadow === undefined) throw new Error(`Invalid input descriptor ${id}.${name}`);
      own(input.block, name); own(input.shadow, name);
      if (input.shadow && !get(graph, input.shadow).shadow) throw new Error(`Input shadow is not a shadow: ${input.shadow}`);
      if (input.block && get(graph, input.block).shadow && input.shadow !== input.block) throw new Error(`Shadow descriptor mismatch: ${id}.${name}`);
    }
  }
  if (shapes) {
    const procedures = new Map();
    for (const block of graph.values()) if (block.opcode === 'procedures_definition' &&
      (!block.inputs.custom_block?.block || graph.get(block.inputs.custom_block.block)?.opcode !== 'procedures_prototype')) throw new Error('Procedure definition requires its prototype');
    for (const block of graph.values()) if (block.opcode === 'procedures_prototype') {
      if (!block.shadow || !block.parent || graph.get(block.parent)?.opcode !== 'procedures_definition') throw new Error('Procedure prototype must be a definition shadow');
      if (procedures.has(block.mutation.proccode)) throw new Error(`Duplicate procedure signature: ${block.mutation.proccode}`);
      procedures.set(block.mutation.proccode, block);
    }
    for (const block of graph.values()) if (block.opcode === 'procedures_call') {
      const prototype = procedures.get(block.mutation.proccode);
      if (!prototype || prototype.mutation.argumentids !== block.mutation.argumentids || (prototype.mutation.warp || 'false') !== (block.mutation.warp || 'false')) throw new Error(`Unresolved/mismatched procedure call: ${block.mutation.proccode}`);
    }
  }
  for (const [id, block] of graph) {
    if (block.parent !== null && !incoming.has(id)) throw new Error(`Parent has no connection to ${id}`);
    if (block.parent === null && (!block.topLevel || block.shadow)) throw new Error(`Detached shadow/non-top-level block ${id}`);
    if (block.topLevel && (!Number.isFinite(block.x) || !Number.isFinite(block.y))) throw new Error(`Invalid top-level coordinates: ${id}`);
  }
  const states = new Map();
  for (const id of graph.keys()) {
    if (states.get(id) === 2) continue;
    const work = [[id, false, 0]];
    while (work.length) {
      const [current, exit, depth] = work.pop();
      if (depth > 512) throw new Error('Block nesting exceeds safe VM serialization depth512');
      if (exit) {states.set(current, 2); continue;}
      if (states.get(current) === 1) throw new Error(`Cycle in block graph at ${current}`);
      if (states.get(current) === 2) continue;
      states.set(current, 1); work.push([current, true, depth]);
      for (const child of edges(get(graph, current))) work.push([child, false, depth + 1]);
    }
  }
  return graph;
};
const checkedGraph = (target, runtime, shapes = true) => validateGraph(graphOf(target), runtime, shapes);
const descendants = (graph, id, single = false) => {
  const result = new Set(), work = [id];
  while (work.length) {
    const current = work.pop(); if (result.has(current)) continue;
    result.add(current);
    const block = get(graph, current);
    const children = edges(block).filter(child => !(single && current === id && child === block.next));
    work.push(...children);
  }
  return result;
};
const parentSlot = (graph, block) => {
  if (!block.parent) return null;
  const parent = get(graph, block.parent);
  if (parent.next === block.id) return {parent: parent.id};
  const input = Object.keys(parent.inputs).find(name => parent.inputs[name].block === block.id || parent.inputs[name].shadow === block.id);
  if (!input) throw new Error('Broken parent connection');
  return {parent: parent.id, input};
};
const setSlot = (graph, slot, id) => {
  const parent = get(graph, slot.parent);
  if (slot.input === undefined) parent.next = id;
  else parent.inputs[slot.input].block = id || parent.inputs[slot.input].shadow;
};
const detach = (graph, id, heal = false, single = false) => {
  const block = get(graph, id);
  if (block.shadow) throw new Error('Cannot detach a shadow; edit its owning input instead');
  const slot = parentSlot(graph, block);
  const next = block.next;
  if (single || heal) {
    block.next = null;
    if (next) {
      const child = get(graph, next);
      child.parent = null; child.topLevel = true; child.x = block.x ?? 0; child.y = (block.y ?? 0) + 64;
    }
  }
  if (slot) {
    setSlot(graph, slot, heal ? next : null);
    if (heal && next) {get(graph, next).parent = slot.parent; get(graph, next).topLevel = false;}
  }
  block.parent = null; block.topLevel = true; block.x = block.x ?? 0; block.y = block.y ?? 0;
  return block;
};
const attach = (graph, id, parentId, input, runtime) => {
  const block = get(graph, id), parent = get(graph, parentId);
  if (block.shadow) throw new Error('Cannot move a shadow out of its owning input');
  if (descendants(graph, id).has(parentId)) throw new Error('Connection would create a cycle');
  checkConnection(parent, block, input, runtime);
  const occupied = input === undefined ? parent.next : parent.inputs[input]?.block;
  if (occupied && occupied !== id && !get(graph, occupied).shadow) throw new Error('Connection is occupied; disconnect first');
  detach(graph, id);
  block.parent = parentId; block.topLevel = false;
  if (input === undefined) parent.next = id;
  else parent.inputs[input] = {name: input, block: id, shadow: parent.inputs[input]?.shadow || null};
};
const createViaAPI = (target, blocks) => {
  for (const block of blocks) {
    const copy = clone(block); const mutation = copy.mutation; delete copy.mutation;
    target.blocks.createBlock(copy);
    if (mutation) target.blocks.changeBlock({id: copy.id, element: 'mutation', value: mutationDOM(mutation)});
  }
};
const applyGraph = (target, graph, runtime) => {
  validateGraph(graph, runtime);
  // VM deleteBlock is recursive. Validate before touching it, then delete only roots.
  // createBlock accepts the entire VM block descriptor and maintains scripts/cache/events.
  for (const id of [...target.blocks.getScripts()]) target.blocks.deleteBlock(id);
  createViaAPI(target, [...graph.values()]);
  const kept = new Set([...graph.values()].map(block => block.comment).filter(Boolean));
  for (const comment of Object.values(target.comments)) if (comment.blockId && !kept.has(comment.id)) {
    target.blocks.blocklyListen({type: 'comment_delete', commentId: comment.id});
  }
};
const resourceType = field => ({VARIABLE: '', LIST: 'list', BROADCAST_OPTION: 'broadcast_msg'})[field];
const resource = (target, runtime, selector, type) => {
  const stage = runtime.getTargetForStage();
  const candidates = [...Object.values(target.variables), ...(stage === target ? [] : Object.values(stage.variables))].filter(item => item.type === type);
  const byId = candidates.find(item => item.id === selector);
  if (byId) return byId;
  const byName = candidates.filter(item => item.name === selector);
  if (byName.length !== 1) throw new CommandError(byName.length ? 'RESOURCE_AMBIGUOUS' : 'RESOURCE_NOT_FOUND',
    `Resource not found or ambiguous: ${selector}`, '查询资源列表并使用稳定 ID。', {selector});
  return byName[0];
};
const fieldMenu = (target, block, name, runtime) => {
  const info = schema(block, runtime).fields[name];
  if (!info) throw new Error(`Field ${name} does not exist`);
  const type = resourceType(name);
  if (type !== undefined) {
    const owners = target.isStage ? [target] : [target, runtime.getTargetForStage()];
    return owners.flatMap(owner => Object.values(owner.variables).filter(item => item.type === type).map(item => ({id: item.id, value: item.name, scope: owner.isStage ? 'global' : 'local'})));
  }
  const originals = runtime.targets.filter(item => item.isOriginal);
  if (name === 'COSTUME') return target.getCostumes().map(item => ({id: item.cliId, value: item.name}));
  if (name === 'BACKDROP') return [...runtime.getTargetForStage().getCostumes().map(item => ({id: item.cliId, value: item.name})), ...['next backdrop', 'previous backdrop', 'random backdrop'].map(value => ({value}))];
  if (name === 'SOUND_MENU') return target.getSounds().map(item => ({id: item.cliId, value: item.name}));
  if (name === 'KEY_OPTION') return ['space', 'up arrow', 'down arrow', 'right arrow', 'left arrow', 'any', ...'abcdefghijklmnopqrstuvwxyz0123456789'].map(value => ({value}));
  const spriteMenus = {TO: ['_random_', '_mouse_'], TOWARDS: ['_mouse_'], TOUCHINGOBJECTMENU: ['_mouse_', '_edge_'], DISTANCETOMENU: ['_mouse_'], CLONE_OPTION: ['_myself_'], OBJECT: ['_stage_']};
  if (spriteMenus[name]) return [...spriteMenus[name].map(value => ({value,
    ...(value === '_stage_' ? {id: runtime.getTargetForStage().id} : {})})),
  ...originals.filter(item => !item.isStage && (name === 'OBJECT' || item !== target)).map(item => ({id: item.id, value: item.getName()}))];
  if (name === 'PROPERTY' && block.opcode === 'sensing_of') {
    const menu = block.inputs.OBJECT && target.blocks.getBlock(block.inputs.OBJECT.block);
    const other = menu?.fields.OBJECT.value === '_stage_' ? runtime.getTargetForStage() : originals.find(item => item.getName() === menu?.fields.OBJECT.value);
    if (!other) return (info.choices || []).map(value => ({value}));
    return [...(other.isStage ? ['backdrop #', 'backdrop name', 'volume'] : ['x position', 'y position', 'direction', 'costume #', 'costume name', 'size', 'volume']),
      ...Object.values(other.variables).filter(item => item.type === '').map(item => item.name)].map(value => ({value}));
  }
  return (info.choices || []).map(value => ({value}));
};
const validateField = (target, block, name, value, runtime) => {
  if (value === undefined) throw new Error('Missing field value');
  const info = schema(block, runtime).fields[name];
  if (!info) throw new Error(`Field ${name} does not exist on ${block.opcode}`);
  const type = resourceType(name);
  if (type !== undefined) return resource(target, runtime, value, type).id;
  if (name === 'COLOUR' && !/^#[\da-f]{6}$/i.test(String(value))) throw new Error('Colour must be #rrggbb');
  if (info.type === 'field_number' || info.type === 'field_angle' || name === 'NOTE') {
    const numeric = number(value, name);
    if ((info.min !== undefined && numeric < Number(info.min)) || (info.max !== undefined && numeric > Number(info.max))) throw new Error(`Field ${name} outside range`);
  }
  const menu = fieldMenu(target, block, name, runtime);
  const strictMenu = ['COSTUME', 'BACKDROP', 'SOUND_MENU', 'TO', 'TOWARDS', 'OBJECT', 'CLONE_OPTION', 'TOUCHINGOBJECTMENU', 'DISTANCETOMENU', 'KEY_OPTION', 'PROPERTY'].includes(name);
  if (strictMenu || menu.length) {
    const byId = menu.find(item => item.id !== undefined && item.id === value);
    const matches = byId ? [byId] : menu.filter(item => item.value === value);
    if (matches.length > 1) throw resourceError(matches.length, `Ambiguous menu resource/value for ${name}: ${value}`, value);
    if (!matches.length) throw new Error(`Invalid menu resource/value for ${name}: ${value}`);
    return String(matches[0].value);
  }
  return String(value);
};
const validateResources = (target, graph, runtime) => {
  for (const block of graph.values()) for (const [name, field] of Object.entries(block.fields)) {
    if (resourceType(name) !== undefined) {
      const variable = resource(target, runtime, field.id, resourceType(name));
      if (field.value !== variable.name) throw new Error(`Resource name/id mismatch on ${block.id}.${name}`);
    }
  }
};
const menuInputs = {
  motion_goto: {TO: 'motion_goto_menu'}, motion_glideto: {TO: 'motion_glideto_menu'}, motion_pointtowards: {TOWARDS: 'motion_pointtowards_menu'},
  looks_switchcostumeto: {COSTUME: 'looks_costume'}, looks_switchbackdropto: {BACKDROP: 'looks_backdrops'}, looks_switchbackdroptoandwait: {BACKDROP: 'looks_backdrops'},
  sound_play: {SOUND_MENU: 'sound_sounds_menu'}, sound_playuntildone: {SOUND_MENU: 'sound_sounds_menu'},
  event_broadcast: {BROADCAST_INPUT: 'event_broadcast_menu'}, event_broadcastandwait: {BROADCAST_INPUT: 'event_broadcast_menu'},
  control_create_clone_of: {CLONE_OPTION: 'control_create_clone_of_menu'}, sensing_touchingobject: {TOUCHINGOBJECTMENU: 'sensing_touchingobjectmenu'},
  sensing_distanceto: {DISTANCETOMENU: 'sensing_distancetomenu'}, sensing_keypressed: {KEY_OPTION: 'sensing_keyoptions'}, sensing_of: {OBJECT: 'sensing_of_object_menu'}
};
const menuOpcodes = new Set(Object.values(menuInputs).flatMap(inputs => Object.values(inputs)));
const recipeOpcodeAvailable = (name, runtime) => !!(runtime.getOpcodeFunction(name) || runtime.getIsHat(name) || menuOpcodes.has(name) ||
  ['math_number', 'math_integer', 'math_positive_number', 'math_whole_number', 'math_angle', 'text', 'colour_picker'].includes(name));
const describeSchemas = (opcode, runtime, target) => {
  const candidates = [...new Set([...frozenSchemas().keys(), ...(!runtime ? [] : runtime.getBlocksJSON()
    .filter(item => item.type?.startsWith('pen_') || item.type?.startsWith('music_')).map(item => item.type))])].sort();
  const describe = name => {
    const info = schema({opcode: name}, runtime);
    const inputs = Object.fromEntries(Object.entries(info.inputs).map(([key, type]) => [key,
      {type, menuOpcode: menuInputs[name]?.[key] || null, default: null, defaultKnown: false}]));
    const fields = Object.fromEntries(Object.entries(info.fields).map(([key, value]) => [key,
      {...value, choices: value.choices || [], dynamic: resourceType(key) !== undefined || ['COSTUME', 'BACKDROP', 'SOUND_MENU', 'TO', 'OBJECT', 'PROPERTY', 'CLONE_OPTION'].includes(key),
        ...(target ? {menu: fieldMenu(target, {opcode: name, inputs: {}, fields: {}}, key, runtime)} : {})}]));
    const exampleInputs = {motion_movesteps: {STEPS: 25}, motion_changeyby: {DY: 40}, looks_say: {MESSAGE: 'Hello'},
      control_repeat: {TIMES: 3, SUBSTACK: [{opcode: 'motion_movesteps', inputs: {STEPS: 10}}]},
      operator_add: {NUM1: 1, NUM2: 2}}[name];
    const available = runtime ? recipeOpcodeAvailable(name, runtime) : null;
    return {opcode: name, shape: info.shape, inputs, fields, available,
      recipeSupported: !name.startsWith('procedures_') && !name.startsWith('argument_') && available !== false,
      example: {opcode: name, ...(exampleInputs ? {inputs: exampleInputs} : {}), ...(name === 'event_whenkeypressed' ? {fields: {KEY_OPTION: 'space'}} : {})},
      exampleRequires: Object.keys(info.fields).filter(key => resourceType(key) !== undefined)
        .map(key => ({field: key, reason: '显式提供已有资源名称或稳定 ID'}))};
  };
  if (opcode) {
    if (!candidates.includes(opcode) || opcode.startsWith('procedures_')) throw new CommandError('NOT_SUPPORTED', `Unknown/unloaded opcode or unavailable input shape: ${opcode}`, '使用 blocks schema 查询可用积木；过程使用 proc 命令。', {opcode});
    return {schemaVersion: 1, ...describe(opcode), notes: ['来源为冻结积木声明；动态资源和可执行性需结合项目查询。']};
  }
  return {schemaVersion: 1, blocks: candidates.map(name => {
    if (name.startsWith('procedures_')) return {opcode: name, recipeSupported: false, reason: '使用现有 proc / blocks procedure-* 命令'};
    const info = describe(name); return {opcode: name, shape: info.shape, available: info.available, recipeSupported: info.recipeSupported};
  })};
};
const menuInput = (graph, parent, name, selector, target, runtime) => {
  const opcode = menuInputs[parent.opcode]?.[name];
  if (!opcode) return false;
  const block = newBlock(opcode, {parent: parent.id, topLevel: false, shadow: true});
  const fieldName = Object.keys(schema(block, runtime).fields)[0], menu = fieldMenu(target, block, fieldName, runtime);
  const raw = selector ?? (menu[0]?.id || menu[0]?.value);
  if (raw === undefined) throw new Error(`Input ${parent.opcode}.${name} requires an available menu resource`);
  const value = validateField(target, block, fieldName, raw, runtime), type = resourceType(fieldName);
  block.fields[fieldName] = type === undefined ? {name: fieldName, value} : {name: fieldName, id: value, value: resource(target, runtime, value, type).name, variableType: type};
  graph.set(block.id, block); parent.inputs[name] = {name, block: block.id, shadow: block.id};
  if (parent.opcode === 'sensing_of') parent.fields.PROPERTY.value = value === '_stage_' ? 'backdrop #' : 'x position';
  return true;
};
const literalInput = (graph, parent, name, value, type, shadowOpcode) => {
  if (type === 'statement' || type === 'prototype' || type === 'argument') throw new Error(`Input ${name} needs a block connection`);
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Input ${name} requires a Boolean block/value`);
    const equal = newBlock('operator_equals', {parent: parent.id, topLevel: false});
    graph.set(equal.id, equal);
    literalInput(graph, equal, 'OPERAND1', 1, 'value'); literalInput(graph, equal, 'OPERAND2', value ? 1 : 0, 'value');
    parent.inputs[name] = {name, block: equal.id, shadow: null};
    return;
  }
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Literal input must be a string/finite number');
  const opcode = shadowOpcode || (typeof value === 'number' ? 'math_number' : 'text');
  const field = opcode === 'text' ? 'TEXT' : opcode === 'colour_picker' ? 'COLOUR' : 'NUM';
  if (opcode === 'colour_picker' && !/^#[\da-f]{6}$/i.test(String(value))) throw new Error('Colour input must be #rrggbb');
  const shadow = newBlock(opcode, {shadow: true, topLevel: false, parent: parent.id, fields: {[field]: {name: field, value: String(value)}}});
  graph.set(shadow.id, shadow); parent.inputs[name] = {name, block: shadow.id, shadow: shadow.id};
};
const paramsFrom = text => {
  const params = text === undefined ? [] : JSON.parse(text);
  if (!Array.isArray(params) || params.length > 128 || params.some(param => !param || typeof param.name !== 'string' || !param.name || !['number', 'text', 'boolean'].includes(param.type)) ||
    new Set(params.map(param => param.name)).size !== params.length) throw new Error('Params require unique {name,type:number|text|boolean}, max128');
  return params;
};
const procedureCode = (name, params) => {
  if (!name || name.includes('%')) throw new Error('Procedure name must be nonempty without raw placeholders; use --params');
  return name + params.map(param => param.type === 'boolean' ? ' %b' : ' %s').join('');
};
const procedureMutation = (name, params, options, ids = params.map(uid)) => ({tagName: 'mutation', children: [],
  proccode: procedureCode(name, params), argumentids: JSON.stringify(ids), argumentnames: JSON.stringify(params.map(param => param.name)),
  argumentdefaults: JSON.stringify(params.map(param => param.default ?? (param.type === 'boolean' ? false : param.type === 'number' ? 0 : ''))),
  warp: String(options.warp === undefined ? false : bool(options.warp)), return: returnType(options.type)});
const returnType = type => {
  const result = {statement: '0', reporter: '1', boolean: '2'}[type || 'statement'];
  if (!result) throw new Error('Procedure type must be statement/reporter/boolean');
  return result;
};
const definitions = graph => [...graph.values()].filter(block => block.opcode === 'procedures_prototype');
const findProcedure = (graph, selector) => {
  const candidates = definitions(graph).filter(block => block.id === selector || block.mutation.proccode === selector || block.mutation.proccode.split(' %')[0] === selector);
  if (candidates.length !== 1) throw resourceError(candidates.length, `Procedure not found or ambiguous: ${selector}`, selector);
  return candidates[0];
};
const addCall = (graph, prototype, values) => {
  const mutation = clone(prototype.mutation), call = newBlock('procedures_call', {mutation});
  graph.set(call.id, call);
  const ids = JSON.parse(mutation.argumentids), names = JSON.parse(mutation.argumentnames), defaults = JSON.parse(mutation.argumentdefaults);
  const types = [...mutation.proccode.matchAll(/%([sb])/g)].map(item => item[1]);
  for (const name of Object.keys(values)) if (!names.includes(name)) throw new Error(`Unknown procedure argument ${name}`);
  for (let index = 0; index < ids.length; index++) {
    if (types[index] === 'b' && !Object.hasOwn(values, names[index])) call.inputs[ids[index]] = {name: ids[index], block: null, shadow: null};
    else literalInput(graph, call, ids[index], values[names[index]] ?? defaults[index], types[index] === 'b' ? 'boolean' : 'value');
  }
  return call;
};
const signature = mutation => JSON.stringify([mutation.proccode, mutation.argumentnames, mutation.argumentdefaults, mutation.warp || 'false', mutation.return || '0']);
const makeBundle = (target, runtime, id, options) => {
  const graph = checkedGraph(target, runtime), selected = id ? descendants(graph, id, mode(options) === 'single') : new Set(graph.keys());
  if (id && get(graph, id).shadow) throw new Error('Cannot copy an input shadow on its own');
  const dependencies = [], work = [...selected];
  for (let index = 0; index < work.length; index++) {
    const block = get(graph, work[index]);
    if (block.opcode !== 'procedures_call') continue;
    const prototype = findProcedure(graph, block.mutation.proccode);
    if (selected.has(prototype.id)) continue;
    const root = prototype.parent;
    dependencies.push(root);
    for (const child of descendants(graph, root)) if (!selected.has(child)) {selected.add(child); work.push(child);}
  }
  const blocks = [...selected].map(key => clone(get(graph, key)));
  for (const block of blocks) {
    if (block.parent && !selected.has(block.parent)) {block.parent = null; block.topLevel = true; block.x = block.x ?? 0; block.y = block.y ?? 0;}
    if (id === block.id && mode(options) === 'single') block.next = null;
  }
  const variables = new Map();
  for (const block of blocks) for (const [name, field] of Object.entries(block.fields)) {
    const type = resourceType(name);
    if (type === undefined) continue;
    const variable = resource(target, runtime, field.id, type);
    const owner = Object.hasOwn(target.variables, variable.id) && !target.isStage ? target : runtime.getTargetForStage();
    variables.set(variable.id, {...clone(variable), scope: owner.isStage ? 'global' : 'local', owner: owner.id});
  }
  validateGraph(new Map(blocks.map(block => [block.id, block])), runtime);
  const comments = Object.values(target.comments).filter(comment => selected.has(comment.blockId)).map(clone);
  return {format: 'tw-cli-blocks', version: 1, source: {targetId: target.id, name: target.getName()},
    blocks, dependencies, variables: [...variables.values()], comments};
};
const validateBundle = (bundle, runtime) => {
  object(bundle, 'Clipboard bundle');
  if (bundle.format !== 'tw-cli-blocks' || bundle.version !== 1 || !Array.isArray(bundle.blocks) || !Array.isArray(bundle.variables) || !Array.isArray(bundle.comments) || !Array.isArray(bundle.dependencies)) throw new Error('Expected tw-cli-blocks version1 bundle');
  if (bundle.extensionURLs && Object.keys(bundle.extensionURLs).length) throw new Error('Executable extensions are denied');
  if (new Set(bundle.blocks.map(block => block.id)).size !== bundle.blocks.length) throw new Error('Duplicate clipboard block IDs');
  const graph = validateGraph(new Map(bundle.blocks.map(block => [block.id, clone(block)])), runtime);
  for (const root of bundle.dependencies) if (get(graph, root).parent !== null) throw new Error('Procedure dependency must be a root');
  const ids = new Set();
  for (const variable of bundle.variables) {
    if (typeof variable.id !== 'string' || !variable.id || ['__proto__', 'constructor', 'prototype'].includes(variable.id) || ids.has(variable.id) || typeof variable.name !== 'string' || !variable.name || !['', 'list', 'broadcast_msg'].includes(variable.type) || !['global', 'local'].includes(variable.scope)) throw new Error('Invalid clipboard variable descriptor');
    if (variable.isCloud) throw new Error('Copying cloud-variable definitions is denied; convert explicitly first');
    if (variable.type === 'list' ? !Array.isArray(variable.value) : variable.type === '' && !['string', 'number', 'boolean'].includes(typeof variable.value)) throw new Error('Invalid clipboard variable value');
    ids.add(variable.id);
  }
  for (const block of graph.values()) for (const [name, field] of Object.entries(block.fields)) if (resourceType(name) !== undefined && !bundle.variables.some(variable => variable.id === field.id && variable.type === resourceType(name) && variable.name === field.value)) throw new Error('Clipboard resource declaration missing/mismatched');
  const commentIds = new Set();
  for (const comment of bundle.comments) {
    if (typeof comment.id !== 'string' || !comment.id || commentIds.has(comment.id) || !graph.has(comment.blockId) || graph.get(comment.blockId).comment !== comment.id ||
      typeof comment.text !== 'string' || !['width', 'height'].every(key => Number.isFinite(comment[key]) && comment[key] > 0) ||
      !['x', 'y'].every(key => comment[key] === null || Number.isFinite(comment[key])) || typeof comment.minimized !== 'boolean') throw new Error('Invalid clipboard block comment');
    commentIds.add(comment.id);
  }
  for (const block of graph.values()) if (block.comment && !commentIds.has(block.comment)) throw new Error('Clipboard comment declaration missing');
  return graph;
};
const pasteBundle = (session, target, bundle, options) => {
  const runtime = session.project.vm.runtime, graph = validateBundle(bundle, runtime), destination = checkedGraph(target, runtime);
  const policy = options.variables || 'reuse';
  if (!['reuse', 'rename', 'error'].includes(policy)) throw new Error('Variable conflict policy must be reuse/rename/error');
  const variableMap = new Map(), plannedVariables = [], owners = [target, runtime.getTargetForStage()];
  const allVariables = () => [...new Set(owners)].flatMap(owner => [...Object.values(owner.variables).map(variable => ({owner, variable})), ...plannedVariables.filter(item => item.owner === owner)]);
  for (const variable of bundle.variables) {
    const owner = variable.scope === 'global' || variable.type === 'broadcast_msg' ? runtime.getTargetForStage() : target;
    const sameSource = bundle.source?.targetId === target.id;
    let match = allVariables().find(item => item.owner === owner && item.variable.id === variable.id && item.variable.type === variable.type && item.variable.name === variable.name && (sameSource || variable.scope === 'global'));
    const named = allVariables().filter(item => item.owner === owner && item.variable.type === variable.type &&
      (variable.type === 'broadcast_msg' ? item.variable.name.toLowerCase() === variable.name.toLowerCase() : item.variable.name === variable.name));
    if (!match && policy === 'reuse' && named.length === 1) match = named[0];
    if (match && match.variable.isCloud) throw new Error('Cannot paste references into cloud variables');
    if (!match) {
      if (policy === 'error' && named.length) throw new Error(`Variable conflict: ${variable.name}`);
      let name = variable.name, suffix = 2;
      const names = new Set(allVariables().filter(item => item.variable.type === variable.type).map(item => variable.type === 'broadcast_msg' ? item.variable.name.toLowerCase() : item.variable.name));
      while (names.has(variable.type === 'broadcast_msg' ? name.toLowerCase() : name)) name = `${variable.name}${suffix++}`;
      match = {owner, variable: {...clone(variable), id: uid(), name}};
      plannedVariables.push(match);
    }
    variableMap.set(variable.id, match.variable);
  }
  // Resolve dependencies by signature, or copy definitions with fresh parameter IDs.
  const procedureMap = new Map();
  for (const prototype of definitions(graph)) {
    const dependency = bundle.dependencies.includes(prototype.parent);
    const existing = definitions(destination).find(item => item.mutation.proccode === prototype.mutation.proccode);
    if (dependency && existing) {
      if (signature(existing.mutation) !== signature(prototype.mutation)) throw new Error(`Procedure signature conflict: ${prototype.mutation.proccode}`);
      procedureMap.set(prototype.mutation.proccode, clone(existing.mutation));
      for (const id of descendants(graph, prototype.parent)) graph.delete(id);
    } else {
      const original = prototype.mutation.proccode, mutation = clone(prototype.mutation);
      if (existing) {
        const split = original.indexOf(' %'), base = split < 0 ? original : original.slice(0, split), suffix = split < 0 ? '' : original.slice(split);
        let n = 2;
        do {mutation.proccode = `${base}${n++}${suffix}`;} while ([...definitions(destination), ...definitions(graph)].some(item => item !== prototype && item.mutation.proccode === mutation.proccode));
      }
      const oldIds = JSON.parse(mutation.argumentids), ids = oldIds.map(uid);
      mutation.argumentids = JSON.stringify(ids);
      prototype.inputs = Object.fromEntries(oldIds.map((old, index) => [ids[index], {...prototype.inputs[old], name: ids[index]}]));
      prototype.mutation = mutation; procedureMap.set(original, mutation);
    }
  }
  for (const call of [...graph.values()].filter(block => block.opcode === 'procedures_call')) {
    const replacement = procedureMap.get(call.mutation.proccode) || definitions(destination).find(block => block.mutation.proccode === call.mutation.proccode)?.mutation;
    if (!replacement) throw new Error(`Unresolved procedure: ${call.mutation.proccode}`);
    const old = JSON.parse(call.mutation.argumentids), ids = JSON.parse(replacement.argumentids);
    if (old.length !== ids.length) throw new Error('Procedure signature mismatch');
    call.inputs = Object.fromEntries(old.map((id, index) => [ids[index], {...call.inputs[id] || {block: null, shadow: null}, name: ids[index]}]));
    call.mutation = clone(replacement);
  }
  const idMap = new Map([...graph.keys()].map(id => [id, uid()]));
  const roots = [...graph.values()].filter(block => block.topLevel);
  const at = coordinate(options.at, roots.length ? {x: (roots[0].x ?? 0) + 32, y: (roots[0].y ?? 0) + 32} : {x: 0, y: 0});
  const origin = roots[0] || {x: 0, y: 0};
  const comments = bundle.comments.filter(comment => graph.has(comment.blockId)).map(comment => ({...clone(comment), id: uid(), blockId: idMap.get(comment.blockId),
    x: comment.x === null ? null : comment.x + at.x - origin.x, y: comment.y === null ? null : comment.y + at.y - origin.y}));
  const commentMap = new Map(comments.map((comment, index) => [bundle.comments.filter(item => graph.has(item.blockId))[index].id, comment.id]));
  const copied = [...graph.values()].map(block => {
    const copy = clone(block); copy.id = idMap.get(block.id); copy.parent = idMap.get(block.parent) || null; copy.next = idMap.get(block.next) || null;
    for (const input of Object.values(copy.inputs)) {input.block = idMap.get(input.block) || null; input.shadow = idMap.get(input.shadow) || null;}
    for (const [name, field] of Object.entries(copy.fields)) if (resourceType(name) !== undefined) {const variable = variableMap.get(field.id); field.id = variable.id; field.value = variable.name;}
    if (copy.comment) copy.comment = commentMap.get(copy.comment);
    if (copy.topLevel) {copy.x = block.x + at.x - origin.x; copy.y = block.y + at.y - origin.y;}
    if (copy.opcode === 'event_whenthisspriteclicked' && target.isStage) copy.opcode = 'event_whenstageclicked';
    if (copy.opcode === 'event_whenstageclicked' && !target.isStage) copy.opcode = 'event_whenthisspriteclicked';
    return copy;
  });
  validateGraph(new Map([...destination, ...copied.map(block => [block.id, block])]), runtime);
  for (const block of copied) for (const [name, field] of Object.entries(block.fields)) {
    if (resourceType(name) === undefined && ['COSTUME', 'BACKDROP', 'SOUND_MENU', 'TO', 'TOWARDS', 'OBJECT', 'CLONE_OPTION', 'TOUCHINGOBJECTMENU', 'DISTANCETOMENU'].includes(name)) {
      const menu = fieldMenu(target, block, name, runtime);
      if (!menu.some(item => item.value === field.value)) throw new Error(`Paste destination lacks menu resource ${name}: ${field.value}`);
    }
  }
  // All validation (including conflicts and mutation shape) is done before the first VM write.
  for (const {owner, variable} of plannedVariables) {
    owner.createVariable(variable.id, variable.name, variable.type, false);
    session.project.vm.setVariableValue(owner.id, variable.id, clone(variable.value));
    owner.blocks.emitProjectChanged();
  }
  createViaAPI(target, copied);
  for (const comment of comments) target.blocks.blocklyListen({type: 'comment_create', commentId: comment.id, blockId: comment.blockId, text: comment.text,
    xy: {x: comment.x, y: comment.y}, width: comment.width, height: comment.height, minimized: comment.minimized});
  validateResources(target, graphOf(target), runtime);
  return {id: roots[0] && idMap.get(roots[0].id), roots: roots.map(block => idMap.get(block.id)), count: copied.length,
    idMap: Object.fromEntries(idMap), variableMap: Object.fromEntries([...variableMap].map(([id, variable]) => [id, variable.id])),
    procedureMap: Object.fromEntries([...procedureMap].map(([code, mutation]) => [code, mutation.proccode]))};
};

// Related conversions verified against frozen block-switching/userscript.js.
const switchGroups = [
  ['motion_turnright', 'motion_turnleft'], ['motion_xposition', 'motion_yposition'],
  ['looks_costumenumbername', 'looks_backdropnumbername'], ['looks_show', 'looks_hide'], ['looks_nextcostume', 'looks_nextbackdrop'],
  ['looks_switchbackdropto', 'looks_switchbackdroptoandwait'], ['sound_play', 'sound_playuntildone'],
  ['sound_seteffectto', 'sound_changeeffectby'], ['sound_setvolumeto', 'sound_changevolumeby'], ['event_broadcast', 'event_broadcastandwait'],
  ['operator_equals', 'operator_gt', 'operator_lt'], ['operator_add', 'operator_subtract', 'operator_multiply', 'operator_divide', 'operator_mod'],
  ['operator_and', 'operator_or'], ['sensing_mousex', 'sensing_mousey'], ['data_showvariable', 'data_hidevariable'], ['data_showlist', 'data_hidelist'],
  ['data_replaceitemoflist', 'data_insertatlist'], ['pen_penDown', 'pen_penUp'], ['pen_setPenColorParamTo', 'pen_changePenColorParamBy'],
  ['pen_setPenHueToNumber', 'pen_changePenHueBy'], ['pen_setPenShadeToNumber', 'pen_changePenShadeBy'], ['pen_setPenSizeTo', 'pen_changePenSizeBy'],
  ['music_setTempo', 'music_changeTempo'], ['motion_setx', 'motion_changexby', 'motion_sety', 'motion_changeyby'],
  ['looks_seteffectto', 'looks_changeeffectby'], ['looks_setsizeto', 'looks_changesizeby'], ['looks_say', 'looks_think', 'looks_sayforsecs', 'looks_thinkforsecs'],
  ['looks_gotofrontback', 'looks_goforwardbackwardlayers'], ['control_if', 'control_if_else'], ['control_repeat_until', 'control_wait_until', 'control_forever'],
  ['sensing_touchingcolor', 'sensing_coloristouchingcolor'], ['data_setvariableto', 'data_changevariableby'], ['data_deleteoflist', 'data_deletealloflist']
];
const switchOpcode = (target, graph, id, opcode, options, runtime) => {
  const block = get(graph, id), original = block.opcode;
  if (original === opcode) return block;
  const before = schema(block, runtime), after = schema({...block, opcode}, runtime);
  const related = switchGroups.some(group => group.includes(original) && group.includes(opcode));
  if (!related && before.shape !== after.shape) throw new Error('Opcode switching requires compatible output/statement shape');
  const inputMap = options['input-map'] ? jsonObject(options['input-map'], 'Input map') : {};
  const fieldMap = options['field-map'] ? jsonObject(options['field-map'], 'Field map') : {};
  if (related) {
    const oldKeys = Object.keys(before.inputs).filter(key => !Object.hasOwn(after.inputs, key));
    const newKeys = Object.keys(after.inputs).filter(key => !Object.hasOwn(before.inputs, key));
    if (oldKeys.length === 1 && newKeys.length === 1 && before.inputs[oldKeys[0]] === after.inputs[newKeys[0]]) inputMap[oldKeys[0]] ??= newKeys[0];
    if (original === 'looks_gotofrontback' || original === 'looks_goforwardbackwardlayers') fieldMap[original === 'looks_gotofrontback' ? 'FRONT_BACK' : 'FORWARD_BACKWARD'] = opcode === 'looks_gotofrontback' ? 'FRONT_BACK' : 'FORWARD_BACKWARD';
  }
  const inputs = {};
  for (const [name, input] of Object.entries(block.inputs)) {
    const mapped = inputMap[name] ?? name;
    if (!Object.hasOwn(after.inputs, mapped)) {
      if (!related) throw new Error(`Destination opcode lacks input ${mapped}`);
      if (input.block && !get(graph, input.block).shadow) detach(graph, input.block);
      if (input.shadow) for (const child of descendants(graph, input.shadow)) graph.delete(child);
      continue;
    }
    if (Object.hasOwn(inputs, mapped)) throw new Error('Input map collision');
    inputs[mapped] = {...input, name: mapped};
  }
  const fields = {};
  for (const [name, field] of Object.entries(block.fields)) {
    const mapped = fieldMap[name] ?? name;
    if (!Object.hasOwn(after.fields, mapped)) throw new Error(`Destination opcode lacks field ${mapped}`);
    if (Object.hasOwn(fields, mapped)) throw new Error('Field map collision');
    fields[mapped] = {...field, name: mapped};
    if (name === 'FRONT_BACK') fields[mapped].value = field.value === 'front' ? 'forward' : 'backward';
    if (name === 'FORWARD_BACKWARD') fields[mapped].value = field.value === 'forward' ? 'front' : 'back';
  }
  block.opcode = opcode; block.inputs = inputs; block.fields = fields;
  const supplied = options.inputs ? jsonObject(options.inputs, 'Inputs') : {};
  for (const [name, value] of Object.entries(supplied)) {
    if (block.inputs[name]?.block) throw new Error(`Input ${name} is occupied`);
    literalInput(graph, block, name, value, after.inputs[name]);
  }
  for (const [name, type] of Object.entries(after.inputs)) if (!block.inputs[name]) {
    if (type === 'value') literalInput(graph, block, name, name === 'SECS' ? 2 : name === 'COLOR2' ? '#000000' : 1, type, name === 'COLOR2' ? 'colour_picker' : undefined);
    else block.inputs[name] = {name, block: null, shadow: null};
  }
  if (['data_setvariableto', 'data_changevariableby'].includes(opcode) && block.inputs.VALUE?.shadow) {
    const shadow = get(graph, block.inputs.VALUE.shadow), old = Object.values(shadow.fields)[0].value;
    shadow.opcode = opcode === 'data_setvariableto' ? 'text' : 'math_number';
    const name = shadow.opcode === 'text' ? 'TEXT' : 'NUM'; shadow.fields = {[name]: {name, value: old}};
  }
  if (options.fields) for (const [name, value] of Object.entries(jsonObject(options.fields, 'Fields'))) block.fields[name] = {name, value};
  for (const [name, field] of Object.entries(block.fields)) validateField(target, block, name, resourceType(name) === undefined ? field.value : field.id, runtime);
  validateGraph(graph, runtime);
  return block;
};
const outputPath = (positional, options) => {
  if (positional && options.output) throw new Error('Use positional output or --output, not both');
  const filename = positional || options.output;
  if (filename && path.extname(filename).toLowerCase() === '.sb3') throw new Error('Block clipboard output is JSON, not --out project.sb3');
  return filename;
};
const selectorFrom = (args, options) => {
  if (args[1] && options.block) throw new Error('Use block positional or --block, not both');
  return args[1] || options.block;
};
const clipboard = new WeakMap();
const readBundle = async filename => {
  const bytes = await readLocalFile(filename, MAX_CLIPBOARD_BYTES);
  // permission.parseJSON caps all JSON at4 MiB; preserve this command's existing
  // 32 MiB/100000-block contract while sharing the recursive prototype guard.
  const bundle = JSON.parse(bytes.toString('utf8'));
  rejectPrototypeKeys(bundle);
  return bundle;
};
const execute = async (session, command, args, options = {}) => {
  if (command !== 'blocks' || !Object.hasOwn(specs.blocks, args[0])) throw new Error('Unknown blocks command');
  const [action, id, a, b] = args;
  if (args[0] === 'schema') {
    if (options.target && !session.project.vm) throw new CommandError('RESOURCE_NOT_FOUND', 'Open a project first to query target menus', '使用 --project 项目.sb3，或在会话中打开项目。', {target: options.target});
    return describeSchemas(args[1], session.project.vm?.runtime, session.project.vm ? session.project.target(options.target) : null);
  }
  const target = session.project.target(options.target), runtime = session.project.vm.runtime;
  const graph = checkedGraph(target, runtime, !readActions.has(action));
  if (!readActions.has(action)) validateResources(target, graph, runtime);
  if (action === 'count') {
    const targets = options.target ? [target] : runtime.targets.filter(item => item.isOriginal);
    const unique = [...new Set(targets.map(item => item.blocks))];
    const counts = unique.map(blocks => ({blocks: Object.values(blocks._blocks).filter(block => options.shadows || !block.shadow).length,
      shadows: Object.values(blocks._blocks).filter(block => block.shadow).length, scripts: blocks.getScripts().length}));
    return {blockCount: counts.reduce((sum, item) => sum + item.blocks, 0), shadowCount: counts.reduce((sum, item) => sum + item.shadows, 0),
      scriptCount: counts.reduce((sum, item) => sum + item.scripts, 0), spriteCount: targets.filter(item => !item.isStage).length};
  }
  if (action === 'list' || action === 'inspect') {
    const selected = selectorFrom(args, options), ids = selected ? descendants(graph, selected, mode(options) === 'single') : new Set(graph.keys());
    return {target: target.id, roots: [...ids].filter(key => !get(graph, key).parent || !ids.has(get(graph, key).parent)), blocks: [...ids].map(key => clone(get(graph, key))), graphSafe: true};
  }
  if (action === 'find') {
    const targets = options.target ? [target] : runtime.targets.filter(item => item.isOriginal), query = (id || '').toLowerCase();
    const result = [];
    for (const current of targets) for (const block of checkedGraph(current, runtime, false).values()) {
      if (options.opcode && block.opcode !== options.opcode) continue;
      if (options['var-id'] && !Object.values(block.fields).some(field => field.id === options['var-id'])) continue;
      if (options.field && (!block.fields[options.field] || (options.value !== undefined && String(block.fields[options.field].value) !== options.value))) continue;
      if (query && !JSON.stringify([block.opcode, block.fields, block.mutation]).toLowerCase().includes(query)) continue;
      let root = block; while (root.parent) root = current.blocks.getBlock(root.parent);
      result.push({target: current.id, targetName: current.getName(), id: block.id, opcode: block.opcode, root: root.id, fields: clone(block.fields)});
    }
    return result;
  }
  if (action === 'field-menu') return fieldMenu(target, get(graph, id), a, runtime);
  if (['copy', 'export', 'cut', 'duplicate', 'share'].includes(action)) {
    const selected = selectorFrom(args, options);
    if (['cut', 'duplicate', 'share'].includes(action) && !selected) throw new Error('Missing block selector');
    const bundle = makeBundle(target, runtime, selected, options);
    if (action === 'duplicate') return pasteBundle(session, target, bundle, options);
    if (action === 'share') {
      const destination = session.project.target(a);
      return session.onTarget(destination, true, () => pasteBundle(session, destination, bundle, options));
    }
    const output = outputPath(a, options);
    if (action === 'export' && !output) throw new Error('Export requires a positional output or --output');
    if (action === 'cut') {
      detach(graph, selected, mode(options) === 'single', mode(options) === 'single');
      for (const key of descendants(graph, selected)) graph.delete(key);
      validateGraph(graph, runtime);
    }
    const file = output ? await atomicWrite(output, Buffer.from(JSON.stringify(bundle, null, 2) + '\n'), options.force) : null;
    if (action === 'cut') applyGraph(target, graph, runtime);
    clipboard.set(session, clone(bundle));
    return {copied: bundle.blocks.length, ...(file || {}), bundle};
  }
  if (action === 'paste' || action === 'import') {
    if (id && options.from) throw new Error('Use input positional or --from, not both');
    const input = id || options.from, bundle = input ? await readBundle(input) : clipboard.get(session);
    if (!bundle) throw new Error('Clipboard empty; copy first or specify a JSON input');
    return pasteBundle(session, target, bundle, options);
  }
  if (action === 'move') {
    const block = get(graph, id);
    if (!block.topLevel) throw new Error('Position applies only to a top-level stack; disconnect first');
    if (a !== undefined && options.at) throw new Error('Use x y or --at, not both');
    const at = a === undefined ? coordinate(options.at) : {x: number(a), y: number(b)};
    if (!at) throw new Error('Missing x y or --at');
    target.blocks.moveBlock({id, newCoordinate: at}); return {id, ...at};
  }
  if (action === 'cleanup' || action === 'clean-up') {
    const start = coordinate(options.at, {x: 48, y: 64}), gap = number(options.gap ?? 72, 'Gap'), width = number(options['column-width'] ?? 480, 'Column width'), columns = number(options.columns ?? 1, 'Columns');
    if (gap < 0 || width <= 0 || !Number.isInteger(columns) || columns < 1 || columns > 100) throw new Error('Invalid layout gap/column width/count');
    const roots = [...graph.values()].filter(block => block.topLevel).sort((one, two) => one.y - two.y || one.x - two.x || one.id.localeCompare(two.id));
    const heights = Array(columns).fill(start.y), result = [];
    roots.forEach((block, index) => {
      const column = index % columns, at = {x: start.x + width * column, y: heights[column]};
      target.blocks.moveBlock({id: block.id, newCoordinate: at});
      heights[column] += descendants(graph, block.id).size * 40 + gap; result.push({id: block.id, ...at});
    });
    return {positions: result, layout: 'deterministic semantic layout; not pixel-identical Blockly metrics'};
  }
  if (action === 'clear') {graph.clear(); applyGraph(target, graph, runtime); return {cleared: true};}
  if (action === 'switch') {const block = switchOpcode(target, graph, id, a, options, runtime); applyGraph(target, graph, runtime); return {id, opcode: block.opcode};}
  if (['connect', 'disconnect', 'heal', 'delete'].includes(action)) {
    if (action === 'connect') {
      const parent = a || options.after || options.parent;
      if (!parent) throw new Error('Connection requires a parent selector');
      if (a && (options.after || options.parent)) throw new Error('Use parent positional or --after/--parent, not both');
      attach(graph, id, parent, options.input, runtime);
    } else {
      if (action === 'delete' && get(graph, id).opcode === 'procedures_definition') {
        const removed = descendants(graph, id), prototype = get(graph, id).inputs.custom_block?.block && get(graph, get(graph, id).inputs.custom_block.block);
        if ([...graph.values()].some(block => block.opcode === 'procedures_call' && block.mutation.proccode === prototype?.mutation.proccode && !removed.has(block.id))) throw new Error('Procedure is used by external call blocks');
      }
      detach(graph, id, action === 'heal' || !!options.heal || (action === 'delete' && mode(options) === 'single'), mode(options) === 'single' || action === 'heal');
      if (action === 'delete') for (const key of descendants(graph, id)) graph.delete(key);
      else Object.assign(get(graph, id), coordinate(options.at, {}));
    }
    applyGraph(target, graph, runtime); return {id, action};
  }
  if (action === 'set-field') {
    const selected = selectorFrom(args, options), name = a ?? options.field, raw = options['var-id'] ?? b ?? options.value;
    if (options['var-id'] && (b !== undefined || options.value !== undefined)) throw new Error('Use --var-id or a field value, not both');
    const block = get(graph, selected), value = validateField(target, block, name, raw, runtime);
    if (block.opcode === 'control_stop' && name === 'STOP_OPTION') {
      if (value !== 'other scripts in sprite' && block.next) throw new Error('Stop option cannot remove an occupied next connection');
      target.blocks.changeBlock({id: selected, element: 'mutation', value: mutationDOM({tagName: 'mutation', children: [], hasnext: String(value === 'other scripts in sprite')})});
    }
    if (block.opcode === 'sensing_of_object_menu' && !block.parent) throw new Error('sensing_of object menu must have a parent');
    target.blocks.changeBlock({id: selected, element: 'field', name, value});
    return {id: selected, field: name, value};
  }
  if (action === 'mutation') {
    const block = get(graph, id), mutation = validateMutation(jsonObject(a, 'Mutation'), block.opcode);
    const old = block.mutation;
    if (block.opcode === 'procedures_prototype' || (block.opcode === 'procedures_call' && (old?.proccode !== mutation.proccode || (old?.warp || 'false') !== (mutation.warp || 'false')))) throw new Error('Use procedure-edit for signature changes');
    block.mutation = mutation; validateGraph(graph, runtime);
    target.blocks.changeBlock({id, element: 'mutation', value: mutationDOM(mutation)}); return {id, mutation: clone(target.blocks.getBlock(id).mutation)};
  }
  if (action === 'add') {
    if (['procedures_definition', 'procedures_prototype', 'procedures_call'].includes(id)) throw new Error('Use procedure-add or procedure-call to create procedure blocks');
    const block = newBlock(id, {mutation: options.mutation ? jsonObject(options.mutation, 'Mutation') : undefined});
    const info = schema(block, runtime);
    if (info.shape === 'prototype') throw new Error('Use procedure-add for a procedure prototype');
    graph.set(block.id, block);
    const fields = options.fields ? jsonObject(options.fields, 'Fields') : {};
    for (const [name, fieldInfo] of Object.entries(info.fields)) {
      const menu = fieldMenu(target, block, name, runtime);
      const raw = fields[name] ?? (menu.length ? menu[0].id ?? menu[0].value : fieldInfo.default ?? (resourceType(name) !== undefined ? undefined : ''));
      const value = validateField(target, block, name, raw, runtime);
      block.fields[name] = resourceType(name) !== undefined ? {name, id: value, value: resource(target, runtime, value, resourceType(name)).name, variableType: resourceType(name)} : {name, value};
    }
    for (const key of Object.keys(fields)) if (!Object.hasOwn(info.fields, key)) throw new Error(`Unknown field ${key}`);
    const inputs = options.inputs ? jsonObject(options.inputs, 'Inputs') : {};
    for (const [name, type] of Object.entries(info.inputs)) {
      if (menuInput(graph, block, name, inputs[name], target, runtime)) continue;
      if (Object.hasOwn(inputs, name)) literalInput(graph, block, name, inputs[name], type, ['COLOR', 'COLOR2'].includes(name) ? 'colour_picker' : undefined);
      else if (['COLOR', 'COLOR2'].includes(name)) literalInput(graph, block, name, '#000000', type, 'colour_picker');
      else block.inputs[name] = {name, block: null, shadow: null};
    }
    for (const key of Object.keys(inputs)) if (!Object.hasOwn(info.inputs, key)) throw new Error(`Unknown input ${key}`);
    Object.assign(block, coordinate(options.at, {}));
    if (options.after || options.parent) attach(graph, block.id, options.after || options.parent, options.input, runtime);
    // Frozen menu blocks are value shadows. Broadcasting relies on block===shadow
    // to resolve the message ID; treating the menu as an ordinary reporter loses it.
    if (options.parent && options.input && menuOpcodes.has(block.opcode)) {
      const parent = get(graph, options.parent), descriptor = parent.inputs[options.input];
      if (menuInputs[parent.opcode]?.[options.input] !== block.opcode) throw new Error('Menu opcode does not match owning input');
      if (descriptor.shadow && descriptor.shadow !== block.id) for (const shadowId of descendants(graph, descriptor.shadow)) graph.delete(shadowId);
      block.shadow = true; descriptor.shadow = block.id;
      if (block.opcode === 'sensing_of_object_menu') parent.fields.PROPERTY.value = block.fields.OBJECT.value === '_stage_' ? 'backdrop #' : 'x position';
    }
    applyGraph(target, graph, runtime); return {id: block.id, opcode: id};
  }
  if (action === 'procedure-add') {
    const params = paramsFrom(options.params), mutation = procedureMutation(id, params, options);
    if (definitions(graph).some(block => block.mutation.proccode === mutation.proccode)) throw new Error('Procedure already exists');
    const definition = newBlock('procedures_definition'), prototype = newBlock('procedures_prototype', {mutation, shadow: true, topLevel: false, parent: definition.id});
    definition.inputs.custom_block = {name: 'custom_block', block: prototype.id, shadow: prototype.id};
    graph.set(definition.id, definition); graph.set(prototype.id, prototype);
    const ids = JSON.parse(mutation.argumentids);
    params.forEach((param, index) => {
      const reporter = newBlock(param.type === 'boolean' ? 'argument_reporter_boolean' : 'argument_reporter_string_number', {fields: {VALUE: {name: 'VALUE', value: param.name}}, shadow: true, topLevel: false, parent: prototype.id});
      prototype.inputs[ids[index]] = {name: ids[index], block: reporter.id, shadow: reporter.id}; graph.set(reporter.id, reporter);
    });
    Object.assign(definition, coordinate(options.at, {})); applyGraph(target, graph, runtime);
    return {id: definition.id, prototype: prototype.id, proccode: mutation.proccode, params};
  }
  if (action === 'procedure-call') {
    const prototype = findProcedure(graph, id), call = addCall(graph, prototype, options.values ? jsonObject(options.values, 'Values') : {});
    Object.assign(call, coordinate(options.at, {}));
    if (options.after || options.parent) attach(graph, call.id, options.after || options.parent, options.input, runtime);
    applyGraph(target, graph, runtime); return {id: call.id, proccode: call.mutation.proccode};
  }
  if (action === 'procedure-delete') {
    const prototype = findProcedure(graph, id), removed = descendants(graph, prototype.parent);
    if ([...graph.values()].some(block => block.opcode === 'procedures_call' && block.mutation.proccode === prototype.mutation.proccode && !removed.has(block.id))) throw new Error('Procedure is used by external call blocks');
    for (const key of removed) graph.delete(key);
    applyGraph(target, graph, runtime); return {deleted: prototype.mutation.proccode};
  }
  if (action === 'procedure-edit') {
    const prototype = findProcedure(graph, id), old = clone(prototype.mutation), oldNames = JSON.parse(old.argumentnames), oldIds = JSON.parse(old.argumentids), types = [...old.proccode.matchAll(/%([sb])/g)].map(item => item[1]);
    const params = options.params ? paramsFrom(options.params) : oldNames.map((name, index) => ({name, type: types[index] === 'b' ? 'boolean' : 'text', default: JSON.parse(old.argumentdefaults)[index]}));
    const mutation = procedureMutation(options.name || old.proccode.split(' %')[0], params, {warp: options.warp ?? old.warp, type: options.type || ({0: 'statement', 1: 'reporter', 2: 'boolean'}[old.return || '0'])},
      params.map(param => oldIds[oldNames.indexOf(param.name)] || uid()));
    if (definitions(graph).some(block => block !== prototype && block.mutation.proccode === mutation.proccode)) throw new Error('Procedure signature already exists');
    for (const block of graph.values()) if (block.opcode.startsWith('argument_reporter_') && !block.shadow && oldNames.includes(block.fields.VALUE.value) && !params.some(param => param.name === block.fields.VALUE.value)) throw new Error('Removed argument is used in procedure body');
    const ids = JSON.parse(mutation.argumentids), renamedInputs = {};
    params.forEach((param, index) => {
      const oldIndex = oldNames.indexOf(param.name), existing = oldIndex < 0 ? null : prototype.inputs[oldIds[oldIndex]];
      if (existing && (param.type === 'boolean') !== (types[oldIndex] === 'b')) throw new Error('Cannot change parameter shape in place');
      if (existing) renamedInputs[ids[index]] = {...existing, name: ids[index]};
      else {
        const reporter = newBlock(param.type === 'boolean' ? 'argument_reporter_boolean' : 'argument_reporter_string_number', {fields: {VALUE: {name: 'VALUE', value: param.name}}, shadow: true, topLevel: false, parent: prototype.id});
        graph.set(reporter.id, reporter); renamedInputs[ids[index]] = {name: ids[index], block: reporter.id, shadow: reporter.id};
      }
    });
    for (const [key, input] of Object.entries(prototype.inputs)) if (!ids.includes(key)) for (const child of edges({next: null, inputs: {[key]: input}})) for (const removed of descendants(graph, child)) graph.delete(removed);
    prototype.inputs = renamedInputs; prototype.mutation = mutation;
    for (const call of [...graph.values()].filter(block => block.opcode === 'procedures_call' && block.mutation.proccode === old.proccode)) {
      const newInputs = {};
      params.forEach((param, index) => {
        const oldKey = oldIds[oldNames.indexOf(param.name)], input = call.inputs[oldKey];
        if (input) newInputs[ids[index]] = {...input, name: ids[index]};
        else if (param.type === 'boolean') newInputs[ids[index]] = {name: ids[index], block: null, shadow: null};
        else {literalInput(graph, call, ids[index], param.default ?? '', 'value'); newInputs[ids[index]] = call.inputs[ids[index]];}
      });
      for (const [key, input] of Object.entries(call.inputs)) if (!Object.hasOwn(newInputs, key)) {
        if (input.block && !get(graph, input.block).shadow) detach(graph, input.block);
        if (input.shadow) for (const child of descendants(graph, input.shadow)) graph.delete(child);
      }
      call.inputs = newInputs; call.mutation = clone(mutation);
    }
    applyGraph(target, graph, runtime); return {proccode: mutation.proccode};
  }
  throw new Error(`Unsupported blocks action: ${action}`);
};

module.exports = {specs, booleanOptions, requiresProject: (command, args) => args[0] !== 'schema',
  isReadOnly: (command, args) => readActions.has(args[0]), execute,
  dispose: session => clipboard.delete(session),
  // Shared semantic helpers for the addon module; these never write project.json.
  helpers: {checkedGraph, graphOf, validateGraph, applyGraph, descendants, schema, resource, resourceType, mutationDOM, makeBundle, pasteBundle, coordinate, clone, newBlock, checkConnection, literalInput, menuInput, menuInputs, menuOpcodes, recipeOpcodeAvailable, fieldMenu, validateField, validateResources, describeSchemas}};
