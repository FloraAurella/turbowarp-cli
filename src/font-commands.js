require('./native-environment');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {inflateSync} = require('node:zlib');
const {GlobalFonts} = require('@napi-rs/canvas');
const {resourceError} = require('./errors');

const MAX_FONT_BYTES = 8 * 1024 * 1024;
const FORMATS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const digest = (bytes, algorithm = 'md5') => crypto.createHash(algorithm).update(bytes).digest('hex');
const BUILTINS = [
  ['Sans Serif', 'NotoSans-Medium.woff2', '9cce1db2de3a3eca334114850dce8256', 'af01ec721b82baf79e15d53f9b946b51ceec09bdc5e255dc9592937ef8eab78a'],
  ['Serif', 'SourceSerifPro-Regular.woff2', 'cb5e60ece6f129af3dd79491ad33dd71', '0b5899f3dfa276d2e63b61d9df630d9a82df167624be9f0c262027d1334e53b4'],
  ['Handwriting', 'handlee-regular.woff2', '2d2ce9e9566ae040564b66197fba7e1a', '414180bc4775382ee7e7c890b8d7b6fcf87d75bd1a454aeb7318b2fae672a330'],
  ['Marker', 'Knewave.woff2', '7eed30bbb3d0fd19027e939e10c085f5', '4f43bba2c06bb0bd814ae7af5c71e5bc52ace78e1244d9fcff314ff710d7b5c4'],
  ['Curly', 'Griffy-Regular.woff2', '4292883a70ab74d2870e5252f32273bb', '865f77a7d5c711c3787d69b4c366213a65be4c3e65b7322fc27b1955ab6025c5'],
  ['Pixel', 'Grand9K-Pixel.woff2', '35f896164d1f0840b8409d4d92501cda', 'b21a730bb241ba8138879f9f8bc91226e3f9da684b53c30b8374c61908338d4c'],
  ['Scratch', 'ScratchSavers_b2.woff2', 'fbec79ccf31e57af8f51257fe8811d3c', 'abf9ee76b94a91c716119478bd87165ea4ec66c82ece817ed2d3730663bab389']
].map(([family, file, md5, sha256]) => Object.freeze({family, file, md5, sha256}));
const metadataCache = new Map();
const nativeFonts = new Map();
const acquireNativeFont = data => {
  const metadata = validateFontBytes(data);
  let record = nativeFonts.get(metadata.sha256);
  if (!record) {
    const alias = `twfont_${metadata.sha256}`;
    const registration = GlobalFonts.register(Buffer.from(data), alias);
    if (!registration) throw new Error('Native font registration failed');
    record = {alias, registration, references: 0, digest: metadata.sha256}; nativeFonts.set(metadata.sha256, record);
  }
  record.references++; return record;
};
const releaseNativeFont = record => {
  if (--record.references === 0) {GlobalFonts.remove(record.registration); nativeFonts.delete(record.digest);}
};
const validateFamily = family => {
  if (typeof family !== 'string' || !/^[-\w ]{1,100}$/.test(family) || !family.trim() || family.trim() !== family) throw new Error('Font family must be 1..100 letters/numbers/spaces/hyphens/underscores');
  return family;
};
const validateFallback = fallback => {
  if (typeof fallback !== 'string' || !fallback || fallback.length > 512 || !fallback.split(',').every(name =>
    /^[-\w ]+$/.test(name.trim()) || /^"[-\w ]+"$/.test(name.trim()) || /^'[-\w ]+'$/.test(name.trim()))) {
    throw new Error('Font fallback must be a plain comma-separated family list; CSS/URLs are denied');
  }
  return fallback;
};
const fontNames = bytes => {
  if (!bytes || bytes.length < 6) return [];
  const count = bytes.readUInt16BE(2), offset = bytes.readUInt16BE(4), names = [];
  if (6 + count * 12 > bytes.length || offset > bytes.length) throw new Error('Invalid font name table');
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12, platform = bytes.readUInt16BE(record), id = bytes.readUInt16BE(record + 6);
    const length = bytes.readUInt16BE(record + 8), start = offset + bytes.readUInt16BE(record + 10);
    if (start + length > bytes.length) throw new Error('Font name record exceeds table');
    if (![1, 2, 4, 6, 16].includes(id)) continue;
    const data = bytes.subarray(start, start + length);
    let text = '';
    if (platform === 0 || platform === 3) for (let j = 0; j + 1 < data.length; j += 2) text += String.fromCharCode(data.readUInt16BE(j));
    else text = data.toString('latin1');
    names.push({id, value: text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)});
  }
  return names.filter((name, i) => names.findIndex(other => other.id === name.id && other.value === name.value) === i);
};
const validateFontBytes = (input, expectedFormat) => {
  const bytes = Buffer.from(input);
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES) throw new Error('Font size must be 12 bytes..8 MiB');
  const signature = bytes.toString('latin1', 0, 4);
  const format = signature === 'wOF2' ? 'woff2' : signature === 'wOFF' ? 'woff' : signature === 'OTTO' ? 'otf' :
    bytes.readUInt32BE(0) === 0x00010000 || signature === 'true' ? 'ttf' : null;
  if (!format || expectedFormat && format !== expectedFormat.toLowerCase()) throw new Error('Unsupported or mismatched font signature (ttf/otf/woff/woff2 only)');
  const key = `${format}:${digest(bytes, 'sha256')}`;
  if (metadataCache.has(key)) return {...metadataCache.get(key)};
  let tableCount, tableNames = [], names = [];
  if (format === 'woff' || format === 'woff2') {
    const header = format === 'woff' ? 44 : 48;
    if (bytes.length < header || bytes.readUInt32BE(8) !== bytes.length || bytes.readUInt16BE(14) !== 0) throw new Error('Invalid WOFF length/header');
    tableCount = bytes.readUInt16BE(12);
    const expanded = bytes.readUInt32BE(16);
    if (!tableCount || tableCount > 256 || expanded < 12 || expanded > MAX_FONT_BYTES * 4) throw new Error('WOFF expanded size/table count exceeds limits');
    if (format === 'woff') {
      if (44 + tableCount * 20 > bytes.length) throw new Error('Invalid WOFF table directory');
      for (let i = 0; i < tableCount; i++) {
        const record = 44 + i * 20, tag = bytes.toString('ascii', record, record + 4);
        const start = bytes.readUInt32BE(record + 4), compressed = bytes.readUInt32BE(record + 8), original = bytes.readUInt32BE(record + 12);
        if (!compressed || compressed > original || start < 44 + tableCount * 20 || start + compressed > bytes.length || original > MAX_FONT_BYTES * 4) throw new Error('Invalid WOFF table bounds');
        tableNames.push(tag);
        if (tag === 'name') names = fontNames(compressed === original ? bytes.subarray(start, start + original) :
          inflateSync(bytes.subarray(start, start + compressed), {maxOutputLength: original}));
      }
    } else if (bytes.readUInt32BE(20) > bytes.length - 48) throw new Error('Invalid WOFF2 compressed bounds');
    for (const [offsetField, lengthField] of (format === 'woff' ? [[24, 28], [36, 40]] : [[28, 32], [40, 44]])) {
      const offset = bytes.readUInt32BE(offsetField), length = bytes.readUInt32BE(lengthField);
      if (offset && (offset < header || offset + length > bytes.length) || !offset && length) throw new Error('Invalid WOFF metadata/private bounds');
    }
  } else {
    tableCount = bytes.readUInt16BE(4);
    if (!tableCount || tableCount > 256 || 12 + tableCount * 16 > bytes.length) throw new Error('Invalid SFNT table directory');
    for (let i = 0; i < tableCount; i++) {
      const record = 12 + i * 16, tag = bytes.toString('ascii', record, record + 4);
      const offset = bytes.readUInt32BE(record + 8), length = bytes.readUInt32BE(record + 12);
      if (offset < 12 + tableCount * 16 || offset + length > bytes.length) throw new Error('Invalid SFNT table bounds');
      tableNames.push(tag); if (tag === 'name') names = fontNames(bytes.subarray(offset, offset + length));
    }
    if (!['head', 'maxp', 'cmap', 'name'].every(tag => tableNames.includes(tag))) throw new Error('Required SFNT font tables are missing');
  }
  if (new Set(tableNames).size !== tableNames.length) throw new Error('Duplicate font table');
  // Decode through the exact native font parser too. Do not trust extension,
  // MIME or just four magic bytes. Registration is private and removed here.
  const active = nativeFonts.get(digest(bytes, 'sha256'));
  if (!active) {
    const registration = GlobalFonts.register(bytes, `tw_validate_${crypto.randomUUID()}`);
    if (!registration) throw new Error('Native font parser rejected the font data');
    GlobalFonts.remove(registration);
  }
  const metadata = {format, bytes: bytes.length, md5: digest(bytes), sha256: digest(bytes, 'sha256'), tableCount, names, nativeDecoded: true};
  if (metadataCache.size < 128) metadataCache.set(key, Object.freeze(metadata));
  return {...metadata};
};
const readBuiltinFonts = () => {
  const directory = path.join(path.dirname(require.resolve('scratch-render-fonts/package.json')), 'src');
  // Never require scratch-render-fonts/src/index: its base64-loader entry writes
  // document styles. Read only the pinned binary files listed above.
  return BUILTINS.map(font => {
    const data = fs.readFileSync(path.join(directory, font.file));
    if (digest(data) !== font.md5 || digest(data, 'sha256') !== font.sha256) throw new Error(`Frozen builtin font hash mismatch: ${font.file}`);
    return {...font, data, metadata: validateFontBytes(data, 'woff2')};
  });
};
const parseFontCSS = (fonts = {}) => {
  if (!fonts || typeof fonts !== 'object' || Array.isArray(fonts) || Object.keys(fonts).length > 64) throw new Error('Font CSS map must contain at most 64 entries');
  let total = 0;
  return Object.entries(fonts).map(([familyList, rule]) => {
    if (typeof rule !== 'string' || rule.length > MAX_FONT_BYTES * 1.5) throw new Error('Font CSS exceeds size limit');
    const familyMatch = familyList.match(/^"([-\w ]+)", (.+)$/);
    if (!familyMatch) throw new Error('Font CSS family list is not a safe subset');
    const family = validateFamily(familyMatch[1]); validateFallback(familyMatch[2]);
    const match = rule.match(/^\s*@font-face\s*\{\s*font-family\s*:\s*"([-\w ]+)"\s*;\s*src\s*:\s*url\(\s*"(data:(?:font\/(?:ttf|otf|woff|woff2)|application\/(?:font-woff|x-font-ttf|x-font-opentype));base64,[A-Za-z0-9+/]*={0,2})"\s*\)\s*;\s*\}\s*$/);
    if (!match || match[1] !== family) throw new Error('Font CSS denied: only one binary data font @font-face rule is allowed');
    const encoded = match[2].split(',')[1], bytes = Buffer.from(encoded, 'base64');
    if (!encoded || bytes.toString('base64') !== encoded) throw new Error('Invalid canonical font base64');
    total += bytes.length; if (total > MAX_FONT_BYTES * 4) throw new Error('Total custom font data exceeds 32 MiB');
    // Frozen scratch-storage Font always emits MIME font/ttf even for WOFF2;
    // trust only the validated binary signature, never the declared MIME.
    return {family, fallback: familyMatch[2], data: bytes, metadata: validateFontBytes(bytes)};
  });
};
const validateProjectFonts = async (json, zip, findAsset) => {
  const fonts = json.customFonts;
  if (fonts === undefined || fonts === null) return;
  if (!Array.isArray(fonts) || fonts.length > 64) throw new Error('Project fonts must be an array of at most 64 entries');
  const families = new Set(); let total = 0;
  for (const font of fonts) {
    if (!font || typeof font.system !== 'boolean') throw new Error('Invalid project font metadata');
    validateFamily(font.family); validateFallback(font.fallback);
    if (families.has(font.family.toLowerCase())) throw new Error('Duplicate project font family'); families.add(font.family.toLowerCase());
    if (font.system) continue; // Portable rendering never enumerates system fonts.
    if (!/^[a-f0-9]{32}\.(ttf|otf|woff|woff2)$/.test(font.md5ext || '')) throw new Error('Invalid local font asset reference');
    const data = await findAsset(zip, font.md5ext).async('nodebuffer');
    const metadata = validateFontBytes(data, font.md5ext.split('.').pop());
    if (metadata.md5 !== font.md5ext.slice(0, 32)) throw new Error('Local font asset MD5 mismatch');
    total += data.length; if (total > MAX_FONT_BYTES * 4) throw new Error('Project fonts exceed 32 MiB');
  }
};

