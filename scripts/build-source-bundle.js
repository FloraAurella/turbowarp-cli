'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('@turbowarp/jszip');
const {listPublicFiles, preparePublicFiles, EXCLUSIONS, sha256} = require('./source-release-policy');

const buildSourceBundle = async ({root = path.resolve(__dirname, '..'), output}) => {
  if (!output || path.extname(output).toLowerCase() !== '.zip') throw new Error('Source output must end in .zip');
  const prepared = await preparePublicFiles(root), zip = new JSZip();
  const manifest = {version: 2, name: 'tw-cli public source delivery', toolVersion: JSON.parse(prepared.files.get('package.json')).version,
    fullParityReady: false, node: '24.x',
    inclusionPolicy: 'Explicit reviewed path allowlist in scripts/source-release-files.json. Directory walks never include additional files.',
    exclusions: EXCLUSIONS, projectDataIncluded: false, fixturePolicy: 'Fixtures are generated from test/helpers/demo-project.js or other synthetic source helpers at test time. No Scratch project archives are included.',
    platformAcceptance: 'macOS arm64 tested only; Windows/Linux installation not accepted',
    instructions: 'Install locked dependencies on Node24. Native project editing tests and tutorial:smoke are self-contained. Full development oracle tests require the documented frozen desktop source; browser/device/platform acceptance remains separate.',
    upstream: prepared.upstream, files: {}};
  for (const [filename, bytes] of [...prepared.files].sort(([one], [two]) => one.localeCompare(two))) {
    manifest.files[filename] = {bytes: bytes.length, sha256: sha256(bytes), mode: filename === 'tw' || filename === 'bin/tw.js' ? '0755' : '0644'};
    zip.file('tw-cli/' + filename, bytes, {date: new Date('2000-01-01T00:00:00Z'), unixPermissions: manifest.files[filename].mode === '0755' ? 0o100755 : 0o100644});
  }
  zip.file('tw-cli/SOURCE-BUNDLE.json', JSON.stringify(manifest, null, 2) + '\n', {date: new Date('2000-01-01T00:00:00Z'), unixPermissions: 0o100644});
  const bytes = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX'}), checked = await JSZip.loadAsync(bytes);
  const archiveFiles = Object.values(checked.files).filter(entry => !entry.dir).map(entry => entry.name).sort();
  const expectedFiles = [...Object.keys(manifest.files).map(filename => 'tw-cli/' + filename), 'tw-cli/SOURCE-BUNDLE.json'].sort();
  if (JSON.stringify(archiveFiles) !== JSON.stringify(expectedFiles)) throw new Error('Source bundle contains unlisted files');
  for (const [filename, expected] of Object.entries(manifest.files)) {
    const data = await checked.file('tw-cli/' + filename).async('nodebuffer');
    if (data.length !== expected.bytes || sha256(data) !== expected.sha256) throw new Error('Bundle readback mismatch: ' + filename);
  }
  const full = path.resolve(output); await fs.mkdir(path.dirname(full), {recursive: true});
  const temporary = full + '.' + crypto.randomUUID() + '.partial';
  try {
    await fs.writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
    await fs.link(temporary, full);
  } finally {await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
  return {path: full, bytes: bytes.length, sha256: sha256(bytes), files: prepared.files.size,
    projectDataIncluded: false, excludedUpstreamProjects: Object.values(prepared.upstream).flatMap(audit => audit.excludedProjectEntries).length,
    experimentalSourceOnly: true, fullParityReady: false, dependenciesIncluded: false, manifest};
};
const main = async () => {
  const args = process.argv.slice(2), output = args.shift();
  let root = path.resolve(__dirname, '..');
  if (args[0] === '--root' && args.length === 2) root = path.resolve(args[1]);
  else if (args.length) throw new Error('Use node scripts/build-source-bundle.js output.zip [--root public-checkout]');
  const {manifest, ...receipt} = await buildSourceBundle({root, output});
  console.log(JSON.stringify(receipt, null, 2));
};
if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {buildSourceBundle, listPublicFiles};
