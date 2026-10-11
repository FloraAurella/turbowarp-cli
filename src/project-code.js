'use strict';

const crypto = require('node:crypto');
const {CommandError, errorInfo, resourceError} = require('./errors');
const {validateProjectPolicy} = require('./project');
const blocks = require('./block-commands');
const h = blocks.helpers;
const clone = h.clone;
const originals = project => {
  if (!project.vm) throw resourceError(0, 'Open a project first');
  return project.vm.runtime.targets.filter(target => target.isOriginal);
};
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) :
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const revision = project => {
  const targets = originals(project);
  const digest = crypto.createHash('sha256');
  digest.update(JSON.stringify(canonical(JSON.parse(project.vm.toJSON(null, {allowOptimization: false})))));
  digest.update(JSON.stringify(targets.map(target => ({id: target.id,
    assets: [...target.getCostumes(), ...target.getSounds()].map(asset => asset.cliId || null),
    blocks: Object.values(target.blocks._blocks).sort((one, two) => one.id.localeCompare(two.id)).map(block => ({id: block.id,
      parent: block.parent, next: block.next, inputs: Object.entries(block.inputs).sort(([one], [two]) => one.localeCompare(two))
        .map(([name, input]) => ({name, block: input.block, shadow: input.shadow}))}))}))));
  for (const asset of project.vm.serializeAssets().sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    digest.update(asset.fileName); digest.update('\0'); digest.update(Buffer.from(asset.fileContent));
  }
  return digest.digest('hex');
};
const fail = (message, path = '$', code = 'INVALID_ARGUMENT', details = {}) => {
  throw new CommandError(code, message, '检查 details.path 和目标／积木 ID；使用 project read 获取可编辑代码。', {path, ...details});
};
const object = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected object', path);
  return value;
};
const refs = (target, graph, predicate) => [...graph.values()].filter(predicate).map(block => ({target: target.id, id: block.id, opcode: block.opcode}));
const validateTarget = (target, runtime) => {
  const graph = h.checkedGraph(target, runtime, false), diagnostics = [], known = new Map();
  for (const block of graph.values()) {
    try {known.set(block.id, h.schema(block, runtime));} catch (error) {
      if (/^(procedures_|argument_)/.test(block.opcode)) throw error;
      diagnostics.push({code: 'RAW_OPCODE', target: target.id, id: block.id, opcode: block.opcode, message: error.message});
    }
  }
  if (!diagnostics.length) {
    try {h.validateGraph(graph, runtime);} catch (error) {
      const procedure = error.message.match(/^Unresolved\/mismatched procedure call: (.+)$/);
      if (procedure) fail(error.message, '$', 'RESOURCE_NOT_FOUND', {target: target.id,
        references: refs(target, graph, block => block.opcode === 'procedures_call' && block.mutation.proccode === procedure[1])});
      throw error;
    }
  }
  else for (const block of graph.values()) {
    const info = known.get(block.id); if (!info) continue;
    for (const name of Object.keys(block.inputs)) if (!Object.hasOwn(info.inputs, name)) fail(`Unknown input ${name}`, '$', 'INVALID_ARGUMENT', {target: target.id, id: block.id});
    for (const name of Object.keys(block.fields)) if (!Object.hasOwn(info.fields, name)) fail(`Unknown field ${name}`, '$', 'INVALID_ARGUMENT', {target: target.id, id: block.id});
    if (block.next && known.has(block.next)) h.checkConnection(block, graph.get(block.next), undefined, runtime);
    for (const [name, input] of Object.entries(block.inputs)) for (const id of new Set([input.block, input.shadow].filter(Boolean))) {
      if (known.has(id)) h.checkConnection(block, graph.get(id), name, runtime);
    }
  }
  for (const block of graph.values()) for (const [name, field] of Object.entries(block.fields)) {
    const type = h.resourceType(name);
    try {
      if (type !== undefined) {
        const value = h.resource(target, runtime, field.id, type);
        if (value.name !== field.value) throw new Error('Resource name/id mismatch');
      } else if (known.has(block.id) && ['COSTUME', 'BACKDROP', 'SOUND_MENU', 'TO', 'TOWARDS', 'TOUCHINGOBJECTMENU', 'DISTANCETOMENU', 'CLONE_OPTION', 'OBJECT'].includes(name)) {
        h.validateField(target, block, name, field.value, runtime);
      }
    } catch (error) {
      const info = errorInfo(error);
      throw new CommandError(info.code === 'INTERNAL_ERROR' ? 'INVALID_ARGUMENT' : info.code, error.message, info.hint,
        {...info.details, target: target.id, id: block.id, field: name, references: refs(target, graph, node => Object.values(node.fields).some(item => item.id && item.id === field.id))});
    }
  }
  // Also enforce procedure references when raw opcodes prevent strict graph validation.
  const prototypes = [...graph.values()].filter(block => block.opcode === 'procedures_prototype');
  for (const call of graph.values()) if (call.opcode === 'procedures_call') {
    const definition = prototypes.filter(block => block.mutation.proccode === call.mutation.proccode);
    if (definition.length !== 1 || definition[0].mutation.argumentids !== call.mutation.argumentids ||
      (definition[0].mutation.warp || 'false') !== (call.mutation.warp || 'false')) {
      fail(`Unresolved/mismatched procedure call: ${call.mutation.proccode}`, '$', 'RESOURCE_NOT_FOUND',
        {target: target.id, id: call.id, references: refs(target, graph, block => block.opcode === 'procedures_call' && block.mutation.proccode === call.mutation.proccode)});
    }
  }
  return {graph, diagnostics};
};
const validate = project => {
  validateProjectPolicy(JSON.parse(project.vm.toJSON(null, {allowOptimization: false})));
  return {valid: true, diagnostics: originals(project).flatMap(target => validateTarget(target, project.vm.runtime).diagnostics)};
};

