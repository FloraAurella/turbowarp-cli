require('./native-environment');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('@turbowarp/jszip');
const VirtualMachine = require('./native-vm');
const ScratchStorage = require('@turbowarp/scratch-storage');
const {NativeRenderer} = require('./native-renderer');
const {loadImage, createCanvas} = require('@napi-rs/canvas');
const {constants} = require('node:fs');
const {checkedPath} = require('./file-boundaries');
const {CommandError, resourceError} = require('./errors');
const parser = require('scratch-parser');
const AudioEngine = require('scratch-audio/src/AudioEngine');
const StageLayering = require('scratch-vm/src/engine/stage-layering');

const {MAX_PROJECT_BYTES, MAX_EXPANDED_PROJECT_BYTES, MAX_PROJECT_METADATA_BYTES} = require('./project-limits');
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex');
const identityUUID = seed => {
  const bytes = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const emptyTarget = (name, isStage, costumes) => ({
  isStage, name, variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
  currentCostume: 0, costumes, sounds: [], volume: 100, layerOrder: isStage ? 0 : 1,
  ...(isStage ? {tempo: 60, videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null} :
    {visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'})
});
const svgCostume = (name, svg) => {
  const assetId = md5(svg);
  return {assetId, name, md5ext: `${assetId}.svg`, dataFormat: 'svg', bitmapResolution: 1};
};

const blankProject = async () => {
  const background = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="white"/></svg>';
  const sprite = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="30" cy="30" r="28" fill="#ff4c4c"/></svg>';
  const costumes = [svgCostume('背景', background), svgCostume('造型', sprite)];
  const zip = new JSZip();
  zip.file(costumes[0].md5ext, background);
  zip.file(costumes[1].md5ext, sprite);
  zip.file('project.json', JSON.stringify({
    targets: [emptyTarget('Stage', true, [costumes[0]]), emptyTarget('Sprite1', false, [costumes[1]])],
    monitors: [], extensions: [], meta: {semver: '3.0.0', agent: 'tw-cli'}
  }));
  return zip.generateAsync({type: 'nodebuffer'});
};

const safeArchivePath = name => {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || path.isAbsolute(name) ||
    /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error(`Unsafe archive entry: ${name}`);
};
const readLocalFile = async (filename, limit = MAX_PROJECT_BYTES) => {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 512 * 1024 * 1024) throw new Error('Invalid local file read limit');
  const full = await checkedPath(filename);
  const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`Expected a regular file within ${limit} bytes: ${full}`);
    const chunks = []; let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length));
      const {bytesRead} = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) throw new Error(`File exceeds ${limit} bytes: ${full}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await checkedPath(full);
    return Buffer.concat(chunks, length);
  } finally {await handle.close();}
};
const parseArchive = (bytes, sprite = false) => new Promise((resolve, reject) => {
  parser(bytes, sprite, (error, result) => error ? reject(new Error(`Scratch parser validation failed: ${typeof error === 'string' ? error : JSON.stringify(error)}`)) : resolve(result));
});
const rejectPrototypeKeys = value => {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop(); if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe prototype key in project data');
      if (child && typeof child === 'object') pending.push(child);
    }
  }
};
const checkedZip = async bytes => {
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error(`Project exceeds the ${MAX_PROJECT_BYTES / 1024 / 1024} MiB input limit`);
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  if (Object.keys(zip.files).length > 20000) throw new Error('Archive contains too many entries');
  for (const entry of Object.values(zip.files)) {
    safeArchivePath(entry.unsafeOriginalName || entry.name);
    if (entry.dir) continue;
    const size = entry._data?.uncompressedSize || 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid archive size');
    total += size;
    if (total > MAX_EXPANDED_PROJECT_BYTES) throw new Error(`Expanded project exceeds the ${MAX_EXPANDED_PROJECT_BYTES / 1024 / 1024} MiB limit`);
  }
  return zip;
};
const findAsset = (zip, name) => {
  safeArchivePath(name);
  const matches = Object.values(zip.files).filter(entry => !entry.dir && (entry.name === name || entry.name.split('/').pop() === name));
  if (matches.length !== 1) throw resourceError(matches.length, `Missing or ambiguous local asset: ${name}`, name);
  return matches[0];
};
const safeExtensions = new Set(['pen', 'music', 'videoSensing', 'Gamepad']);
const assertExtensionPolicy = (ids, urls) => {
  if (urls && (urls instanceof Map ? urls.size : Object.keys(urls).length)) throw new Error('Custom executable extensions are denied in this build');
  for (const id of ids || []) if (!safeExtensions.has(id)) throw new Error(`Extension ${id} is not approved for headless execution`);
};
const validateProjectPolicy = json => {
  if (!Array.isArray(json.targets) || json.targets.filter(target => target.isStage).length !== 1) throw new Error('Project must have exactly one stage');
  assertExtensionPolicy(json.extensions, json.extensionURLs);
  let cloudCount = 0;
  for (const target of json.targets) {
    for (const variable of Object.values(target.variables || {})) {
      if (Array.isArray(variable) && variable[2]) {
        if (!target.isStage) throw new Error('Cloud variables must belong to the stage');
        require('./local-cloud').validateName(variable[0]); require('./local-cloud').validateValue(variable[1]);
        if (++cloudCount > 10) throw new Error('Cloud variable limit reached (max 10)');
      }
    }
    for (const block of Object.values(target.blocks || {})) {
      if (Array.isArray(block)) continue;
      const category = block.opcode && block.opcode.split('_')[0];
      const core = ['event', 'control', 'motion', 'looks', 'sound', 'sensing', 'operator', 'data', 'procedures', 'argument', 'math', 'text', 'colour'];
      if (category && !core.includes(category) && !safeExtensions.has(category)) throw new Error(`Extension ${category} is not approved for headless execution`);
    }
  }
};
const checkAssets = async (json, zip, version = 3, verifyHash = true) => {
  if (version === 3) await require('./font-commands').validateProjectFonts(json, zip, findAsset);
  const targets = version === 3 ? json.targets : [json, ...(json.children || []).filter(child => child.objName)];
  for (const target of targets) for (const type of ['costumes', 'sounds']) for (const asset of target[type] || []) {
    if (version === 3 && asset.asset !== undefined) throw new Error('Inline executable/embedded asset objects are not accepted in local archives');
    const md5ext = version === 3 ? asset.md5ext || `${asset.assetId}.${asset.dataFormat}` : type === 'costumes' ? asset.baseLayerMD5 : asset.md5;
    if (!/^[a-f0-9]{32}\.(svg|png|jpeg|jpg|gif|bmp|wav|mp3)$/i.test(md5ext || '')) throw new Error(`Invalid local asset reference: ${md5ext}`);
    const extension = md5ext.split('.').pop();
    const name = version === 3 ? md5ext : `${type === 'costumes' ? asset.baseLayerID : asset.soundID}.${extension}`;
    const bytes = await findAsset(zip, name).async('nodebuffer');
    if (verifyHash && md5(bytes) !== md5ext.slice(0, 32).toLowerCase()) throw new Error(`Local asset MD5 mismatch: ${name}`);
    if (type === 'costumes' && asset.textLayerMD5) {
      const text = await findAsset(zip, `${asset.textLayerID}.png`).async('nodebuffer');
      if (verifyHash && md5(text) !== asset.textLayerMD5.split('.')[0]) throw new Error('Local text layer MD5 mismatch');
    }
  }
};

const readSB3 = async bytes => {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error(`Project exceeds the ${MAX_PROJECT_BYTES / 1024 / 1024} MiB input limit`);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Expected a local Scratch ZIP project');
  const zip = await checkedZip(bytes);
  for (const name of ['project.json', 'tw-cli-state.json']) if (zip.file(name)?._data.uncompressedSize > MAX_PROJECT_METADATA_BYTES) throw new Error(`Project metadata exceeds ${MAX_PROJECT_METADATA_BYTES / 1024 / 1024} MiB: ${name}`);
  if (!zip.file('project.json')) throw new Error('SB3 is missing project.json');
  const json = JSON.parse(await zip.file('project.json').async('string'));
  rejectPrototypeKeys(json);
  validateProjectPolicy(json);
  await checkAssets(json, zip);
  return {zip, json};
};

const normalizeProject = async input => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!/^ScratchV0[12]$/.test(bytes.toString('ascii', 0, 10)) && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new Error('Expected a local SB/SB2/SB3 project archive');
  }
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error(`Project exceeds the ${MAX_PROJECT_BYTES / 1024 / 1024} MiB input limit`);
  let json, zip, sourceFormat;
  if (/^ScratchV0[12]$/.test(bytes.toString('ascii', 0, 10))) {
    sourceFormat = 'sb';
    const {SB1File} = require('scratch-sb1-converter');
    const sb = new SB1File(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    let expanded = 0;
    for (const image of sb.images()) {
      const width = Number(image.width), height = Number(image.height);
      if (width > 0 && height > 0) {
        if (!Number.isSafeInteger(width * height) || width * height > 16000000) throw new Error('SB bitmap exceeds pixel limit');
        expanded += width * height * 4;
      } else expanded += image.rawBytes.length;
    }
    for (const sound of sb.sounds()) {
      if (!Number.isSafeInteger(sound.sampleCount) || sound.sampleCount < 0) throw new Error('Invalid SB sound size');
      expanded += sound.sampleCount * 2;
    }
    if (expanded > MAX_EXPANDED_PROJECT_BYTES) throw new Error(`SB expanded media exceeds the ${MAX_EXPANDED_PROJECT_BYTES / 1024 / 1024} MiB limit`);
    json = sb.json; json.projectVersion = 2;
    const fake = sb.zip; zip = new JSZip();
    let total = 0;
    for (const [name, entry] of Object.entries(fake.files)) {
      const data = Buffer.from(entry.bytes); total += data.length;
      if (total > MAX_EXPANDED_PROJECT_BYTES) throw new Error(`Converted SB assets exceed the ${MAX_EXPANDED_PROJECT_BYTES / 1024 / 1024} MiB limit`);
      zip.file(name, data);
    }
  } else {
    zip = await checkedZip(bytes);
    const metadataFiles = Object.values(zip.files).filter(entry => entry.name === 'project.json' || /^[^/]+\/project\.json$/.test(entry.name));
    if (metadataFiles.length !== 1 || metadataFiles[0]._data.uncompressedSize > MAX_PROJECT_METADATA_BYTES) throw new Error(`Project must have one metadata file within ${MAX_PROJECT_METADATA_BYTES / 1024 / 1024} MiB`);
    [json] = await parseArchive(bytes);
    rejectPrototypeKeys(json);
    sourceFormat = json.projectVersion === 2 ? 'sb2' : 'sb3';
    if (sourceFormat === 'sb3') {
      validateProjectPolicy(json); await checkAssets(json, zip);
      if (!zip.file('project.json')) {
        zip.file('project.json', JSON.stringify(json));
        return {bytes: await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}), sourceFormat};
      }
      return {bytes, sourceFormat};
    }
  }
  if (json.info?.savedExtensions?.length || json.extensionURLs && Object.keys(json.extensionURLs).length) throw new Error('Custom executable extensions are denied in legacy projects');
  await checkAssets(json, zip, 2, sourceFormat !== 'sb');
  // Deserialize only after required local assets and archive paths are checked.
  // No renderer means upstream never invokes browser-only SVG/bitmap conversion.
  const vm = new VirtualMachine();
  const loadExtensions = vm._loadExtensions.bind(vm);
  vm._loadExtensions = (ids, urls) => {assertExtensionPolicy(ids, urls); return loadExtensions(ids, urls);};
  vm.attachStorage(new ScratchStorage()); vm.setCompilerOptions({enabled: false});
  require('./device-adapters').registerOfflineExtensions(vm);
  try {
    await vm.deserializeProject(json, zip);
    const serialized = JSON.parse(vm.toJSON(null, {allowOptimization: false}));
    // Renderer-free VM serialization otherwise emits pane order for every
    // layer. executableTargets retains the legacy children/z-order sorting.
    const originals = vm.runtime.targets.filter(target => target.isOriginal);
    for (let i = 0; i < serialized.targets.length; i++) serialized.targets[i].layerOrder = vm.runtime.executableTargets.indexOf(originals[i]);
    for (const target of serialized.targets) {
      const source = target.isStage ? json : (json.children || []).find(child => child.objName === target.name);
      if (!source) continue;
      // Legacy text layers are raster assets too. Composite locally, never through
      // Image/Canvas browser globals; untouched image and sound bytes stay exact.
      for (let i = 0; i < target.costumes.length; i++) {
        const costume = target.costumes[i], legacy = source.costumes[i];
        if (!legacy?.textLayerMD5) continue;
        if (costume.dataFormat === 'svg') throw new Error('Legacy SVG text layers require a GUI normalization oracle');
        const base = await loadImage(await findAsset(zip, `${legacy.baseLayerID}.${costume.dataFormat}`).async('nodebuffer'));
        const text = await loadImage(await findAsset(zip, `${legacy.textLayerID}.png`).async('nodebuffer'));
        if (base.width * base.height > 16000000) throw new Error('Legacy bitmap exceeds pixel limit');
        const canvas = createCanvas(base.width, base.height); const context = canvas.getContext('2d');
        context.drawImage(base, 0, 0); context.drawImage(text, 0, 0);
        const data = canvas.toBuffer('image/png');
        costume.assetId = md5(data); costume.md5ext = `${costume.assetId}.png`; costume.dataFormat = 'png';
        costume._mergedData = data;
      }
    }
    const output = new JSZip();
    for (const asset of vm.serializeAssets()) output.file(asset.fileName, asset.fileContent);
    for (const target of serialized.targets) for (const costume of target.costumes) if (costume._mergedData) {
      output.file(costume.md5ext, costume._mergedData); delete costume._mergedData;
    }
    validateProjectPolicy(serialized);
    output.file('project.json', JSON.stringify(serialized));
    const converted = await output.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
    await readSB3(converted);
    return {bytes: converted, sourceFormat, warnings: ['Legacy assets preserved; browser SVG quirks/getBBox normalization is not claimed.']};
  } finally {try {require('./device-adapters').disposeOfflineExtensions(vm); vm.clear();} finally {vm.quit(); vm.runtime.removeAllListeners(); vm.removeAllListeners();}}
};
const readProject = async bytes => {
  const normalized = await normalizeProject(bytes);
  return {...await readSB3(normalized.bytes), ...normalized};
};
const readSpriteArchive = async bytes => {
  const zip = await checkedZip(bytes);
  const metadataFiles = Object.values(zip.files).filter(entry => entry.name === 'sprite.json' || /^[^/]+\/sprite\.json$/.test(entry.name));
  if (metadataFiles.length !== 1 || metadataFiles[0]._data.uncompressedSize > MAX_PROJECT_METADATA_BYTES) throw new Error(`Sprite must have one metadata file within ${MAX_PROJECT_METADATA_BYTES / 1024 / 1024} MiB`);
  const [sprite] = await parseArchive(bytes, true);
  rejectPrototypeKeys(sprite);
  if (sprite.projectVersion !== 3 || sprite.isStage) throw new Error('Expected a local sprite3 archive, not a stage or legacy sprite');
  validateProjectPolicy({targets: [emptyTarget('Stage', true, []), sprite], extensions: sprite.extensions || [], extensionURLs: sprite.extensionURLs});
  await checkAssets({targets: [sprite]}, zip);
  return {sprite, zip};
};

const atomicWrite = async (filename, bytes, overwrite = false, {beforeCommit} = {}) => {
  const full = await checkedPath(filename, {missing: true});
  const parent = path.dirname(full);
  await fs.mkdir(parent, {recursive: true});
  await checkedPath(parent, {directory: true});
  const temporary = path.join(parent, `.${path.basename(full)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    if (overwrite) {
      try {
        const stat = await fs.lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing to overwrite a non-regular file');
      } catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const actual = await readLocalFile(temporary, Math.max(MAX_PROJECT_BYTES, bytes.length));
    if (!crypto.timingSafeEqual(crypto.createHash('sha512').update(actual).digest(), crypto.createHash('sha512').update(bytes).digest())) {
      throw new Error('Atomic write verification failed');
    }
    await checkedPath(full, {missing: true});
    if (beforeCommit) await beforeCommit(full);
    if (overwrite) await fs.rename(temporary, full);
    else {
      try {await fs.link(temporary, full);} catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new CommandError('OUTPUT_EXISTS', `EEXIST: 输出文件已存在：${full}`, '选择其他路径，或显式使用 --force。', {path: full});
      }
      await fs.unlink(temporary);
    }
    return {path: full, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});
  }
};