const specs = require('./command-catalog').moduleSpecs['font-commands.js'];
const requiresProject = (command, args) => args[0] !== 'builtins';
const isReadOnly = (command, args) => ['list', 'builtins', 'inspect', 'export', 'measure', 'render', 'load'].includes(args[0]);
const selectFont = (manager, selector) => {
  const matches = manager.fonts.filter((font, index) => font.family.toLowerCase() === String(selector).toLowerCase() || String(index) === String(selector));
  if (matches.length !== 1) throw resourceError(matches.length, 'Font not found or ambiguous', selector); return matches[0];
};
const summary = (font, index) => ({index, family: font.family, fallback: font.fallback, system: font.system,
  ...(font.asset ? {assetId: font.asset.assetId, md5ext: `${font.asset.assetId}.${font.asset.dataFormat}`, ...validateFontBytes(font.asset.data, font.asset.dataFormat)} :
    {portableSystemAccess: false, limitation: 'System fonts are metadata only; native SVG uses pinned fallback, not host font discovery'})});
const execute = async (session, command, args, options = {}) => {
  const definition = specs.font[args[0]];
  if (command !== 'font' || !definition || args.length - 1 < definition.min || args.length - 1 > definition.max ||
    Object.keys(options).some(option => !definition.options.includes(option))) throw new Error('Invalid font command/options');
  if (args[0] === 'builtins') return {fonts: BUILTINS.map(font => ({family: font.family, format: 'woff2', md5: font.md5, sha256: font.sha256})), noDOM: true};
  if (!session.project.vm) throw new Error('Open or create a project first');
  const manager = session.project.vm.runtime.fontManager, renderer = session.project.renderer;
  const [action, first, second, third] = args;
  if (action === 'list') return {fonts: manager.fonts.map(summary)};
  if (action === 'inspect') return summary(selectFont(manager, first), manager.fonts.indexOf(selectFont(manager, first)));
  if (action === 'load') {manager.updateRenderer(); return {loaded: manager.fonts.map(summary), noDOM: true};}
  if (action === 'reset') {manager.clear(); return {reset: true, fonts: []};}
  if (action === 'delete') {const font = selectFont(manager, first); manager.deleteFont(manager.fonts.indexOf(font)); return {deleted: font.family};}
  if (action === 'measure') return renderer.measureFontText(first, second, Number(options.size || 24));
  if (action === 'render') {
    if (third && options.output) throw new Error('Use positional output or --output, not both');
    const output = third || options.output; if (!output || path.extname(output).toLowerCase() !== '.png') throw new Error('Font render output must end in .png');
    const bytes = renderer.fontPreview(first, second, {size: Number(options.size || 24), width: Number(options.width || 320), height: Number(options.height || 80)});
    return require('./project').atomicWrite(output, bytes, options.force);
  }
  if (action === 'export') {
    const font = selectFont(manager, first); if (!font.asset) throw new Error('System font metadata has no binary asset to export');
    if (second && options.output) throw new Error('Use positional output or --output, not both');
    const output = second || options.output;
    if (!output || path.extname(output).slice(1).toLowerCase() !== font.asset.dataFormat) throw new Error('Font export extension must match binary format');
    return require('./project').atomicWrite(output, Buffer.from(font.asset.data), options.force);
  }
  const fallback = validateFallback(options.fallback || 'sans-serif');
  if (action === 'system') {validateFamily(first); manager.addSystemFont(first, fallback); return summary(selectFont(manager, first), manager.fonts.length - 1);}
  let family, bytes, format;
  if (['builtin', 'add-builtin'].includes(action)) {
    const builtin = readBuiltinFonts().find(font => font.family.toLowerCase() === first.toLowerCase());
    if (!builtin) throw new Error('Unknown frozen builtin font'); family = second || builtin.family; bytes = builtin.data; format = 'woff2';
  } else {
    family = first;
    const filename = second; format = path.extname(filename).slice(1).toLowerCase();
    if (!FORMATS.has(format)) throw new Error('Font file must end in .ttf/.otf/.woff/.woff2');
    bytes = await require('./project').readLocalFile(filename, MAX_FONT_BYTES);
  }
  validateFamily(family);
  if (!manager.isValidCustomFont(family)) throw new Error('Custom font family is restricted');
  const metadata = validateFontBytes(bytes, format);
  const storage = session.project.vm.runtime.storage;
  const asset = storage.createAsset(storage.AssetType.Font, format, new Uint8Array(bytes), null, true);
  manager.addCustomFont(family, fallback, asset);
  return {family, fallback, assetId: asset.assetId, ...metadata};
};
module.exports = {specs, requiresProject, isReadOnly, execute, usesProjectTarget: false, booleanOptions: ['force'],
  BUILTINS, MAX_FONT_BYTES, validateFontBytes, validateFamily, validateFallback, validateProjectFonts, readBuiltinFonts, parseFontCSS, acquireNativeFont, releaseNativeFont};