const commentData = comment => {
  const result = {};
  for (const key of ['id', 'blockId', 'text', 'x', 'y', 'width', 'height', 'minimized']) if (comment[key] !== undefined) result[key] = clone(comment[key]);
  return result;
};
const scriptBody = (target, graph, root) => {
  const sequence = id => {
    const result = [];
    while (id) {const block = graph.get(id); result.push(node(block)); id = block.next;}
    return result;
  };
  const node = block => {
    const data = clone(block); delete data.parent; delete data.next; delete data.topLevel; delete data.x; delete data.y;
    data.layout = {topLevel: block.topLevel, ...(!block.topLevel || block.x === undefined ? {} : {x: block.x}), ...(!block.topLevel || block.y === undefined ? {} : {y: block.y})};
    data.inputs = Object.fromEntries(Object.entries(block.inputs).map(([name, input]) => [name, {...clone(input),
      block: input.block ? graph.get(input.block).next ? sequence(input.block) : node(graph.get(input.block)) : null,
      shadow: input.shadow ? node(graph.get(input.shadow)) : null}]));
    if (block.comment && target.comments[block.comment]) data.commentData = commentData(target.comments[block.comment]);
    return data;
  };
  return sequence(root);
};
const read = async (project, options = {}) => {
  let targets = options.target ? [project.target(options.target)] : originals(project);
  if (options.script) {
    targets = targets.filter(target => target.blocks.getScripts().includes(options.script));
    if (targets.length !== 1) throw resourceError(targets.length, `Script not found or ambiguous: ${options.script}`, options.script);
  }
  const diagnostics = [], result = {version: 1, revision: revision(project), targets: [], diagnostics};
  for (const target of targets) {
    const graph = h.checkedGraph(target, project.vm.runtime, false);
    for (const block of graph.values()) try {h.schema(block, project.vm.runtime);} catch (error) {
      diagnostics.push({code: 'RAW_OPCODE', target: target.id, id: block.id, opcode: block.opcode, message: error.message});
    }
    const resources = Object.values(target.variables).map(variable => ({id: variable.id, name: variable.name, value: clone(variable.value), cloud: !!variable.isCloud}));
    const byType = type => resources.filter(item => target.variables[item.id].type === type);
    const asset = item => ({id: item.cliId, name: item.name, assetId: item.assetId, md5: item.md5,
      format: item.dataFormat, ...(item.rotationCenterX === undefined ? {} : {rotationCenterX: item.rotationCenterX, rotationCenterY: item.rotationCenterY}),
      ...(item.sampleCount === undefined ? {} : {samples: item.sampleCount, rate: item.rate})});
    const scripts = target.blocks.getScripts().filter(root => !options.script || root === options.script).map(root => ({root,
      opcode: graph.get(root).opcode, position: {x: graph.get(root).x, y: graph.get(root).y}, blockCount: h.descendants(graph, root).size,
      ...((options.target || options.script) ? {body: scriptBody(target, graph, root)} : {})}));
    result.targets.push({id: target.id, name: target.getName(), isStage: target.isStage,
      variables: byType(''), lists: byType('list'), broadcasts: byType('broadcast_msg'),
      assets: {costumes: target.getCostumes().map(asset), sounds: target.getSounds().map(asset)},
      comments: Object.values(target.comments).map(commentData), procedures: [...graph.values()].filter(block => block.opcode === 'procedures_prototype').map(block =>
        ({id: block.id, root: block.parent, name: block.mutation.proccode, params: JSON.parse(block.mutation.argumentnames).map((name, index) => ({name,
          id: JSON.parse(block.mutation.argumentids)[index], default: JSON.parse(block.mutation.argumentdefaults)[index], type: [...block.mutation.proccode.matchAll(/%([sb])/g)][index][1] === 'b' ? 'boolean' : 'text'})),
        warp: block.mutation.warp === 'true', type: {0: 'statement', 1: 'reporter', 2: 'boolean'}[block.mutation.return || '0']})), scripts});
  }
  if (options.format && !['json', 'text'].includes(options.format)) fail('format must be json/text', '$.format');
  if (options.format !== 'text') return result;
  const lines = [`project version=1 revision=${result.revision}`];
  const show = (body, indent) => {
    for (const node of Array.isArray(body) ? body : [body]) {
      lines.push(`${indent}${node.opcode} [${node.id}]${Object.keys(node.fields || {}).length ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(node.fields).map(([name, field]) => [name, field.value]))) : ''}`);
      if (node.mutation?.proccode) lines.push(`${indent}  procedure ${JSON.stringify(node.mutation.proccode)}`);
      if (node.commentData) lines.push(`${indent}  comment ${JSON.stringify(node.commentData.text)}`);
      for (const [name, input] of Object.entries(node.inputs || {})) {
        if (input.block) {lines.push(`${indent}  ${name}:`); show(input.block, indent + '    ');}
        if (input.shadow && (!input.block || input.block.id !== input.shadow.id)) {lines.push(`${indent}  ${name} hidden shadow:`); show(input.shadow, indent + '    ');}
      }
    }
  };
  for (const target of result.targets) {
    lines.push(`target ${JSON.stringify(target.name)} [${target.id}]`);
    for (const type of ['variables', 'lists', 'broadcasts']) for (const resource of target[type]) lines.push(`  ${type} ${JSON.stringify(resource.name)} [${resource.id}] = ${JSON.stringify(resource.value)}`);
    for (const script of target.scripts) {lines.push(`  script [${script.root}] at ${script.position.x},${script.position.y}`); if (script.body) show(script.body, '    '); else lines.push(`    ${script.opcode} (${script.blockCount} blocks; read --script ${script.root})`);}
  }
  return {text: lines.join('\n')};
};
const find = (project, query, options = {}) => {
  if (typeof query !== 'string') fail('query must be a string', '$.query');
  const needle = query.toLowerCase(), matches = [];
  for (const target of options.target ? [project.target(options.target)] : originals(project)) {
    const graph = h.checkedGraph(target, project.vm.runtime, false);
    for (const block of graph.values()) {
      if (options.opcode && block.opcode !== options.opcode) continue;
      if (options.resource && !Object.values(block.fields).some(field => field.id === options.resource || field.value === options.resource)) continue;
      const comment = block.comment && target.comments[block.comment];
      if (!JSON.stringify([block.opcode, block.fields, block.mutation, comment?.text]).toLowerCase().includes(needle)) continue;
      let root = block; while (root.parent) root = graph.get(root.parent);
      matches.push({target: target.id, targetName: target.getName(), id: block.id, root: root.id, opcode: block.opcode,
        fields: clone(block.fields), ...(comment ? {comment: commentData(comment)} : {})});
    }
    for (const comment of Object.values(target.comments)) if (!comment.blockId && comment.text.toLowerCase().includes(needle)) matches.push({target: target.id, targetName: target.getName(), comment: commentData(comment)});
  }
  return matches;
};

