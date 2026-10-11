'use strict';

// The author-side compiler alone sees Scratch's block graph. The generated
// factories use the pinned TurboWarp compiler's normal execution ABI.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const JSZip = require('@turbowarp/jszip');
const {minify} = require('terser');
const NativeVM = require('../native-vm');
const ScratchStorage = require('@turbowarp/scratch-storage');
const Thread = require('scratch-vm/src/engine/thread');
const {IRGenerator} = require('scratch-vm/src/compiler/irgen');
const {IROptimizer} = require('scratch-vm/src/compiler/iroptimizer');
const {frozenSchemas} = require('../block-schema');
const StringUtil = require('scratch-vm/src/util/string-util');

const VERSION = '43f13efd1883eeef8f82616faf69380ff75ab068';
const LIMITS = Object.freeze({archive: 64 * 1024 * 1024, expanded: 128 * 1024 * 1024,
  project: 12 * 1024 * 1024, entries: 4096, targets: 256, blocks: 100000});
const ALLOWED_EXTENSIONS = new Set(['pen', 'music']);
const UNSUPPORTED = new Set(['sensing_loudness', 'sensing_loud', 'sensing_online', 'sensing_userid']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };

function loadSourceGenerator() {
  const filename = require.resolve('scratch-vm/src/compiler/jsgen');
  let source = fs.readFileSync(filename, 'utf8');
  const boundary = 'const fn = jsexecute.scopedEval(factory);';
  if (!source.includes(boundary)) fail('COMPILER_VERSION', 'Pinned compiler source boundary changed');
  source = source.replace(boundary, 'const fn = factory;');
  const privateModule = new Module(filename, module);
  privateModule.filename = filename;
  privateModule.paths = Module._nodeModulePaths(path.dirname(filename));
  privateModule._compile(source, filename);
  return privateModule.exports;
}
const SourceGenerator = loadSourceGenerator();

async function decodeBounded(entry, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', chunk => {
      length += chunk.length;
      if (length > limit) {
        const error = new Error(`ZIP entry ${entry.name} exceeds its decoded size limit`); error.code = 'ARCHIVE_LIMIT';
        stream.destroy(); reject(error); return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks, length)));
  });
}

// Read central-directory limits before any decompression. ZIP64, encrypted,
// multipart, duplicate and path-bearing entries are unnecessary for an SB3.
function inspectArchive(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > LIMITS.archive) fail('ARCHIVE_LIMIT', 'SB3 exceeds the 64 MiB upload limit');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0) fail('INVALID_SB3', 'Expected an SB3 ZIP archive');
  const count = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  let cursor = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6) ||
    count !== bytes.readUInt16LE(eocd + 8) || count === 65535 || count > LIMITS.entries || cursor + size !== eocd) {
    fail('INVALID_SB3', 'Unsupported ZIP directory layout or entry limit');
  }
  const names = new Set();
  let expanded = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('INVALID_SB3', 'Invalid ZIP directory entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const length = 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (cursor + length > eocd || (flags & 1) || ![0, 8].includes(method) || uncompressed === 0xffffffff) {
      fail('INVALID_SB3', 'Encrypted, ZIP64 or unsupported ZIP entry');
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..' || names.has(name)) {
      fail('INVALID_SB3', 'Duplicate or unsafe ZIP filename');
    }
    if (name === 'project.json' && uncompressed > LIMITS.project) fail('PROJECT_LIMIT', 'project.json exceeds 12 MiB');
    expanded += uncompressed;
    if (expanded > LIMITS.expanded) fail('ARCHIVE_LIMIT', 'Expanded SB3 exceeds 128 MiB');
    names.add(name); cursor += length;
  }
  if (cursor !== eocd || !names.has('project.json')) fail('INVALID_SB3', 'SB3 has no valid project.json');
  return bytes;
}

