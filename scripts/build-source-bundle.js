const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('@turbowarp/jszip');
const {atomicWrite, readLocalFile} = require('../src/project');

const root = path.resolve(__dirname, '..');
const walk = async (directory, prefix) => {
  const files = [];
  for (const item of await fs.readdir(directory, {withFileTypes: true})) {
    const relative = prefix + '/' + item.name, full = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Source bundle refuses symlinks: ' + relative);
    if (item.isDirectory()) files.push(...await walk(full, relative));
    else if (item.isFile()) files.push(relative);
    else throw new Error('Source bundle refuses non-regular files: ' + relative);
  }
  return files;
};
const main = async () => {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3 || !output.endsWith('.zip')) throw new Error('Use node scripts/build-source-bundle.js /absolute/new-source.zip');
  const files = ['package.json', 'package-lock.json', '.npmrc', '.gitignore', 'baseline.json',
    'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'tw'];
  for (const name of ['bin', 'src', 'resources', 'vendor', 'LICENSES', 'upstream', 'docs', 'scripts', 'test']) {
    files.push(...await walk(path.join(root, name), name));
  }
  const zip = new JSZip(), manifest = {version: 1, name: 'tw-cli experimental source delivery', fullParityReady: false,
    node: '24.x', platformAcceptance: 'macOS arm64 tested only; Windows/Linux installation not accepted',
    exclusions: ['node_modules', 'desktop-master', 'examples', 'old browser user databases'],
    instructions: 'Install locked dependencies on Node24, then use ./tw; resources:check and tutorial:smoke work without a sibling desktop. Full development tests reference the frozen desktop source oracle.', files: {}};
  for (const file of files.sort()) {
    const bytes = await readLocalFile(path.join(root, file), 100 * 1024 * 1024);
    manifest.files[file] = {bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
    zip.file('tw-cli/' + file, bytes, {unixPermissions: file === 'tw' || file === 'bin/tw.js' ? 0o100755 : 0o100644});
  }
  zip.file('tw-cli/SOURCE-BUNDLE.json', JSON.stringify(manifest, null, 2) + '\n', {unixPermissions: 0o100644});
  const bytes = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX'});
  const checked = await JSZip.loadAsync(bytes);
  for (const [file, expected] of Object.entries(manifest.files)) {
    const data = await checked.file('tw-cli/' + file).async('nodebuffer');
    if (data.length !== expected.bytes || crypto.createHash('sha256').update(data).digest('hex') !== expected.sha256) throw new Error('Bundle readback mismatch: ' + file);
  }
  const result = await atomicWrite(output, bytes);
  console.log(JSON.stringify({...result, files: files.length, experimentalSourceOnly: true, fullParityReady: false,
    dependenciesIncluded: false, siblingDesktopIncluded: false}, null, 2));
};
main().catch(error => {console.error(error); process.exitCode = 1;});
