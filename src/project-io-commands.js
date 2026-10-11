const path = require('node:path');
const {readProject, readSpriteArchive, readLocalFile, atomicWrite, emptyTarget, validateProjectPolicy, rejectPrototypeKeys, md5} = require('./project');
const {LibraryStore, FileStore, kindName} = require('./library-store');
const {resourceError} = require('./errors');
const {MAX_PROJECT_BYTES} = require('./project-limits');

const specs = require('./command-catalog').moduleSpecs['project-io-commands.js'];
const requiresProject = (command, args) => command === 'library' ? args[0] === 'load' : command === 'backpack' ?
  ['save', 'load'].includes(args[0]) : command === 'project' && !['fetch', 'restore-use', 'restore-list'].includes(args[0]);
const isReadOnly = (command, args) => !(command === 'library' && args[0] === 'load' || command === 'backpack' && args[0] === 'load' ||
  command === 'project' && ['import', 'import-sprite', 'restore'].includes(args[0]));
const validate = (command, args, options) => {
  const definition = specs[command]?.[args[0]];
  if (!definition || args.length - 1 < definition.min || args.length - 1 > definition.max) throw new Error(`Invalid ${command} subcommand arguments`);
  for (const key of Object.keys(options)) if (!definition.options.includes(key)) throw new Error(`Unsupported option --${key} for ${command} ${args[0]}`);
};
const destination = (positional, options, extension) => {
  if (positional && options.output) throw new Error('Use one output path: positional or --output, not both');
  const file = positional || options.output;
  if (!file || path.extname(file).toLowerCase() !== extension) throw new Error(`Output must end in ${extension}; use positional or --output`);
  return file;
};
const store = async (session, namespace, options, use) => {
  const key = namespace === 'backpack' ? 'backpackDirectory' : 'restoreDirectory';
  const directory = use || options.dir || session[key];
  const result = new FileStore(directory, namespace); await result.prepare(!!use);
  if (use) session[key] = result.directory;
  return result;
};
const selectAsset = (target, type, selector) => {
  const assets = type === 'costume' ? target.getCostumes() : target.getSounds();
  const byId = assets.find(asset => asset.cliId === selector); if (byId) return byId;
  const matches = assets.filter((asset, i) => asset.name === selector || String(i) === String(selector));
  if (matches.length !== 1) throw resourceError(matches.length, `Asset not found or ambiguous: ${selector}`, selector);
  return matches[0];
};
const spriteArchive = async (session, target) => {
  if (target.isStage) throw new Error('Stage cannot be exported as a sprite3');
  const bytes = await session.project.vm.exportSprite(target.id, 'nodebuffer');
  await readSpriteArchive(bytes); return bytes;
};
const importSprite = async (session, bytes) => {
  await readSpriteArchive(bytes);
  const result = await session.addSpriteArchive(bytes);
  session.project.ensureAssetIds(session.project.target(result.id));
  return result;
};
const attachAsset = async (session, type, descriptor, bytes, selector) => {
  const target = type === 'backdrop' ? session.project.target('stage') : session.project.target(selector);
  const storage = session.project.vm.runtime.storage;
  rejectPrototypeKeys(descriptor);
  const format = descriptor.dataFormat || descriptor.md5ext?.split('.').pop();
  if (!['svg', 'png', 'jpeg', 'jpg', 'gif', 'bmp', 'wav', 'mp3'].includes(format) || descriptor.assetId && descriptor.assetId !== md5(bytes)) throw new Error('Asset metadata/content mismatch');
  if (type === 'sound') {
    delete descriptor.cliId; delete descriptor.tags;
    const asset = storage.createAsset(storage.AssetType.Sound, format, new Uint8Array(bytes), null, true);
    await session.project.vm.addSound({...descriptor, asset, assetId: asset.assetId, dataFormat: format, md5: `${asset.assetId}.${format}`}, target.id);
  } else {
    const asset = storage.createAsset(format === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap,
      format, new Uint8Array(bytes), null, true);
    const costume = {...descriptor, asset, assetId: asset.assetId, dataFormat: format, md5: `${asset.assetId}.${format}`};
    delete costume.cliId; delete costume.tags;
    await session.project.hydrateCostume(costume); target.addCostume(costume); target.setCostume(target.getCostumes().length - 1);
  }
  session.project.ensureAssetIds(target);
  return {target: target.id, name: descriptor.name, assetId: md5(bytes), bytes: bytes.length};
};
const blockArchive = async (session, target, id) => {
  if (!target.blocks.getBlock(id)) throw new Error('Block not found');
  const ids = new Set(); const pending = [id];
  while (pending.length) {
    const next = pending.pop(); if (ids.has(next)) continue;
    const block = target.blocks.getBlock(next); if (!block) throw new Error('Broken block graph'); ids.add(next);
    if (block.next) pending.push(block.next);
    for (const input of Object.values(block.inputs || {})) {if (input.block) pending.push(input.block); if (input.shadow) pending.push(input.shadow);}
  }
  const blocks = [...ids].map(id => structuredClone(target.blocks.getBlock(id)));
  blocks[0].parent = null; blocks[0].topLevel = true;
  const needed = new Set();
  for (const block of blocks) for (const field of Object.values(block.fields || {})) if (field.id &&
    ['VARIABLE', 'LIST', 'BROADCAST_OPTION'].some(name => block.fields[name] === field)) needed.add(field.id);
  const stage = session.project.target('stage');
  const variables = [...needed].map(id => target.variables[id] || stage.variables[id]).filter(Boolean).map(variable =>
    ({id: variable.id, name: variable.name, type: variable.type, value: variable.value, isCloud: false}));
  return Buffer.from(JSON.stringify({version: 1, blocks: session.project.vm.exportStandaloneBlocks(blocks), variables}));
};
const loadBlocks = async (session, target, bytes) => {
  const data = JSON.parse(bytes); rejectPrototypeKeys(data);
  if (data.version !== 1 || !Array.isArray(data.blocks) || data.blocks.length > 10000 || !Array.isArray(data.variables)) throw new Error('Invalid backpack block graph');
  const blockMap = Object.fromEntries(data.blocks.map(block => [block.id, block]));
  if (Object.keys(blockMap).length !== data.blocks.length || data.blocks.some(block => typeof block.id !== 'string' ||
    typeof block.opcode !== 'string' || block.next && !blockMap[block.next] || block.parent && !blockMap[block.parent] ||
    Object.values(block.inputs || {}).some(input => input.block && !blockMap[input.block] || input.shadow && !blockMap[input.shadow]))) {
    throw new Error('Invalid or dangling backpack block graph');
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error('Cyclic backpack block graph');
    if (visited.has(id)) return; visiting.add(id);
    const block = blockMap[id]; if (block.next) visit(block.next);
    for (const input of Object.values(block.inputs || {})) {if (input.block) visit(input.block); if (input.shadow) visit(input.shadow);}
    visiting.delete(id); visited.add(id);
  };
  for (const id of Object.keys(blockMap)) visit(id);
  validateProjectPolicy({targets: [emptyTarget('Stage', true, []), {...emptyTarget('Blocks', false, []), blocks: blockMap}]});
  if (data.blocks.some(block => block.extensionURLs && Object.keys(block.extensionURLs).length)) throw new Error('Executable block extensions are denied');
  const remap = new Map();
  for (const variable of data.variables) {
    if (!['', 'list', 'broadcast_msg'].includes(variable.type) || typeof variable.name !== 'string') throw new Error('Invalid backpack variable');
    const owner = variable.type === 'broadcast_msg' ? session.project.target('stage') : target;
    let existing = Object.values(owner.variables).find(item => item.name === variable.name && item.type === variable.type);
    if (!existing) {
      const id = require('node:crypto').randomUUID(); owner.createVariable(id, variable.name, variable.type, false);
      existing = owner.variables[id]; existing.value = structuredClone(variable.value);
    }
    remap.set(variable.id, existing.id);
  }
  for (const block of data.blocks) for (const field of Object.values(block.fields || {})) if (remap.has(field.id)) field.id = remap.get(field.id);
  await session.project.vm.shareBlocksToTarget(data.blocks, target.id);
  return {blocks: data.blocks.length, target: target.id};
};

