const fs = require('node:fs');
const path = require('node:path');

const filenames = [
  'runtime-commands.js',
  'project-io-commands.js',
  'package-commands.js',
  'extension-commands.js',
  'paint-commands.js',
  'asset-commands.js',
  'block-commands.js',
  'addon-commands.js',
  'device-commands.js',
  'settings-commands.js',
  'monitor-commands.js',
  'record-commands.js',
  'gamepad-mapping-commands.js',
  'target-commands.js',
  'font-commands.js'
];
const specs = Object.create(null);
const routes = new Map();
const modules = [];
const booleanOptions = new Set();
for (const filename of filenames) {
  const full = path.join(__dirname, filename);
  if (!fs.existsSync(full)) continue;
  const implementation = require(full);
  if (!implementation.specs || typeof implementation.execute !== 'function') {
    throw new Error(`Invalid command module contract: ${filename}`);
  }
  for (const [command, definition] of Object.entries(implementation.specs)) {
    if (routes.has(command)) throw new Error(`Duplicate modular command ${command}`);
    specs[command] = definition;
    routes.set(command, implementation);
  }
  for (const option of implementation.booleanOptions || []) booleanOptions.add(option);
  modules.push({filename, implementation});
}

const route = command => routes.get(command);
const dispose = session => {
  for (const {implementation} of modules) {
    if (typeof implementation.dispose === 'function') implementation.dispose(session);
  }
};
const captureState = session => {
  const state = {};
  for (const {filename, implementation} of modules) {
    if (typeof implementation.captureState === 'function') state[filename] = structuredClone(implementation.captureState(session));
  }
  return state;
};
const restoreState = (session, state = {}) => {
  for (const {filename, implementation} of modules) {
    if (typeof implementation.restoreState === 'function') implementation.restoreState(session, structuredClone(state[filename]));
  }
};

module.exports = {specs, route, dispose, captureState, restoreState, booleanOptions};
