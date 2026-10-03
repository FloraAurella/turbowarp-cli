'use strict';
const {readLocalFile} = require('./project');
const {CommandError, errorInfo} = require('./errors');
const {checkedGraph, schema, resource, resourceType, newBlock, checkConnection, literalInput,
  menuInput, menuInputs, menuOpcodes, recipeOpcodeAvailable, fieldMenu, validateField, validateGraph, validateResources, applyGraph} = require('./block-commands').helpers;

const LIMITS = Object.freeze({bytes: 32 * 1024 * 1024, depth: 64, blocks: 100000});
const fail = (message, path, code = 'INVALID_ARGUMENT') => {
  throw new CommandError(code, message, '使用 blocks schema <opcode> 查询形状、输入和字段；检查 details.path 指向的节点。', {path});
};
const at = (path, operation) => {
  try {return operation();} catch (error) {
    if (error.details?.path) throw error;
    const info = errorInfo(error);
    throw new CommandError(info.code === 'INTERNAL_ERROR' ? 'INVALID_ARGUMENT' : info.code, error.message, info.hint, {...info.details, path});
  }
};
const object = (value, path, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Expected object at ${path}`, path);
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`Unknown recipe field ${key}`, `${path}.${key}`);
  return value;
};
const readRecipe = async filename => {
  const bytes = await readLocalFile(filename, LIMITS.bytes);
  let recipe;
  try {recipe = JSON.parse(bytes.toString('utf8'));} catch {fail('Expected valid script recipe JSON', '$');}
  const pending = [{value: recipe, path: '$', depth: 0}];
  while (pending.length) {
    const item = pending.pop();
    if (!item.value || typeof item.value !== 'object') continue;
    // Bound the JSON envelope too, before recursive block construction.
    if (item.depth > LIMITS.depth * 4) fail('Recipe JSON nesting exceeds limit', item.path);
    for (const [key, value] of Object.entries(item.value)) {
      const location = Array.isArray(item.value) ? `${item.path}[${key}]` : `${item.path}.${key}`;
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe prototype key in script recipe', location);
      if (value && typeof value === 'object') pending.push({value, path: location, depth: item.depth + 1});
    }
  }
  object(recipe, '$', ['version', 'scripts']);
  if (recipe.version !== 1) fail('Expected script recipe version 1', '$.version');
  if (!Array.isArray(recipe.scripts) || recipe.scripts.length === 0) fail('scripts must be a nonempty array', '$.scripts');
  return recipe;
};

// Compile into a detached graph. validate and apply share this entire path;
// no VM block API, resource creation, or file write happens during compilation.
const compile = (recipe, target, runtime) => {
  const graph = checkedGraph(target, runtime), originalSize = graph.size;
  const nodeMap = Object.create(null), roots = [];
  const connect = (parent, child, input, path) => at(path, () => {
    checkConnection(parent, child, input, runtime);
    child.parent = parent.id; child.topLevel = false;
    if (input === undefined) parent.next = child.id;
    else parent.inputs[input] = {name: input, block: child.id, shadow: child.shadow ? child.id : null};
  });
  const sequence = (nodes, path, depth, allowEmpty = false) => {
    if (!Array.isArray(nodes) || (!allowEmpty && !nodes.length)) fail('Expected nonempty block array', path);
    if (depth > LIMITS.depth) fail('Recipe nesting exceeds 64', path);
    let first = null, previous = null;
    nodes.forEach((node, index) => {
      const location = `${path}[${index}]`, block = build(node, location, depth + 1);
      if (previous) connect(previous, block, undefined, location);
      else first = block;
      previous = block;
    });
    return first;
  };
  const build = (node, path, depth) => {
    if (depth > LIMITS.depth) fail('Recipe nesting exceeds 64', path);
    object(node, path, ['opcode', 'inputs', 'fields']);
    if (typeof node.opcode !== 'string' || !node.opcode) fail('opcode must be a nonempty string', `${path}.opcode`);
    if (/^(procedures_|argument_)/.test(node.opcode)) fail('Use proc / blocks procedure-* for custom procedures', `${path}.opcode`, 'NOT_SUPPORTED');
    if (!recipeOpcodeAvailable(node.opcode, runtime)) {
      fail(`Unknown/unloaded opcode ${node.opcode}`, `${path}.opcode`, 'NOT_SUPPORTED');
    }
    const block = newBlock(node.opcode), info = at(`${path}.opcode`, () => schema(block, runtime));
    graph.set(block.id, block); nodeMap[path] = block.id;
    if (graph.size > LIMITS.blocks) fail('Block graph exceeds 100000 blocks', path);
    const fields = node.fields === undefined ? {} : object(node.fields, `${path}.fields`);
    for (const key of Object.keys(fields)) if (!Object.hasOwn(info.fields, key)) fail(`Unknown field ${key}`, `${path}.fields.${key}`);
    for (const [name, fieldInfo] of Object.entries(info.fields)) at(`${path}.fields.${name}`, () => {
      const type = resourceType(name), menu = fieldMenu(target, block, name, runtime);
      if (type !== undefined && !Object.hasOwn(fields, name)) fail(`Resource field ${name} must be explicit`, `${path}.fields.${name}`);
      const raw = Object.hasOwn(fields, name) ? fields[name] : (menu[0]?.id ?? menu[0]?.value ?? fieldInfo.default ?? '');
      if (!['string', 'number'].includes(typeof raw) || typeof raw === 'number' && !Number.isFinite(raw)) {
        fail('Field value must be a string/finite number', `${path}.fields.${name}`);
      }
      // sensing_of PROPERTY depends on its OBJECT menu, which is built below.
      const value = node.opcode === 'sensing_of' && name === 'PROPERTY' && Object.hasOwn(fields, name) ? String(raw) :
        validateField(target, block, name, raw, runtime);
      block.fields[name] = type === undefined ? {name, value} : {name, id: value, value: resource(target, runtime, value, type).name, variableType: type};
    });
    if (node.opcode === 'control_stop') block.mutation = {tagName: 'mutation', children: [], hasnext: String(block.fields.STOP_OPTION.value === 'other scripts in sprite')};
    const inputs = node.inputs === undefined ? {} : object(node.inputs, `${path}.inputs`);
    for (const key of Object.keys(inputs)) if (!Object.hasOwn(info.inputs, key)) fail(`Unknown input ${key}`, `${path}.inputs.${key}`);
    for (const [name, type] of Object.entries(info.inputs)) {
      const location = `${path}.inputs.${name}`, value = inputs[name];
      block.inputs[name] = {name, block: null, shadow: null};
      if (!Object.hasOwn(inputs, name)) continue;
      at(location, () => {
        if (type === 'statement') {
          const child = sequence(value, location, depth + 1, true);
          if (child) connect(block, child, name, location);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          const child = build(value, location, depth + 1);
          if (menuOpcodes.has(child.opcode)) {
            if (menuInputs[block.opcode]?.[name] !== child.opcode) fail('Menu opcode does not match owning input', location);
            child.shadow = true;
          }
          connect(block, child, name, location);
          if (child.opcode === 'sensing_of_object_menu') block.fields.PROPERTY.value = child.fields.OBJECT.value === '_stage_' ? 'backdrop #' : 'x position';
        } else if (!menuInput(graph, block, name, value, target, runtime)) {
          literalInput(graph, block, name, value, type, ['COLOR', 'COLOR2'].includes(name) ? 'colour_picker' : undefined);
        }
      });
    }
    if (node.opcode === 'sensing_of' && Object.hasOwn(fields, 'PROPERTY')) {
      at(`${path}.fields.PROPERTY`, () => {
        const descriptor = block.inputs.OBJECT;
        const menu = descriptor.block && graph.get(descriptor.block);
        const key = menu?.fields.OBJECT?.value;
        const other = key === '_stage_' ? runtime.getTargetForStage() : runtime.targets.find(item => item.isOriginal && item.getName() === key);
        if (!other) fail('sensing_of requires an available OBJECT menu', `${path}.inputs.OBJECT`);
        const properties = [...(other.isStage ? ['backdrop #', 'backdrop name', 'volume'] : ['x position', 'y position', 'direction', 'costume #', 'costume name', 'size', 'volume']),
          ...Object.values(other.variables).filter(item => item.type === '').map(item => item.name)];
        if (!properties.includes(fields.PROPERTY)) fail('Invalid menu resource/value for PROPERTY', `${path}.fields.PROPERTY`);
        block.fields.PROPERTY.value = fields.PROPERTY;
      });
    }
    if (graph.size > LIMITS.blocks) fail('Block graph exceeds 100000 blocks', path);
    return block;
  };
  recipe.scripts.forEach((nodes, index) => {
    const root = sequence(nodes, `$.scripts[${index}]`, 0);
    const shape = at(`$.scripts[${index}][0]`, () => schema(root, runtime).shape);
    if (!['hat', 'statement', 'end'].includes(shape) || root.shadow) fail('A script root must be a hat or statement', `$.scripts[${index}][0]`);
    root.x = 48; root.y = 64 + index * 160; roots.push(root.id);
  });
  at('$.scripts', () => {validateGraph(graph, runtime); validateResources(target, graph, runtime);});
  return {graph, result: {schemaVersion: 1, valid: true, targetId: target.id, roots, nodeMap,
    blockCount: graph.size - originalSize, nodeCount: Object.keys(nodeMap).length, diagnostics: []}};
};
const execute = async (session, args, target) => {
  const recipe = await readRecipe(args[1]);
  const {graph, result} = compile(recipe, target, session.project.vm.runtime);
  if (args[0] === 'apply') applyGraph(target, graph, session.project.vm.runtime);
  return {...result, applied: args[0] === 'apply'};
};
module.exports = {execute, compile, readRecipe, LIMITS};