const SAFE_COMMANDS = {
  sprite: ['list', 'select', 'set', 'rename', 'add', 'duplicate', 'delete', 'front', 'back'],
  var: ['list', 'add', 'set', 'rename', 'delete'], list: ['all', 'get', 'add', 'append', 'clear', 'set', 'insert', 'replace', 'remove', 'rename', 'delete'],
  broadcast: ['list', 'add', 'rename', 'delete'], comment: ['list', 'add', 'set', 'move', 'delete'],
  costume: ['list', 'add', 'use', 'rename', 'delete'], sound: ['list', 'add', 'rename', 'delete', 'effect', 'trim'],
  blocks: ['schema', 'list', 'inspect', 'count', 'find', 'field-menu', 'add', 'set-field', 'mutation', 'connect', 'disconnect', 'delete', 'clear', 'switch', 'position', 'cleanup', 'clean-up', 'procedure-add', 'procedure-call', 'procedure-edit', 'procedure-delete'],
  block: ['list', 'add', 'field', 'input', 'move', 'delete'], proc: ['list', 'define', 'call', 'rename', 'delete'], stage: ['info', 'tempo'],
  asset: ['list', 'info', 'duplicate', 'rename', 'delete', 'reorder', 'select', 'size', 'center', 'convert', 'blank', 'share', 'effect', 'trim', 'fade', 'mute', 'delete-range', 'keep-range', 'range'],
  targets: ['list', 'info', 'find', 'reorder', 'layer', 'draggable', 'effect', 'clear-effects', 'folder-create', 'folder-add', 'folder-remove', 'folder-rename', 'folder-remove-all'],
  monitor: ['list', 'add', 'set', 'delete']
};
const assertBatchCommand = argv => {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string') || !SAFE_COMMANDS[argv[0]]?.includes(argv[1])) fail('Command is not allowed in a project batch', '$.command', 'NOT_SUPPORTED');
  for (const arg of argv) if (/^--(?:project|out|output|force|allow|dir|file|config)(?:=|$)/.test(arg)) fail(`Option ${arg} is not allowed in a project batch`, '$.args', 'NOT_SUPPORTED');
  return argv;
};
const assertResourceDeletion = (project, argv) => {
  const {command, args, options} = require('./command-catalog').validateCommand(argv);
  if (command === 'proc' && args[0] === 'delete' || command === 'blocks' && args[0] === 'procedure-delete') {
    const target = project.target(options.target), graph = h.graphOf(target);
    const prototypes = [...graph.values()].filter(block => block.opcode === 'procedures_prototype' && (block.id === args[1] || block.parent === args[1] || block.mutation.proccode === args[1] || block.mutation.proccode.split(' %')[0] === args[1]));
    if (prototypes.length !== 1) throw resourceError(prototypes.length, `Procedure not found or ambiguous: ${args[1]}`, args[1]);
    const references = refs(target, graph, block => block.opcode === 'procedures_call' && block.mutation.proccode === prototypes[0].mutation.proccode);
    if (references.length) fail('Procedure is used by external call blocks', '$', 'RESOURCE_IN_USE', {references});
  }
  if (args[0] !== 'delete' || !['var', 'list', 'broadcast', 'costume', 'sound', 'asset', 'sprite'].includes(command)) return;
  const runtime = project.vm.runtime, target = command === 'broadcast' ? runtime.getTargetForStage() : project.target(options.target);
  let reference;
  if (['var', 'list', 'broadcast'].includes(command)) {
    const kind = {var: '', list: 'list', broadcast: 'broadcast_msg'}[command], resource = h.resource(target, runtime, args[1], kind);
    reference = field => field.id === resource.id;
  } else if (command === 'sprite') reference = field => field.value === target.getName();
  else {
    const kind = command === 'asset' ? args[1] : command, selector = command === 'asset' ? args[2] : args[1];
    const assets = ['costume', 'costumes', 'backdrop'].includes(kind) ? target.getCostumes() : target.getSounds();
    const candidates = assets.filter((asset, index) => asset.cliId === selector || asset.name === selector || String(index) === selector);
    if (candidates.length !== 1) throw resourceError(candidates.length, `Asset not found or ambiguous: ${selector}`, selector);
    const names = ['costume', 'costumes', 'backdrop'].includes(kind) ? target.isStage ? ['BACKDROP'] : ['COSTUME'] : ['SOUND_MENU'];
    reference = (field, name, owner) => names.includes(name) && (owner === target || target.isStage && names.includes('BACKDROP')) && field.value === candidates[0].name;
  }
  const references = originals(project).flatMap(owner => refs(owner, h.graphOf(owner), block => owner !== target || command !== 'sprite' ?
    Object.entries(block.fields).some(([name, field]) => reference(field, name, owner)) : false));
  if (references.length) fail('Resource is used by project blocks', '$', 'RESOURCE_IN_USE', {references});
};
const TYPES = ['block.update', 'script.add', 'script.replace', 'script.delete', 'procedure.define', 'procedure.update', 'procedure.delete', 'command'];
const validateDocument = document => {
  object(document, '$');
  const active = new Set(), pending = [{value: document, path: '$', depth: 0}];
  let visited = 0;
  while (pending.length) {
    const {value, path, depth, exit} = pending.pop();
    if (exit) {active.delete(value); continue;}
    if (++visited > 2000000) fail('Edit document exceeds JSON node limit', path);
    if (depth > 1536) fail('Edit document nesting exceeds limit', path);
    if (!value || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value) || ['function', 'symbol', 'bigint'].includes(typeof value)) fail('Expected finite JSON data', path);
      continue;
    }
    if (active.has(value)) fail('Edit document must not contain cycles', path);
    active.add(value); pending.push({value, exit: true});
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected plain JSON object', path);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsafe prototype key in edit document', `${path}.${key}`);
      if (descriptor.get || descriptor.set) fail('Accessor properties are not supported in edit documents', `${path}.${key}`);
      pending.push({value: descriptor.value, path: `${path}.${key}`, depth: depth + 1});
    }
  }
  for (const key of Object.keys(document)) if (!['version', 'baseRevision', 'operations'].includes(key)) fail(`Unknown edit document property ${key}`, `$.${key}`);
  if (JSON.stringify(document).length > 32 * 1024 * 1024) fail('Edit document exceeds 32 MiB', '$');
  if (document.version !== 1) fail('Expected edit document version 1', '$.version');
  if (document.baseRevision !== undefined && (typeof document.baseRevision !== 'string' || !/^[a-f0-9]{64}$/.test(document.baseRevision))) fail('baseRevision must be a SHA256 revision', '$.baseRevision');
  if (!Array.isArray(document.operations) || document.operations.length > 100000) fail('operations must be an array with at most 100000 entries', '$.operations');
  for (const [index, operation] of document.operations.entries()) {
    object(operation, `$.operations[${index}]`);
    if (!TYPES.includes(operation.op || operation.type)) fail('Unknown edit operation type', `$.operations[${index}].type`);
    const type = operation.op || operation.type;
    const keys = ['op', 'type', 'target', ...(type === 'block.update' ? ['id', 'inputs', 'fields', 'position'] : type.startsWith('script.') ? ['root', 'body'] :
      type.startsWith('procedure.') ? ['name', 'params', 'warp', 'returnType', 'newName'] : ['command', 'args'])];
    for (const key of Object.keys(operation)) if (!keys.includes(key)) fail(`Unknown operation property ${key}`, `$.operations[${index}].${key}`);
    if (operation.target !== undefined && typeof operation.target !== 'string') fail('target must be a string', `$.operations[${index}].target`);
    if (type === 'command') {
      if (operation.args !== undefined && (!Array.isArray(operation.args) || operation.args.some(arg => typeof arg !== 'string'))) fail('Command args must be a string array', `$.operations[${index}].args`);
      assertBatchCommand([operation.command, ...(operation.args || [])]);
    }
    if (type === 'block.update') for (const key of ['inputs', 'fields', 'position']) if (operation[key] !== undefined) object(operation[key], `$.operations[${index}].${key}`);
    if (operation.position) for (const [key, value] of Object.entries(operation.position)) if (!['x', 'y'].includes(key) || !Number.isFinite(value)) fail('Position requires finite x/y coordinates', `$.operations[${index}].position.${key}`);
  }
  return document;
};

