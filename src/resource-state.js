const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {brotliDecompressSync} = require('node:zlib');
const {checkedPathSync} = require('./file-boundaries');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_SHA256 = 'e70eb3fcf7049df08ebc1572cad080396e04c8d14b4b0421ed340f82efd2aa1f';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const read = (filename, limit = 64 * 1024 * 1024) => {
  const handle = fs.openSync(checkedPathSync(filename), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > limit) throw new Error('Resource must be a bounded regular file');
    const bytes = fs.readFileSync(handle);
    if (bytes.length > limit) throw new Error('Resource exceeded its read limit');
    return bytes;
  } finally {fs.closeSync(handle);}
};
const walk = (directory, relative = '') => fs.readdirSync(path.join(directory, relative), {withFileTypes: true}).flatMap(entry => {
  const name = relative ? relative + '/' + entry.name : entry.name;
  if (entry.isSymbolicLink()) throw new Error('Resource tree contains a symlink: ' + name);
  if (entry.isDirectory()) return walk(directory, name);
  if (!entry.isFile()) throw new Error('Resource tree contains a non-regular file: ' + name);
  return [name];
});
const inspect = (directory = path.join(ROOT, 'resources')) => {
  const errors = [], library = {expected: 1304, available: 0, missing: 0, invalid: 0};
  let checkedFiles = 0, totalBytes = 0, extensionFiles = 0;
  const check = (name, run) => {try {run();} catch (error) {errors.push(name + ': ' + error.message);}};
  const baseline = JSON.parse(read(path.join(ROOT, 'baseline.json'), 4 * 1024 * 1024));
  check('resource inventory', () => {
    const bytes = read(path.join(directory, 'RESOURCE-MANIFEST.json'), 4 * 1024 * 1024);
    if (hash(bytes) !== MANIFEST_SHA256) throw new Error('Pinned manifest SHA-256 mismatch');
    const manifest = JSON.parse(bytes);
    if (manifest.version !== 1 || !manifest.files || Object.keys(manifest.files).length !== 1610) throw new Error('Invalid resource inventory');
    const actual = walk(directory).filter(name => name !== 'RESOURCE-MANIFEST.json').sort();
    const expected = Object.keys(manifest.files).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Resource filenames differ from the frozen inventory');
    for (const name of expected) {
      check(name, () => {
        if (name.includes('\\') || name.split('/').some(part => part === '..' || part === '.') || path.isAbsolute(name)) throw new Error('Unsafe resource path');
        const bytes = read(path.join(directory, name));
        if (hash(bytes) !== manifest.files[name]) throw new Error('SHA-256 mismatch');
        checkedFiles++; totalBytes += bytes.length;
      });
    }
  });
  for (const [name, expected] of Object.entries(baseline.distExtensions.files)) check('extension ' + name, () => {
    if (hash(read(path.join(directory, 'extensions', name))) !== expected) throw new Error('Frozen extension hash mismatch');
    extensionFiles++;
  });
  check('library assets', () => {
    const bytes = read(path.join(directory, 'library-manifest.json'), 4 * 1024 * 1024);
    if (hash(bytes) !== baseline.libraryFiles.manifestSha256) throw new Error('Frozen library manifest hash mismatch');
    const records = JSON.parse(bytes);
    if (!Array.isArray(records) || records.length !== library.expected) throw new Error('Frozen library asset count mismatch');
    const names = new Set();
    for (const record of records) {
      let name;
      try {
        const url = new URL(record.src); name = url.pathname.slice(1);
        if (url.protocol !== 'https:' || !['assets.scratch.mit.edu', 'cdn.assets.scratch.mit.edu'].includes(url.hostname) ||
          url.port || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{32}$/.test(record.md5) ||
          !/^[a-f0-9]{64}$/.test(record.sha256) || !new RegExp(`^${record.md5}\\.(svg|png|jpg|jpeg|gif|bmp|wav|mp3)$`).test(name) || names.has(name)) {
          throw new Error('Invalid frozen asset record');
        }
        names.add(name);
        const asset = brotliDecompressSync(read(path.join(directory, 'library', name + '.br'), 32 * 1024 * 1024), {maxOutputLength: 32 * 1024 * 1024});
        if (hash(asset) !== record.sha256 || hash(asset, 'md5') !== record.md5) throw new Error('Expanded asset MD5/SHA-256 mismatch');
        library.available++;
      } catch (error) {
        if (error.code === 'ENOENT') library.missing++; else library.invalid++;
        errors.push('library ' + (name || record.md5) + ': ' + error.message);
      }
    }
  });
  return {complete: errors.length === 0 && checkedFiles === 1610 && extensionFiles === 301 && library.available === library.expected,
    directory: path.resolve(directory), manifestSha256: MANIFEST_SHA256, checkedFiles, totalBytes, extensionFiles, library, errors};
};
module.exports = {inspect, MANIFEST_SHA256};
