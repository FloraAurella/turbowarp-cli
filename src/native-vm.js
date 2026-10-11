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
const preserveCompactBlockIds = source => {
  const boundaries = [
    ['const deserializeInputDesc = function (inputDescOrId, parentId, isShadow, blocks) {',
      'const deserializeInputDesc = function (inputDescOrId, parentId, isShadow, blocks, sourceId) {'],
    ['const newId = uid();', 'const newId = sourceId === undefined ? uid() : sourceId;'],
    ['primitiveObj.shadow = isShadow;', 'primitiveObj.shadow = isShadow;\n    primitiveObj.topLevel = false;'],
    ['const deserializeBlocks = function (blocks) {', `const deserializeBlocks = function (blocks) {
    const compactIncoming = new Map();
    for (const [ownerId, owner] of Object.entries(blocks)) {
        if (Array.isArray(owner)) continue;
        if (typeof owner.next === 'string') compactIncoming.set(owner.next, ownerId);
        for (const input of Object.values(owner.inputs || {})) {
            for (const child of Array.isArray(input) ? input.slice(1, 3) : [input?.block, input?.shadow]) {
                if (typeof child === 'string') compactIncoming.set(child, ownerId);
            }
        }
    }`],
    ['deserializeInputDesc(block, null, false, blocks);', `// Dictionary entries already have an authoritative SB3 identity. Only
            // inline input primitives need generated IDs and slot stabilization.
            if (compactIncoming.has(blockId)) {
                throw new Error('Standalone compact block ' + blockId + ' is referenced by ' + compactIncoming.get(blockId));
            }
            const primitiveId = deserializeInputDesc(block, null, false, blocks, blockId);
            if (primitiveId && block.length === 3 && (block[0] === VAR_PRIMITIVE || block[0] === LIST_PRIMITIVE)) {
                // A detached reporter without saved layout is still distinct,
                // non-executing code. Give it the standard default position.
                Object.assign(blocks[primitiveId], {topLevel: true, x: 0, y: 0});
            }`]
  ];
  for (const [before, after] of boundaries) {
    if (source.split(before).length !== 2) throw new Error('Frozen compact block identity boundary changed');
    source = source.replace(before, after);
  }
  return source;
};
const serializers = Object.fromEntries(['sb2', 'sb3'].map(name => [name,
  compile(require.resolve('scratch-vm/src/serialization/' + name), source => name === 'sb3' ? preserveCompactBlockIds(source) : source,
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
