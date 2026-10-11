'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const acorn = require('acorn');

const BUNDLE_HASH = 'cfe51b7bfa293d6047ed9c305f21fbc34a99abf3099d646f1ab3f25588a80a28';
let runtimeBundle;

function seedAssets(storage, manifest, assets, decodeBase64) {
  for (const target of manifest.project.targets) {
    for (const costume of target.costumes || []) {
      const key = costume.md5ext || `${costume.assetId}.${costume.dataFormat}`;
      if (!assets[key]) throw new Error('Missing costume asset');
      const data = decodeBase64(assets[key]);
      const type = costume.dataFormat.toLowerCase() === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
      // createAsset only constructs an Asset; it does not place it in the
      // lookup cache. The metadata deserializer must be able to load by ID.
      storage.cache(type, costume.dataFormat, data, costume.assetId);
    }
    for (const sound of target.sounds || []) {
      const key = sound.md5ext || `${sound.assetId}.${sound.dataFormat}`;
      if (!assets[key]) throw new Error('Missing sound asset');
      storage.cache(storage.AssetType.Sound, sound.dataFormat, decodeBase64(assets[key]), sound.assetId);
    }
  }
}

async function renderInitialFrame(renderer, runtime) {
  // SVG costume creation returns before its image has loaded. Wait for the
  // image event without replacing the renderer's own onload callback.
  const images = Object.values(renderer._allSkins).filter(Boolean).map(skin => skin._svgImage).filter(Boolean);
  await Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise((resolve, reject) => {
    const clean = () => {image.removeEventListener('load', loaded);image.removeEventListener('error', failed);};
    const loaded = () => {clean();resolve();};
    const failed = () => {clean();reject(new Error('Unable to render SVG costume'));};
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
  })));
  runtime.requestRedraw();
  renderer.draw();
}

