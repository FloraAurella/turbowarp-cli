'use strict';

const path = require('node:path');
const {atomicWrite, readLocalFile} = require('./project');
const {parseJSON} = require('./permission-policy');
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const blocks = require('./block-commands');
const MonitorRecord = require('scratch-vm/src/engine/monitor-record');
const {checkedGraph, graphOf, applyGraph, descendants, schema, resource, resourceType, clone} = blocks.helpers;
const {resourceError} = require('./errors');
const inventory = require('../docs/addons-inventory.json');
const manifests = new Map(inventory.addons.map(addon => [addon.id, addon]));
if (inventory.count !== 81 || manifests.size !== 81) throw new Error('Frozen addon inventory must contain exactly81 unique manifests');
const specs = require('./command-catalog').moduleSpecs['addon-commands.js'];
const booleanOptions = ['delete-orphans', 'delete-unused'];
const configurationActions = new Set(['list', 'inspect', 'get', 'enabled', 'setting', 'default', 'defaults', 'reset', 'reset-setting', 'presets', 'preset', 'commands']);
const semanticReads = new Set(['block-count', 'find', 'variables', 'copy-single', 'copy-all']);
const manifest = id => {
  if (!manifests.has(id)) throw new Error(`Unknown frozen addon: ${id}`);
  return manifests.get(id);
};
const bool = value => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('Expected true/false');
};
const numeric = (value, label) => {
  if (value === undefined || value === '' || !Number.isFinite(Number(value))) throw new Error(`${label} must be finite`);
  return Number(value);
};
const defaults = addon => ({enabled: !!addon.enabledByDefault,
  settings: Object.fromEntries(addon.settings.map(setting => [setting.id, clone(setting.default)]))});
const validateSetting = (setting, input, fromCLI = false) => {
  let value = input;
  if (fromCLI && setting.type === 'boolean') value = bool(input);
  if (fromCLI && ['integer', 'positive_integer'].includes(setting.type)) {
    if (!/^-?\d+$/.test(String(input))) throw new Error(`Setting ${setting.id} requires an integer`);
    value = Number(input);
  }
  if (setting.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Setting ${setting.id} requires a boolean`);
  } else if (setting.type === 'integer' || setting.type === 'positive_integer') {
    if (!Number.isSafeInteger(value) || (setting.type === 'positive_integer' && value <= 0) ||
      (setting.min !== undefined && value < setting.min) || (setting.max !== undefined && value > setting.max)) {
      throw new Error(`Setting ${setting.id} outside integer range ${setting.min ?? (setting.type === 'positive_integer' ? 1 : '-inf')}..${setting.max ?? 'inf'}`);
    }
  } else if (setting.type === 'select') {
    if (!setting.potentialValues.some(option => option.id === value)) throw new Error(`Invalid selection for ${setting.id}`);
  } else if (setting.type === 'color') {
    if (typeof value !== 'string' || (!/^#[\da-f]{6}$/i.test(value) && !(setting.allowTransparency && (/^#[\da-f]{8}$/i.test(value) || value === 'transparent')))) throw new Error(`Setting ${setting.id} requires #rrggbb${setting.allowTransparency ? ', #rrggbbaa or transparent' : ''}`);
  } else if (setting.type === 'untranslated') {
    if (typeof value !== 'string' || [...value].length > (setting.max ?? 1024)) throw new Error(`Setting ${setting.id} requires text, max${setting.max ?? 1024} characters`);
  } else throw new Error(`Unsupported frozen setting type: ${setting.type}`);
  return value;
};
const blankConfig = () => ({format: 'tw-cli-addons', version: 1,
  addons: Object.fromEntries(inventory.addons.map(addon => [addon.id, defaults(addon)]))});
