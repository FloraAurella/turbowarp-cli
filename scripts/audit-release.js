'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('@turbowarp/jszip');

// Audit the bytes that will be published, including nested upstream archives.
// Test projects must be generated at test time, never shipped as binary fixtures.
const forbidden = /\.(?:sb3|sb2|sb|sprite3|sprite2|sprite)$/i;
const privatePath = /(?:^|\/)(?:\.git|\.zcode|games|edit)(?:\/|$)|(?:^|\/)docs\/verification\/|(?:^|\/)examples\/verified-/;
async function auditZip(bytes, label, state, depth = 0) {
  if (depth > 8) throw new Error('Nested archive depth exceeds audit limit: ' + label);
  const zip = await JSZip.loadAsync(bytes);
  for (const entry of Object.values(zip.files)) {
    const name = entry.name;
    if (name !== entry.unsafeOriginalName && entry.unsafeOriginalName !== undefined ||
        name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error('Unsafe archive entry: ' + label + ':' + name);
    }
    if (entry.dir) continue;
    const location = label + ':' + name;
    if (forbidden.test(name) || privatePath.test(name)) throw new Error('Private project/data entry: ' + location);
    if (((entry.unixPermissions || 0) & 0o170000) === 0o120000) throw new Error('Symlink in archive: ' + location);
    const data = await entry.async('nodebuffer');
    state.files++; state.expandedBytes += data.length;
    if (state.expandedBytes > 2 * 1024 ** 3) throw new Error('Release audit expansion budget exceeded');
    if (/\.zip$/i.test(name)) {
      state.nestedArchives++;
      await auditZip(data, location, state, depth + 1);
    } else if (/\.(?:tgz|tar|tar\.gz|7z|rar)$/i.test(name)) {
      throw new Error('Archive format needs an explicit audit before publishing: ' + location);
    }
  }
}
async function auditRelease(file) {
  const bytes = await fs.readFile(file), state = {files: 0, nestedArchives: 0, expandedBytes: 0};
  await auditZip(bytes, path.basename(file), state);
  return {file: path.basename(file), bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...state, projectFiles: 0, privateDataFiles: 0};
}
if (require.main === module) {
  if (process.argv.length < 3) throw new Error('Use node scripts/audit-release.js archive.zip [...]');
  Promise.all(process.argv.slice(2).map(auditRelease)).then(results => {
    console.log(JSON.stringify({passed: true, results}, null, 2));
  }).catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {auditRelease};