// Rebuild only the selected target graph through the VM API; unsupported existing
// opcodes are retained as data. Their structural connections are still validated.
const install = (target, graph, runtime, comments) => {
  h.validateGraph(graph, runtime, false);
  h.applyGraph(target, graph, runtime, false);
  for (const comment of comments.values()) {
    if (comment.blockId && (!graph.has(comment.blockId) || graph.get(comment.blockId).comment !== comment.id)) continue;
    target.createComment(comment.id, comment.blockId, comment.text, comment.x, comment.y, comment.width, comment.height, comment.minimized);
  }
};
const compileBody = (body, target, graph, runtime, idMap, comments, operationIndex, parentId = null) => {
  const sequence = (nodes, parent, path, depth) => {
    if (!Array.isArray(nodes) || !nodes.length) fail('Script body must be a nonempty array', path);
    let root, previous;
    for (const [index, node] of nodes.entries()) {
      const block = build(node, previous?.id || parent, `${path}[${index}]`, depth + 1);
      if (!root) root = block;
      if (previous) previous.next = block.id;
      previous = block;
    }
    return root;
  };
  const build = (node, parent, path, depth) => {
    if (depth > 512) fail('Structured code exceeds nesting limit', path);
    object(node, path);
    if (typeof node.opcode !== 'string') fail('Node requires opcode', path + '.opcode');
    const id = node.id || crypto.randomUUID();
    if (typeof id !== 'string' || !id) fail('Node ID must be a nonempty string', path + '.id');
    if (graph.has(id)) {
      const existing = graph.get(id);
      // The active input and its shadow may contain the same shadow node twice.
      if (existing.shadow && node.shadow && existing.parent === (parent || null) && JSON.stringify(existing._sourceNode) === JSON.stringify(node)) return existing;
      fail(`Block ID already exists: ${id}`, path + '.id');
    }
    const block = h.newBlock(node.opcode, {id, parent: parent || null, topLevel: !parent, shadow: !!node.shadow,
      ...(node.mutation ? {mutation: clone(node.mutation)} : {}), ...(node.comment ? {comment: node.comment} : {})});
    const extras = clone(node); for (const key of ['id', 'opcode', 'fields', 'inputs', 'layout', 'position', 'shadow', 'mutation', 'comment', 'commentData']) delete extras[key];
    if (['next', 'parent', 'topLevel'].some(key => Object.hasOwn(extras, key))) fail('Use nested code instead of raw connection pointers', path);
    Object.assign(block, extras);
    if (node.layout) Object.assign(block, Object.fromEntries(Object.entries(node.layout).filter(([key]) => ['x', 'y'].includes(key))));
    graph.set(id, block); idMap[path] = id;
    Object.defineProperty(block, '_sourceNode', {value: node, configurable: true});
    if (graph.size > 100000) fail('Block graph exceeds 100000 blocks', path);
    let info; try {info = h.schema(block, runtime);} catch {if (!node.id || !target.blocks.getBlock(node.id) || target.blocks.getBlock(node.id).opcode !== node.opcode) fail(`Unknown/unloaded opcode: ${node.opcode}`, path, 'NOT_SUPPORTED');}
    const fields = node.fields || {};
    for (const [name, raw] of Object.entries(fields)) {
      const descriptor = raw && typeof raw === 'object' && !Array.isArray(raw);
      const original = node.id && target.blocks.getBlock(node.id);
      const prior = original?.opcode === node.opcode ? original.fields[name] : null;
      if (descriptor && prior && JSON.stringify(canonical(raw)) === JSON.stringify(canonical(prior))) {
        // Existing Scratch fields may intentionally contain nonstandard literal
        // values. Preserve those exactly only when the supplied data is unchanged.
        block.fields[name] = clone(raw); continue;
      }
      try {
        const type = h.resourceType(name), selector = descriptor ? type === undefined ? raw.value : raw.id ?? raw.value : raw;
        const value = h.validateField(target, block, name, selector, runtime);
        block.fields[name] = type === undefined ? {...(descriptor ? clone(raw) : {}), name, value} :
          {...(descriptor ? clone(raw) : {}), name, id: value, value: h.resource(target, runtime, value, type).name, variableType: type};
      } catch (error) {
        const details = errorInfo(error);
        throw new CommandError(details.code === 'INTERNAL_ERROR' ? 'INVALID_ARGUMENT' : details.code, error.message, details.hint,
          {...details.details, path: `${path}.fields.${name}`, target: target.id, id: block.id});
      }
    }
    if (info) for (const [name, fieldInfo] of Object.entries(info.fields)) if (!Object.hasOwn(block.fields, name)) {
      if (h.resourceType(name) !== undefined) fail(`Resource field ${name} must be explicit`, path + '.fields.' + name);
      const menu = h.fieldMenu(target, block, name, runtime); block.fields[name] = {name, value: menu[0]?.value ?? fieldInfo.default ?? ''};
    }
    const inputs = node.inputs || {};
    for (const [name, value] of Object.entries(inputs)) {
      if (info && !Object.hasOwn(info.inputs, name)) fail(`Unknown input ${name}`, path + '.inputs.' + name);
      const location = path + '.inputs.' + name;
      if (value === null) {block.inputs[name] = {name, block: null, shadow: null}; continue;}
      if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'opcode') && (Object.hasOwn(value, 'block') || Object.hasOwn(value, 'shadow'))) {
        const active = value.block ? Array.isArray(value.block) ? sequence(value.block, id, location + '.block', depth + 1) : build(value.block, id, location + '.block', depth + 1) : null;
        const shadow = value.shadow ? build(value.shadow, id, location + '.shadow', depth + 1) : null;
        block.inputs[name] = {...clone(value), name, block: active?.id || null, shadow: shadow?.id || null};
      } else if (Array.isArray(value) || value && typeof value === 'object') {
        const child = Array.isArray(value) ? sequence(value, id, location, depth + 1) : build(value, id, location, depth + 1);
        block.inputs[name] = {name, block: child.id, shadow: child.shadow ? child.id : null};
      } else if (!h.menuInput(graph, block, name, value, target, runtime)) h.literalInput(graph, block, name, value, info?.inputs[name], ['COLOR', 'COLOR2'].includes(name) ? 'colour_picker' : undefined);
    }
    if (info) for (const name of Object.keys(info.inputs)) if (!Object.hasOwn(block.inputs, name)) block.inputs[name] = {name, block: null, shadow: null};
    if (node.commentData) {
      const comment = clone(node.commentData); comment.id ||= block.comment || crypto.randomUUID(); comment.blockId = id;
      block.comment = comment.id; comments.set(comment.id, comment);
    }
    return block;
  };
  const wrapped = !Array.isArray(body) && body?.body ? body : {body};
  const root = sequence(wrapped.body, parentId, `$.operations[${operationIndex}].body`, 0);
  if (wrapped.position) Object.assign(root, wrapped.position);
  return root;
};
const applyOperations = async (session, document) => {
  validateDocument(document);
  const before = revision(session.project);
  if (document.baseRevision && before !== document.baseRevision) fail('Project revision changed since reading', '$.baseRevision', 'PROJECT_CONFLICT', {expected: document.baseRevision, actual: before});
  const results = [], idMap = Object.create(null);
  for (const [index, operation] of document.operations.entries()) {
    const type = operation.op || operation.type;
    try {
      if (type === 'command') {
        const argv = [operation.command, ...(operation.args || [])];
        if (operation.target !== undefined) {
          const catalog = require('./command-catalog'), parsed = catalog.validateCommand(argv);
          const rule = catalog.commandSpecs[operation.command][parsed.args[0]];
          if (rule.options.includes('target')) {
            const target = session.project.target(operation.target);
            if (parsed.options.target && session.project.target(parsed.options.target).id !== target.id) fail('Command target conflicts with operation target');
            if (!parsed.options.target) argv.push('--target', target.id);
          }
        }
        assertBatchCommand(argv);
        assertResourceDeletion(session.project, argv);
        results.push(await session.execute(argv)); continue;
      }
      const target = session.project.target(operation.target), runtime = session.project.vm.runtime;
      if (type.startsWith('procedure.')) {
        if (typeof operation.name !== 'string' || !operation.name) fail('Procedure requires name');
        const args = [type === 'procedure.define' ? 'procedure-add' : type === 'procedure.update' ? 'procedure-edit' : 'procedure-delete', operation.name];
        const options = {target: target.id};
        if (operation.params !== undefined) options.params = JSON.stringify(operation.params);
        if (operation.warp !== undefined) options.warp = String(operation.warp);
        if (operation.type !== undefined && operation.type !== type) options.type = operation.type;
        if (operation.returnType !== undefined) options.type = operation.returnType;
        if (operation.newName !== undefined) options.name = operation.newName;
        try {results.push(await blocks.execute(session, 'blocks', args, options));} catch (error) {
          if (/external call/.test(error.message)) throw new CommandError('RESOURCE_IN_USE', error.message, '先移除调用或修改引用。', {references: refs(target, h.graphOf(target), block => block.opcode === 'procedures_call' && block.mutation.proccode.split(' %')[0] === operation.name)});
          throw error;
        }
        continue;
      }
      const graph = h.graphOf(target), comments = new Map(Object.values(target.comments).map(comment => [comment.id, commentData(comment)]));
      if (type === 'block.update') {
        const block = graph.get(operation.id); if (!block) throw resourceError(0, `Block not found: ${operation.id}`, operation.id);
        if (operation.position) {if (!block.topLevel) fail('Position applies only to a top-level stack'); Object.assign(block, operation.position);}
        if (operation.fields) for (const [name, raw] of Object.entries(operation.fields)) {
          const value = h.validateField(target, block, name, raw && typeof raw === 'object' ? raw.id || raw.value : raw, runtime), kind = h.resourceType(name);
          block.fields[name] = kind === undefined ? {name, value} : {name, id: value, value: h.resource(target, runtime, value, kind).name, variableType: kind};
          if (block.opcode === 'control_stop' && name === 'STOP_OPTION') block.mutation = {tagName: 'mutation', children: [], hasnext: String(value === 'other scripts in sprite')};
          if (block.opcode === 'sensing_of_object_menu' && name === 'OBJECT' && block.parent) {
            const parent = graph.get(block.parent);
            if (parent.opcode === 'sensing_of') parent.fields.PROPERTY.value = value === '_stage_' ? 'backdrop #' : 'x position';
          }
        }
        if (operation.inputs) for (const [name, value] of Object.entries(operation.inputs)) {
          const info = h.schema(block, runtime); if (!Object.hasOwn(info.inputs, name)) fail(`Unknown input ${name}`);
          const prior = block.inputs[name];
          // Simple literals update their original shadow in place, retaining ID.
          const leaf = prior?.shadow && graph.get(prior.shadow);
          if (leaf?.shadow && ['string', 'number'].includes(typeof value) && ['math_number', 'math_integer', 'math_positive_number', 'math_whole_number', 'math_angle', 'text', 'colour_picker'].includes(leaf.opcode) && !h.menuInputs[block.opcode]?.[name]) {
            if (info.inputs[name] !== 'value') fail(`Input ${name} does not accept a scalar literal`);
            if (prior.block && prior.block !== prior.shadow) for (const child of h.descendants(graph, prior.block)) graph.delete(child);
            const field = Object.values(leaf.fields)[0]; field.value = leaf.opcode === 'colour_picker' ? h.validateField(target, leaf, field.name, value, runtime) : String(value);
            prior.block = prior.shadow;
          } else {
            for (const id of new Set([prior?.block, prior?.shadow].filter(Boolean))) for (const child of h.descendants(graph, id)) graph.delete(child);
            if (value === null) block.inputs[name] = {name, block: null, shadow: null};
            else if (value && typeof value === 'object') {
              const descriptor = !Array.isArray(value) && !Object.hasOwn(value, 'opcode') && (Object.hasOwn(value, 'block') || Object.hasOwn(value, 'shadow')) ? value : {block: value};
              const child = descriptor.block ? compileBody(Array.isArray(descriptor.block) ? descriptor.block : [descriptor.block], target, graph, runtime, idMap, comments, index, block.id) : null;
              const shadow = descriptor.shadow ? compileBody([descriptor.shadow], target, graph, runtime, idMap, comments, index, block.id) : null;
              block.inputs[name] = {name, block: child?.id || null, shadow: shadow?.id || (child?.shadow ? child.id : null)};
            } else if (!h.menuInput(graph, block, name, value, target, runtime)) h.literalInput(graph, block, name, value, info.inputs[name]);
          }
        }
        results.push({type, target: target.id, id: block.id});
      } else {
        if (type !== 'script.add') {
          const root = graph.get(operation.root); if (!root?.topLevel) throw resourceError(0, `Script root not found: ${operation.root}`, operation.root);
          const removed = h.descendants(graph, root.id);
          if (root.opcode === 'procedures_definition') {
            const prototype = graph.get(root.inputs.custom_block.block), references = refs(target, graph, block => !removed.has(block.id) && block.opcode === 'procedures_call' && block.mutation.proccode === prototype.mutation.proccode);
            if (references.length && type === 'script.delete') fail('Procedure is used by external call blocks', '$', 'RESOURCE_IN_USE', {references});
          }
          for (const id of removed) graph.delete(id);
        }
        const root = type === 'script.delete' ? null : compileBody(operation.body, target, graph, runtime, idMap, comments, index);
        results.push({type, target: target.id, root: root?.id || operation.root});
      }
      // Validate before the graph reaches the VM, including known shape checks.
      const original = target.blocks._blocks; target.blocks._blocks = Object.fromEntries(graph);
      try {validateTarget(target, runtime);} finally {target.blocks._blocks = original;}
      install(target, graph, runtime, comments);
    } catch (error) {
      const info = errorInfo(error), details = {...info.details, operation: index, path: info.details.path === '$' || !info.details.path ? `$.operations[${index}]` : info.details.path,
        ...(operation.target ? {target: operation.target} : {}), ...(operation.id ? {id: operation.id} : {})};
      throw new CommandError(info.code === 'INTERNAL_ERROR' ? 'INVALID_ARGUMENT' : info.code, error.message, info.hint, details);
    }
  }
  const checked = validate(session.project), after = revision(session.project);
  return {changed: before !== after, revision: after, operations: results, idMap, diagnostics: checked.diagnostics};
};

module.exports = {read, find, revision, validate, validateDocument, applyOperations, assertBatchCommand};
