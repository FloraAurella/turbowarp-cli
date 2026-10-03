const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {inspect: inspectResources} = require('./resource-state');

const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => {
  try {return JSON.parse(fs.readFileSync(file, 'utf8'));} catch (error) {
    return {unavailable: error.code || error.message};
  }
};
const status = () => {
  const censusFile = path.join(root, 'docs/census/m1-census.json');
  const census = readJSON(censusFile);
  const addon = readJSON(path.join(root, 'docs/addons-inventory.json'));
  const resources = inspectResources();
  const library = resources.library;
  const actions = census.actions || [];
  const pending = actions.filter(action => action.implementationStatus !== 'verified' || action.acceptanceStatus !== 'verified').length;
  const addonRows = addon.addons || [];
  const addonsPending = addonRows.filter(item => item.implementationStatus !== 'verified' || item.acceptanceStatus !== 'verified').length;
  const current = {census: {coverageComplete: census.coverageComplete === true, records: actions.length,
    actualActions: census.stats?.actualActionCount ?? null, pending,
    sha256: fs.existsSync(censusFile) ? hash(fs.readFileSync(censusFile)) : null},
  addons: {count: addonRows.length, fullyDispositioned: addon.fullyDispositioned === true, pending: addonsPending}, library,
  resources: {complete: resources.complete, checkedFiles: resources.checkedFiles, extensionFiles: resources.extensionFiles, errors: resources.errors}};
  const gates = readJSON(path.join(root, 'docs/acceptance-evidence.json'));
  const requirements = ['imageDifferential', 'audioDifferential', 'platforms', 'performance', 'permissions', 'devices'];
  const missingGates = requirements.filter(name => gates[name]?.verified !== true);
  const complete = current.census.coverageComplete && actions.length > 0 && pending === 0 &&
    current.addons.count === 81 && current.addons.fullyDispositioned && addonsPending === 0 &&
    resources.complete && library.expected > 0 && library.available === library.expected && library.invalid === 0 && missingGates.length === 0;
  return {releaseReady: complete, noDOM: typeof document === 'undefined' && typeof window === 'undefined', ...current,
    missingAcceptanceGates: missingGates,
    note: 'Command existence, ledger structure, and passing unit tests do not by themselves prove full GUI parity.'};
};
module.exports = {status};