// This function is also serialized into the offline player. Keep its dependencies
// explicit: neither a script lookup nor monitor execution requires a block graph.
function installAotRuntime(vm, manifest, programs, Thread, execute, MonitorRecord) {
  const runtime = vm.runtime;
  const originals = runtime.targets.filter(target => target.isOriginal);
  const eventsBySprite = new Map();
  for (const event of manifest.events) {
    const target = originals[event.targetIndex];
    if (!target || !programs[event.programIndex]) throw new Error('Invalid compiled event registration');
    let events = eventsBySprite.get(target.sprite);
    if (!events) eventsBySprite.set(target.sprite, events = []);
    events.push(event);
  }

  const getEvents = target => eventsBySprite.get(target.sprite) || [];
  const initializeThread = thread => {
    const event = getEvents(thread.target).find(candidate => candidate.id === thread.topBlock);
    if (!event) throw new Error('Missing compiled entry point');
    const program = programs[event.programIndex];
    thread.procedures = Object.create(null);
    for (const code of Object.keys(program.procedures)) {
      thread.procedures[code] = program.procedures[code](thread);
    }
    thread.generator = program.startingFunction(thread)();
    thread.executableHat = program.executableHat;
    thread.triedToCompile = true;
    thread.isCompiled = true;
  };

  const createThread = (id, target) => {
    const thread = new Thread(id);
    thread.target = target;
    thread.blockContainer = target.blocks;
    thread.pushStack(id);
    thread.tryCompile = () => initializeThread(thread);
    initializeThread(thread);
    return thread;
  };
  runtime._pushThread = (id, target) => {
    const thread = createThread(id, target);
    runtime.threads.push(thread);
    runtime.threadMap.set(thread.getId(), thread);
    return thread;
  };
  runtime._restartThread = previous => {
    const thread = createThread(previous.topBlock, previous.target);
    runtime.threadMap.set(thread.getId(), thread);
    const index = runtime.threads.indexOf(previous);
    if (index === -1) runtime.threads.push(thread);
    else runtime.threads[index] = thread;
    return thread;
  };
  runtime.allScriptsDo = (callback, target) => {
    const targets = target ? [target] : runtime.executableTargets;
    for (let i = targets.length - 1; i >= 0; i--) {
      for (const event of getEvents(targets[i])) callback(event.id, targets[i]);
    }
  };
  runtime.allScriptsByOpcodeDo = (opcode, callback, target) => {
    const targets = target ? [target] : runtime.executableTargets;
    for (let i = targets.length - 1; i >= 0; i--) {
      for (const event of getEvents(targets[i])) {
        if (event.opcode !== opcode) continue;
        const fieldsOfInputs = Object.create(null);
        for (const [name, value] of Object.entries(event.fields)) {
          fieldsOfInputs[name] = {value: String(value).toUpperCase()};
        }
        callback({blockId: event.id, fieldsOfInputs}, targets[i]);
      }
    }
  };
  // Cache resets may ask a live thread to recompile. Reinitialize its existing
  // compiled entry, never fall back to the ordinary interpreter/compiler.
  runtime.compilerOptions.enabled = true;
  runtime._updateGlows = () => {};
  runtime.precompile = () => {};

  const stage = runtime.getTargetForStage();
  const monitors = new Map();
  const addMonitor = description => {
    const target = description.spriteName ? originals.find(t => t.getName() === description.spriteName) : stage;
    if (!target) return;
    const monitor = Object.assign({}, description, {targetId: target.isStage ? null : target.id});
    const info = runtime.monitorBlockInfo[monitor.opcode];
    if (info && info.isSpriteSpecific && monitor.opcode !== 'data_variable' && monitor.opcode !== 'data_listcontents') {
      const fields = Object.fromEntries(Object.entries(monitor.params || {}).map(([name, value]) => [name, {name, value}]));
      monitor.id = info.getId(target.id, fields);
    }
    monitors.set(monitor.id, {monitor, target});
    runtime.requestAddMonitor(new MonitorRecord(monitor));
  };
  for (const monitor of manifest.project.monitors || []) addMonitor(monitor);
  for (const target of originals) {
    for (const variable of Object.values(target.variables)) {
      if (variable.type !== '' && variable.type !== 'list') continue;
      if (monitors.has(variable.id)) continue;
      addMonitor({id: variable.id, opcode: variable.type === 'list' ? 'data_listcontents' : 'data_variable',
        params: variable.type === 'list' ? {LIST: variable.name} : {VARIABLE: variable.name},
        spriteName: target.isStage ? null : target.getName(), visible: false, value: variable.value});
    }
  }
  runtime.monitorBlocks.changeBlock = change => {
    if (change.element === 'checkbox') runtime.requestUpdateMonitor({id: change.id, visible: Boolean(change.value)});
  };
  runtime._pushMonitors = () => {
    for (const [id, {monitor, target}] of monitors) {
      const state = runtime._monitorState.get(id);
      if (!state || !state.visible) continue;
      let value;
      if (monitor.opcode === 'data_variable' || monitor.opcode === 'data_listcontents') {
        const variable = target.lookupVariableById(id);
        if (!variable) continue;
        value = variable.type === 'list' ? variable.value.slice() : variable.value;
      } else {
        const primitive = runtime._primitives[monitor.opcode];
        if (!primitive) continue;
        const utility = {target, thread: {updateMonitor: true},
          ioQuery: (device, method, args) => runtime.ioDevices[device][method].apply(runtime.ioDevices[device], args)};
        value = primitive(monitor.params || {}, utility);
        if (value && typeof value.then === 'function') continue;
      }
      runtime.requestUpdateMonitor({id, value});
    }
  };
  runtime.monitorBlocks._blocks = Object.create(null);
  runtime.monitorBlocks._scripts = [];
  for (const target of originals) {
    if (Object.keys(target.blocks._blocks).length) throw new Error('Player must not contain a project block graph');
    target.blocks.forceNoGlow = true;
  }
  // The import API was needed only for runtime state and assets. Export/import
  // entry points are deliberately unavailable in the compiled player.
  const unavailable = () => { throw new Error('Compiled player does not contain an editable Scratch project'); };
  for (const name of ['loadProject', 'deserializeProject', 'saveProjectSb3', 'toJSON', 'exportSprite', 'addSprite']) {
    vm[name] = unavailable;
  }
  vm.emitWorkspaceUpdate = () => {};
  runtime.emit('MONITORS_UPDATE', runtime._monitorState.shallowClone());
  return {runtime, execute};
}

