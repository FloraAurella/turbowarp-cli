const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const compile = (filename, transform, override) => {
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = compiled.require.bind(compiled);
  compiled.require = request => override && override(request) || originalRequire(request);
  compiled._compile(transform(fs.readFileSync(filename, 'utf8')), filename);
  return compiled.exports;
};

const runtimeFile = require.resolve('scratch-vm/src/engine/runtime');
const Runtime = compile(runtimeFile, source => {
  const boundary = '!document.hidden && !this.frameLoop._interpolationAnimation';
  if (!source.includes(boundary)) throw new Error('Frozen VM visibility boundary changed');
  return source.replace(boundary, '!this.frameLoop._interpolationAnimation');
});
// Suppress only the known deferred-renderer warning, inside a private frozen
// module copy. Do not change the shared logger or hide asset decode failures.
const loadCostume = compile(require.resolve('scratch-vm/src/import/load-costume'), source => {
  const deferred = "log.warn('No rendering module present; cannot load costume: ', costume.name);";
  if (!source.includes(deferred)) throw new Error('Frozen deferred costume boundary changed');
  return source.replace(deferred, '/* Native renderer and fonts are attached after deserialization. */');
});
const serializers = Object.fromEntries(['sb2', 'sb3'].map(name => [name,
  compile(require.resolve('scratch-vm/src/serialization/' + name), source => source,
    request => request === '../import/load-costume.js' ? loadCostume : null)]));
// Upstream dispatch is a process-wide singleton. Separate sessions (including a
// candidate for a failed open) must not register primitives into another VM.
module.exports = function NativeVM() {
  const dispatch = new (require('scratch-vm/src/dispatch/central-dispatch').constructor)();
  const ExtensionManager = compile(require.resolve('scratch-vm/src/extension-support/extension-manager'), source => source,
    request => request === '../dispatch/central-dispatch' ? dispatch : null);
  const VirtualMachine = compile(require.resolve('scratch-vm/src/virtual-machine'), source => source,
    request => request === './engine/runtime' ? Runtime : request === './dispatch/central-dispatch' ? dispatch :
      request === './extension-support/extension-manager' ? ExtensionManager :
        request === './import/load-costume.js' ? loadCostume :
          request.startsWith('./serialization/') ? serializers[request.slice('./serialization/'.length)] : null);
  return new VirtualMachine();
};