function validateProject(project) {
  if (!object(project) || !Array.isArray(project.targets) || !project.targets.length || project.targets.length > LIMITS.targets) {
    fail('INVALID_PROJECT', 'Project must have between 1 and 256 targets');
  }
  if (project.targets.filter(t => object(t) && t.isStage === true).length !== 1) fail('INVALID_PROJECT', 'Project must contain exactly one stage');
  if (project.extensionURLs && Object.keys(project.extensionURLs).length) fail('UNSUPPORTED_EXTENSION', 'Custom extension URLs cannot be used in a protected offline build');
  if (!Array.isArray(project.extensions || [])) fail('INVALID_PROJECT', 'Invalid extensions list');
  for (const extension of project.extensions || []) {
    if (!ALLOWED_EXTENSIONS.has(extension)) fail('UNSUPPORTED_EXTENSION', `Unsupported extension: ${extension}. Only pen and music are supported.`);
  }
  const extensions = new Set(project.extensions || []);
  let count = 0;
  for (const target of project.targets) {
    if (!object(target) || typeof target.name !== 'string' || !object(target.blocks) ||
      !object(target.variables || {}) || !object(target.lists || {}) || !Array.isArray(target.costumes) || !Array.isArray(target.sounds)) {
      fail('INVALID_PROJECT', 'Malformed target, variables or assets');
    }
    for (const variable of Object.values(target.variables || {})) {
      if (!Array.isArray(variable) || typeof variable[0] !== 'string') fail('INVALID_PROJECT', 'Malformed variable');
      if (variable[2]) fail('UNSUPPORTED_CLOUD', 'Cloud variables require an online service and are not supported');
    }
    for (const [id, block] of Object.entries(target.blocks)) {
      // SB3 stores unattached variable/list reporters in a compact array form;
      // these are editor-only artifacts and have no event entry point.
      if (Array.isArray(block) && [12, 13].includes(block[0]) && typeof block[1] === 'string' && block.length <= 5) {
        delete target.blocks[id]; continue;
      }
      if (!object(block) || typeof block.opcode !== 'string' || !object(block.inputs || {}) || !object(block.fields || {})) {
        fail('INVALID_BLOCK', `${target.name}: malformed block ${id}`);
      }
      if (++count > LIMITS.blocks) fail('PROJECT_LIMIT', 'Project exceeds 100,000 blocks');
      const category = block.opcode.split('_')[0];
      if (ALLOWED_EXTENSIONS.has(category)) extensions.add(category);
      if (!['motion', 'looks', 'sound', 'event', 'control', 'sensing', 'operator', 'data', 'procedures', 'argument', 'math', 'text', 'colour', 'pen', 'music'].includes(category)) {
        fail('UNSUPPORTED_BLOCK', `${target.name}: unsupported block ${block.opcode} (${id})`);
      }
      if (UNSUPPORTED.has(block.opcode)) fail('UNSUPPORTED_BLOCK', `${target.name}: ${block.opcode} requires unavailable online or microphone input`);
      if (block.opcode === 'event_whengreaterthan' && String(block.fields?.WHENGREATERTHANMENU?.[0]).toLowerCase() === 'loudness') {
        fail('UNSUPPORTED_BLOCK', `${target.name}: loudness hats require microphone input`);
      }
      for (const reference of [block.next, block.parent]) {
        if (reference != null && (typeof reference !== 'string' || !Object.hasOwn(target.blocks, reference))) fail('INVALID_BLOCK', `${target.name}: dangling block reference ${id}`);
      }
    }
    // Follow only execution/input edges. Parent pointers intentionally form
    // back edges, but next/input cycles would make IR generation recurse forever.
    const states = new Map();
    const visit = (id, depth) => {
      if (depth > 1500) fail('PROJECT_LIMIT', `${target.name}: block nesting exceeds 1500`);
      if (states.get(id) === 1) fail('INVALID_BLOCK', `${target.name}: cyclic block graph`);
      if (states.get(id) === 2) return;
      states.set(id, 1);
      const block = target.blocks[id];
      if (block.next) visit(block.next, depth + 1);
      for (const input of Object.values(block.inputs || {})) {
        if (!Array.isArray(input)) fail('INVALID_BLOCK', `${target.name}: malformed block input`);
        for (const child of input.slice(1)) {
          if (typeof child === 'string') {
            if (!Object.hasOwn(target.blocks, child)) fail('INVALID_BLOCK', `${target.name}: dangling input reference`);
            visit(child, depth + 1);
          }
        }
      }
      states.set(id, 2);
    };
    for (const id of Object.keys(target.blocks)) visit(id, 0);
  }
  project.extensions = [...extensions];
  return count;
}

