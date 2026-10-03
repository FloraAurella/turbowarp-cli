const path = require('node:path');
const {atomicWrite, readLocalFile, rejectPrototypeKeys} = require('./project');

const defaults = {locale: 'en', updateChecker: 'stable', crashDumps: 'none', ignoredUpdate: null,
  ignoredUpdateUntil: 0, camera: null, microphone: null, bypassCORS: false,
  hardwareAcceleration: true, backgroundThrottling: true, lastDirectory: '', spellchecker: true,
  exitFullscreenOnEscape: true, richPresence: false, dataVersion: 0, desktopVersion: '0.0.0', electronVersion: '0.0.0'};
const nonApplicable = new Set(['hardwareAcceleration', 'backgroundThrottling', 'spellchecker', 'exitFullscreenOnEscape', 'richPresence', 'camera', 'microphone', 'bypassCORS', 'crashDumps', 'updateChecker']);
const migrate = data => {
  const result = {};
  if (typeof data.locale === 'string') result.locale = data.locale;
  if (data.disable_update_checker === true) result.updateChecker = 'never';
  if (data.bypass_cors === true) result.bypassCORS = true;
  if (data.hardware_acceleration === false) result.hardwareAcceleration = false;
  if (data.background_throttling === false) result.backgroundThrottling = false;
  if (typeof data.last_accessed_directory === 'string') result.lastDirectory = data.last_accessed_directory;
  return result;
};
const execute = async (args, filename) => {
  if (!filename) throw new Error('Use --config FILE.json; CLI never changes desktop user settings implicitly');
  let data;
  try {
    const parsed = JSON.parse((await readLocalFile(filename, 2 * 1024 * 1024)).toString('utf8'));
    rejectPrototypeKeys(parsed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v2 !== undefined &&
      (!parsed.v2 || typeof parsed.v2 !== 'object' || Array.isArray(parsed.v2))) throw new Error('Invalid preferences object');
    data = parsed.v2 || migrate(parsed);
  } catch (error) {if (error.code !== 'ENOENT') throw error; data = {};}
  const [action, key, raw] = args;
  if (action === 'list') return {file: path.resolve(filename), values: {...defaults, ...data}, nonApplicable: [...nonApplicable],
    note: 'Stored desktop compatibility values do not activate Electron-only behavior'};
  if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown preference ${key}`);
  if (action === 'get') return {key, value: data[key] ?? defaults[key], effectiveInCLI: !nonApplicable.has(key)};
  if (action !== 'set') throw new Error('Use pref list/get/set');
  if (raw === undefined) throw new Error('Missing preference value');
  let value;
  try {value = JSON.parse(raw);} catch {value = raw;}
  const original = defaults[key];
  if (original === null) {
    if (value !== null && typeof value !== 'string') throw new Error('Preference must be string or null');
  } else if (typeof value !== typeof original) throw new Error(`Preference ${key} requires ${typeof original}`);
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid numeric preference');
  if (key === 'updateChecker' && !['stable', 'prerelease', 'never'].includes(value)) throw new Error('updateChecker must be stable/prerelease/never');
  data[key] = value;
  await atomicWrite(filename, Buffer.from(JSON.stringify({v2: data}, null, 2)), true);
  return {key, value, effectiveInCLI: !nonApplicable.has(key)};
};
module.exports = {execute, defaults};