const execute = async (session, command, args, options = {}) => {
  if (command === 'project' && ['read', 'find', 'validate', 'apply', 'exec'].includes(args[0])) {
    return session.nativeProject(args, options);
  }
  validate(command, args, options);
  if (requiresProject(command, args) && !session.project.vm) throw new Error('Open or create a project first');
  const [action, first, second, third] = args;
  if (command === 'library') {
    const library = new LibraryStore(options.dir);
    if (action === 'status') return library.status();
    if (action === 'categories') return library.categories(first);
    if (action === 'list' || action === 'search') return library.browse(first, {...options, query: action === 'search' ? second : options.query});
    const kind = kindName(first);
    if (kind === 'sprite') return importSprite(session, await library.spriteArchive(second));
    const descriptor = await library.select(kind, second);
    return attachAsset(session, kind, descriptor, await library.readAsset(descriptor.md5ext), options.target);
  }
  if (command === 'project') {
    if (action === 'fetch') {
      const integer = (value, min, max, label) => {
        const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be ${min}..${max}`); return number;
      };
      const maxBytes = integer(options['max-bytes'] || MAX_PROJECT_BYTES, 1, MAX_PROJECT_BYTES, 'max-bytes');
      const timeoutMs = integer(options['timeout-ms'] || 15000, 100, 30000, 'timeout-ms');
      const {createPolicy, writeFile} = require('./permission-policy');
      const policy = createPolicy(session, options, 'project fetch');
      const file = destination(second, options, '.sb3');
      const bytes = await require('./network-policy').fetchBytes(first, policy, {maxBytes, timeoutMs, httpsOnly: true});
      const prepared = await readProject(bytes);
      const result = await writeFile(policy, file, prepared.bytes, {explicit: true, force: !!options.force});
      return {...result, sourceFormat: prepared.sourceFormat, warnings: prepared.warnings || []};
    }
    if (action === 'import') {
      const bytes = await readLocalFile(first); const prepared = await readProject(bytes);
      await session.project.load(prepared.bytes);
      return {source: path.resolve(first), sourceFormat: prepared.sourceFormat, warnings: prepared.warnings || [], ...session.project.info()};
    }
    if (action === 'import-sprite') return importSprite(session, await readLocalFile(first));
    if (action === 'export-sprite') return atomicWrite(destination(first, options, '.sprite3'),
      await spriteArchive(session, session.project.target(options.target)), options.force);
    if (action === 'export') return atomicWrite(destination(first, options, '.sb3'), await session.snapshot(), options.force);
    const points = await store(session, 'restore', options, action === 'restore-use' ? first : null);
    if (action === 'restore-use') return {directory: points.directory, backend: 'atomic-local-files', indexedDB: false};
    if (action === 'restore-list') return points.list();
    if (action === 'restore-save') return points.save('project', first, await session.snapshot(), {selected: session.project.vm.editingTarget.id});
    const {item, payload} = await points.read(first);
    if (item.type !== 'project') throw new Error('Restore point must contain a project');
    await readProject(payload); await session.restore(payload, item.metadata.selected);
    return {restored: item.id, name: item.name, ...session.project.info()};
  }
  const backpack = await store(session, 'backpack', options, action === 'use' ? first : null);
  if (action === 'use') return {directory: backpack.directory, backend: 'atomic-local-files', indexedDB: false};
  if (action === 'list') return backpack.list();
  if (action === 'save') {
    const type = first, name = second;
    if (type === 'project') {if (third !== undefined) throw new Error('Project backpack save does not take a selector'); return backpack.save(type, name, await session.snapshot(), {selected: session.project.vm.editingTarget.id});}
    const target = session.project.target(options.target); session.project.ensureAssetIds(target);
    if (type === 'sprite') {if (third !== undefined) throw new Error('Use --target for sprite backpack save'); return backpack.save(type, name, await spriteArchive(session, target));}
    if (type === 'block' && third === undefined) throw new Error('Choose a block ID to save');
    if (type === 'block') return backpack.save(type, name, await blockArchive(session, target, third));
    if (!['costume', 'sound'].includes(type)) throw new Error('Backpack type must be project/sprite/block/costume/sound');
    if (third === undefined) throw new Error('Choose an asset name/index/CLI ID to save');
    const asset = selectAsset(target, type, third);
    const serialized = JSON.parse(session.project.vm.toJSON(null, {allowOptimization: false})).targets.find(record => record.name === target.getName() && record.isStage === target.isStage);
    const index = (type === 'costume' ? target.getCostumes() : target.getSounds()).indexOf(asset);
    return backpack.save(type, name, Buffer.from(asset.asset.data), {asset: serialized[type === 'costume' ? 'costumes' : 'sounds'][index]});
  }
  const {item, payload} = await backpack.read(first);
  if (item.type === 'project') {await readProject(payload); await session.restore(payload, item.metadata.selected); return {loaded: item.id, type: item.type};}
  if (item.type === 'sprite') return importSprite(session, payload);
  const target = session.project.target(options.target);
  if (item.type === 'block') return loadBlocks(session, target, payload);
  return attachAsset(session, item.type, item.metadata.asset, payload, options.target);
};
module.exports = {specs, requiresProject, isReadOnly, execute, booleanOptions: ['force'], usesProjectTarget: false};