const validateConfig = value => {
  if (!value || value.format !== 'tw-cli-addons' || value.version !== 1 || !value.addons || typeof value.addons !== 'object' || Array.isArray(value.addons)) throw new Error('Expected explicit tw-cli-addons version1 configuration');
  for (const key of Object.keys(value)) if (!['format', 'version', 'addons'].includes(key)) throw new Error(`Unknown config property ${key}`);
  const result = blankConfig();
  for (const [id, state] of Object.entries(value.addons)) {
    const addon = manifest(id);
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.enabled !== 'boolean' || !state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) throw new Error(`Invalid config for ${id}`);
    for (const key of Object.keys(state)) if (!['enabled', 'settings'].includes(key)) throw new Error(`Unknown addon config property ${key}`);
    result.addons[id].enabled = state.enabled;
    for (const [key, settingValue] of Object.entries(state.settings)) {
      const setting = addon.settings.find(item => item.id === key);
      if (!setting) throw new Error(`Unknown setting ${id}.${key}`);
      result.addons[id].settings[key] = validateSetting(setting, settingValue);
    }
  }
  return result;
};
const readConfig = async (filename, writable = false) => {
  if (!filename) {
    if (writable) throw new Error('Configuration writes require an explicit --config file.json; no IndexedDB or implicit home path');
    return {value: blankConfig(), exists: false};
  }
  if (path.extname(filename).toLowerCase() === '.sb3') throw new Error('Addon --config must not be an SB3 project file');
  try {
    const bytes = await readLocalFile(filename, MAX_CONFIG_BYTES);
    return {value: validateConfig(parseJSON(bytes.toString('utf8'))), exists: true};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {value: blankConfig(), exists: false};
  }
};
const equivalences = {
  'block-count': ['blocks count', 'addon block-count'],
  'find-bar': ['blocks find <query>', 'addon find <query> --kind blocks|costumes|sounds|all'],
  'block-duplicate': ['blocks duplicate <id> --mode stack|single'],
  'block-cherry-picking': ['blocks disconnect <id> --single --heal'],
  'block-switching': ['blocks switch <id> <opcode>', 'blocks set-field <argument-id> VALUE <name>'],
  'editor-devtools': ['addon cleanup-plus [--delete-orphans] [--delete-unused] [--make-space <root>]',
    'addon replace-variable <old-id> <new-id>', 'addon copy-single <id> [--output file.json]', 'addon copy-all [--output file.json]',
    'addon cut-single <id> [--output file.json]', 'addon paste-at [file.json] --at x,y', 'addon costume-next', 'addon costume-previous'],
  'paint-snap': ['addon snap-move <costume> <node-id> <dx> <dy> [--config file.json]',
    'addon snap-scale <costume> <node-id> <sx> [sy] [--config file.json]'],
  'swap-local-global': ['addon swap-scope <var-or-list-id> global|local [--cloud true|false]'],
  'rename-broadcasts': ['addon rename-broadcast <id-or-name> <new-name>'],
  'initialise-sprite-position': ['addon initial-sprite --config file.json', 'addon initial-sprite --x 20 --y 40'],
  'move-to-top-layer': ['addon move-layer front|back'],
  'move-to-top-bottom': ['asset reorder costume|sound <asset-name-or-index> <zero-based-destination-index>'],
  'variable-manager': ['addon variables [query]', 'addon set-variable <id> <value>', 'addon set-list <id> <newline-text>', 'addon rename-variable <id> <name>'],
  'color-picker': ['blocks set-field <id> COLOUR #rrggbb'],
  'editor-searchable-dropdowns': ['blocks field-menu <id> <field>'],
  'script-snap': ['blocks move <id> <x> <y>'],
  'no-script-bumping': ['blocks connect <id> --after <parent>', 'blocks move <id> <x> <y>'],
  'jump-to-def': ['blocks find --opcode procedures_prototype'],
  'reorder-custom-inputs': ['blocks procedure-edit <proccode> --params <ordered-json>']
};
const semanticLimits = {
  'block-switching': 'Core frozen related conversions and explicit shape-safe input/field maps; debugger custom logging procedures are not implicitly executed.',
  'editor-devtools': 'Deterministic columns use semantic height estimates, not Blockly pixel metrics. Deletion needs explicit flags. Disabled injection UI is not evaluated.',
  'paint-snap': 'Delegates to reviewed paint engine; unsupported SVG geometry is refused, guides/UI and popover double-click threshold bug are not simulated.',
  'swap-local-global': 'Preserves ID/value/monitor, refuses cross-sprite local use and shadowing/conflicts. Cloud conversion is local provider only.',
  'initialise-sprite-position': 'Explicit application to selected sprite; no monkey-patching future add/duplicate callbacks. Randomization and frozen truthiness quirks are not claimed.',
  'find-bar': 'Structured search only; viewport navigation and history are not implemented.'
};
const indexEntry = addon => ({id: addon.id, disposition: addon.disposition, commands: equivalences[addon.id] || [],
  implementation: equivalences[addon.id] ? 'explicit-semantic-commands' : addon.disposition === 'not-applicable' ? 'configuration-only-no-semantic-effect' : 'configuration-only-actions-not-implemented',
  boundary: semanticLimits[addon.id] || addon.reason, source: addon.source,
  userscriptExecuted: false, domEnabled: false});
