require('./network-policy').install();
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {Project} = require('./project');
const {createInputReplay} = require('./device-adapters');
const {PROTOCOL} = require('./runtime-controller');
const {resourceError, errorInfo} = require('./errors');

const LIMITS = {logEntries: 10000, logBytes: 4 * 1024 * 1024, watchBytes: 1024 * 1024,
  watches: 32, breakpoints: 256, answers: 4096, frames: 100000, operations: 100000, responseBytes: 8 * 1024 * 1024};
const integer = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
};
const object = (value, keys, name) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${name} field ${key}`);
};
const boolean = (value, name) => {if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`); return value;};
const text = (value, name, max = 10000) => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be text (max ${max} characters)`);
  return value;
};
const seededRandom = seed => {
  let state = integer(seed, 'seed', 0, 0xffffffff) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
};

class BoundedLog {
  constructor(capacity = 1000, maxBytes = LIMITS.logBytes) {
    this.capacity = integer(capacity, 'log capacity', 1, LIMITS.logEntries);
    this.maxBytes = maxBytes; this.entries = []; this.bytes = 0; this.dropped = 0; this.sequence = 0;
  }
  add(entry) {
    const value = {sequence: ++this.sequence, ...entry};
    const serialized = JSON.stringify(value), bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxBytes) {this.dropped++; return;}
    while (this.entries.length >= this.capacity || this.bytes + bytes > this.maxBytes) {
      this.bytes -= this.entries.shift().bytes; this.dropped++;
    }
    this.entries.push({value: JSON.parse(serialized), bytes}); this.bytes += bytes;
  }
  setCapacity(capacity) {
    this.capacity = integer(capacity, 'log capacity', 1, LIMITS.logEntries);
    while (this.entries.length > this.capacity) {this.bytes -= this.entries.shift().bytes; this.dropped++;}
  }
  read(limit = this.capacity, since = 0) {
    integer(limit, 'log limit', 1, LIMITS.logEntries); integer(since, 'log sequence', 0, Number.MAX_SAFE_INTEGER);
    return {entries: this.entries.filter(entry => entry.value.sequence > since).slice(-limit).map(entry => entry.value),
      dropped: this.dropped, capacity: this.capacity, bytes: this.bytes, sequence: this.sequence};
  }
  clear() {this.entries = []; this.bytes = 0; this.dropped = 0;}
}

// Load frozen interpreter code with explicit cooperative boundaries. Files in
// node_modules are never rewritten. Fail closed if an upstream anchor changes.
const compile = (file, transform, overrides) => {
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(overrides, name) ? overrides[name] : original(name);
  loaded._compile(transform(fs.readFileSync(file, 'utf8')), file); return loaded.exports;
};
const replace = (source, anchor, replacement) => {
  if (!source.includes(anchor) || source.indexOf(anchor) !== source.lastIndexOf(anchor)) throw new Error('Frozen interpreter debug boundary changed');
  return source.replace(anchor, replacement);
};
const installDebugger = (vm, hooks) => {
  const execute = compile(require.resolve('scratch-vm/src/engine/execute'), source => replace(source,
    '        const primitiveReportedValue = blockFunction(argValues, blockUtility);',
    `        if (!runtime._cliDebug.beforeOperation(thread, opCached)) {
            currentStackFrame.reported = ops.slice(0, i).map(op => ({opCached: op.id, inputValue:
                op._parentKey === 'BROADCAST_INPUT' ? op._parentValues.BROADCAST_OPTION.name : op._parentValues[op._parentKey]}));
            currentStackFrame.reporting = null;
            return;
        }
        const primitiveReportedValue = blockFunction(argValues, blockUtility);
        runtime._cliDebug.afterOperation(thread, opCached);`), {});
  const Sequencer = compile(require.resolve('scratch-vm/src/engine/sequencer'), source => {
    source = replace(source, '            for (let i = 0; i < threads.length; i++) {',
      '            for (let i = 0; i < threads.length; i++) {\n                if (this.runtime._cliDebug.blocked) break;');
    source = replace(source, '               numActiveThreads > 0 &&',
      '               numActiveThreads > 0 && !this.runtime._cliDebug.blocked &&');
    source = replace(source, '        while ((currentBlockId = thread.peekStack())) {',
      '        while ((currentBlockId = thread.peekStack())) {\n            if (this.runtime._cliDebug.blocked) return;');
    source = replace(source, '            thread.blockGlowInFrame = currentBlockId;',
      '            if (this.runtime._cliDebug.blocked) return;\n            thread.blockGlowInFrame = currentBlockId;');
    source = replace(source, '                return;\n            } else if (thread.status === Thread.STATUS_PROMISE_WAIT)',
      '                this.runtime._cliDebug.yielded = true;\n                return;\n            } else if (thread.status === Thread.STATUS_PROMISE_WAIT)');
    source = replace(source, '                return;\n            } else if (thread.status === Thread.STATUS_YIELD_TICK)',
      '                this.runtime._cliDebug.yielded = true;\n                return;\n            } else if (thread.status === Thread.STATUS_YIELD_TICK)');
    source = replace(source, '                // stepThreads will reset the thread to Thread.STATUS_RUNNING\n                return;',
      '                // stepThreads will reset the thread to Thread.STATUS_RUNNING\n                this.runtime._cliDebug.yielded = true;\n                return;');
    source = replace(source, '                        // Don\'t do anything to the stack, since loops need\n                        // to be re-executed.\n                        return;',
      '                        // Don\'t do anything to the stack, since loops need\n                        // to be re-executed.\n                        this.runtime._cliDebug.yielded = true;\n                        return;');
    return source;
  }, {'./execute.js': execute});
  vm.runtime._cliDebug = hooks;
  vm.runtime.sequencer = new Sequencer(vm.runtime);
};

const applySettings = (project, input) => {
  const settings = input.runtimeSettings || {};
  object(settings, ['compiler', 'warpTimer', 'volume'], 'runtime settings');
  const compile = input.compile ?? settings.compiler ?? false;
  const warpTimer = settings.warpTimer ?? false;
  boolean(compile, 'compile'); boolean(warpTimer, 'warpTimer');
  project.vm.setCompilerOptions({enabled: compile, warpTimer});
  project.vm.setTurboMode(boolean(input.turbo ?? false, 'turbo'));
  project.vm.setFramerate(integer(input.fps ?? 30, 'fps', 1, 240));
  // Stored project options must not lift resource or hardware boundaries in a
  // long-lived worker. The CLI can inspect up to 300 clones, never infinity.
  const maxClones = project.vm.runtime.runtimeOptions.maxClones;
  project.vm.setRuntimeOptions({maxClones: Number.isFinite(maxClones) ? Math.min(300, Math.max(0, maxClones)) : 300});
  if (settings.volume !== undefined) {
    if (!Number.isFinite(settings.volume) || settings.volume < 0 || settings.volume > 100) throw new Error('volume must be in 0..100');
    project.audio.inputNode.gain.value = settings.volume / 100;
  }
  if (input.seed !== undefined) Math.random = seededRandom(input.seed);
  return compile;
};

class PersistentRuntime {
  constructor() {
    this.project = new Project(); this.replay = null; this.state = 'initializing'; this.frame = 0; this.timeMS = 0;
    this.timer = null; this.lifeTimer = null; this.disposed = false; this.inFrame = false; this.preparedFrame = false;
    this.traceEnabled = false; this.traceLog = new BoundedLog(); this.hitLog = new BoundedLog(256);
    this.eventLog = new BoundedLog(256); this.breakpoints = new Map(); this.watches = new Map();
    this.answerQueue = []; this.answerCount = 0; this.answerBytes = 0; this.pendingQuestion = null; this.questionSequence = 0;
    this.lastHit = null; this.bypass = null; this.cursor = null; this.operations = 0; this.stepBudget = null;
  }
  async init(input) {
    object(input, ['project', 'fps', 'compile', 'turbo', 'seed', 'inputs', 'cloudFile', 'runtimeSettings', 'paused',
      'traceLimit', 'watch', 'target', 'maxFrames', 'lifetimeMS', 'answer'], 'runtime initialization');
    const bytes = Buffer.from(text(input.project, 'project base64', 140 * 1024 * 1024), 'base64');
    await this.project.load(bytes);
    if (input.cloudFile) this.project.attachCloud(text(input.cloudFile, 'cloud path', 4096));
    this.compiled = applySettings(this.project, input); this.fps = this.project.vm.runtime.frameLoop.framerate;
    this.seed = input.seed;
    this.maxFrames = integer(input.maxFrames ?? 100000, 'maxFrames', 1, LIMITS.frames);
    this.lifetimeMS = integer(input.lifetimeMS ?? 300000, 'runtime lifetime', 100, 3600000);
    if (input.paused !== undefined) boolean(input.paused, 'paused');
    if (input.traceLimit !== undefined) {
      if (this.compiled) throw new Error('Block trace requires interpreter mode (start without --compile)');
      this.traceLog = new BoundedLog(input.traceLimit); this.traceEnabled = true;
    }
    const vm = this.project.vm;
    this.startMS = vm.runtime.currentMSecs;
    vm.runtime.updateCurrentMSecs = () => {vm.runtime.currentMSecs = this.startMS + this.timeMS;};
    const hooks = {blocked: false,
      beforeOperation: (thread, block) => this.beforeOperation(thread, block),
      afterOperation: (thread, block) => this.afterOperation(thread, block)};
    if (!this.compiled) installDebugger(vm, hooks);
    this.hooks = hooks;
    this.replay = await createInputReplay(vm, input.inputs || []);
    vm.runtime.on('QUESTION', question => this.question(question));
    vm.runtime.on('PROJECT_STOP_ALL', () => {this.pendingQuestion = null;});
    const control = vm.runtime.ext_scratch3_control;
    const createClone = control._createClone.bind(control);
    control._createClone = (option, target) => {
      const before = new Set(vm.runtime.targets.map(target => target.id));
      const result = createClone(option, target);
      const clone = vm.runtime.targets.find(target => !before.has(target.id));
      this.eventLog.add({type: clone ? 'clone-created' : 'clone-failed', frame: this.frame,
        targetId: clone?.id ?? target.id, originalTargetId: target.sprite.clones[0]?.id, option});
      return result;
    };
    vm.greenFlag(); this.eventLog.add({type: 'green-flag', frame: 0});
    if (input.answer !== undefined) this.scheduleAnswer({text: text(input.answer, 'answer'), frame: 0});
    if (input.watch) this.addWatch({selector: input.watch, target: input.target});
    this.state = input.paused ? 'paused' : 'running';
    this.lifeTimer = setTimeout(() => {
      this.state = 'expired';
      this.eventLog.add({type: 'lifetime-limit', frame: this.frame});
      const status = this.status(); this.dispose();
      send({protocol: PROTOCOL, event: 'expired', status}, () => process.exit(0));
    }, this.lifetimeMS);
    if (this.state === 'running') this.schedule();
    return this.status();
  }
  beforeOperation(thread, block) {
    if (this.hooks.blocked) return false;
    const location = {threadId: thread.getId(), targetId: thread.target.id, blockId: block.id};
    const originalTargetId = thread.target.sprite.clones[0]?.id ?? thread.target.id;
    const key = `${originalTargetId}:${block.id}`;
    if (!thread.updateMonitor && this.breakpoints.has(key)) {
      if (this.bypass?.threadId === location.threadId && this.bypass.blockId === block.id) this.bypass = null;
      else {
        this.lastHit = {...location, originalTargetId, frame: this.frame, timeMS: this.timeMS}; this.cursor = thread.getId();
        this.hitLog.add(this.lastHit); this.eventLog.add({type: 'breakpoint', ...this.lastHit});
        this.state = 'paused'; this.hooks.blocked = true; return false;
      }
    }
    if (this.stepBudget !== null && this.stepBudget <= 0) {this.hooks.blocked = true; return false;}
    if (++this.operations > LIMITS.operations) {
      this.state = 'paused'; this.hooks.blocked = true;
      this.eventLog.add({type: 'operation-limit', frame: this.frame}); return false;
    }
    if (this.traceEnabled && !thread.updateMonitor) this.traceLog.add({type: 'block', frame: this.frame, timeMS: this.timeMS,
      ...location, originalTargetId: thread.target.sprite.clones[0]?.id, opcode: block.opcode});
    return true;
  }
  afterOperation() {if (this.stepBudget !== null) this.stepBudget--;}
  target(selector) {
    if (selector === undefined) return this.project.target();
    const byId = this.project.vm.runtime.targets.find(target => target.id === selector);
    return byId || this.project.target(selector);
  }
  location(selector, targetSelector) {
    text(selector, 'block ID', 256);
    const candidates = targetSelector === undefined ? this.project.vm.runtime.targets.filter(target => target.isOriginal) : [this.target(targetSelector)];
    const matches = candidates.filter(target => target.blocks.getBlock(selector));
    if (matches.length !== 1) throw resourceError(matches.length, 'Block ID not found or ambiguous; specify --target', selector);
    const block = matches[0].blocks.getBlock(selector);
    const original = matches[0].sprite.clones[0] || matches[0];
    if (block.shadow) throw new Error('Shadow blocks have no executable breakpoint boundary');
    if (!this.project.vm.runtime.getOpcodeFunction(block.opcode)) throw new Error('Block has no executable primitive boundary');
    return {targetId: original.id, blockId: selector};
  }
  addWatch({selector, target}) {
    text(selector, 'watch variable', 256);
    let owner = this.target(target);
    const find = target => {
      const variables = Object.values(target.variables).filter(variable => variable.type !== 'broadcast_msg');
      const byId = variables.find(variable => variable.id === selector);
      return byId ? [byId] : variables.filter(variable => variable.name === selector);
    };
    let matches = find(owner);
    if (!matches.length && !owner.isStage) {owner = this.project.vm.runtime.getTargetForStage(); matches = find(owner);}
    if (matches.length !== 1) throw resourceError(matches.length, 'Watch variable not found or ambiguous', selector);
    const variable = matches[0], key = `${owner.id}:${variable.id}`;
    if (!this.watches.has(key) && this.watches.size >= LIMITS.watches) throw new Error('Watch limit reached (max 32)');
    if (!this.watches.has(key)) this.watches.set(key, {targetId: owner.id, variableId: variable.id, name: variable.name,
      log: new BoundedLog(256, LIMITS.watchBytes), last: undefined});
    this.sampleWatches('added');
    return this.watchState();
  }
  sampleWatches(reason = 'frame') {
    for (const watch of this.watches.values()) {
      const value = this.project.vm.runtime.getTargetById(watch.targetId)?.variables[watch.variableId]?.value;
      const serialized = JSON.stringify(value);
      if (serialized !== watch.last || reason === 'frame') {
        watch.log.add({frame: this.frame, timeMS: this.timeMS, reason, value}); watch.last = serialized;
      }
    }
  }
  watchState(limit = 256) {
    return {watches: [...this.watches.values()].map(watch => ({targetId: watch.targetId, variableId: watch.variableId, name: watch.name,
      ...watch.log.read(limit)}))};
  }
  question(question) {
    if (question === null) {this.pendingQuestion = null; return;}
    const queue = this.project.vm.runtime.ext_scratch3_sensing?._questionList;
    const current = queue?.[0];
    this.pendingQuestion = {id: ++this.questionSequence, text: current ? current[0] : question,
      targetId: current?.[2]?.id ?? null, frame: this.frame};
    this.eventLog.add({type: 'question', ...this.pendingQuestion});
  }
  scheduleAnswer(data) {
    object(data, ['text', 'frame', 'questionId'], 'answer'); text(data.text, 'answer');
    const frame = integer(data.frame ?? this.frame, 'answer frame', this.frame, 99999);
    if (this.answerCount >= LIMITS.answers) throw new Error('Answer queue exceeds 4096 events');
    if (data.questionId !== undefined) integer(data.questionId, 'question ID', 1, Number.MAX_SAFE_INTEGER);
    const bytes = Buffer.byteLength(data.text);
    if (this.answerBytes + bytes > LIMITS.logBytes) throw new Error('Answer queue exceeds 4 MiB');
    this.answerQueue.push({...data, frame}); this.answerCount++; this.answerBytes += bytes;
    return {queued: true, frame};
  }
  deliverAnswers() {
    if (!this.pendingQuestion) return;
    const index = this.answerQueue.findIndex(answer => answer.frame <= this.frame &&
      (answer.questionId === undefined || answer.questionId === this.pendingQuestion.id));
    if (index < 0) return;
    const answer = this.answerQueue.splice(index, 1)[0], question = this.pendingQuestion;
    this.pendingQuestion = null;
    this.eventLog.add({type: 'answer', questionId: question.id, frame: this.frame, text: answer.text});
    this.project.vm.runtime.emit('ANSWER', answer.text);
  }
  async prepareFrame() {
    if (this.preparedFrame) return;
    if (this.frame >= this.maxFrames) {this.state = 'paused'; throw new Error('Runtime frame limit reached');}
    this.timeMS = this.frame * 1000 / this.fps;
    this.project.vm.runtime.updateCurrentMSecs();
    this.replay.applyFrame(this.frame);
    this.deliverAnswers();
    if (this.project.cloud) this.project.cloud.sync();
    this.preparedFrame = true;
  }
  async advanceFrame() {
    await this.prepareFrame();
    this.operations = 0; this.stepBudget = null; this.hooks.blocked = false;
    if (this.seed !== undefined) {
      let checks = 0;
      this.project.vm.runtime.sequencer.timer.timeElapsed = () => checks++ * this.project.vm.runtime.currentStepTime;
    }
    this.project.vm.runtime._step();
    await new Promise(resolve => setImmediate(resolve));
    this.deliverAnswers(); await Promise.resolve();
    if (!this.hooks.blocked) {this.frame++; this.preparedFrame = false;}
    this.sampleWatches();
    if (this.frame >= this.maxFrames) {this.state = 'paused'; this.eventLog.add({type: 'frame-limit', frame: this.frame});}
  }
  schedule() {
    if (this.timer || this.state !== 'running' || this.disposed) return;
    this.timer = setTimeout(async () => {
      this.timer = null; this.inFrame = true;
      try {await this.advanceFrame();} catch (error) {this.state = 'paused'; this.eventLog.add({type: 'error', error: error.message, frame: this.frame});}
      finally {this.inFrame = false; if (this.state === 'running') this.schedule();}
    }, 1000 / this.fps);
  }
  async idle() {while (this.inFrame) await new Promise(resolve => setImmediate(resolve));}
  pause() {clearTimeout(this.timer); this.timer = null; this.state = 'paused'; this.project.vm.runtime.emit('RUNTIME_PAUSED');}
  unpause() {
    if (this.frame >= this.maxFrames) throw new Error('Runtime frame limit reached; start a new runtime');
    this.bypass = this.lastHit; this.lastHit = null;
    this.hooks.blocked = false; this.state = 'running'; this.eventLog.add({type: 'resume', frame: this.frame});
    this.project.vm.runtime.emit('RUNTIME_UNPAUSED'); this.schedule();
  }
  status() {
    const vm = this.project.vm;
    if (!vm) return {state: this.state, frame: this.frame, timeMS: this.timeMS, disposed: true};
    const threads = vm.runtime.threads.filter(thread => !thread.updateMonitor).map(thread => ({id: thread.getId(),
      targetId: thread.target?.id, topBlock: thread.topBlock, blockId: thread.peekStack(), status: thread.status,
      compiled: thread.isCompiled, stack: thread.isCompiled ? null : thread.stack.slice()}));
    return {state: this.state, frame: this.frame, timeMS: this.timeMS, stage: this.project.info().stage, fps: this.fps, compiled: this.compiled, seed: this.seed,
      maxFrames: this.maxFrames, threads, targets: this.project.info().targets, cloneCount: vm.runtime.targets.filter(target => !target.isOriginal).length,
      pendingQuestion: this.pendingQuestion, answerQueue: this.answerQueue.length, breakpoint: this.lastHit,
      permissions: {network: 'deny', executableExtensions: 'deny', liveDevices: 'deny'}, noDOM: typeof document === 'undefined' && typeof window === 'undefined'};
  }
  async step(data) {
    object(data, ['count', 'frames', 'threadId'], 'step');
    if (this.state !== 'paused') throw new Error('Pause runtime before stepping');
    const frames = data.frames === undefined ? null : integer(data.frames, 'step frames', 1, 10000);
    if (frames !== null) {
      if (data.threadId !== undefined || data.count !== undefined) throw new Error('Use frame step or block step, not both');
      this.bypass = this.lastHit; this.lastHit = null;
      const before = this.frame;
      for (let i = 0; i < frames; i++) {await this.advanceFrame(); if (this.lastHit || this.frame >= this.maxFrames || this.hooks.blocked) break;}
      return {...this.status(), steppedFrames: this.frame - before};
    }
    if (this.compiled) throw new Error('Compiled single-step is unsupported; start without --compile (frame step is available)');
    const count = integer(data.count ?? 1, 'step count', 1, 10000);
    if (data.threadId !== undefined) text(data.threadId, 'thread ID', 512);
    this.bypass = this.lastHit; this.lastHit = null;
    let executed = 0;
    for (let i = 0; i < count; i++) {
      await this.prepareFrame();
      const threads = this.project.vm.runtime.threads.filter(thread => !thread.updateMonitor && !thread.isKilled && thread.stack.length && thread.status !== 4);
      if (threads.some(thread => thread.isCompiled)) throw new Error('Compiled thread cannot be single-stepped');
      const ready = threads.filter(thread => [0, 2, 3].includes(thread.status));
      let thread = data.threadId ? ready.find(thread => thread.getId() === data.threadId) : ready.find(thread => thread.getId() === this.cursor) || ready[0];
      if (!thread) {
        if (data.threadId && !threads.some(thread => thread.getId() === data.threadId)) throw new Error('Thread not found');
        if (!threads.length) break;
        this.frame++; this.preparedFrame = false; this.sampleWatches('waiting'); break;
      }
      thread.status = 0; this.cursor = thread.getId(); this.operations = 0; this.stepBudget = 1; this.hooks.blocked = false; this.hooks.yielded = false;
      const sequencer = this.project.vm.runtime.sequencer;
      sequencer.activeThread = thread;
      try {sequencer.stepThread(thread);} finally {sequencer.activeThread = null;}
      executed += 1 - Math.max(0, this.stepBudget);
      this.stepBudget = null;
      await new Promise(resolve => setImmediate(resolve));
      this.deliverAnswers(); await Promise.resolve();
      this.project.vm.runtime.threads = this.project.vm.runtime.threads.filter(thread => thread.stack.length && thread.status !== 4 && !thread.isKilled);
      this.project.vm.runtime.updateThreadMap(); this.sampleWatches('step');
      if (this.lastHit) break;
      if (this.hooks.yielded || !this.project.vm.runtime.threads.some(thread => thread.getId() === this.cursor)) {
        this.cursor = null; this.frame++; this.preparedFrame = false;
      }
    }
    return {...this.status(), steppedBlocks: executed};
  }
  async handle(action, data) {
    await this.idle();
    if (this.disposed) throw new Error('Runtime is disposed');
    switch (action) {
    case 'status': object(data, [], 'status'); return this.status();
    case 'pause': object(data, [], 'pause'); this.pause(); this.eventLog.add({type: 'pause', frame: this.frame}); return this.status();
    case 'resume': object(data, [], 'resume'); this.unpause(); return this.status();
    case 'stop': object(data, [], 'stop'); this.pause(); this.project.vm.stopAll(); this.answerQueue = []; this.state = 'stopped';
      this.eventLog.add({type: 'stop', frame: this.frame}); return this.status();
    case 'step': return this.step(data);
    case 'input': {
      object(data, ['event'], 'input');
      const event = {...data.event, frame: data.event?.frame ?? this.frame};
      if (event.frame < this.frame) throw new Error('Input frame is in the past');
      await this.replay.append(event); return {queued: true, frame: event.frame, device: event.device};
    }
    case 'answer': {
      if (data.frame === undefined && !this.pendingQuestion) throw new Error('No pending question; use --frame to schedule an answer');
      if (data.questionId !== undefined && this.pendingQuestion && data.questionId !== this.pendingQuestion.id && data.frame === undefined) throw new Error('Question ID does not match current prompt');
      const result = this.scheduleAnswer(data); if (data.frame === undefined) {this.deliverAnswers(); await Promise.resolve();}
      return result;
    }
    case 'watch': {
      object(data, ['action', 'selector', 'target', 'limit'], 'watch');
      if (data.action === 'add') return this.addWatch(data);
      if (data.action === 'list' || data.action === 'samples') return this.watchState(data.limit ?? 256);
      if (data.action === 'clear') {this.watches.clear(); return {watches: []};}
      if (data.action === 'remove') {
        const matches = [...this.watches.entries()].filter(([, watch]) => (watch.variableId === data.selector || watch.name === data.selector) &&
          (data.target === undefined || watch.targetId === this.target(data.target).id));
        if (matches.length !== 1) throw resourceError(matches.length, 'Watch not found or ambiguous', data.selector);
        this.watches.delete(matches[0][0]); return this.watchState();
      }
      throw new Error('Use watch add/remove/list/samples/clear');
    }
    case 'trace': {
      object(data, ['action', 'limit', 'since'], 'trace');
      if (data.action === 'events') return this.eventLog.read(data.limit ?? 256, data.since ?? 0);
      if (data.action === 'on') {
        if (this.compiled) throw new Error('Block trace requires interpreter mode');
        if (data.limit !== undefined) this.traceLog.setCapacity(data.limit);
        this.traceEnabled = true;
      }
      else if (data.action === 'off') this.traceEnabled = false;
      else if (data.action === 'clear') {this.traceLog.clear(); this.eventLog.clear();}
      else if (data.action !== 'get') throw new Error('Use trace on/off/get/events/clear');
      return {enabled: this.traceEnabled, mode: 'interpreter-primitives', ...this.traceLog.read(data.limit ?? this.traceLog.capacity, data.since ?? 0)};
    }
    case 'breakpoint': {
      object(data, ['action', 'blockId', 'target', 'limit', 'since'], 'breakpoint');
      if (data.action === 'add' || data.action === 'remove') {
        if (this.compiled) throw new Error('Block breakpoints require interpreter mode');
        const location = this.location(data.blockId, data.target), key = `${location.targetId}:${location.blockId}`;
        if (data.action === 'add') {if (!this.breakpoints.has(key) && this.breakpoints.size >= LIMITS.breakpoints) throw new Error('Breakpoint limit reached'); this.breakpoints.set(key, location);}
        else if (!this.breakpoints.delete(key)) throw new Error('Breakpoint not found');
      } else if (data.action === 'clear') {this.breakpoints.clear(); this.lastHit = null;}
      else if (data.action === 'hits') return this.hitLog.read(data.limit ?? 256, data.since ?? 0);
      else if (data.action !== 'list') throw new Error('Use breakpoint add/remove/list/hits/clear');
      return {breakpoints: [...this.breakpoints.values()]};
    }
    case 'clones': object(data, [], 'clones'); return {limit: this.project.vm.runtime.runtimeOptions.maxClones, clones: this.project.vm.runtime.targets.filter(target => !target.isOriginal).map(target => ({
      id: target.id, originalId: target.sprite.clones[0]?.id, name: target.getName(), x: target.x, y: target.y, visible: target.visible,
      variables: Object.values(target.variables).map(variable => ({id: variable.id, name: variable.name, value: variable.value}))}))};
    default: throw new Error(`Unknown runtime action ${action}`);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer); clearTimeout(this.lifeTimer);
    try {this.replay?.dispose();} finally {this.project.dispose();}
  }
}

const send = (message, callback) => {
  if (Buffer.byteLength(JSON.stringify(message)) > LIMITS.responseBytes) message = {protocol: PROTOCOL, id: message.id, ok: false, error: 'Runtime response exceeds 8 MiB; query smaller watch/trace limits'};
  if (process.connected) process.send(message, callback || (() => {})); else callback?.(new Error('IPC disconnected'));
};

// Backward-compatible batch worker protocol. Trace is opt-in: without it the
// old frames/targets/png/questions/watch fields and scheduling remain unchanged.
const batch = async input => {
  const project = new Project(); let replay;
  try {
    const traceLog = input.traceLimit === undefined ? null : new BoundedLog(input.traceLimit);
    await project.load(Buffer.from(input.project, 'base64'));
    if (input.cloudFile) project.attachCloud(input.cloudFile);
    const compiled = applySettings(project, input);
    if (traceLog && compiled) throw new Error('Batch block trace requires interpreter mode; disable --compile and settings compiler');
    const vm = project.vm, questions = [];
    let frameIndex = 0, elapsed = 0;
    if (traceLog) {
      // Reuse interpreter hooks only; no persistent state, frame timer, heartbeat
      // or debugger scheduling is enabled for an ordinary bounded batch run.
      installDebugger(vm, {blocked: false, beforeOperation: (thread, block) => {
        if (!thread.updateMonitor) traceLog.add({type: 'block', frame: frameIndex, timeMS: elapsed,
          threadId: thread.getId(), targetId: thread.target.id, originalTargetId: thread.target.sprite.clones[0]?.id ?? thread.target.id,
          blockId: block.id, opcode: block.opcode});
        return true;
      }, afterOperation: () => {}});
    }
    vm.runtime.on('QUESTION', question => {
      questions.push(question);
      vm.runtime.emit('ANSWER', input.answer === undefined ? '' : String(input.answer));
    });
    const start = vm.runtime.currentMSecs;
    vm.runtime.updateCurrentMSecs = () => {vm.runtime.currentMSecs = start + elapsed;};
    const watchedTarget = input.watch && vm.runtime.getTargetById(input.watch.targetId);
    const watchedVariable = watchedTarget && watchedTarget.variables[input.watch.variableId];
    if (input.watch && !watchedVariable) throw new Error('Watch variable missing from runtime copy');
    const samples = []; let watchBytes = 0;
    replay = await createInputReplay(vm, input.inputs || []);
    vm.greenFlag();
    for (let frame = 0; frame < integer(input.frames, 'frames', 1, 100000); frame++) {
      frameIndex = frame;
      if (input.seed !== undefined) {let checks = 0; vm.runtime.sequencer.timer.timeElapsed = () => checks++ * vm.runtime.currentStepTime;}
      elapsed = frame * 1000 / input.fps;
      replay.applyFrame(frame);
      if (project.cloud) project.cloud.sync();
      vm.runtime._step(); await new Promise(resolve => setImmediate(resolve));
      if (watchedVariable) {
        const serialized = JSON.stringify({frame: frame + 1, timeMS: elapsed, value: watchedVariable.value});
        watchBytes += Buffer.byteLength(serialized);
        if (watchBytes > 4 * 1024 * 1024) throw new Error('Watch samples exceed the 4 MiB limit; reduce --frames or watched list size');
        samples.push(JSON.parse(serialized));
      }
    }
    const result = {frames: input.frames, threads: vm.runtime.threads.length, questions, targets: project.info().targets,
      png: project.renderer.png().toString('base64'), noDOM: typeof document === 'undefined' && typeof window === 'undefined'};
    if (input.seed !== undefined) result.seed = input.seed;
    if (watchedVariable) result.watch = {targetId: watchedTarget.id, variableId: watchedVariable.id, name: watchedVariable.name, samples};
    if (traceLog) result.trace = {mode: 'interpreter-primitives', ...traceLog.read()};
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.responseBytes) throw new Error('Batch runtime response exceeds 8 MiB; reduce --frames, --watch data or --trace capacity');
    replay.dispose(); replay = null; project.dispose(); process.send(result, error => process.exit(error ? 1 : 0));
  } catch (error) {
    try {replay?.dispose(); project.dispose();} catch (cleanup) {error.message += `; cleanup: ${cleanup.message}`;}
    if (process.connected) process.send({error: error.message}, () => process.exit(1)); else process.exit(1);
  }
};

let runtime = null, queue = Promise.resolve(), first = true;
process.on('message', message => {
  if (first && message?.protocol !== PROTOCOL) {first = false; batch(message); return;}
  first = false;
  queue = queue.then(async () => {
    let stop = false;
    try {
      object(message, ['protocol', 'id', 'action', 'data'], 'IPC request');
      if (message.protocol !== PROTOCOL) throw new Error('Invalid runtime IPC protocol');
      integer(message.id, 'request ID', 1, Number.MAX_SAFE_INTEGER);
      let result;
      if (message.action === 'init') {
        if (runtime) throw new Error('Runtime already initialized');
        runtime = new PersistentRuntime(); result = await runtime.init(message.data);
      } else {
        if (!runtime) throw new Error('Initialize runtime first');
        result = await runtime.handle(message.action, message.data || {});
        stop = message.action === 'stop';
        if (stop) runtime.dispose();
      }
      send({protocol: PROTOCOL, id: message.id, ok: true, result}, stop ? () => process.exit(0) : undefined);
    } catch (error) {
      if (message?.action === 'init') {runtime?.dispose(); stop = true;}
      send({protocol: PROTOCOL, id: message?.id ?? null, ok: false, error: error.message,
        errorInfo: errorInfo(error)}, stop ? () => process.exit(1) : undefined);
    }
  }).catch(() => {runtime?.dispose(); process.exit(1);});
});
process.on('disconnect', () => {runtime?.dispose(); process.exit(0);});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {runtime?.dispose(); process.exit(0);});
