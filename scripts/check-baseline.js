const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {brotliDecompressSync} = require('node:zlib');

const root = path.resolve(__dirname, '..');
const desktop = path.resolve(root, '../desktop-master');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'baseline.json'), 'utf8'));
const hash = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const errors = [];
const missing = [];
const check = (label, run) => {
  try {run();} catch (error) {errors.push(`${label}: ${error.message}`);}
};
const verifyHash = (file, expected) => {
  if (hash(fs.readFileSync(file)) !== expected) throw new Error(`hash mismatch: ${file}`);
};

check('desktop lockfile', () => verifyHash(path.join(root, '..', baseline.lockfile.path), baseline.lockfile.sha256));
const lock = JSON.parse(fs.readFileSync(path.join(desktop, 'package-lock.json'), 'utf8'));
for (const [name, pin] of Object.entries(baseline.pins)) {
  check(`upstream pin ${name}`, () => {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || !entry.resolved || !entry.resolved.endsWith(`#${pin}`)) {
      throw new Error('resolved commit differs from frozen baseline');
    }
  });
}
check('embedded packager', () => verifyHash(path.join(desktop, baseline.packager.path), baseline.packager.sha256));
check('library manifest', () => verifyHash(path.join(desktop, baseline.libraryFiles.manifest), baseline.libraryFiles.manifestSha256));

const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(file) : [file];
});
check('frozen extension files', () => {
  const dir = path.join(desktop, 'dist-extensions');
  const actual = walk(dir).map(file => path.relative(dir, file)).sort();
  const expected = Object.keys(baseline.distExtensions.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('extension inventory differs');
  for (const file of actual) verifyHash(path.join(dir, file), baseline.distExtensions.files[file]);
});
check('addon inventory', () => {
  const dir = path.join(desktop, 'node_modules/scratch-gui/src/addons/addons');
  const ids = fs.readdirSync(dir, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, '_manifest_entry.js')))
    .map(entry => entry.name).sort();
  if (ids.length !== baseline.addons.count || JSON.stringify(ids) !== JSON.stringify([...baseline.addons.ids].sort())) {
    throw new Error(`addon inventory differs (${ids.length} found)`);
  }
});

const assets = JSON.parse(fs.readFileSync(path.join(desktop, baseline.libraryFiles.manifest), 'utf8'));
for (const asset of assets) {
  const filename = `${asset.md5}${path.extname(asset.src)}.br`;
  const file = path.join(desktop, 'dist-library-files', filename);
  if (!fs.existsSync(file)) {
    missing.push(filename);
    continue;
  }
  check(`library asset ${filename}`, () => {
    const bytes = brotliDecompressSync(fs.readFileSync(file));
    if (hash(bytes) !== asset.sha256 || hash(bytes, 'md5') !== asset.md5) throw new Error('asset content differs');
  });
}
console.log(JSON.stringify({
  frozenBaselineVerified: errors.length === 0,
  complete: errors.length === 0 && missing.length === 0,
  extensionFiles: Object.keys(baseline.distExtensions.files).length,
  addons: baseline.addons.count,
  libraryAssets: {expected: assets.length, missing: missing.length},
  errors
}, null, 2));
if (errors.length > 0) process.exitCode = 1;
else if (missing.length > 0) process.exitCode = 2;
