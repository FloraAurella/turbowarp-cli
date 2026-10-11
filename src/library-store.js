const fs = require('node:fs/promises');
const {existsSync} = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {brotliDecompressSync} = require('node:zlib');
const JSZip = require('@turbowarp/jszip');
const {resourceError} = require('./errors');
const {atomicWrite, readLocalFile, emptyTarget, md5, checkedZip, rejectPrototypeKeys, MAX_PROJECT_BYTES} = require('./project');

const root = path.resolve(__dirname, '..');
const desktop = path.resolve(root, '../desktop-master');
const GUI_LIBRARY_HASHES = {
  sprite: 'e12c042e362c78d155712023b4ae24b818d99e2fd77083c89084137fcd0bceed',
  costume: 'f5eaa95ab1d0c90e9f8bfd2df173ef926208c66a5f486cbcb78068f92f59c5d6',
  sound: '672a319037416befa40658a36fe6350181e4a8cc7c98659b5063fb67e286e4b8',
  backdrop: 'ab5ad4666e1d8fbf1e3ad407a335366154a7872ada2a60ad9923d1a42594c4fa'
};
const GUI_CATEGORIES = {
  sprite: ['animals', 'people', 'fantasy', 'dance', 'music', 'sports', 'food', 'fashion', 'letters'],
  costume: ['animals', 'people', 'fantasy', 'dance', 'music', 'sports', 'food', 'fashion', 'letters'],
  sound: ['animals', 'effects', 'loops', 'notes', 'percussion', 'space', 'sports', 'voice', 'wacky'],
  backdrop: ['fantasy', 'music', 'sports', 'outdoors', 'indoors', 'space', 'underwater', 'patterns']
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const kindName = kind => {
  const normalized = String(kind).replace(/s$/, '');
  if (!Object.hasOwn(GUI_LIBRARY_HASHES, normalized)) throw new Error('Library kind must be sprite/costume/sound/backdrop');
  return normalized;
};
const assetName = record => {
  const url = new URL(record.src);
  if (url.protocol !== 'https:' || !['assets.scratch.mit.edu', 'cdn.assets.scratch.mit.edu'].includes(url.hostname) || url.port || url.username || url.password ||
    !/^[a-f0-9]{32}$/.test(record.md5) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid frozen library manifest entry');
  const name = url.pathname.slice(1);
  if (!new RegExp(`^${record.md5}\\.(svg|png|jpg|jpeg|gif|bmp|wav|mp3)$`).test(name) || url.search || url.hash) throw new Error('Unsafe frozen library asset path');
  return name;
};
const verifyAsset = (bytes, record) => {
  if (bytes.length > 32 * 1024 * 1024 || md5(bytes) !== record.md5 || sha256(bytes) !== record.sha256) {
    throw new Error(`Frozen library MD5/SHA256 mismatch: ${assetName(record)}`);
  }
  return bytes;
};

class LibraryStore {
  constructor(directory) {
    const resources = path.join(root, 'resources');
    this.resourceMode = existsSync(path.join(resources, 'library-manifest.json')) && existsSync(path.join(resources, 'libraries/sprites.json'));
    this.directory = path.resolve(directory || (this.resourceMode ? path.join(resources, 'library') : path.join(desktop, 'dist-library-files')));
    this.guiRoot = this.resourceMode ? path.join(resources, 'libraries') : path.join(desktop, 'node_modules/scratch-gui/src/lib/libraries');
    this.manifestPath = this.resourceMode ? path.join(resources, 'library-manifest.json') : null;
    this._libraries = new Map(); this._manifest = null;
  }
  async manifest() {
    if (!this._manifest) {
      const baseline = JSON.parse(await readLocalFile(path.join(root, 'baseline.json')));
      const filename = this.manifestPath || path.join(desktop, baseline.libraryFiles.manifest);
      const bytes = await readLocalFile(filename);
      if (sha256(bytes) !== baseline.libraryFiles.manifestSha256) throw new Error(`Frozen library manifest hash mismatch: ${filename}`);
      this._manifest = JSON.parse(bytes);
      const names = this._manifest.map(assetName);
      if (new Set(names).size !== names.length) throw new Error('Duplicate frozen library assets');
    }
    return this._manifest;
  }
  async entries(kind) {
    kind = kindName(kind);
    if (!this._libraries.has(kind)) {
      const file = path.join(this.guiRoot, `${kind}s.json`);
      const bytes = await readLocalFile(file);
      if (sha256(bytes) !== GUI_LIBRARY_HASHES[kind]) throw new Error(`Frozen GUI library JSON hash mismatch: ${file}`);
      this._libraries.set(kind, JSON.parse(bytes));
    }
    return this._libraries.get(kind);
  }
  async browse(kind, {category, query = '', offset = 0, limit = 50} = {}) {
    kind = kindName(kind);
    offset = Number(offset); limit = Number(limit);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Library pagination: offset >= 0, limit 1..1000');
    const normalized = value => String(value).trim().toLowerCase();
    const all = await this.entries(kind);
    const matches = all.map((entry, index) => ({entry, index})).filter(({entry}) =>
      (!category || normalized(category) === 'all' || (entry.tags || []).some(tag => normalized(tag) === normalized(category))) &&
      normalized(`${entry.name} ${(entry.tags || []).join(' ')}`).includes(normalized(query)));
    return {kind, total: matches.length, offset, items: matches.slice(offset, offset + limit).map(({entry, index}) =>
      ({index, name: entry.name, tags: entry.tags || [], ...(entry.md5ext ? {md5ext: entry.md5ext} : {})}))};
  }
  async categories(kind) {
    kind = kindName(kind); const entries = await this.entries(kind);
    return {kind, categories: ['all', ...GUI_CATEGORIES[kind]].map(tag => ({tag, count: tag === 'all' ? entries.length :
      entries.filter(entry => (entry.tags || []).some(value => value.trim().toLowerCase() === tag)).length}))};
  }
  async select(kind, selector) {
    const entries = await this.entries(kind);
    const matches = entries.filter((entry, index) => entry.name.toLowerCase() === String(selector).toLowerCase() || String(index) === String(selector));
    if (matches.length !== 1) throw resourceError(matches.length, `Library item not found or ambiguous: ${kind}/${selector}`, selector);
    return structuredClone(matches[0]);
  }
  async record(name) {
    if (!/^[a-f0-9]{32}\.(svg|png|jpg|jpeg|gif|bmp|wav|mp3)$/.test(name)) throw new Error('Invalid library asset ID');
    const record = (await this.manifest()).find(record => assetName(record) === name);
    if (!record) throw new Error(`Asset is not in frozen library manifest: ${name}`);
    return record;
  }
  async readAsset(name) {
    const record = await this.record(name);
    const filename = path.join(this.directory, `${name}.br`);
    let compressed;
    try {compressed = await readLocalFile(filename, 32 * 1024 * 1024);} catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Missing frozen library asset: ${filename}; fetch explicitly with node ${path.join(root, 'scripts/fetch-cli-library.js')} --asset ${name} --dir ${this.directory} (no implicit network)`);
    }
    return verifyAsset(brotliDecompressSync(compressed, {maxOutputLength: 32 * 1024 * 1024}), record);
  }
  async spriteArchive(selector) {
    const entry = await this.select('sprite', selector);
    const sprite = {...emptyTarget(entry.name, false, entry.costumes), ...entry, layerOrder: 1};
    delete sprite.tags;
    const zip = new JSZip();
    for (const asset of [...sprite.costumes, ...sprite.sounds]) zip.file(asset.md5ext, await this.readAsset(asset.md5ext));
    zip.file('sprite.json', JSON.stringify(sprite));
    return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
  }
  async status() {
    const records = await this.manifest(); let available = 0; const missing = [], invalid = [];
    for (const record of records) {
      const name = assetName(record);
      try {await this.readAsset(name); available++;} catch (error) {
        if (error.message.startsWith('Missing frozen library asset:')) missing.push(name); else invalid.push({name, error: error.message});
      }
    }
    return {directory: this.directory, expected: records.length, available, missing: missing.length, invalid, missingAssets: missing};
  }
}

// An explicit local folder, never IndexedDB. Each atomic ZIP contains metadata and
// payload together, so a crash cannot leave a separately-indexed half item.
class FileStore {
  constructor(directory, namespace) {
    if (!directory) throw new Error('Choose an explicit local directory first');
    this.directory = path.resolve(directory);
    this.namespace = namespace;
  }
  async prepare(create = false) {
    const parts = this.directory.split(path.sep).filter(Boolean); let cursor = path.parse(this.directory).root;
    for (const part of parts) {
      cursor = path.join(cursor, part); let component;
      try {component = await fs.lstat(cursor);} catch (error) {if (create && error.code === 'ENOENT') break; throw error;}
      if (component.isSymbolicLink() && !(process.platform === 'darwin' && ['/tmp', '/var'].includes(cursor) &&
        await fs.realpath(cursor) === `/private${cursor}`)) throw new Error('Local store directory must not contain symlinks');
    }
    if (create) await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Local store directory must not be a symlink');
    // macOS /var and /tmp are system aliases. Resolve the chosen folder once;
    // item files themselves still require O_NOFOLLOW on every access.
    this.directory = await fs.realpath(this.directory);
  }
  itemPath(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('Store item ID must be a UUID, not a path');
    return path.join(this.directory, `${id}.${this.namespace}.zip`);
  }
  async save(type, name, payload, metadata = {}) {
    await this.prepare(true);
    if (!['project', 'sprite', 'block', 'costume', 'sound'].includes(type) || typeof name !== 'string' || !name || name.length > 512) throw new Error('Invalid local store item type/name');
    if (payload.length > MAX_PROJECT_BYTES) throw new Error(`Store item exceeds ${MAX_PROJECT_BYTES / 1024 / 1024} MiB`);
    const id = crypto.randomUUID(); const zip = new JSZip();
    const item = {version: 1, id, type, name, created: new Date().toISOString(), bytes: payload.length, sha256: sha256(payload), metadata};
    zip.file('item.json', JSON.stringify(item)); zip.file('payload', payload);
    const written = await atomicWrite(this.itemPath(id), await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
    return {...item, path: written.path};
  }
  async read(id) {
    await this.prepare(); const file = this.itemPath(id);
    const bytes = await readLocalFile(file);
    const zip = await checkedZip(bytes);
    if (Object.keys(zip.files).sort().join(',') !== 'item.json,payload' || zip.file('item.json')._data.uncompressedSize > 4 * 1024 * 1024 || Object.values(zip.files).some(entry => entry.dir ||
      entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name || entry._data.uncompressedSize > MAX_PROJECT_BYTES)) throw new Error('Invalid local store archive');
    const item = JSON.parse(await zip.file('item.json').async('string')); rejectPrototypeKeys(item); const payload = await zip.file('payload').async('nodebuffer');
    if (item.version !== 1 || item.id !== id || !['project', 'sprite', 'block', 'costume', 'sound'].includes(item.type) ||
      item.bytes !== payload.length || item.sha256 !== sha256(payload)) throw new Error('Local store metadata/payload checksum mismatch');
    return {item: {...item, path: file}, payload};
  }
  async list() {
    await this.prepare(); const suffix = `.${this.namespace}.zip`;
    const items = [];
    for (const name of (await fs.readdir(this.directory)).sort()) if (name.endsWith(suffix)) {
      const {item} = await this.read(name.slice(0, -suffix.length)); items.push(item);
    }
    return {directory: this.directory, items};
  }
}
module.exports = {LibraryStore, FileStore, kindName, assetName, verifyAsset, sha256, GUI_LIBRARY_HASHES};
