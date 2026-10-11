'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('@turbowarp/jszip');
const policy = require('./source-release-files.json');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const projectArchive = /\.(?:sb3|sb2|sb|sprite3|sprite2|sprite)$/i;
const EXCLUSIONS = ['games/', 'edit/', 'examples/', '.zcode/', 'docs/verification/', 'test/fixtures/',
  'protected-preview/artifacts/', 'protected-preview/verification.md', 'node_modules/', '.git/', 'releases/', '.open-source/',
  '*.sb3', '*.sb2', '*.sb', '*.sprite3', '*.sprite2', '*.sprite', '**/project.json', 'unlisted files'];
const assertPublicPath = filename => {
  if (typeof filename !== 'string' || !filename || filename.includes('\\') || filename.includes('\0') || path.posix.isAbsolute(filename) ||
    filename.split('/').some(part => ['', '.', '..', '.git', '.zcode', 'node_modules', '__pycache__'].includes(part)) ||
    /^(?:games|edit|examples|releases|\.open-source|test\/fixtures|docs\/verification)(?:\/|$)/.test(filename) ||
    projectArchive.test(filename) || /(?:^|\/)project\.json$/i.test(filename)) throw new Error('Private/project data path is forbidden in source release: ' + filename);
};
const assertNoProjectJSON = (filename, bytes) => {
  if (!filename.toLowerCase().endsWith('.json')) return;
  let value;
  try {value = JSON.parse(bytes.toString('utf8'));} catch {
    // Some hash-pinned upstream configuration uses JSON with comments. It is
    // source configuration, but malformed project-shaped data still fails closed.
    if (/(?:^|[,{])\s*["']?(?:targets|objName)["']?\s*:/.test(bytes.toString('utf8'))) throw new Error('Scratch project JSON is forbidden in source release: ' + filename);
    return;
  }
  if (value && typeof value === 'object' && (Array.isArray(value.targets) || typeof value.objName === 'string')) {
    throw new Error('Scratch project JSON is forbidden in source release: ' + filename);
  }
};
const readChecked = async (root, relative) => {
  assertPublicPath(relative);
  const full = path.join(root, relative);
  for (let current = full; current !== path.dirname(root); current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Source release refuses symlinks: ' + relative);
    if (current === full && !stat.isFile()) throw new Error('Source release requires regular files: ' + relative);
    if (current === root) break;
  }
  const bytes = await fs.readFile(full);
  if (bytes.length > 100 * 1024 * 1024) throw new Error('Source file exceeds 100 MiB: ' + relative);
  assertNoProjectJSON(relative, bytes);
  return bytes;
};
const listPublicFiles = async (root = path.resolve(__dirname, '..')) => {
  const files = [...policy.files, ...Object.keys(policy.pinnedResources), ...Object.keys(policy.upstream), 'upstream/SOURCE-MANIFEST.json'];
  for (const relative of policy.optionalFiles) {
    try {await fs.lstat(path.join(root, relative)); files.push(relative);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  for (const relative of files) assertPublicPath(relative);
  if (new Set(files).size !== files.length) throw new Error('Duplicate public source allowlist path');
  return files.sort();
};
const inspectNestedArchive = async (filename, bytes, depth = 0) => {
  if (depth > 5) throw new Error('Nested source archives exceed depth limit: ' + filename);
  const archive = await JSZip.loadAsync(bytes);
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    assertPublicPath(entry.unsafeOriginalName || entry.name);
    const data = await entry.async('nodebuffer');
    assertNoProjectJSON(entry.name, data);
    if (/\.(?:tgz|tar|tar\.gz|gz|7z|rar)$/i.test(entry.name)) throw new Error('Unsupported nested archive format: ' + filename + ':' + entry.name);
    if (entry.name.endsWith('.zip') || data[0] === 0x50 && data[1] === 0x4b) await inspectNestedArchive(filename + ':' + entry.name, data, depth + 1);
  }
};
const filterUpstream = async (filename, bytes, spec) => {
  const archive = await JSZip.loadAsync(bytes), output = new JSZip(), included = new Set(), excluded = [];
  for (const [name, entry] of Object.entries(archive.files)) {
    if (entry.dir) continue;
    if (spec.excludedEntries.includes(name)) {excluded.push(name); continue;}
    assertPublicPath(name);
    if (!Object.hasOwn(spec.entries, name)) throw new Error('Unlisted upstream archive entry: ' + filename + ':' + name);
    const data = await entry.async('nodebuffer');
    if (sha256(data) !== spec.entries[name]) throw new Error('Upstream source hash mismatch: ' + filename + ':' + name);
    assertNoProjectJSON(name, data);
    if (/\.(?:tgz|tar|tar\.gz|gz|7z|rar)$/i.test(name)) throw new Error('Unsupported upstream archive format: ' + name);
    if (name.endsWith('.zip') || data[0] === 0x50 && data[1] === 0x4b) await inspectNestedArchive(name, data);
    included.add(name);
    output.file(name, data, {date: new Date('2000-01-01T00:00:00Z'), unixPermissions: 0o100644});
  }
  if (included.size !== Object.keys(spec.entries).length) throw new Error('Missing allowlisted upstream source entries: ' + filename);
  const filtered = await output.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX'});
  return {bytes: filtered, audit: {originalSha256: spec.originalSha256, inputSha256: sha256(bytes), sha256: sha256(filtered),
    bytes: filtered.length, includedFiles: included.size, excludedProjectEntries: spec.excludedEntries, removedFromInput: excluded.sort(),
    note: 'Filtered upstream code archive; excluded sample Scratch projects are not redistributed. Original archive checksum is provenance, not the filtered archive checksum.'}};
};
const preparePublicFiles = async (root = path.resolve(__dirname, '..')) => {
  root = path.resolve(root);
  const files = new Map(), upstream = {};
  for (const filename of await listPublicFiles(root)) {
    if (filename === 'upstream/SOURCE-MANIFEST.json') continue;
    let bytes = await readChecked(root, filename);
    if (policy.pinnedResources[filename] && sha256(bytes) !== policy.pinnedResources[filename]) throw new Error('Licensed resource hash mismatch: ' + filename);
    if (policy.upstream[filename]) {
      const result = await filterUpstream(filename, bytes, policy.upstream[filename]);
      bytes = result.bytes; upstream[filename] = result.audit;
    }
    files.set(filename, bytes);
  }
  files.set('upstream/SOURCE-MANIFEST.json', Buffer.from(JSON.stringify({version: 2,
    archives: Object.entries(upstream).map(([filename, audit]) => ({path: filename, ...audit})),
    extensionsCommit: '90192c38ce9128c5eb828ad0957e0a968de9babd',
    desktopNote: 'Frozen desktop source snapshot; not the official v1.16.0 tag. Archives are filtered code and license deliveries, not complete upstream checkouts.'}, null, 2) + '\n'));
  return {files, upstream};
};
module.exports = {listPublicFiles, preparePublicFiles, assertPublicPath, assertNoProjectJSON, EXCLUSIONS, sha256};