function rekeyProject(project) {
  let sequence = 0;
  for (const target of project.targets) {
    const mapping = new Map(Object.keys(target.blocks).map(id => [id, `b${(sequence++).toString(36)}`]));
    const procedures = new Map();
    for (const block of Object.values(target.blocks)) {
      const code = block.mutation && block.mutation.proccode;
      if (typeof code === 'string' && !procedures.has(code)) {
        procedures.set(code, `p${procedures.size} ${(code.match(/%[sbn]/g) || []).join(' ')}`.trim());
      }
    }
    const rewritten = Object.create(null);
    for (const [id, block] of Object.entries(target.blocks)) {
      const copy = {...block, next: mapping.get(block.next) || null, parent: mapping.get(block.parent) || null};
      delete copy.comment; delete copy.x; delete copy.y;
      copy.inputs = Object.fromEntries(Object.entries(block.inputs || {}).map(([key, input]) => [key,
        input.map((value, index) => index && typeof value === 'string' ? mapping.get(value) || value : value)]));
      if (copy.mutation) copy.mutation = {...copy.mutation, proccode: procedures.get(copy.mutation.proccode) || copy.mutation.proccode};
      rewritten[mapping.get(id)] = copy;
    }
    target.blocks = rewritten; target.comments = {};
  }
}

function compileThread(thread) {
  const generator = new IRGenerator(thread);
  const top = thread.blockContainer.getBlock(thread.topBlock);
  if (top.opcode === 'procedures_definition') {
    const prototype = thread.blockContainer.getBlock(top.inputs.custom_block?.block);
    if (!prototype?.mutation?.proccode) fail('INVALID_BLOCK', 'Procedure definition has no valid prototype');
    const generateTree = generator.generateScriptTree;
    generator.generateScriptTree = function(tree, id) {
      if (id === thread.topBlock && !tree.script.isProcedure) {
        const warp = String(prototype.mutation.warp) === 'true';
        tree.setProcedureVariant(`${warp ? 'W' : 'Z'}${prototype.mutation.proccode}`);
        if (warp) tree.enableWarp();
      }
      return generateTree.call(this, tree, id);
    };
  }
  const ir = generator.generate();
  new IROptimizer(ir).optimize();
  const emit = script => {
    if (!script.cachedCompileResult) script.cachedCompileResult = new SourceGenerator(script, ir, thread.target).compile();
    if (typeof script.cachedCompileResult !== 'string') fail('COMPILER_VERSION', 'Compiler did not return generated source');
    return script.cachedCompileResult;
  };
  const startingSource = emit(ir.entry);
  const procedures = Object.fromEntries(Object.entries(ir.procedures).map(([variant, script]) => [variant, emit(script)]));
  return {startingSource, procedures, executableHat: ir.entry.executableHat};
}

