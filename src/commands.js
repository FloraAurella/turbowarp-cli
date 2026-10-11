const path = require('node:path');
const crypto = require('node:crypto');
const {fork} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const {Project, blankProject, atomicWrite, readLocalFile, emptyTarget, svgCostume, md5} = require('./project');
const editorCommands = require('./editor-commands');
const commandModules = require('./command-modules');
const {resourceError, CommandError} = require('./errors');

const number = (value, label) => {
  const result = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(result)) throw new Error(`${label} must be a finite number`);
  return result;
};
const integer = (value, label, min = 0, max = 100000) => {
  const result = number(value, label);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return result;
};
const parseValue = value => {
  if (value === undefined) throw new Error('Missing value');
  try {return JSON.parse(value);} catch {return value;}
};
const snapshotFingerprint = async bytes => {
  const archive = await JSZip.loadAsync(bytes);
  const digest = crypto.createHash('sha256');
  for (const name of Object.keys(archive.files).sort()) {
    if (archive.files[name].dir) continue;
    digest.update(name + '\0');
    digest.update(await archive.files[name].async('nodebuffer'));
    digest.update('\0');
  }
  return digest.digest('hex');
};
const assetIndex = (assets, selector) => {
  const indices = assets.map((asset, index) => asset.name === selector || String(index) === String(selector) ? index : -1).filter(index => index >= 0);
  if (indices.length !== 1) throw resourceError(indices.length, `Asset not found or ambiguous: ${selector}`, selector);
  return indices[0];
};
// [minimum positional arguments, maximum, accepted options]. Validate before loading
// --project or starting a transaction, so typos cannot change session state.
const {commandSpecs: COMMANDS, optionsFrom, validateCommand, commandHelp, HELP} = require('./command-catalog');