class Project {
  constructor() {this.vm = null; this.renderer = null; this.audio = null; this.file = null; this.cloud = null; this.cloudFile = null;}
  async load(bytes) {
    // Build the replacement off to the side. A decoder/renderer failure must not
    // destroy the previous project, its cloud provider, or pending input state.
    const candidate = new Project();
    await candidate.loadCurrent(bytes);
    const cloud = this.cloud;
    this.cloud = null;
    if (cloud) this.vm.runtime.ioDevices.cloud.setProvider(null);
    try {this.dispose();} catch (error) {candidate.dispose(); throw error;}
    Object.assign(this, {vm: candidate.vm, renderer: candidate.renderer, audio: candidate.audio,
      sourceFormat: candidate.sourceFormat, importWarnings: candidate.importWarnings});
    if (cloud) {
      cloud.vm = this.vm;
      this.vm.runtime.ioDevices.cloud.setStage(this.vm.runtime.getTargetForStage());
      this.vm.runtime.ioDevices.cloud.setProvider(cloud.provider);
      this.cloud = cloud; this.cloudFile = cloud.filename;
    }
    return this.info();
  }
  async loadCurrent(bytes) {
    const {json, zip, bytes: normalizedBytes, sourceFormat, warnings = []} = await readProject(bytes);
    const metadata = zip.file('tw-cli-state.json');
    const identity = metadata ? JSON.parse(await metadata.async('string')) : null;
    if (identity) rejectPrototypeKeys(identity);
    if (metadata && (!identity || identity.version !== 1 || !Array.isArray(identity.targets) || identity.targets.length !== json.targets.length ||
      !identity.targets.every(id => typeof id === 'string' && id.length > 0 && id.length < 256) ||
      new Set(identity.targets).size !== identity.targets.length)) throw new Error('Invalid CLI target identity metadata');
    if (identity && Object.hasOwn(identity, 'extra') && (!identity.extra || typeof identity.extra !== 'object' || Array.isArray(identity.extra))) {
      throw new Error('Invalid CLI loaded extension metadata');
    }
    if (identity?.extra?.loadedExtensions !== undefined) {
      if (!Array.isArray(identity.extra.loadedExtensions) || new Set(identity.extra.loadedExtensions).size !== identity.extra.loadedExtensions.length) {
        throw new Error('Invalid CLI loaded extension metadata');
      }
      assertExtensionPolicy(identity.extra.loadedExtensions);
    }
    try {
      const {OfflineAudioContext} = await import('node-web-audio-api');
      const vm = this.vm = new VirtualMachine();
      vm.attachStorage(new ScratchStorage());
      vm.runtime.ioDevices.video.provider = {
        enableVideo: () => Promise.reject(new Error('Live camera capture is not supported; use recorded input')),
        disableVideo: () => {}, getFrame: () => null
      };
      vm.setCompilerOptions({enabled: false});
      this.audio = new AudioEngine(new OfflineAudioContext(2, 44100, 44100));
      vm.attachAudioEngine(this.audio);
      require('./device-adapters').registerOfflineExtensions(vm);
      await vm.loadProject(normalizedBytes);
      this.renderer = new NativeRenderer(vm.runtime.stageWidth, vm.runtime.stageHeight);
      vm.attachRenderer(this.renderer);
      // Fonts deserialize while renderer is deliberately absent. Register all
      // validated binary assets before any SVG costume is rasterized.
      vm.runtime.fontManager.updateRenderer();
      const originals = vm.runtime.targets.filter(target => target.isOriginal);
      {
        // An ordinary SB3 lacks our identity metadata. Stable derived identities
        // let independent read/validate/apply processes refer to the same nodes.
        const seed = crypto.createHash('sha256').update(normalizedBytes).digest('hex');
        const remap = new Map(originals.map((target, index) => [target.id, identity ? identity.targets[index] : identityUUID(`${seed}:target:${index}`)]));
        for (const target of originals) target.id = remap.get(target.id);
        for (const monitor of vm.runtime.getMonitorState().valueSeq()) {
          if (remap.has(monitor.targetId)) vm.runtime.requestUpdateMonitor({id: monitor.id, targetId: remap.get(monitor.targetId)});
        }
        for (const block of Object.values(vm.runtime.monitorBlocks._blocks)) {
          if (remap.has(block.targetId)) block.targetId = remap.get(block.targetId);
        }
        vm.runtime.monitorBlocks.resetCache();
      }
      if (identity && Object.hasOwn(identity, 'assets')) {
        if (!identity.assets || typeof identity.assets !== 'object' || Array.isArray(identity.assets) ||
          Object.keys(identity.assets).length !== originals.length || !originals.every(target => Object.hasOwn(identity.assets, target.id))) {
          throw new Error('Invalid CLI asset identity metadata');
        }
        const used = new Set();
        for (const target of originals) for (const type of ['costumes', 'sounds']) {
          const assets = type === 'costumes' ? target.getCostumes() : target.getSounds();
          const ids = identity.assets[target.id]?.[type];
          if (!Array.isArray(ids) || ids.length !== assets.length || ids.some(id => typeof id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || used.has(id))) {
            throw new Error('Invalid CLI asset identity metadata');
          }
          if (new Set(ids).size !== ids.length) throw new Error('Invalid CLI asset identity metadata');
          for (let i = 0; i < assets.length; i++) {
            used.add(ids[i]); Object.defineProperty(assets[i], 'cliId', {value: ids[i], writable: true, configurable: true});
          }
        }
      }
      if (identity?.blockInputs !== undefined && (!identity.blockInputs || typeof identity.blockInputs !== 'object' ||
        Array.isArray(identity.blockInputs) || Object.keys(identity.blockInputs).length !== originals.length ||
        !originals.every(target => Object.hasOwn(identity.blockInputs, target.id)))) {
        throw new Error('Invalid CLI block input identity metadata');
      }
      for (const [index, target] of originals.entries()) {
        // SB3 stores number/text/variable input primitives without their VM IDs.
        // Persist slot identities separately and derive them for ordinary SB3s.
        const sourceIds = new Set(Object.keys(json.targets[index].blocks || {}));
        const persisted = identity?.blockInputs?.[target.id] || {};
        if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) throw new Error('Invalid CLI block input identity metadata');
        for (const [key, value] of Object.entries(persisted)) {
          let slot;
          try {slot = JSON.parse(key);} catch {throw new Error('Invalid CLI block input identity metadata');}
          if (!Array.isArray(slot) || slot.length !== 3 || slot.some(part => typeof part !== 'string' || !part) ||
            !['block', 'shadow'].includes(slot[2]) || typeof value !== 'string' || !value || value.length > 256 ||
            ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid CLI block input identity metadata');
        }
        const graph = target.blocks._blocks, remap = new Map(), active = new Set();
        const resolveId = id => {
          if (remap.has(id)) return remap.get(id);
          if (sourceIds.has(id)) {remap.set(id, id); return id;}
          if (active.has(id) || active.size > 512) throw new Error('Invalid cyclic block input identity');
          active.add(id);
          const block = graph[id], parent = block.parent && graph[block.parent];
          let key;
          if (parent) {
            const input = Object.entries(parent.inputs).find(([, input]) => input.block === id || input.shadow === id);
            if (!input) throw new Error('Block input identity has no owning slot');
            key = JSON.stringify([resolveId(parent.id), input[0], input[1].shadow === id ? 'shadow' : 'block']);
          } else throw new Error(`Block input identity has no source entry or owning slot: ${id}`);
          const result = Object.hasOwn(persisted, key) ? persisted[key] : identityUUID(`${target.id}:input:${key}`);
          remap.set(id, result); active.delete(id); return result;
        };
        for (const id of Object.keys(graph)) resolveId(id);
        if (new Set(remap.values()).size !== remap.size) throw new Error('Duplicate CLI block input identity');
        const resolveReference = id => id ? remap.get(id) || id : id;
        const rebuilt = Object.create(null);
        for (const block of Object.values(graph)) {
          block.id = resolveReference(block.id); block.parent = resolveReference(block.parent); block.next = resolveReference(block.next);
          for (const input of Object.values(block.inputs)) {input.block = resolveReference(input.block); input.shadow = resolveReference(input.shadow);}
          rebuilt[block.id] = block;
        }
        target.blocks._blocks = rebuilt;
        target.blocks._scripts = target.blocks._scripts.map(resolveReference);
        target.blocks.resetCache();
        for (const comment of Object.values(target.comments)) {
          comment.blockId = resolveReference(comment.blockId);
          // Compact dictionary reporters omit block.comment during serialization.
          // Their comment records retain the source ID and restore the reverse link.
          const source = json.targets[index].blocks?.[comment.blockId], block = rebuilt[comment.blockId];
          if (block && Array.isArray(source) && [12, 13].includes(source[0])) {
            if (block.comment && block.comment !== comment.id) throw new Error(`Multiple comments attached to compact block: ${block.id}`);
            block.comment = comment.id;
          }
        }
      }
      for (const target of originals) {
        if (!identity?.assets) for (const type of ['costumes', 'sounds']) {
          const assets = type === 'costumes' ? target.getCostumes() : target.getSounds();
          assets.forEach((asset, index) => Object.defineProperty(asset, 'cliId', {
            value: identityUUID(`${target.id}:${type}:${index}:${asset.assetId}`), writable: true, configurable: true
          }));
        }
        this.ensureAssetIds(target);
        target.renderer = this.renderer;
        target.initDrawable(target.isStage ? StageLayering.BACKGROUND_LAYER : StageLayering.SPRITE_LAYER);
        for (const costume of target.getCostumes()) await this.hydrateCostume(costume);
        target.updateAllDrawableProperties();
      }
      // Metadata/JSON follows target-pane order, not names (duplicate names are
      // renamed by VM). Keep layer order by corresponding record index.
      const layers = new Map(originals.map((target, index) => [target, json.targets[index].layerOrder ?? index]));
      const sprites = originals.filter(target => !target.isStage).sort((a, b) => layers.get(a) - layers.get(b));
      for (const target of sprites) target.goToFront();
      for (const id of identity?.extra?.loadedExtensions || []) if (!vm.extensionManager.isExtensionLoaded(id)) {
        await vm.extensionManager.loadExtensionURL(id);
      }
      vm.runtime.parseProjectOptions();
      vm.setCompilerOptions({enabled: false});
      vm.setEditingTarget((originals.find(target => !target.isStage) || originals[0]).id);
      this.sourceFormat = sourceFormat; this.importWarnings = warnings;
      return this.info();
    } catch (error) {this.dispose(); throw error;}
  }
  async hydrateCostume(costume) {
    if (!costume.asset) throw new Error(`Missing costume asset: ${costume.name}`);
    const center = Number.isFinite(costume.rotationCenterX) && Number.isFinite(costume.rotationCenterY) ?
      [costume.rotationCenterX, costume.rotationCenterY] : undefined;
    if (costume.dataFormat === 'svg') {
      costume.skinId = this.renderer.createSVGSkin(costume.asset.decodeText(), center);
      costume.size = this.renderer.getSkinSize(costume.skinId);
      if (!center) {
        const rotation = this.renderer.getSkinRotationCenter(costume.skinId);
        costume.rotationCenterX = rotation[0]; costume.rotationCenterY = rotation[1];
      }
      costume.bitmapResolution = 1;
    } else {
      const image = await loadImage(Buffer.from(costume.asset.data));
      if (!image.width || !image.height) throw new Error(`Cannot decode bitmap ${costume.name}`);
      const resolution = costume.bitmapResolution || 2;
      costume.skinId = this.renderer.createBitmapSkin(image, resolution, center && center.map(value => value / resolution));
      costume.size = [image.width, image.height];
      if (!center) {costume.rotationCenterX = image.width / 2; costume.rotationCenterY = image.height / 2;}
    }
  }
  target(selector) {
    if (!this.vm) throw new Error('No project is open');
    const originals = this.vm.runtime.targets.filter(target => target.isOriginal);
    // IDs are authoritative even if another sprite happens to use one as its name.
    const byId = selector === undefined ? null : originals.find(target => target.id === selector);
    if (byId) return byId;
    const matches = originals.filter(target => selector === undefined ? target === this.vm.editingTarget :
      selector === 'stage' ? target.isStage : target.getName() === selector);
    if (matches.length !== 1) throw resourceError(matches.length, `Target not found or ambiguous: ${selector}`, selector);
    return matches[0];
  }
  info() {
    return {file: this.file, stage: {width: this.vm.runtime.stageWidth, height: this.vm.runtime.stageHeight},
      selected: this.vm.editingTarget?.getName(),
      targets: this.vm.runtime.targets.filter(target => target.isOriginal).map(target => ({
        id: target.id, name: target.getName(), isStage: target.isStage, x: target.x, y: target.y,
        size: target.size, direction: target.direction, visible: target.visible,
        costumes: target.getCostumes().map((costume, index) => ({index, name: costume.name, format: costume.dataFormat, md5: costume.md5})),
        sounds: target.getSounds().map((sound, index) => ({index, name: sound.name, rate: sound.rate, samples: sound.sampleCount})),
        blocks: Object.keys(target.blocks._blocks).length,
        variables: Object.values(target.variables).map(variable => ({id: variable.id, name: variable.name, type: variable.type, value: variable.value, cloud: variable.isCloud}))
      }))};
  }
  ensureAssetIds(target) {
    for (const asset of [...target.getCostumes(), ...target.getSounds()]) {
      if (!asset.cliId) Object.defineProperty(asset, 'cliId', {value: crypto.randomUUID(), writable: true, configurable: true});
    }
    return target;
  }
  async bytes() {
    if (!this.vm) throw new Error('No project is open');
    const targets = this.vm.runtime.targets.filter(target => target.isOriginal).map(target => this.ensureAssetIds(target));
    const zip = new JSZip();
    const serialized = this.vm.toJSON(null, {allowOptimization: false});
    const json = JSON.parse(serialized);
    zip.file('project.json', serialized);
    zip.file('tw-cli-state.json', JSON.stringify({version: 1,
      targets: targets.map(target => target.id), extra: {loadedExtensions: [...safeExtensions].filter(id => this.vm.extensionManager.isExtensionLoaded(id))},
      assets: Object.fromEntries(targets.map(target => [target.id, {
        costumes: target.getCostumes().map(asset => asset.cliId), sounds: target.getSounds().map(asset => asset.cliId)
      }])),
      blockInputs: Object.fromEntries(targets.map((target, index) => [target.id,
        Object.fromEntries(Object.values(target.blocks._blocks).flatMap(parent => Object.entries(parent.inputs).flatMap(([name, input]) =>
          ['block', 'shadow'].filter(role => input[role] && !Object.hasOwn(json.targets[index].blocks, input[role])).map(role =>
            [JSON.stringify([parent.id, name, role]), input[role]]))))
      ]))}));
    for (const asset of this.vm.serializeAssets()) zip.file(asset.fileName, asset.fileContent);
    return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
  }
  attachCloud(file) {
    const cloud = new (require('./local-cloud').LocalCloud)(file, this.vm);
    if (this.cloud) this.cloud.close();
    this.cloud = cloud;
    this.cloudFile = cloud.filename;
  }
  dispose() {
    const {cloud, vm, renderer, audio} = this;
    this.cloud = null; this.cloudFile = null; this.vm = null; this.renderer = null; this.audio = null;
    try {if (cloud) cloud.close();} finally {
      try {
        if (vm) {try {require('./device-adapters').disposeOfflineExtensions(vm); vm.clear();} finally {vm.quit(); vm.runtime.removeAllListeners(); vm.removeAllListeners();}}
      } finally {
        try {if (renderer) renderer.dispose();} finally {if (audio) audio.inputNode.disconnect();}
      }
    }
  }
}

module.exports = {Project, blankProject, emptyTarget, svgCostume, md5, atomicWrite, readProject, readSpriteArchive,
  normalizeProject, readLocalFile, safeArchivePath, checkedZip, rejectPrototypeKeys, validateProjectPolicy, MAX_PROJECT_BYTES};
