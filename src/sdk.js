'use strict';

const {CommandError} = require('./errors');
if (process.versions.node.split('.')[0] !== '24') {
  throw new CommandError('NODE_RUNTIME_UNAVAILABLE', 'tw-cli SDK requires Node.js 24 for native addon compatibility',
    'Run your editing script with Node.js 24; the in-process SDK cannot switch Node runtimes.');
}
const {CommandSession} = require('./commands');
const engine = () => require('./project-code');
const encode = value => JSON.stringify(value);

// Keep the VM and session implementation out of the public SDK surface.
const states = new WeakMap();
const stateOf = project => {
  const state = states.get(project);
  if (!state || state.session.disposed) throw new CommandError('SESSION_DISPOSED', 'Project has been disposed');
  return state;
};

class ProjectSDK {
  constructor(session, options = {}) {states.set(this, {session, managed: !!options.managed, reports: []});}
  async read(options = {}) {return engine().read(stateOf(this).session.project, options);}
  async find(query, options = {}) {return engine().find(stateOf(this).session.project, query, options);}
  target(selector) {
    const {session} = stateOf(this);
    // Resolve immediately so misspellings and ambiguous names fail before editing.
    return new TargetSDK(this, session.project.target(selector).id);
  }
  async batch(edits, options = {}) {
    const state = stateOf(this);
    if ((state.managed || state.session._batchDepth) && options.out) throw new CommandError('BATCH_COMMAND_DENIED', 'Cannot save an intermediate project inside a batch or managed script');
    if (typeof edits !== 'function') {
      const document = Array.isArray(edits) ? {version: 1, operations: edits} : edits;
      const result = await state.session.applyProjectEdits(document, options);
      state.reports.push(result);
      return result;
    }
    return state.session.projectBatch(async () => {
      const start = state.reports.length;
      await edits(this);
      const reports = state.reports.slice(start);
      return {operations: reports.flatMap(report => report.operations || []),
        idMap: Object.assign({}, ...reports.map(report => report.idMap || {})),
        diagnostics: reports.flatMap(report => report.diagnostics || [])};
    }, options);
  }
  async validate(document) {
    const {session} = stateOf(this);
    if (document === undefined) return engine().validate(session.project);
    return session.validateProjectEdits(Array.isArray(document) ? {version: 1, operations: document} : document);
  }
  async save(filename, options = {}) {
    const {session, managed} = stateOf(this);
    if (managed || session._batchDepth) throw new CommandError('BATCH_COMMAND_DENIED', 'Save is not allowed inside a batch or managed editing script');
    if (typeof filename !== 'string' || !filename) throw new CommandError('INVALID_ARGUMENT', 'SDK save requires an explicit output filename');
    await this.validate();
    return session.save(filename, !!options.force);
  }
  dispose() {
    const state = states.get(this);
    if (!state || state.session.disposed) return;
    if (state.session._batchDepth) throw new CommandError('BATCH_COMMAND_DENIED', 'Dispose is not allowed inside a batch');
    state.session.dispose();
  }
}

class TargetSDK {
  constructor(project, id) {
    this.id = id;
    const apply = operation => project.batch([{...operation, target: id}]);
    const command = (name, args) => apply({op: 'command', command: name, args: [...args, '--target', id]});
    this.read = options => project.read({...options, target: id});
    this.find = query => project.find(query, {target: id});
    this.scripts = Object.freeze({
      add: body => apply({op: 'script.add', body}),
      replace: (root, body) => apply({op: 'script.replace', root, body}),
      delete: root => apply({op: 'script.delete', root}),
      read: root => project.read({target: id, script: root})
    });
    this.blocks = Object.freeze({update: (blockId, patch) => apply({...patch, op: 'block.update', id: blockId})});
    this.procedures = Object.freeze({
      define: spec => apply({...spec, op: 'procedure.define'}),
      update: (name, patch) => apply({...patch, op: 'procedure.update', name}),
      delete: name => apply({op: 'procedure.delete', name})
    });
    this.variables = Object.freeze({
      add: (name, value = 0, options = {}) => command('var', ['add', name, encode(value), ...(options.type ? ['--type', options.type] : [])]),
      set: (name, value) => command('var', ['set', name, encode(value)]),
      rename: (name, newName) => command('var', ['rename', name, newName]),
      delete: name => command('var', ['delete', name])
    });
    this.lists = Object.freeze({
      add: (name, values = []) => command('list', ['add', name, encode(values)]),
      set: (name, values) => command('list', ['set', name, encode(values)]),
      append: (name, value) => command('list', ['append', name, encode(value)]),
      clear: name => command('list', ['clear', name]),
      rename: (name, newName) => command('list', ['rename', name, newName]),
      delete: name => command('list', ['delete', name])
    });
    const assets = kind => Object.freeze({
      add: filename => command(kind, ['add', filename]),
      import: filename => command(kind, ['add', filename]),
      rename: (selector, name) => command('asset', ['rename', kind, String(selector), name]),
      delete: selector => command('asset', ['delete', kind, String(selector)]),
      reorder: (selector, index) => command('asset', ['reorder', kind, String(selector), String(index)])
    });
    this.assets = Object.freeze({costumes: assets('costume'), sounds: assets('sound')});
    Object.freeze(this);
  }
}

const createSDK = (session, options) => new ProjectSDK(session, options);
const openProject = async input => {
  const session = new CommandSession();
  try {
    if (typeof input === 'string') await session.open(input);
    else if (Buffer.isBuffer(input) || input instanceof Uint8Array) await session.project.load(Buffer.from(input));
    else throw new CommandError('INVALID_ARGUMENT', 'openProject requires a filename or project bytes');
    return createSDK(session);
  } catch (error) {session.dispose(); throw error;}
};
const createProject = async () => {
  const session = new CommandSession();
  try {await session.execute(['new']); return createSDK(session);} catch (error) {session.dispose(); throw error;}
};

module.exports = {openProject, createProject};
// Internal worker bridge, deliberately excluded from package exports and declarations.
Object.defineProperty(module.exports, 'createSDK', {value: createSDK});