class CommandSession {
  static HISTORY_LIMIT = 99;
  static HISTORY_BYTE_LIMIT = 200 * 1024 * 1024;
  constructor() {this.project = new Project(); this.undoStack = []; this.redoStack = []; this.dirty = false; this.inputs = []; this.runtimeSettings = {}; this.workers = new Set(); this.disposed = false;}
  snapshot() {return this.project.bytes();}
  sessionState() {return {inputs: structuredClone(this.inputs), runtimeSettings: structuredClone(this.runtimeSettings),
    username: this.project.vm?.runtime.ioDevices.userData.getUsername(), volume: this.project.audio?.inputNode.gain.value,
    modules: commandModules.captureState(this)};}
  restoreSessionState(state) {
    if (!state) return;
    this.inputs = structuredClone(state.inputs || []);
    this.runtimeSettings = structuredClone(state.runtimeSettings || {});
    if (this.project.vm && state.username !== undefined) this.project.vm.postIOData('userData', {username: state.username});
    if (this.project.audio && state.volume !== undefined) this.project.audio.inputNode.gain.value = state.volume;
    commandModules.restoreState(this, state.modules || {});
  }
  trimHistory(stack) {
    let bytes = stack.reduce((sum, entry) => sum + entry.bytes.length, 0);
    while (stack.length > CommandSession.HISTORY_LIMIT || stack.length > 1 && bytes > CommandSession.HISTORY_BYTE_LIMIT) bytes -= stack.shift().bytes.length;
  }
  async restore(bytes, selected) {
    await this.project.load(bytes);
    if (selected) {
      const target = this.project.target(selected);
      this.project.vm.editingTarget = target; this.project.vm.runtime.setEditingTarget(target);
    }
  }
  async transaction(label, operation, options = {}) {
    if (this._batchDepth) {
      if (options.out) throw new CommandError('INVALID_ARGUMENT', 'Nested output is forbidden in a project batch', '仅在批量提交后保存一次项目。');
      return operation();
    }
    const before = await this.snapshot();
    const serializedBefore = this.project.vm.toJSON(null, {allowOptimization: false});
    const selected = this.project.vm.editingTarget?.id;
    const dirty = this.dirty;
    const file = this.project.file, sourceHash = this.project.sourceHash;
    const state = this.sessionState();
    try {
      const result = await operation(before);
      if (options.skipUnchanged && result.changed === false) {
        if (options.out && path.resolve(options.out) !== this.project.file) result.saved = await this.save(options.out, options.force);
        return result;
      }
      this.dirty = true;
      // Persistence is part of the command, not a second transaction. A refused
      // overwrite must leave the project and undo/redo stacks untouched.
      if (options.out) {
        const saved = await this.save(options.out, options.force);
        if (options.skipUnchanged) result.saved = saved;
      }
      this.undoStack.push({label, bytes: before, selected, state});
      this.trimHistory(this.undoStack);
      this.redoStack = [];
      return result;
    } catch (error) {
      if (this.disposed) throw error;
      let unchanged = false;
      try {
        unchanged = this.project.vm && this.project.vm.toJSON(null, {allowOptimization: false}) === serializedBefore &&
          await snapshotFingerprint(await this.snapshot()) === await snapshotFingerprint(before);
      } catch {}
      try {
        if (!unchanged) await this.restore(before, selected);
        else if (selected && this.project.vm.runtime.getTargetById(selected)) {
          this.project.vm.editingTarget = this.project.vm.runtime.getTargetById(selected);
          this.project.vm.runtime.setEditingTarget(this.project.vm.editingTarget);
        }
      } finally {this.restoreSessionState(state); this.dirty = dirty; this.project.file = file; this.project.sourceHash = sourceHash;}
      throw error;
    }
  }
  async onTarget(target, explicit, operation) {
    const selected = this.project.vm.editingTarget?.id;
    const select = id => {
      const vm = this.project.vm;
      const current = vm.runtime.getTargetById(id);
      if (current) {vm.editingTarget = current; vm.runtime.setEditingTarget(current);}
    };
    select(target.id);
    try {return await operation();} finally {
      if (explicit) select(selected);
    }
  }
  async execute(argv) {
    if (this.disposed) throw new Error('Command session is disposed');
    const {command, args, options} = validateCommand(argv);
    if (command === 'project' && ['read', 'find', 'validate'].includes(args[0]) && options.project) {
      const candidate = new CommandSession();
      candidate.stdinOwned = this.stdinOwned;
      try {await candidate.open(options.project); return await candidate.nativeProject(args, options);}
      finally {candidate.dispose();}
    }
    if (!options.project) return this.executeCommand(argv);
    if (command === 'script' && args[0] === 'validate') {
      const candidate = new Project();
      try {
        await candidate.load(await readLocalFile(options.project));
        return await require('./script-recipes').execute({project: candidate}, args, candidate.target(options.target));
      } finally {candidate.dispose();}
    }
    if (this.projectSwitch) throw new Error('Nested --project replacement is not supported');
    const before = {project: this.project, state: this.sessionState(), dirty: this.dirty, undo: this.undoStack, redo: this.redoStack};
    this.projectSwitch = before;
    try {
      const result = await this.executeCommand(argv);
      if (this.project !== before.project) before.project.dispose();
      return result;
    } catch (error) {
      if (this.project !== before.project) {
        try {this.project.dispose();} finally {
          this.project = before.project; this.restoreSessionState(before.state);
          this.undoStack = before.undo; this.redoStack = before.redo; this.dirty = before.dirty;
        }
      }
      throw error;
    } finally {this.projectSwitch = null;}
  }
  async executeCommand(argv) {
    const {command, args, options} = validateCommand(argv);
    if (command === 'help') return options.json ? commandHelp(args[0], true) : {text: commandHelp(args[0])};
    if (command === 'capabilities') return require('./capabilities').describe();
    if (command === 'doctor') {const runtime = require('./node-runtime'); return runtime.doctor(runtime.selectNode());}
    if (command === 'pref') return require('./preferences').execute(args, options.config);
    if (command === 'check') return require('./acceptance-state').status();
    if (command === 'package') {
      const pack = commandModules.route('pack');
      const packArgs = ['build', args[0] || options.out || ''];
      const packOptions = {force: !!options.force};
      if (!this.packagerSettings && packArgs[1]) packOptions.opt = 'app.windowTitle=' + JSON.stringify(path.basename(packArgs[1], path.extname(packArgs[1])));
      if (options.project) packOptions.project = options.project;
      await pack.preflight(this, 'pack', packArgs, packOptions);
      if (options.project) {
        if (this.dirty) throw new Error('Save or discard current changes before --project');
        await this.open(options.project);
      }
      if (!this.project.vm) throw new Error('Open a project first: open 项目.sb3 or --project 项目.sb3');
      return pack.execute(this, 'pack', packArgs, packOptions);
    }
    const route = commandModules.route(command);
    if (typeof route?.preflight === 'function') await route.preflight(this, command, args, options);
    if (options.project) {
      if (this.dirty) throw new Error('Save or discard current changes before --project');
      await this.open(options.project);
    }
    if (command === 'new') {
      if (this.dirty && !options.force) throw new Error('Unsaved changes; use save or --force');
      const output = args[0] || options.out;
      const previous = output && this.project.vm ? {bytes: await this.snapshot(), selected: this.project.vm.editingTarget?.id,
        file: this.project.file, sourceHash: this.project.sourceHash, dirty: this.dirty, state: this.sessionState()} : null;
      try {
        await this.project.load(await blankProject());
        this.project.file = null; this.project.sourceHash = null; this.dirty = true;
        const result = output ? await this.save(output, options.force) : this.project.info();
        this.undoStack = []; this.redoStack = []; this.inputs = []; this.runtimeSettings = {};
        commandModules.restoreState(this);
        return result;
      } catch (error) {
        if (previous) {
          try {await this.restore(previous.bytes, previous.selected);} finally {this.restoreSessionState(previous.state); this.project.file = previous.file; this.project.sourceHash = previous.sourceHash; this.dirty = previous.dirty;}
        }
        throw error;
      }
    }
    if (command === 'open') {
      if (this.dirty && !options.force) throw new Error('Unsaved changes; use save or --force');
      return this.open(args[0]);
    }
    const modular = commandModules.route(command);
    if (modular) {
      const required = typeof modular.requiresProject === 'function' ? modular.requiresProject(command, args) : true;
      if (required && !this.project.vm) throw new Error('Open a project first: open 项目.sb3 or --project 项目.sb3');
      const execute = async () => {
        const target = required && modular.usesProjectTarget !== false && options.target ? this.project.target(options.target) : null;
        return target ? this.onTarget(target, true, () => modular.execute(this, command, args, options)) :
          modular.execute(this, command, args, options);
      };
      const readOnly = modular.mutates === false || (typeof modular.isReadOnly === 'function' && modular.isReadOnly(command, args, options, this));
      return required && !readOnly ? this.transaction(`${command} ${args.join(' ')}`, execute, options) : execute();
    }
    if (!this.project.vm) throw new Error('Open a project first: open 项目.sb3 or --project 项目.sb3');
    if (command === 'info') return {...this.project.info(), dirty: this.dirty};
    if (command === 'save') return this.save(args[0] || options.out, options.force);
    if (command === 'history') return {undo: this.undoStack.map(item => item.label), redo: this.redoStack.map(item => item.label)};
    if (command === 'undo' || command === 'redo') {
      const source = command === 'undo' ? this.undoStack : this.redoStack;
      const destination = command === 'undo' ? this.redoStack : this.undoStack;
      if (!source.length) throw new Error(`Nothing to ${command}`);
      const entry = source[source.length - 1];
      const current = {label: entry.label, bytes: await this.snapshot(), selected: this.project.vm.editingTarget?.id, state: this.sessionState()};
      const dirty = this.dirty;
      try {
        await this.restore(entry.bytes, entry.selected);
        this.restoreSessionState(entry.state);
        this.dirty = true;
        if (options.out) await this.save(options.out, options.force);
      } catch (error) {
        try {await this.restore(current.bytes, current.selected);} finally {this.restoreSessionState(current.state); this.dirty = dirty;}
        throw error;
      }
      source.pop(); destination.push(current); this.trimHistory(destination);
      return {action: command, label: entry.label};
    }
    if (command === 'render') return atomicWrite(args[0] || options.out || 'stage.png', this.project.renderer.png(), options.force);
    if (command === 'cloud') {
      const stage = this.project.vm.runtime.getTargetForStage();
      if (args[0] === 'use') {if (!args[1]) throw new Error('Missing cloud state path'); this.project.attachCloud(args[1]); return {file: this.project.cloudFile};}
      if (!this.project.cloud) throw new Error('Use cloud use 状态.json first');
      if (args[0] === 'sync') return {values: this.project.cloud.sync()};
      if (args[0] === 'list') return {file: this.project.cloudFile, values: this.project.cloud.read()};
      if (args[0] === 'add') {
        const name = args[1]; const initial = parseValue(args[2] ?? '0');
        const {validateName, validateValue} = require('./local-cloud');
        validateName(name); validateValue(initial);
        if (Object.values(stage.variables).some(variable => variable.name === name)) throw new Error('Duplicate cloud variable name');
        if (!this.project.vm.runtime.canAddCloudVariable()) throw new Error('Cloud variable limit reached');
        return this.transaction('cloud add', () => {
          const id = crypto.randomUUID();
          // The upstream create hook writes the default zero before the supplied
          // value. Create locally, then make exactly one validated external write.
          stage.createVariable(id, name, '', false);
          stage.variables[id].isCloud = true;
          this.project.vm.runtime.addCloudVariable();
          this.project.vm.setVariableValue(stage.id, id, initial); return {id, name, value: initial};
        }, options);
      }
      const matches = Object.values(stage.variables).filter(variable => variable.isCloud && (variable.name === args[1] || variable.id === args[1]));
      const variable = matches.length === 1 ? matches[0] : null;
      if (!variable) throw resourceError(matches.length, 'Cloud variable not found or ambiguous', args[1]);
      if (args[0] === 'get') {this.project.cloud.sync(); return {name: variable.name, value: variable.value};}
      if (args[0] === 'set') {
        const value = parseValue(args[2]);
        require('./local-cloud').validateValue(value);
        // Persist first: provider failure must not leave the editor with a value
        // that was never accepted by the shared cloud state.
        this.project.cloud.updateVariable(variable.name, value);
        variable.value = value;
        this.dirty = true; return {name: variable.name, value: variable.value};
      }
      throw new Error('Use cloud use/list/add/get/set/sync');
    }
    if (command === 'run') return this.run(options);
    if (command === 'input') return this.input(args);
    const target = this.project.target(options.target);
    if (command === 'sense') {
      if (args[0] === 'color') {
        if (!/^#[0-9a-f]{6}$/i.test(args[1] || '')) throw new Error('Color must be #rrggbb');
        const color = [1, 3, 5].map(index => parseInt(args[1].slice(index, index + 2), 16));
        return {touching: this.project.renderer.isTouchingColor(target.drawableID, color)};
      }
      if (args[0] === 'touching') return {touching: this.project.renderer.isTouchingDrawables(target.drawableID, [this.project.target(args[1]).drawableID])};
      throw new Error('Use sense color #rrggbb or sense touching Target');
    }
    if (Object.hasOwn(editorCommands, command)) {
      const readOnly = ['list', 'all', 'get', 'info', 'source', 'nodes'].includes(args[0]);
      const operation = () => this.onTarget(target, options.target !== undefined, () => editorCommands[command](this, args, options, target));
      return readOnly ? operation() : this.transaction(`${command} ${args.join(' ')}`, operation, options);
    }
    const readOnly = command === 'script' && args[0] === 'validate' ||
      ['sprite', 'var', 'block', 'costume', 'sound'].includes(command) && (args[0] === 'list' || args[0] === 'export' || args[0] === 'render');
    const operations = {
      sprite: () => this.sprite(args, options, target),
      var: () => this.variable(args, options, target),
      block: () => this.block(args, options, target),
      script: () => args[0] === 'demo' ? this.script(args, target) : require('./script-recipes').execute(this, args, target),
      costume: () => this.costume(args, options, target),
      sound: () => this.sound(args, options, target)
    };
    if (!Object.hasOwn(operations, command)) throw new Error(`Unknown command ${command}; use help`);
    if (command === 'sprite' && args[0] === 'select') return operations[command]();
    const operation = command === 'script' && args[0] === 'validate' ? operations[command] :
      () => this.onTarget(target, options.target !== undefined, operations[command]);
    return readOnly ? operation() : this.transaction(`${command} ${args.join(' ')}`, operation, options);
  }
  async open(file) {
    if (!file) throw new Error('Missing project path');
    const bytes = await readLocalFile(file);
    if (this.projectSwitch?.project === this.project) {
      const candidate = new Project();
      try {
        await candidate.load(bytes);
        if (this.project.cloudFile) candidate.attachCloud(this.project.cloudFile);
      } catch (error) {candidate.dispose(); throw error;}
      this.project = candidate;
    } else await this.project.load(bytes);
    this.project.file = path.resolve(file); this.undoStack = []; this.redoStack = []; this.dirty = false; this.inputs = []; this.runtimeSettings = {};
    this.project.sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
    commandModules.restoreState(this);
    return this.project.info();
  }
  async save(file, force) {
    if (this._batchDepth) throw new CommandError('INVALID_ARGUMENT', 'Saving inside a project batch is forbidden', '在 batch 完成后调用 save，或向最终提交提供 --out。');
    const filename = file || this.project.file;
    if (!filename) throw new Error('Missing output path: save 项目.sb3');
    if (path.extname(filename).toLowerCase() !== '.sb3') throw new Error('Project output must end in .sb3');
    const overwrite = force || path.resolve(filename) === this.project.file;
    const checkConflict = async () => {
      if (path.resolve(filename) !== this.project.file || !this.project.sourceHash) return;
      let actual;
      try {actual = crypto.createHash('sha256').update(await readLocalFile(filename)).digest('hex');}
      catch (error) {if (error.code !== 'ENOENT') throw error; actual = null;}
      if (actual !== this.project.sourceHash) throw new CommandError('PROJECT_CONFLICT', 'The source project changed on disk after it was opened', '重新读取项目并重新应用修改；--force 不绕过内容冲突。', {path: path.resolve(filename)});
    };
    await checkConflict();
    const result = await atomicWrite(filename, await this.project.bytes(), overwrite, {beforeCommit: checkConflict});
    this.project.file = result.path; this.project.sourceHash = result.sha256; this.dirty = false;
    return result;
  }
  async projectBatch(callback, options = {}) {
    if (this._batchDepth) {
      if (options.out) throw new CommandError('BATCH_COMMAND_DENIED', 'Nested project output is forbidden', '在 batch 完成后保存一次项目。');
      return callback();
    }
    const engine = require('./project-code');
    return this.transaction('project batch', async before => {
      const previous = engine.revision(this.project);
      this._batchDepth = 1;
      this._batchSnapshot = before;
      let result;
      try {result = await callback(); await engine.validate(this.project);}
      finally {this._batchDepth = 0; this._batchSnapshot = null;}
      const revision = engine.revision(this.project);
      return {...result, version: 1, changed: revision !== previous, revision,
        diagnostics: result?.diagnostics || [], idMap: result?.idMap || {}};
    }, {...options, skipUnchanged: true});
  }
  async applyProjectEdits(document, options = {}) {
    return this.projectBatch(() => require('./project-code').applyOperations(this, document), options);
  }
  async validateProjectEdits(document) {
    const candidate = new CommandSession();
    try {
      await candidate.project.load(await this.snapshot());
      const result = await candidate.applyProjectEdits(document);
      return {...result, valid: true, applied: false};
    } finally {candidate.dispose();}
  }
  async nativeProject(args, options = {}) {
    const engine = require('./project-code');
    if (args[0] === 'read') {
      if (options.format && !['json', 'text'].includes(options.format)) throw new CommandError('INVALID_ARGUMENT', 'format must be json or text', '使用 --format json 或 --format text。');
      return engine.read(this.project, options);
    }
    if (args[0] === 'find') return engine.find(this.project, args[1], options);
    if (args[0] === 'exec') {
      const {runProjectScript} = require('./project-execution');
      return this.projectBatch(async () => {
        const edited = await runProjectScript(this._batchSnapshot, args[1], {workers: this.workers});
        const selected = this.project.vm.editingTarget?.id;
        await this.project.load(edited.bytes);
        if (selected && this.project.vm.runtime.getTargetById(selected)) this.project.vm.setEditingTarget(selected);
        return edited.result;
      }, options);
    }
    let bytes;
    if (args[1] === '-') {
      if (this.stdinOwned) throw new CommandError('INVALID_ARGUMENT', 'JSONL sessions already own stdin', '在会话中使用编辑文件路径，或通过 SDK 提交对象。');
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) {
        size += Buffer.byteLength(chunk);
        if (size > 32 * 1024 * 1024) throw new CommandError('INVALID_ARGUMENT', 'Edit JSON exceeds 32 MiB', '拆分编辑文档。');
        chunks.push(Buffer.from(chunk));
      }
      bytes = Buffer.concat(chunks);
    } else bytes = await readLocalFile(args[1], 32 * 1024 * 1024);
    let document;
    try {document = JSON.parse(bytes.toString('utf8'));}
    catch {throw new CommandError('INVALID_ARGUMENT', 'Expected valid project edit JSON', '提供 {version:1,baseRevision,operations}。', {path: '$'});}
    return args[0] === 'validate' ? this.validateProjectEdits(document) : this.applyProjectEdits(document, options);
  }
  async sprite(args, options, target) {
    const vm = this.project.vm;
    const [action, name, value] = args;
    if (action === 'list') return this.project.info().targets;
    if (action === 'select') {vm.setEditingTarget(this.project.target(name).id); return {selected: vm.editingTarget.getName()};}
    if (action === 'set') {
      vm.setEditingTarget(target.id);
      const numeric = ['x', 'y', 'size', 'direction'];
      if (numeric.includes(name)) {
        const n = number(value, name);
        if (name === 'size' && (n <= 0 || n > 10000)) throw new Error('Size must be in (0,10000]');
        vm.postSpriteInfo({[name]: n});
      } else if (name === 'visible') {
        if (!['true', 'false', 'on', 'off'].includes(value)) throw new Error('Visible must be true/false');
        vm.postSpriteInfo({visible: value === 'true' || value === 'on'});
      } else if (name === 'rotationStyle') {
        if (!['all around', 'left-right', "don't rotate"].includes(value)) throw new Error('Invalid rotation style');
        vm.postSpriteInfo({rotationStyle: value});
      } else throw new Error(`Unknown sprite property ${name}`);
    } else if (action === 'rename') {if (!name) throw new Error('Missing name'); vm.renameSprite(target.id, name);}
    else if (action === 'delete') vm.deleteSprite(target.id);
    else if (action === 'duplicate') {
      const bytes = await vm.exportSprite(target.id, 'nodebuffer');
      return this.addSpriteArchive(bytes);
    } else if (action === 'add') {
      if (!name) throw new Error('Missing sprite name');
      const svg = options.file ? (await readLocalFile(options.file, 32 * 1024 * 1024)).toString('utf8') : '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#4c97ff"/></svg>';
      const costume = svgCostume('costume1', svg);
      const zip = new JSZip(); zip.file(costume.md5ext, svg); zip.file('sprite.json', JSON.stringify(emptyTarget(name, false, [costume])));
      return this.addSpriteArchive(await zip.generateAsync({type: 'nodebuffer'}));
    } else if (action === 'front') target.goToFront();
    else if (action === 'back') target.goToBack();
    else throw new Error(`Unknown sprite action ${action}`);
    return this.project.info();
  }
  async addSpriteArchive(bytes) {
    const vm = this.project.vm;
    const renderer = vm.runtime.renderer;
    const ids = new Set(vm.runtime.targets.map(target => target.id));
    vm.runtime.renderer = null;
    try {await vm.addSprite(bytes);} finally {vm.runtime.renderer = renderer;}
    const target = vm.runtime.targets.find(item => !ids.has(item.id) && item.isOriginal);
    if (!target) throw new Error('Sprite import created no target');
    target.renderer = renderer; target.initDrawable(require('scratch-vm/src/engine/stage-layering').SPRITE_LAYER);
    for (const costume of target.getCostumes()) await this.project.hydrateCostume(costume);
    target.updateAllDrawableProperties();
    return {id: target.id, name: target.getName()};
  }
  variable(args, options, target) {
    const [action, name, value] = args;
    if (action === 'list') return Object.values(target.variables).map(variable => ({id: variable.id, name: variable.name, type: variable.type, value: variable.value}));
    if (action === 'add') {
      if (!name || Object.values(target.variables).some(variable => variable.name === name)) throw new Error('Missing or duplicate variable name');
      const type = options.type === 'list' ? 'list' : '';
      if (options.type && options.type !== 'list') throw new Error('Only --type list is supported');
      const id = crypto.randomUUID(); target.createVariable(id, name, type, false);
      if (value !== undefined) {
        const parsed = parseValue(value);
        if (type === 'list' && !Array.isArray(parsed)) throw new Error('List value must be a JSON array');
        target.variables[id].value = parsed;
      }
      return {id, name};
    }
    const matches = Object.values(target.variables).filter(variable => variable.id === name || variable.name === name);
    if (matches.length !== 1) throw resourceError(matches.length, `Variable not found or ambiguous: ${name}`, name);
    const variable = matches[0];
    if (action === 'set') {
      const parsed = parseValue(value);
      if (variable.type === 'list' && !Array.isArray(parsed)) throw new Error('List value must be a JSON array');
      if (variable.isCloud) {
        require('./local-cloud').validateValue(parsed);
        if (this.project.cloud) this.project.cloud.updateVariable(variable.name, parsed);
        variable.value = parsed;
      } else this.project.vm.setVariableValue(target.id, variable.id, parsed);
    } else if (action === 'rename') {
      if (!value || Object.values(target.variables).some(item => item !== variable && item.name === value)) throw new Error('Missing or duplicate name');
      if (variable.isCloud) require('./local-cloud').validateName(value);
      target.renameVariable(variable.id, value);
    } else if (action === 'delete') target.deleteVariable(variable.id);
    else throw new Error(`Unknown var action ${action}`);
    return {id: variable.id, name: variable.name, value: variable.value};
  }
  block(args, options, target) {
    const blocks = target.blocks;
    const [action, id, field, value] = args;
    if (action === 'list') return Object.values(blocks._blocks);
    if (action === 'add') return this.addBlock(target, id, options);
    if (!blocks.getBlock(id)) throw new Error(`Block not found: ${id}`);
    if (action === 'delete') blocks.deleteBlock(id);
    else if (action === 'input') {
      if (!blocks.getBlock(id).inputs[field]) throw new Error(`Input ${field} does not exist`);
      let child = value;
      if (!blocks.getBlock(child)) {
        child = crypto.randomUUID();
        const parsed = parseValue(value);
        const numeric = typeof parsed === 'number';
        const key = numeric ? 'NUM' : 'TEXT';
        blocks.createBlock({id: child, opcode: numeric ? 'math_number' : 'text', inputs: {},
          fields: {[key]: {name: key, value: String(parsed)}}, next: null, parent: null, shadow: true, topLevel: false});
      }
      if (child === id) throw new Error('Input cannot reference itself');
      for (let cursor = id; cursor; cursor = blocks.getBlock(cursor)?.parent) if (cursor === child) throw new Error('Input would create a cycle');
      const childBlock = blocks.getBlock(child);
      const oldParent = childBlock.parent;
      let oldInput;
      if (oldParent) oldInput = Object.keys(blocks.getBlock(oldParent).inputs).find(key => blocks.getBlock(oldParent).inputs[key].block === child);
      blocks.moveBlock({id: child, oldParent: oldParent || undefined, oldInput, newParent: id, newInput: field});
      if (childBlock.shadow) blocks.getBlock(id).inputs[field] = {name: field, block: child, shadow: child};
      blocks.resetCache();
    }
    else if (action === 'field') {
      if (!blocks.getBlock(id).fields[field]) throw new Error(`Field ${field} does not exist`);
      blocks.changeBlock({id, element: 'field', name: field, value});
    } else if (action === 'move') {
      const parent = options.after || options.parent;
      if (parent && !blocks.getBlock(parent)) throw new Error('Parent block not found');
      if (parent && !options.input && blocks.getBlock(parent).next && blocks.getBlock(parent).next !== id) throw new Error('Parent already has a next block; detach it first');
      const occupied = parent && options.input && blocks.getBlock(parent).inputs[options.input];
      if (occupied?.block && occupied.block !== id && occupied.block !== occupied.shadow) throw new Error('Parent input is occupied; detach it first');
      if (parent === id) throw new Error('A block cannot contain itself');
      for (let cursor = parent; cursor; cursor = blocks.getBlock(cursor)?.parent) {
        if (cursor === id) throw new Error('Block move would create a cycle');
      }
      const block = blocks.getBlock(id);
      const oldParent = block.parent;
      let oldInput;
      if (oldParent) oldInput = Object.keys(blocks.getBlock(oldParent).inputs).find(key => blocks.getBlock(oldParent).inputs[key].block === id);
      blocks.moveBlock({id, oldParent: oldParent || undefined, oldInput, newParent: parent, newInput: options.input});
    } else throw new Error(`Unknown block action ${action}`);
    return {id, action};
  }
  addBlock(target, opcode, options = {}) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]+$/.test(opcode || '')) throw new Error('Invalid opcode');
    const vm = this.project.vm;
    if (!vm.runtime.getOpcodeFunction(opcode) && !vm.runtime.getIsHat(opcode)) throw new Error(`Unknown/unloaded opcode ${opcode}`);
    const blocks = target.blocks;
    const inputs = options.inputs ? JSON.parse(options.inputs) : {};
    const rawFields = options.fields ? JSON.parse(options.fields) : {};
    if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object') throw new Error('Inputs must be a JSON object');
    if (!rawFields || Array.isArray(rawFields) || typeof rawFields !== 'object') throw new Error('Fields must be a JSON object');
    const parent = options.after || options.parent;
    if (parent && !blocks.getBlock(parent)) throw new Error('Parent block not found');
    if (parent && !options.input && blocks.getBlock(parent).next) throw new Error('Parent already has a next block; move it first');
    const occupied = parent && options.input && blocks.getBlock(parent).inputs[options.input];
    if (occupied?.block && occupied.block !== occupied.shadow) throw new Error('Parent input is occupied; detach it first');
    const id = crypto.randomUUID();
    const descriptors = {};
    const shadows = [];
    for (const [name, value] of Object.entries(inputs)) {
      const shadowId = crypto.randomUUID();
      const isNumber = typeof value === 'number';
      const shadowField = isNumber ? 'NUM' : 'TEXT';
      descriptors[name] = {name, block: shadowId, shadow: shadowId};
      shadows.push({id: shadowId, opcode: isNumber ? 'math_number' : 'text',
        inputs: {}, fields: {[shadowField]: {name: shadowField, value: String(value)}},
        next: null, parent: id, shadow: true, topLevel: false});
    }
    const fields = Object.fromEntries(Object.entries(rawFields).map(([name, value]) => [name, {name, value}]));
    blocks.createBlock({id, opcode, inputs: descriptors, fields, next: null, parent: null,
      shadow: false, topLevel: true, x: 0, y: 0});
    for (const shadow of shadows) blocks.createBlock(shadow);
    if (parent) blocks.moveBlock({id, newParent: parent, newInput: options.input});
    return {id, opcode};
  }
  script(args, target) {
    if (args[0] !== 'demo') throw new Error('Use script demo [distance]');
    const distance = args[1] === undefined ? 25 : number(args[1], 'distance');
    const hat = this.addBlock(target, 'event_whenflagclicked');
    const motion = this.addBlock(target, 'motion_movesteps', {inputs: JSON.stringify({STEPS: distance}), after: hat.id});
    return {blocks: [hat.id, motion.id], distance};
  }
  async costume(args, options, target) {
    const [action, name, value] = args;
    const costumes = target.getCostumes();
    if (action === 'list') return costumes.map((costume, index) => ({index, name: costume.name, format: costume.dataFormat}));
    if (action === 'add') {
      const file = await readLocalFile(name, 32 * 1024 * 1024);
      const format = path.extname(name).slice(1).toLowerCase();
      if (!['svg', 'png', 'jpg', 'jpeg', 'bmp', 'gif'].includes(format)) throw new Error('Unsupported costume format');
      const storage = this.project.vm.runtime.storage;
      const asset = storage.createAsset(format === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap, format, new Uint8Array(file), null, true);
      const costume = {name: path.basename(name, path.extname(name)), asset, assetId: asset.assetId,
        dataFormat: format, md5: `${asset.assetId}.${format}`, bitmapResolution: format === 'svg' ? 1 : 2};
      await this.project.hydrateCostume(costume); target.addCostume(costume); target.setCostume(costumes.length - 1);
      return {name: costume.name};
    }
    const index = assetIndex(costumes, name);
    if (action === 'export') return atomicWrite(value, Buffer.from(costumes[index].asset.data), options.force);
    this.project.vm.setEditingTarget(target.id);
    if (action === 'use') target.setCostume(index);
    else if (action === 'rename') {if (!value) throw new Error('Missing name'); this.project.vm.renameCostume(index, value);}
    else if (action === 'delete') {if (costumes.length < 2) throw new Error('Cannot delete the final costume'); this.project.vm.deleteCostume(index);}
    else throw new Error(`Unknown costume action ${action}`);
    return {action, name};
  }
  async sound(args, options, target) {
    const [action, name, value] = args;
    const sounds = target.getSounds();
    if (action === 'list') return sounds.map((sound, index) => ({index, name: sound.name, samples: sound.sampleCount}));
    if (action === 'add') {
      const bytes = await readLocalFile(name, 32 * 1024 * 1024);
      if (path.extname(name).toLowerCase() !== '.wav') throw new Error('Only WAV sound import is currently validated');
      const storage = this.project.vm.runtime.storage;
      const asset = storage.createAsset(storage.AssetType.Sound, storage.DataFormat.WAV, new Uint8Array(bytes), null, true);
      await this.project.vm.addSound({name: path.basename(name, '.wav'), asset, assetId: asset.assetId,
        dataFormat: 'wav', md5: `${asset.assetId}.wav`}, target.id);
      return {name: sounds[sounds.length - 1].name};
    }
    const index = assetIndex(sounds, name);
    if (action === 'export') return atomicWrite(value, Buffer.from(sounds[index].asset.data), options.force);
    if (action === 'render') return this.renderSound(sounds[index], value, options);
    if (action === 'effect') return require('./audio-editor').edit(this, target, index, value, []);
    if (action === 'trim') return require('./audio-editor').edit(this, target, index, 'trim', [value, args[3]]);
    this.project.vm.setEditingTarget(target.id);
    if (action === 'rename') {if (!value) throw new Error('Missing name'); this.project.vm.renameSound(index, value);}
    else if (action === 'delete') this.project.vm.deleteSound(index);
    else throw new Error(`Unknown sound action ${action}`);
    return {action, name};
  }
  async renderSound(sound, filename, options) {
    const {OfflineAudioContext} = await import('node-web-audio-api');
    const AudioEngine = require('scratch-audio/src/AudioEngine');
    const sampleRate = 44100;
    const pitch = number(options.pitch ?? 0, 'pitch');
    if (Math.abs(pitch) > 480) throw new Error('Pitch must be within -480..480');
    const duration = Math.min(300, Math.max(1, (sound.sampleCount / sound.rate) / Math.pow(2, pitch / 120) + 0.25));
    const context = new OfflineAudioContext(2, Math.ceil(sampleRate * duration), sampleRate);
    const engine = new AudioEngine(context);
    const bank = engine.createBank();
    try {
      const player = await engine.decodeSoundPlayer({data: new Uint8Array(sound.asset.data)});
      bank.addSoundPlayer(player);
      const volume = number(options.volume ?? 100, 'volume');
      const pan = number(options.pan ?? 0, 'pan');
      if (volume < 0 || volume > 100 || pan < -100 || pan > 100) throw new Error('Volume 0..100; pan -100..100');
      const finished = bank.playSound({volume, soundEffects: {pitch, pan}}, player.id);
      const result = await context.startRendering(); await finished;
      const bytes = wav(result);
      return atomicWrite(filename, bytes, options.force);
    } finally {bank.dispose(); engine.inputNode.disconnect();}
  }
  async package(filename, force) {
    if (!filename) throw new Error('Missing output .html/.zip');
    return this.execute(['package', filename, ...(force ? ['--force'] : [])]);
  }
  async run(options) {
    const frames = integer(options.frames ?? 30, 'frames', 1, 100000);
    const fps = integer(options.fps ?? this.project.vm.runtime.frameLoop.framerate ?? 30, 'fps', 1, 240);
    const seed = options.seed === undefined ? undefined : integer(options.seed, 'seed', 0, 0xffffffff);
    const traceLimit = options.trace === undefined ? undefined : integer(options.trace, 'trace capacity', 1, 10000);
    const compile = !!options.compile || !!this.runtimeSettings.compiler;
    if (compile && traceLimit !== undefined) throw new Error('Block trace requires interpreter mode; disable the compiler');
    let watch;
    if (options.watch !== undefined) {
      const target = this.project.target(options.target);
      const find = target => {
        const variables = Object.values(target.variables).filter(variable => variable.type !== 'broadcast_msg');
        const byId = variables.find(variable => variable.id === options.watch);
        return byId ? [byId] : variables.filter(variable => variable.name === options.watch);
      };
      let owner = target, matches = find(target);
      if (!matches.length && !target.isStage) {owner = this.project.vm.runtime.getTargetForStage(); matches = find(owner);}
      if (matches.length !== 1) throw resourceError(matches.length, `Watch variable not found or ambiguous: ${options.watch}`, options.watch);
      watch = {targetId: owner.id, variableId: matches[0].id};
    }
    const bytes = await this.snapshot();
    if (this.disposed) throw new Error('Command session is disposed');
    const result = await new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, 'runtime-worker.js'), [], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
      this.workers.add(child);
      let stderr = '', message, failure;
      const fail = error => {failure ||= error; child.kill('SIGKILL');};
      const timer = setTimeout(() => fail(new Error('Runtime exceeded 30 second limit')), 30000);
      child.stderr.on('data', data => {stderr = (stderr + data).slice(-4000);});
      child.once('message', result => {message = result;});
      child.once('error', fail);
      // Wait for close (including stdio), not merely the first IPC message. No
      // success is reported while a worker still owns native handles.
      child.once('close', (code, signal) => {
        clearTimeout(timer); this.workers.delete(child);
        if (failure) reject(failure);
        else if (message?.error) reject(new Error(message.error));
        else if (code !== 0 || !message) reject(new Error(`Runtime exited ${code ?? signal}: ${stderr}`));
        else resolve(message);
      });
      child.send({project: bytes.toString('base64'), frames, fps, seed, watch, traceLimit, compile,
        turbo: !!options.turbo || this.project.vm.runtime.turboMode, answer: options.answer, inputs: this.inputs,
        runtimeSettings: this.runtimeSettings, cloudFile: this.project.cloudFile}, error => {if (error) fail(error);});
    });
    if (options.out) result.image = await atomicWrite(options.out, Buffer.from(result.png, 'base64'), options.force);
    delete result.png;
    return result;
  }
  async input(args) {
    const result = await commandModules.route('device').execute(this, 'device', args, {});
    return {...result, injected: args[0]};
  }
  dispose() {
    this.disposed = true;
    for (const worker of this.workers) worker.kill('SIGKILL');
    try {commandModules.dispose(this);} finally {
      try {this.project.dispose();} finally {this.undoStack = []; this.redoStack = []; this.inputs = [];}
    }
  }
}

const wav = buffer => {
  const frames = buffer.length;
  const channels = buffer.numberOfChannels;
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(buffer.sampleRate, 24);
  bytes.writeUInt32LE(buffer.sampleRate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const data = Array.from({length: channels}, (_, channel) => buffer.getChannelData(channel));
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const sample = Math.max(-1, Math.min(1, data[channel][frame]));
    bytes.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + (frame * channels + channel) * 2);
  }
  return bytes;
};

module.exports = {CommandSession, HELP, commandHelp, commandSpecs: COMMANDS, optionsFrom, validateCommand, wav};