async function compileProject(input, options = {}) {
  const started = Date.now();
  const bytes = inspectArchive(input);
  const zip = await JSZip.loadAsync(bytes);
  const projectData = await decodeBounded(zip.file('project.json'), LIMITS.project);
  const projectText = projectData.toString('utf8');
  if (Buffer.byteLength(projectText) > LIMITS.project) fail('PROJECT_LIMIT', 'project.json exceeds 12 MiB');
  let project;
  try { project = JSON.parse(projectText); } catch { fail('INVALID_PROJECT', 'project.json is not valid JSON'); }
  const blockCount = validateProject(project);
  const stageSize = {width: 480, height: 360};
  for (const comment of Object.values(project.targets.find(t => t.isStage).comments || {})) {
    if (!object(comment) || typeof comment.text !== 'string') continue;
    const line = comment.text.split('\n').find(text => text.endsWith(' // _twconfig_'));
    if (!line) continue;
    let config;
    try {config = JSON.parse(line.slice(0, -' // _twconfig_'.length));} catch {fail('INVALID_PROJECT', 'Invalid TurboWarp project configuration');}
    for (const axis of ['width', 'height']) {
      if (config[axis] === undefined) continue;
      const value = Number(config[axis]);
      if (!Number.isFinite(value) || value < 1 || value > 4096) fail('PROJECT_LIMIT', 'Stage dimensions must be between 1 and 4096');
      stageSize[axis] = Math.round(value);
    }
    break;
  }
  const assets = Object.create(null);
  let assetBytes = 0;
  for (const target of project.targets) {
    for (const asset of [...target.costumes, ...target.sounds]) {
      if (!object(asset)) fail('INVALID_ASSET', 'Malformed costume or sound');
      const filename = asset.md5ext || `${asset.assetId}.${asset.dataFormat}`;
      if (typeof asset.assetId !== 'string' || typeof asset.dataFormat !== 'string' || filename !== `${asset.assetId}.${asset.dataFormat}`) {
        fail('INVALID_ASSET', `${target.name}: asset identifier, format and filename disagree`);
      }
      if (!/^[A-Za-z0-9_-]+\.(svg|png|jpg|jpeg|wav|mp3)$/i.test(filename) || !zip.file(filename)) {
        fail('MISSING_ASSET', `${target.name}: missing or unsupported offline asset ${filename}`);
      }
      if (!Object.hasOwn(assets, filename)) {
        const data = await decodeBounded(zip.file(filename), LIMITS.expanded - projectData.length - assetBytes);
        assetBytes += data.length;
        if (assetBytes + projectData.length > LIMITS.expanded) fail('ARCHIVE_LIMIT', 'Decoded project and assets exceed the size limit');
        if (/\.svg$/i.test(filename)) {
          const svg = data.toString('utf8');
          if (/<\s*(script|foreignObject)\b|\bon\w+\s*=|(?:href\s*=\s*["']\s*(?:https?:|\/\/))|url\s*\(\s*["']?\s*(?:https?:|\/\/)/i.test(svg)) {
            fail('UNSAFE_ASSET', `${target.name}: SVG contains executable or external content`);
          }
        }
        assets[filename] = data.toString('base64');
      }
    }
  }
  // Metadata is deliberately whitelisted: comments, editor coordinates, custom
  // extension state, saved compiler caches and other opaque payloads stay local.
  rekeyProject(project);
  const manifestProject = {targets: project.targets.map(target => {
    const fields = ['isStage', 'name', 'variables', 'lists', 'broadcasts', 'currentCostume', 'costumes', 'sounds', 'volume', 'layerOrder', 'tempo', 'videoTransparency', 'videoState', 'textToSpeechLanguage', 'visible', 'x', 'y', 'size', 'direction', 'draggable', 'rotationStyle'];
    const clean = Object.fromEntries(fields.filter(key => Object.hasOwn(target, key)).map(key => [key, target[key]]));
    clean.costumes = target.costumes.map(asset => Object.fromEntries(['assetId', 'name', 'md5ext', 'dataFormat', 'bitmapResolution', 'rotationCenterX', 'rotationCenterY'].filter(k => Object.hasOwn(asset, k)).map(k => [k, asset[k]])));
    clean.sounds = target.sounds.map(asset => Object.fromEntries(['assetId', 'name', 'md5ext', 'dataFormat', 'format', 'rate', 'sampleCount'].filter(k => Object.hasOwn(asset, k)).map(k => [k, asset[k]])));
    return {...clean, blocks: {}, comments: {}};
  }), monitors: (project.monitors || []).map(monitor => {
    if (!object(monitor) || !frozenSchemas().has(monitor.opcode) || UNSUPPORTED.has(monitor.opcode)) fail('UNSUPPORTED_MONITOR', 'Unsupported or malformed monitor');
    const clean = Object.fromEntries(['id', 'mode', 'opcode', 'params', 'spriteName', 'value', 'width', 'height', 'x', 'y', 'visible', 'sliderMin', 'sliderMax', 'isDiscrete'].filter(key => Object.hasOwn(monitor, key)).map(key => [key, monitor[key]]));
    if (['data_variable', 'data_listcontents'].includes(clean.opcode)) clean.id = StringUtil.replaceUnsafeChars(clean.id);
    return clean;
  }), extensions: project.extensions || [], meta: {semver: '3.0.0'}};
  // Loading no assets avoids renderer/audio requirements on the author-side.
  const compileInput = {...project, monitors: [], targets: project.targets.map(t => ({...t, costumes: [], sounds: []}))};
  const vm = new NativeVM();
  vm.attachStorage(new ScratchStorage());
  vm.setCompilerOptions({enabled: false, warpTimer: true});
  vm.runtime.setStageSize(stageSize.width, stageSize.height);
  const programs = [];
  const events = [];
  try {
    await vm.deserializeProject({...compileInput, projectVersion: 3});
    const targets = vm.runtime.targets.filter(t => t.isOriginal);
    if (targets.length !== project.targets.length) fail('INVALID_PROJECT', 'Deserialization changed the target count');
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const target = targets[targetIndex];
      if (target.isStage !== project.targets[targetIndex].isStage || target.getName() !== project.targets[targetIndex].name) fail('INVALID_PROJECT', 'Duplicate target names or changed target ordering');
      target.sprite.costumes = project.targets[targetIndex].costumes;
      target.sprite.sounds = project.targets[targetIndex].sounds;
      for (const block of Object.values(target.blocks._blocks)) {
        if (!frozenSchemas().has(block.opcode) && !vm.runtime.getOpcodeFunction(block.opcode) && !vm.runtime.getIsHat(block.opcode)) {
          fail('UNSUPPORTED_BLOCK', `${target.name}: unknown block ${block.opcode}`);
        }
      }
      for (const id of target.blocks.getScripts()) {
        const block = target.blocks.getBlock(id);
        if (!vm.runtime.getIsHat(block.opcode) && block.opcode !== 'procedures_definition') continue;
        const thread = new Thread(id); thread.target = target; thread.blockContainer = target.blocks;
        let result;
        try { result = compileThread(thread); } catch (error) {
          fail('COMPILE_UNSUPPORTED', `${target.getName()}: cannot compile ${block.opcode}: ${error.message}`);
        }
        const programIndex = programs.length; programs.push(result);
        if (vm.runtime.getIsHat(block.opcode)) {
          let fields = block.fields;
          if (!Object.keys(fields).length) {
            fields = {};
            for (const input of Object.values(block.inputs)) Object.assign(fields, target.blocks.getBlock(input.block)?.fields || {});
          }
          events.push({targetIndex, id, opcode: block.opcode, fields: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])), executableHat: result.executableHat, programIndex});
        }
      }
    }
    // Deserialization canonicalizes IDs, and IR generation may create missing
    // scalar/list references exactly as TurboWarp does. Snapshot AFTER every
    // script is compiled so runtime state matches every generated reference.
    // Only values are retained; this never serializes VM blocks or its caches.
    for (let index = 0; index < targets.length; index++) {
      const metadata = manifestProject.targets[index];
      metadata.variables = Object.create(null);
      metadata.lists = Object.create(null);
      metadata.broadcasts = Object.create(null);
      for (const [id, variable] of Object.entries(targets[index].variables)) {
        if (variable.type === 'list') metadata.lists[id] = [variable.name, variable.value];
        else if (variable.type === 'broadcast_msg') metadata.broadcasts[id] = variable.value;
        else metadata.variables[id] = [variable.name, variable.value];
      }
    }
  } finally { vm.runtime.dispose(); }
  // Each factory is serialized as a string, so outer HTML minification cannot
  // rename its local variables. Mangle these author-side with globals reserved.
  for (const program of programs) {
    const mangle = async source => {
      const result = await minify(`const protectedFactory=${source};`, {ecma: 2020, compress: false, mangle: {toplevel: false}, output: {comments: false}});
      if (result.error) throw result.error;
      if (!result.code || !result.code.startsWith('const protectedFactory=')) fail('COMPILER_VERSION', 'Unexpected generated-factory minifier output');
      return result.code.slice('const protectedFactory='.length).replace(/;$/, '');
    };
    program.startingSource = await mangle(program.startingSource);
    for (const variant of Object.keys(program.procedures)) program.procedures[variant] = await mangle(program.procedures[variant]);
  }
  const programSource = `(function(scopedEval){return [${programs.map(program =>
    `{startingFunction:scopedEval(${JSON.stringify(program.startingSource)}),procedures:{${Object.entries(program.procedures).map(([key, source]) => `${JSON.stringify(key)}:scopedEval(${JSON.stringify(source)})`).join(',')}},executableHat:${Boolean(program.executableHat)}}`).join(',')}];})`.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim().slice(0, 200) : 'Scratch project';
  return {programSource, manifest: {format: 1, title, runtimeVersion: VERSION, stageSize, project: manifestProject, events}, assets,
    report: {format: 1, runtimeVersion: VERSION, blockCount, compiledScripts: programs.length, events: events.length,
      assetCount: Object.keys(assets).length, assetBytes, programBytes: Buffer.byteLength(programSource), elapsedMs: Date.now() - started,
      protection: 'ahead-of-time', sourceGraphIncluded: false}};
}

module.exports = {compileProject, inspectArchive, validateProject, LIMITS, VERSION};