const configResult = (addon, state, filename) => ({id: addon.id, ...clone(state), config: filename ? path.resolve(filename) : null,
  disposition: addon.disposition, semanticEffect: addon.disposition === 'not-applicable' ? 'no semantic effect' : 'configuration stored; semantic commands are explicit, not auto-enabled',
  userscriptExecuted: false, domEnabled: false, commands: equivalences[addon.id] || []});
const configuration = async (args, options) => {
  const [action, id, key, input] = args;
  if (action === 'commands') return id ? indexEntry(manifest(id)) : inventory.addons.map(indexEntry);
  if (action === 'default' || action === 'defaults') return id ? configResult(manifest(id), defaults(manifest(id))) : blankConfig();
  const writes = ['reset', 'reset-setting', 'preset'].includes(action) || (action === 'enabled' && key !== undefined) || (action === 'setting' && input !== undefined) || (action === 'presets' && key !== undefined);
  const {value: config, exists} = await readConfig(options.config, writes);
  if (action === 'list') return inventory.addons.map(addon => configResult(addon, config.addons[addon.id], options.config));
  if (action === 'reset' && !id) {
    const file = await atomicWrite(options.config, Buffer.from(JSON.stringify(blankConfig(), null, 2) + '\n'), exists);
    return {...file, reset: 'all81', userscriptExecuted: false, domEnabled: false};
  }
  const addon = manifest(id), state = config.addons[id];
  if (action === 'inspect' || action === 'get') return {...configResult(addon, state, options.config),
    manifest: clone(addon), defaults: defaults(addon), equivalence: indexEntry(addon)};
  if (action === 'enabled') {
    if (key === undefined) return configResult(addon, state, options.config);
    state.enabled = bool(key);
  } else if (action === 'setting' || action === 'reset-setting') {
    const setting = addon.settings.find(item => item.id === key);
    if (!setting) throw new Error(`Unknown setting ${id}.${key}`);
    if (action === 'setting' && input === undefined) return {id, setting: key, value: clone(state.settings[key]), default: clone(setting.default), type: setting.type, config: options.config ? path.resolve(options.config) : null};
    state.settings[key] = action === 'reset-setting' ? clone(setting.default) : validateSetting(setting, input, true);
  } else if (action === 'reset') config.addons[id] = defaults(addon);
  else if (action === 'presets' || action === 'preset') {
    if (key === undefined) return {id, presets: clone(addon.presets)};
    const preset = addon.presets.find(item => item.id === key);
    if (!preset) throw new Error(`Unknown preset ${id}.${key}`);
    for (const [name, settingValue] of Object.entries(preset.values)) {
      const setting = addon.settings.find(item => item.id === name);
      if (!setting) throw new Error('Frozen preset refers to an unknown setting');
      state.settings[name] = validateSetting(setting, settingValue);
    }
  } else throw new Error(`Unsupported addon configuration action ${action}`);
  const file = await atomicWrite(options.config, Buffer.from(JSON.stringify(validateConfig(config), null, 2) + '\n'), exists);
  return {...configResult(addon, config.addons[id], options.config), saved: file};
};
const visibleVariables = (target, runtime) => {
  const owners = target.isStage ? [target] : [target, runtime.getTargetForStage()];
  return owners.flatMap(owner => Object.values(owner.variables).map(variable => ({owner, variable})));
};
const getVariable = (target, runtime, selector) => {
  const candidates = visibleVariables(target, runtime).filter(item => item.variable.type !== 'broadcast_msg');
  const byId = candidates.find(item => item.variable.id === selector);
  if (byId) return byId;
  const byName = candidates.filter(item => item.variable.name === selector);
  if (byName.length !== 1) throw resourceError(byName.length, `Variable/list not found or ambiguous: ${selector}`, selector);
  return byName[0];
};
const renameBroadcast = async (session, selector, newName) => {
  const vm = session.project.vm, runtime = vm.runtime, stage = runtime.getTargetForStage();
  const old = resource(stage, runtime, selector, 'broadcast_msg');
  newName = newName?.trim(); if (!newName) throw new Error('Broadcast name must not be empty');
  const existing = Object.values(stage.variables).find(variable => variable.type === 'broadcast_msg' && variable.name.toLowerCase() === newName.toLowerCase() && variable.id !== old.id);
  if (existing) newName = existing.name;
  const targets = runtime.targets.filter(item => item.isOriginal);
  for (const target of targets) checkedGraph(target, runtime);
  if (!existing) {stage.renameVariable(old.id, newName); vm.setVariableValue(stage.id, old.id, newName);}
  const selected = runtime.getEditingTarget();
  try {
    for (const target of targets) {
      // VM.setEditingTarget also emits workspace XML and deletes unreferenced
      // broadcasts. Use the engine context API while applying semantic events.
      runtime.setEditingTarget(target);
      for (const block of Object.values(target.blocks._blocks)) if (block.fields.BROADCAST_OPTION?.id === old.id) {
        target.blocks.changeBlock({id: block.id, element: 'field', name: 'BROADCAST_OPTION', value: existing?.id || old.id});
      }
    }
  } finally {runtime.setEditingTarget(selected);}
  if (existing) stage.deleteVariable(old.id);
  stage.blocks.emitProjectChanged();
  return {id: existing?.id || old.id, name: newName, merged: !!existing};
};
const swapScope = (session, target, selector, scope, options) => {
  if (!['global', 'local'].includes(scope)) throw new Error('Scope must be global/local');
  const runtime = session.project.vm.runtime, stage = runtime.getTargetForStage(), {owner, variable} = getVariable(target, runtime, selector);
  const destination = scope === 'global' ? stage : target;
  const cloud = options.cloud === undefined ? !!variable.isCloud : bool(options.cloud);
  if (scope === 'local' && target.isStage) throw new Error('Stage cannot own local variables');
  if (cloud && (scope !== 'global' || variable.type !== '')) throw new Error('Cloud variable must be a global scalar');
  const targets = runtime.targets.filter(item => item.isOriginal);
  for (const current of targets) checkedGraph(current, runtime);
  const users = targets.filter(current => Object.values(current.blocks._blocks).some(block => block.fields.VARIABLE?.id === variable.id || block.fields.LIST?.id === variable.id ||
    (block.opcode === 'sensing_of' && block.fields.PROPERTY?.value === variable.name && current.blocks.getBlock(block.inputs.OBJECT?.block)?.fields.OBJECT?.value === (owner.isStage ? '_stage_' : owner.getName()))));
  if (scope === 'local' && users.some(current => current !== target)) throw new Error(`Variable used by other targets: ${users.filter(current => current !== target).map(current => current.getName()).join(', ')}`);
  let name = variable.name;
  if (cloud && !variable.isCloud) name = `☁ ${name}`;
  if (!cloud && variable.isCloud && name.startsWith('☁ ')) name = name.slice(2);
  const conflicts = targets.filter(current => Object.values(current.variables).some(item => item.id !== variable.id && item.type === variable.type && item.name === name) &&
    (scope === 'global' || current === target || current.isStage));
  if (conflicts.length) throw new Error(`Variable scope/name conflict: ${conflicts.map(current => current.getName()).join(', ')}`);
  if (cloud && !variable.isCloud) {
    const localCloud = require('./local-cloud'); localCloud.validateName(name); localCloud.validateValue(variable.value);
    if (!runtime.canAddCloudVariable()) throw new Error('Cloud variable limit reached');
  }
  if (owner === destination && cloud === !!variable.isCloud) return {id: variable.id, name, scope, cloud, changed: false};
  const monitor = runtime.getMonitorState().get(variable.id), monitorBlock = runtime.monitorBlocks.getBlock(variable.id);
  const value = clone(variable.value), savedBlock = monitorBlock ? clone(monitorBlock) : null;
  owner.deleteVariable(variable.id); destination.createVariable(variable.id, name, variable.type, cloud);
  session.project.vm.setVariableValue(destination.id, variable.id, value);
  const selected = runtime.getEditingTarget();
  try {
    for (const current of targets) {
      runtime.setEditingTarget(current);
      for (const block of Object.values(current.blocks._blocks)) {
        const fieldName = block.fields.VARIABLE?.id === variable.id ? 'VARIABLE' : block.fields.LIST?.id === variable.id ? 'LIST' : null;
        if (fieldName) current.blocks.changeBlock({id: block.id, element: 'field', name: fieldName, value: variable.id});
      }
    }
  } finally {runtime.setEditingTarget(selected);}
  if (savedBlock) {
    savedBlock.targetId = scope === 'local' ? target.id : null;
    const key = variable.type === 'list' ? 'LIST' : 'VARIABLE'; savedBlock.fields[key].value = name;
    runtime.monitorBlocks.createBlock(savedBlock);
  }
  if (monitor) runtime.requestAddMonitor(new MonitorRecord({...monitor, targetId: scope === 'local' ? target.id : null,
    spriteName: scope === 'local' ? target.getName() : null, params: {[variable.type === 'list' ? 'LIST' : 'VARIABLE']: name}}));
  destination.blocks.emitProjectChanged();
  return {id: variable.id, name, scope, cloud, changed: true};
};
const cleanupPlus = (session, target, options) => {
  const runtime = session.project.vm.runtime, graph = checkedGraph(target, runtime), roots = [...graph.values()].filter(block => block.topLevel);
  const orphanRoots = roots.filter(block => ['value', 'boolean'].includes(schema(block, runtime).shape));
  const removedBlocks = [], removedVariables = [];
  if (options['delete-orphans']) for (const root of orphanRoots) for (const id of descendants(graph, root.id)) {graph.delete(id); removedBlocks.push(id);}
  const columns = [];
  for (const block of roots.filter(block => graph.has(block.id))) {
    let best = null, distance = 256;
    for (const column of columns) if (Math.abs(column.x - block.x) < distance) {distance = Math.abs(column.x - block.x); best = column;}
    if (best) {best.x = (best.x * best.blocks.length + block.x) / (best.blocks.length + 1); best.blocks.push(block);}
    else columns.push({x: block.x, blocks: [block]});
  }
  columns.sort((a, b) => a.x - b.x);
  const gap = numeric(options.gap ?? 72, 'Gap'); if (gap < 0) throw new Error('Gap must be nonnegative');
  let x = 48;
  if (options['make-space'] && !graph.has(options['make-space'])) throw new Error('make-space root not found');
  for (const column of columns) {
    let y = 64, width = 320;
    column.blocks.sort((a, b) => a.y - b.y);
    for (const block of column.blocks) {
      block.x = x; block.y = y;
      const extra = block.id === options['make-space'];
      y += descendants(graph, block.id).size * 40 + (extra ? 480 : gap); if (extra) width += 380;
    }
    x += width + 96;
  }
  const used = new Set([...graph.values()].flatMap(block => Object.values(block.fields).map(field => field.id)).filter(Boolean));
  if (options['delete-unused'] && !target.isStage) {
    for (const variable of Object.values(target.variables)) if (['', 'list'].includes(variable.type) && !used.has(variable.id)) {
      // sensing_of uses a name rather than an ID. Treat that as a real reference too.
      const indirect = runtime.targets.some(current => Object.values(current.blocks._blocks).some(block => block.opcode === 'sensing_of' && block.fields.PROPERTY?.value === variable.name && current.blocks.getBlock(block.inputs.OBJECT?.block)?.fields.OBJECT?.value === target.getName()));
      if (!indirect) removedVariables.push(variable.id);
    }
  }
  applyGraph(target, graph, runtime);
  for (const id of removedVariables) {target.deleteVariable(id); target.blocks.emitProjectChanged();}
  return {columns: columns.length, removedBlocks, removedVariables, orphanCandidates: orphanRoots.map(block => block.id),
    boundary: 'Frozen256 column grouping; explicit deletion flags; semantic height estimates, not Blockly pixel geometry'};
};
const execute = async (session, command, args, options = {}) => {
  if (command !== 'addon' || !Object.hasOwn(specs.addon, args[0])) throw new Error('Unknown addon command');
  if (configurationActions.has(args[0])) return configuration(args, options);
  const [action, selector, a, b, c] = args, vm = session.project.vm, runtime = vm.runtime, target = session.project.target(options.target);
  if (action === 'block-count') return blocks.execute(session, 'blocks', ['count'], options);
  if (action === 'switch') return blocks.execute(session, 'blocks', ['switch', selector, a], options);
  if (action === 'rename-broadcast') return renameBroadcast(session, selector, a);
  if (action === 'copy-single' || action === 'copy-all' || action === 'cut-single' || action === 'paste-at') {
    const delegated = action === 'paste-at' ? ['paste', ...(selector ? [selector] : [])] : action === 'copy-all' ? ['copy'] : [action === 'cut-single' ? 'cut' : 'copy', selector, ...(a ? [a] : [])];
    return blocks.execute(session, 'blocks', delegated, {...options, mode: action === 'copy-all' || action === 'paste-at' ? 'stack' : 'single'});
  }
  if (action === 'find') {
    const kind = options.kind || 'all';
    if (!['all', 'blocks', 'costumes', 'sounds'].includes(kind)) throw new Error('Find kind must be all/blocks/costumes/sounds');
    const matches = kind === 'blocks' || kind === 'all' ? (await blocks.execute(session, 'blocks', ['find', selector], options)).map(item => ({kind: 'blocks', ...item})) : [];
    const targets = options.target ? [target] : runtime.targets.filter(item => item.isOriginal), query = selector.toLowerCase();
    for (const current of targets) for (const assetKind of ['costumes', 'sounds']) if (kind === 'all' || kind === assetKind) {
      const assets = assetKind === 'costumes' ? current.getCostumes() : current.getSounds();
      assets.forEach((asset, index) => {if (asset.name.toLowerCase().includes(query)) matches.push({kind: assetKind, target: current.id, targetName: current.getName(), name: asset.name, index});});
    }
    return matches;
  }
  if (action === 'initial-sprite') {
    if (target.isStage) throw new Error('Initial position requires a sprite');
    const {value: config} = await readConfig(options.config), settings = config.addons['initialise-sprite-position'].settings;
    const x = numeric(options.x ?? settings.x, 'x'), y = numeric(options.y ?? settings.y, 'y');
    target.setXY(x, y); target.blocks.emitProjectChanged(); return {id: target.id, x, y, applied: 'explicit current sprite only'};
  }
  if (action === 'move-layer') {
    if (target.isStage) throw new Error('Stage cannot change sprite layer');
    if (['front', 'back'].includes(selector) && a !== undefined) throw new Error('front/back do not accept a layer count');
    if (selector === 'front') target.goToFront(); else if (selector === 'back') target.goToBack();
    else if (selector === 'forward' || selector === 'backward') {
      const layers = numeric(a ?? 1, 'Layers'); if (!Number.isSafeInteger(layers) || layers < 1) throw new Error('Layers must be positive integer');
      target.goForwardLayers(selector === 'forward' ? layers : -layers);
    } else throw new Error('Layer must be front/back/forward/backward');
    target.blocks.emitProjectChanged(); return {id: target.id, layer: target.getLayerOrder()};
  }
  if (action === 'variables') return visibleVariables(target, runtime).filter(({variable}) => variable.type !== 'broadcast_msg' && (!selector || variable.name.toLowerCase().includes(selector.toLowerCase())))
    .map(({owner, variable}) => ({...clone(variable), scope: owner.isStage ? 'global' : 'local', target: owner.id}));
  if (['set-variable', 'set-list', 'rename-variable'].includes(action)) {
    const {owner, variable} = getVariable(target, runtime, selector);
    if (action === 'rename-variable') {
      const name = a?.trim(); if (!name) throw new Error('Variable name must not be empty');
      if (variable.isCloud) require('./local-cloud').validateName(name);
      if (Object.values(owner.variables).some(item => item !== variable && item.type === variable.type && item.name === name)) throw new Error('Variable name conflict');
      owner.renameVariable(variable.id, name);
      for (const current of runtime.targets.filter(item => item.isOriginal)) await session.onTarget(current, true, () => {
        for (const block of Object.values(current.blocks._blocks)) for (const fieldName of ['VARIABLE', 'LIST']) if (block.fields[fieldName]?.id === variable.id) current.blocks.changeBlock({id: block.id, element: 'field', name: fieldName, value: variable.id});
      });
    } else {
      if ((action === 'set-list') !== (variable.type === 'list')) throw new Error('Use set-list for lists, set-variable for scalars');
      const value = action === 'set-list' ? a.split('\n') : a;
      if (variable.isCloud) require('./local-cloud').validateValue(value);
      vm.setVariableValue(owner.id, variable.id, value);
    }
    owner.blocks.emitProjectChanged(); return clone(variable);
  }
  if (action === 'replace-variable') {
    const old = getVariable(target, runtime, selector).variable, replacement = getVariable(target, runtime, a).variable;
    if (old.type !== replacement.type) throw new Error('Reference replacement requires matching variable/list types');
    checkedGraph(target, runtime); let count = 0;
    for (const block of Object.values(target.blocks._blocks)) for (const fieldName of ['VARIABLE', 'LIST']) if (block.fields[fieldName]?.id === old.id) {
      target.blocks.changeBlock({id: block.id, element: 'field', name: fieldName, value: replacement.id}); count++;
    }
    return {old: old.id, replacement: replacement.id, count};
  }
  if (action === 'swap-scope') return swapScope(session, target, selector, a, options);
  if (action === 'cleanup-plus') return cleanupPlus(session, target, options);
  if (action === 'costume-next' || action === 'costume-previous') {
    const count = target.getCostumes().length; if (!count) throw new Error('No costumes');
    target.setCostume((target.currentCostume + (action === 'costume-next' ? 1 : count - 1)) % count);
    target.blocks.emitProjectChanged(); return {index: target.currentCostume};
  }
  if (action === 'snap-move' || action === 'snap-scale') {
    const {value: config} = await readConfig(options.config), snapSettings = {...config.addons['paint-snap'].settings,
      enabled: true, zoom: numeric(options.zoom ?? 1, 'Zoom')};
    if (snapSettings.zoom <= 0) throw new Error('Zoom must be positive');
    if (options.threshold !== undefined) snapSettings.threshold = validateSetting(manifest('paint-snap').settings.find(item => item.id === 'threshold'), options.threshold, true);
    const engine = require('./vector-editor');
    if (typeof engine.execute !== 'function') throw new Error('Reviewed paint snapping engine unavailable; configuration saving does not implement snapping');
    return engine.execute(session, target, [action, selector, a, b, ...(c === undefined ? [] : [c])], {snapSettings, ...(options.spec ? {spec: options.spec} : {})});
  }
  throw new Error(`Unsupported addon semantic action ${action}`);
};

module.exports = {specs, booleanOptions,
  requiresProject: (command, args) => !configurationActions.has(args[0]),
  isReadOnly: (command, args) => semanticReads.has(args[0]) || configurationActions.has(args[0]), execute};