function getRuntimeBundle() {
  if (runtimeBundle) return runtimeBundle;
  const filename = require.resolve('@turbowarp/packager/dist/scaffolding/scaffolding-full.js');
  const source = fs.readFileSync(filename, 'utf8');
  if (crypto.createHash('sha256').update(source).digest('hex') !== BUNDLE_HASH) {
    throw new Error('Frozen browser player changed; compiled ABI must be reviewed before rebuilding');
  }
  const tree = acorn.parse(source, {ecmaVersion: 2020});
  const modules = tree.body[0].expression.argument.arguments[0].elements;
  const replacements = [45, 68, 190, 192, 193, 195].map(index => ({
    start: modules[index].start, end: modules[index].end,
    text: 'function(){throw new Error("Browser compiler omitted from compiled player")}'
  }));
  const musicModule = modules[119];
  const musicSource = source.slice(musicModule.start, musicModule.end);
  const musicReadyBoundary = 'Promise.all(t).then((()=>{}))';
  if (!musicSource.includes(musicReadyBoundary)) throw new Error('Frozen music loading boundary changed');
  replacements.push({start: musicModule.start, end: musicModule.end,
    text: musicSource.replace(musicReadyBoundary, 'this.aotSoundReady=Promise.all(t)')});
  // Capture just the private classes needed by the AOT player inside the outer
  // lexical scope. Do not expose webpack's module loader on window.
  const marker = 'r(r.s=303)';
  const position = source.indexOf(marker);
  if (position < 0) throw new Error('Frozen browser bootstrap changed');
  replacements.push({start: position, end: position + marker.length,
    text: 'r(r.s=303);aotInternals={Thread:r(21),execute:r(47),MonitorRecord:r(25)}'});
  let result = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  runtimeBundle = result;
  return result;
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function generateRuntime(compiled, options = {}) {
  const ids = Object.assign({containerId: 'project', startId: 'green-flag', stopId: 'stop', statusId: 'status'}, options);
  return `(function(){"use strict";let aotInternals;\n${getRuntimeBundle()}\n` +
    `const manifest=${scriptJson(compiled.manifest)},assets=${scriptJson(compiled.assets)};\n` +
    `const options=${scriptJson(ids)}; const installAotRuntime=${installAotRuntime.toString()};const seedAssets=${seedAssets.toString()};const renderInitialFrame=${renderInitialFrame.toString()};\n` +
    `const scaffolding=new window.Scaffolding.Scaffolding();\n` +
    `if(manifest.stageSize){scaffolding.width=manifest.stageSize.width;scaffolding.height=manifest.stageSize.height;}\n` +
    `scaffolding.setup();scaffolding.appendTo(document.getElementById(options.containerId));\n` +
    `const status=document.getElementById(options.statusId),startButton=document.getElementById(options.startId),stopButton=document.getElementById(options.stopId);\n` +
    `const setStatus=text=>{if(status)status.textContent=text};\n` +
    `const ready=(async()=>{\n` +
    `if(manifest.format!==1)throw new Error('Unsupported compiled player format');\n` +
    `seedAssets(scaffolding.storage,manifest,assets,encoded=>Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)));\n` +
    `for(const extension of manifest.project.extensions||[])scaffolding.vm.extensionManager.loadExtensionIdSync(extension);\n` +
    `if(scaffolding.vm.runtime.ext_scratch3_music)await scaffolding.vm.runtime.ext_scratch3_music.aotSoundReady;\n` +
    `const project=JSON.parse(JSON.stringify(manifest.project));project.projectVersion=3;project.monitors=[];\n` +
    `await scaffolding.vm.deserializeProject(project);\n` +
    `const programs=(${compiled.programSource})(aotInternals.execute.scopedEval);\n` +
    `installAotRuntime(scaffolding.vm,manifest,programs,aotInternals.Thread,aotInternals.execute,aotInternals.MonitorRecord);\n` +
    `scaffolding.vm.runtime.handleProjectLoaded();await renderInitialFrame(scaffolding.renderer,scaffolding.vm.runtime);scaffolding.vm.start();setStatus('就绪 · 点击绿旗开始');if(startButton)startButton.disabled=false;if(stopButton)stopButton.disabled=false;\n` +
    (options.exposeDebug ? `window.__protectedDebug={vm:scaffolding.vm,scaffolding,manifest,programs};\n` : '') +
    `return true;})();\n` +
    `const start=async()=>{await ready;if(scaffolding.audioEngine&&scaffolding.audioEngine.audioContext)await scaffolding.audioEngine.audioContext.resume();if(document.activeElement&&document.activeElement.tagName==='BUTTON')document.activeElement.blur();scaffolding.greenFlag();setStatus('运行中')};const stop=()=>{scaffolding.stopAll();setStatus('已停止')};\n` +
    `if(startButton)startButton.addEventListener('click',()=>start().catch(error=>setStatus(error.message)));if(stopButton)stopButton.addEventListener('click',stop);\n` +
    `window.protectedPlayer=Object.freeze({start,stop,ready});ready.catch(error=>{setStatus('加载失败：'+error.message);console.error(error)});delete window.Scaffolding;\n})();`;
}

module.exports = {generateRuntime, getRuntimeBundle, installAotRuntime, seedAssets, renderInitialFrame};
