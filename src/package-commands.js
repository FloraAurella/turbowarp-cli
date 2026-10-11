'use strict';
require('./native-environment');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const {createHash} = require('node:crypto');
const Packager = require('@turbowarp/packager');
const JSZip = require('@turbowarp/jszip');
const {MAX_PROJECT_BYTES, MAX_EXPANDED_PROJECT_BYTES} = require('./project-limits');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const {parseDOM} = require('htmlparser2');
const serialize = require('dom-serializer');
const permission = require('./permission-policy');
const network = require('./network-policy');
const specs = require('./command-catalog').moduleSpecs['package-commands.js'];
const VERSION = '3.13.0';
const DIST = path.dirname(require.resolve('@turbowarp/packager'));
const BUNDLE_SHA256 = '3618dbbca2f1ed3ae6949291df0a48b16df7a09a641d7012a9870bd5dd080b95';
const LARGE_ASSETS = Object.freeze(Object.fromEntries([
  ['nwjs-win64', 'nwjs-v0.68.1-win-x64.zip', '82527d29f060bad7ec041f7c0536b1376f8bad5e5584adf7e3cf7205755a106c'],
  ['nwjs-win32', 'nwjs-v0.68.1-win-ia32.zip', '7dd3104c2726082a8acd8973af2b2b223bc97960b722ec141b9bf07d84a0281b'],
  ['nwjs-mac', 'nwjs-v0.68.1-osx-x64.zip', '4b1356302738a45f7ee212f6ecb997eb5d31403bfc45a7dd58429c968a1f581a'],
  ['nwjs-linux-x64', 'nwjs-v0.68.1-linux-x64.zip', '5f597add1a2b6f13592117cc955111cea8211c13b21165e29c6616f385df5b94'],
  ['electron-win32', 'electron-v22.3.27-win32-ia32.zip', '47bd498e5513529c5e141394fc9fd610cba1dcdea9e6dbb165edf929cbfd9af2'],
  ['electron-win64', 'electron-v22.3.27-win32-x64.zip', '1a02c0f7af9664696f790dcce05948f0458a2f4f2d48c685f911d2eb99a4c9da'],
  ['electron-win-arm', 'electron-v22.3.27-win32-arm64.zip', '0e4ad218018c0881ef4de363107a94dd2ced40367a0e18ca7d0dde1f40da0531'],
  ['electron-mac', 'electron-v22.3.27-macos-universal.zip', '598b35f9030fe30f81b4041be048cd0374f675bd1bc0f172c26cf2808e80a3d9'],
  ['electron-linux64', 'electron-v22.3.27-linux-x64.zip', '631d8eb08098c48ce2b29421e74c69ac0312b1e42f445d8a805414ba1242bf3a'],
  ['electron-linux-arm32', 'electron-v22.3.27-linux-armv7l.zip', '9f8372606e5ede83cf1c73a3d8ff07047e4e3ef614aa89a76cd497dc06cf119d'],
  ['electron-linux-arm64', 'electron-v22.3.27-linux-arm64.zip', '60279395a5ce4eaf3c08f1e717771b203830902d3fe3a7c311bc37deb1a0e15e'],
  ['webview-mac', 'WebView-macos-7.zip', 'fef0603a17df6dd976eb2aeb704aaec6d2666455089fbf3398becfaf5b29448b'],
  ['steamworks.js', 'steamworks.js-0.3.2.zip', 'fd8bc80a97cd880d71113dfc5f81b124b6e212335393db73e3df168c5c546fbc']
].map(([id, filename, sha256]) => [id, Object.freeze({filename, sha256,
  urls: Object.freeze([`https://packagerdata.turbowarp.org/${filename}`, `https://blobs.turbowarp.xyz/${filename}`])})])));
const LOCAL_ASSETS = Object.freeze({
  scaffolding: ['scaffolding-full.js', 'cfe51b7bfa293d6047ed9c305f21fbc34a99abf3099d646f1ab3f25588a80a28'],
  'scaffolding-min': ['scaffolding-min.js', '198cc472feabc376fa919d0ce7f24f19af22b41517675d9f19265dabc6841747'],
  addons: ['addons.js', '7b3040f71caa51456f54bc99e0a8d175d998259f287018a321798dad84b3dbe4']
});
const TARGETS = Object.freeze(['html', 'zip', 'zip-one-asset', ...Object.keys(LARGE_ASSETS).filter(id => id !== 'steamworks.js')]);
const IMAGE_KEYS = new Set(['app.icon', 'cursor.custom', 'loadingScreen.image']);
// Exact eight E([...]) partial resets from frozen standalone.html:230.
// Display clears its icon/loading image stores; cursor clears custom image.
const RESET_GROUPS = Object.freeze(Object.fromEntries(Object.entries({
  runtime: ['turbo', 'framerate', 'interpolation', 'highQualityPen', 'maxClones', 'fencing', 'miscLimits', 'stageWidth', 'stageHeight', 'resizeMode', 'username'],
  appearance: ['app.windowTitle', 'app.icon', 'loadingScreen', 'autoplay', 'controls', 'appearance', 'monitors'],
  input: ['cursor', 'chunks'], cloud: ['cloudVariables'],
  advanced: ['compiler', 'extensions', 'bakeExtensions', 'custom', 'projectId', 'maxTextureDimension'],
  target: ['target'], app: ['app.packageName', 'app.windowMode', 'app.escapeBehavior', 'app.backgroundThrottling'],
  steamworks: ['steamworks']
}).map(([name, fields]) => [name, Object.freeze(fields)])));
const ENUMS = Object.freeze({
  target: TARGETS, resizeMode: ['preserve-ratio', 'stretch', 'dynamic-resize'],
  'loadingScreen.imageMode': ['normal', 'stretch'], 'app.windowMode': ['window', 'maximize', 'fullscreen'],
  'app.escapeBehavior': ['unfullscreen-only', 'exit-only', 'unfullscreen-or-exit', 'nothing'],
  'app.windowControls': ['default', 'frameless'], 'cloudVariables.mode': ['ws', 'local', 'none', 'custom'],
  'steamworks.onError': ['ignore', 'warning', 'error'],
  'cursor.type': ['auto', 'default', 'none', 'custom', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair',
    'text', 'vertical-text', 'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll',
    'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize',
    'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'zoom-in', 'zoom-out']
});
const NUMBERS = Object.freeze({framerate: [1, 1000, false], maxClones: [0, 9999999999, true], stageWidth: [1, 8192, true],
  stageHeight: [1, 8192, true], maxTextureDimension: [1, 16384, true], 'cursor.center.x': [0, 8192, true], 'cursor.center.y': [0, 8192, true]});
const upstreamDefaults = () => new Packager.Packager().options;
const defaults = () => {
  const settings = upstreamDefaults();
  // D3: retain cloud variable semantics locally, never silently map desktop's
  // local JSON provider to a public WebSocket cloud service.
  settings.cloudVariables.mode = 'local';
  settings.cloudVariables.cloudHost = '';
  return settings;
};
const plainObject = value => value && !Array.isArray(value) && typeof value === 'object';
const leaves = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
  const name = prefix ? `${prefix}.${key}` : key;
  return plainObject(child) && name !== 'cloudVariables.custom' ? leaves(child, name) : [name];
});
const OPTION_KEYS = Object.freeze(leaves(upstreamDefaults()));
const keyParts = name => {
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z\d]*(?:\.[a-zA-Z][a-zA-Z\d]*)*$/.test(name) ||
    name.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('拒绝 prototype/path traversal 选项路径');
  const parts = name.split('.');
  let value = upstreamDefaults();
  for (const part of parts) {
    if (!plainObject(value) || !Object.hasOwn(value, part)) throw new Error('未知打包选项：' + name);
    value = value[part];
  }
  return parts;
};
const getAt = (settings, name) => keyParts(name).reduce((object, key) => object[key], settings);
const putAt = (settings, name, value) => {
  const parts = keyParts(name), last = parts.pop();
  parts.reduce((object, key) => object[key], settings)[last] = structuredClone(value);
};
const validateLeaf = (name, value) => {
  permission.assertData(value);
  const expected = getAt(upstreamDefaults(), name);
  if (IMAGE_KEYS.has(name)) {
    if (value === null) return;
    if (!plainObject(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'file')) throw new Error(`${name} 需要 null 或 {"file":"本地图片路径"}`);
    permission.assertLocalPath(value.file); return;
  }
  if (name === 'extensions') {
    if (!Array.isArray(value) || value.length > 100 || !value.every(item => typeof item === 'string')) throw new Error('extensions 必须是最多100项URL字符串数组');
    if (new Set(value).size !== value.length) throw new Error('extensions 不能重复');
    for (const url of value) permission.safeURL(url, ['https:']);
    return;
  }
  if (name === 'cloudVariables.custom') {
    if (!plainObject(value) || Object.keys(value).length > 1000) throw new Error('cloudVariables.custom 必须是变量名→ws/local/none 的对象');
    for (const [key, mode] of Object.entries(value)) {
      if (!key || key.length > 256 || /[\x00-\x1f\x7f]|<\/(?:script|style)(?:[\s/>])/i.test(key) || !['ws', 'local', 'none'].includes(mode)) throw new Error('cloudVariables.custom 值只能是 ws/local/none');
    }
    return;
  }
  if (typeof value !== typeof expected || value === null) throw new Error(`${name} 类型应为 ${typeof expected}；不自动转换`);
  if (Object.hasOwn(ENUMS, name) && !ENUMS[name].includes(value)) throw new Error(`${name} 只能是 ${ENUMS[name].join('/')}`);
  if (Object.hasOwn(NUMBERS, name)) {
    const [min, max, integer] = NUMBERS[name];
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`${name} 必须为 ${min}..${max} 的${integer ? '整数' : '有限数字'}`);
  }
  if (typeof value !== 'string') return;
  if (value.length > (name.startsWith('custom.') ? 1024 * 1024 : 8192) || /\x00/.test(value)) throw new Error(name + ' 字符串超限/含NUL');
  if (['appearance.background', 'appearance.foreground', 'appearance.accent', 'monitors.variableColor', 'monitors.listColor'].includes(name) && !/^#[\da-f]{6}$/i.test(value)) throw new Error(name + ' 必须是 #rrggbb，不允许CSS注入');
  if (name === 'app.packageName' && (!/^[a-zA-Z\d][a-zA-Z\d_-]{0,99}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value))) throw new Error('app.packageName 必须是安全ASCII单段名称；拒绝 traversal/Windows保留名');
  if (name === 'app.version' && !/^\d+\.\d+\.\d+(?:-[a-zA-Z\d.-]+)?$/.test(value)) throw new Error('app.version 需要三段版本号');
  if (name === 'steamworks.appId' && !/^\d{1,10}$/.test(value)) throw new Error('steamworks.appId 必须是十进制ID字符串');
  if (name === 'cloudVariables.cloudHost' && value !== '') permission.safeURL(value, ['wss:', 'ws:']);
  if ((name.startsWith('custom.') || ['username', 'projectId'].includes(name)) && /<\/(?:script|style)(?:[\s/>])/i.test(value)) throw new Error(name + ' 不允许结束HTML标签注入');
};
const merge = (settings, patch, prefix = '') => {
  if (!plainObject(patch)) throw new Error('config/import 必须是普通JSON对象');
  permission.assertData(patch);
  for (const [key, value] of Object.entries(patch)) {
    const name = prefix ? `${prefix}.${key}` : key;
    keyParts(name);
    const original = getAt(upstreamDefaults(), name);
    if (plainObject(original) && name !== 'cloudVariables.custom') {
      if (!plainObject(value)) throw new Error(name + ' 必须是嵌套JSON对象');
      merge(settings, value, name);
    } else {validateLeaf(name, value); putAt(settings, name, value);}
  }
  return settings;
};
const validateSettings = settings => {
  // A freshly complete object is required: never let unknown/inherited state
  // from callers reach upstream options or their generated code.
  const normalized = merge(defaults(), settings);
  for (const name of OPTION_KEYS) validateLeaf(name, getAt(normalized, name));
  if (normalized.stageWidth * normalized.stageHeight > 16000000) throw new Error('舞台最多1600万像素');
  return normalized;
};
const settingsFor = session => validateSettings(session.packagerSettings || defaults());
const authorizeSettings = (settings, p, {build = false} = {}) => {
  if (settings.custom.js) p.require('custom-js');
  if (settings.custom.css) p.require('custom-css');
  if (settings.extensions.length) {
    p.require('extension-code');
    for (const url of settings.extensions) p.require('net', permission.safeURL(url, ['https:']).hostname);
  }
  const cloud = settings.cloudVariables;
  const ws = cloud.mode === 'ws' || cloud.mode === 'custom' && Object.values(cloud.custom).includes('ws');
  // An explicit cloudHost config is itself sensitive, even if currently unused.
  if (cloud.cloudHost || ws) {
    p.require('cloud-network');
    if (!cloud.cloudHost) throw new Error('ws 云模式需要显式 cloudVariables.cloudHost');
    const url = permission.safeURL(cloud.cloudHost, ['wss:', 'ws:']);
    p.require('net', url.hostname);
    if (url.href.replace(/\/$/, '') === 'wss://clouddata.turbowarp.org') p.require('net', 'clouddata.turbowarp.xyz');
  }
  if (cloud.unsafeCloudBehaviors) p.require('unsafe-cloud');
  if (settings.chunks.gamepad) p.require('gamepad');
  if (settings.chunks.pointerlock) p.require('pointerlock');
  if (build && settings.cursor.type === 'custom' && !settings.cursor.custom) throw new Error('custom cursor 需要 cursor.custom 图片文件');
};
const readJSONValue = (name, text) => {
  const expected = getAt(upstreamDefaults(), name);
  if (IMAGE_KEYS.has(name)) return text === 'null' ? null : text.startsWith('{') ? permission.parseJSON(text) : {file: text};
  if (typeof expected === 'string') return text.startsWith('"') ? permission.parseJSON(text) : text;
  return permission.parseJSON(text);
};
const applySet = (settings, name, text) => {
  const value = readJSONValue(name, text), original = getAt(upstreamDefaults(), name);
  if (plainObject(original) && name !== 'cloudVariables.custom') {
    const patch = {}, parts = keyParts(name), last = parts.pop();
    let cursor = patch;
    for (const key of parts) cursor = cursor[key] = {};
    cursor[last] = value;
    return merge(settings, patch);
  }
  validateLeaf(name, value); putAt(settings, name, value); return settings;
};

// SVG is decoded only after a small geometry-only allowlist pass. No external
// references, text/fonts, CSS, entity, data URI, or executable/animation nodes.
const checkSVG = text => {
  if (/<!|<\?(?!xml\s)|[\x00]/i.test(text)) throw new Error('拒绝SVG实体/DTD/活动资源');
  const nodes = parseDOM(text, {xmlMode: true, decodeEntities: true});
  const roots = nodes.filter(node => node.name);
  if (roots.length !== 1 || roots[0].name !== 'svg') throw new Error('SVG根无效');
  const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'title', 'desc']);
  const attrs = new Set(['xmlns', 'width', 'height', 'viewBox', 'id', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'clip-path']);
  const pending = [...nodes]; let count = 0;
  while (pending.length) {
    const node = pending.pop();
    if (++count > 10000) throw new Error('SVG节点超限');
    if (node.name && !tags.has(node.name)) throw new Error('拒绝SVG外部/可执行节点：' + node.name);
    for (const [name, value] of Object.entries(node.attribs || {})) {
      if (!attrs.has(name) || /[<>"'\\@]|(?:https?|file|data|javascript):/i.test(value) && name !== 'xmlns') throw new Error('拒绝SVG外部/活动属性');
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') throw new Error('SVG namespace 无效');
      if (/url\s*\(/i.test(value) && !/^url\(#[a-zA-Z\d_-]+\)$/i.test(value)) throw new Error('拒绝SVG资源URL');
    }
    pending.push(...(node.children || []));
  }
  const dimension = name => {
    const value = roots[0].attribs[name];
    if (!/^\d+(?:\.\d+)?(?:px)?$/.test(value || '')) throw new Error('SVG图片须指定有限width/height');
    return Number(value.replace(/px$/, ''));
  };
  return [dimension('width'), dimension('height')];
};
const imageBytes = async bytes => {
  let width, height, mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.length >= 24) {
    if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG IHDR 无效');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mime = 'image/png';
  } else if (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a') {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); mime = 'image/gif';
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 255) throw new Error('JPEG marker 无效');
      const marker = bytes[offset + 1], size = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break;}
      if (size < 2 || offset + size + 2 > bytes.length) throw new Error('JPEG segment 无效');
      offset += size + 2;
    }
    mime = 'image/jpeg';
  } else {
    const text = bytes.toString('utf8');
    if (!/^\s*(?:<\?xml[^?]*\?>\s*)?<svg[\s>]/.test(text)) throw new Error('拒绝图片格式：只支持真实PNG/JPEG/GIF及安全几何SVG');
    [width, height] = checkSVG(text); mime = 'image/svg+xml';
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 16000000 || width > 8192 || height > 8192) throw new Error('图片尺寸无效/超过1600万像素');
  const image = await loadImage(bytes);
  if (!image.width || !image.height || image.width * image.height > 16000000) throw new Error('图片解码无效');
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  const png = canvas.toBuffer('image/png');
  return {image: new Packager.Image('image/png', png), originalMime: mime, width: image.width, height: image.height,
    sourceSHA256: permission.sha256(bytes), pngSHA256: permission.sha256(png)};
};
const materializeImages = async (settings, p) => {
  const reports = [];
  for (const name of IMAGE_KEYS) {
    const descriptor = getAt(settings, name);
    if (!descriptor) continue;
    const bytes = await permission.readFile(p, descriptor.file, {maxBytes: 16 * 1024 * 1024});
    const result = await imageBytes(bytes);
    const parts = keyParts(name), last = parts.pop();
    parts.reduce((object, key) => object[key], settings)[last] = result.image;
    const {image, ...report} = result;
    reports.push({option: name, file: permission.assertLocalPath(descriptor.file), ...report});
  }
  return reports;
};
const validateArchive = async (bytes, {maxExpanded = 1024 * 1024 * 1024} = {}) => {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0, count = 0;
  for (const file of Object.values(zip.files)) {
    const name = file.unsafeOriginalName || file.name;
    if (!name || name.includes('\\') || name.split('/').includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\x00-\x1f\x7f]/.test(name)) throw new Error('拒绝 ZIP archive path traversal');
    total += file._data?.uncompressedSize || 0;
    if (++count > 100000 || total > maxExpanded) throw new Error('ZIP 展开大小/条目超限');
    if ((file.unixPermissions & 0o170000) === 0o120000) {
      // Preserve known official relative symlinks as ZIP entries, never extract
      // or follow them. Ensure their eventual resolution stays inside ZIP root.
      const target = await file.async('string');
      if (target.includes('\\') || path.posix.isAbsolute(target) || /^[a-z]:/i.test(target) || /[\x00-\x1f\x7f]/.test(target)) throw new Error('拒绝不安全 ZIP symlink');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      if (resolved === '..' || resolved.startsWith('../')) throw new Error('拒绝逃逸 ZIP symlink');
    }
  }
  return zip;
};
const downloadAsset = async (id, p, cache) => {
  if (!Object.hasOwn(LARGE_ASSETS, id)) throw new Error('未知官方下载资产：' + id);
  const asset = LARGE_ASSETS[id];
  if (!cache) return p.deny('write', null, '官方target下载必须显式 --cache 本地目录', 'ERR_CACHE_REQUIRED');
  const allowed = asset.urls.filter(url => p.grants.some(grant => grant.id === 'net' && grant.resource === new URL(url).hostname));
  if (!allowed.length) return p.deny('net', 'packagerdata.turbowarp.org', '官方下载必须显式 --allow net:packagerdata.turbowarp.org 或 net:blobs.turbowarp.xyz');
  p.require('net', new URL(allowed[0]).hostname);
  let root;
  try {root = await permission.safePath(cache, {directory: true, missing: true});}
  catch (error) {return p.deny('write', cache, error.message, error.code);}
  // --cache explicitly authorizes only the fixed digest files in this directory.
  const filename = path.join(root, `${asset.sha256}.zip`);
  let bytes;
  try {bytes = await permission.readFile(p, filename, {explicit: true, maxBytes: 256 * 1024 * 1024});}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  let cached = !!bytes;
  if (!bytes) {
    let failure;
    for (const url of allowed) {
      try {bytes = await network.fetchBytes(url, p); break;} catch (error) {failure = error;}
    }
    if (!bytes) throw failure;
  }
  if (permission.sha256(bytes) !== asset.sha256) throw new Error('官方下载/缓存 SHA-256 不匹配；拒绝使用：' + id);
  await validateArchive(bytes);
  if (!cached) {
    try {await permission.writeFile(p, filename, bytes, {explicit: true});}
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await permission.readFile(p, filename, {explicit: true, maxBytes: 256 * 1024 * 1024});
      if (permission.sha256(existing) !== asset.sha256) throw new Error('并发缓存 SHA-256 不匹配');
      cached = true;
    }
  }
  return {data: bytes, id, path: filename, bytes: bytes.length, sha256: asset.sha256, cached};
};
const nativeICNS = async bytes => {
  const {Icns, IcnsImage} = require('@fiahfy/icns');
  const image = await loadImage(Buffer.from(bytes));
  const result = new Icns();
  for (const [type, size] of [['ic04', 16], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
    if (size !== 16 && size > image.width) continue;
    const canvas = createCanvas(size, size); canvas.getContext('2d').drawImage(image, 0, 0, size, size);
    result.append(IcnsImage.fromPNG(canvas.toBuffer('image/png'), type));
  }
  return result.data;
};
const xmlEscape = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[character]));
const updatePlist = async (zip, name, properties) => {
  const file = zip.file(name); if (!file) throw new Error('官方包缺少 plist：' + name);
  const source = await file.async('string');
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source)) throw new Error('拒绝 plist 实体');
  const nodes = parseDOM(source.replace(/<\?xml[^?]*\?>|<!DOCTYPE[^>]*>/g, ''), {xmlMode: true, decodeEntities: true});
  const plist = nodes.find(node => node.name === 'plist'), dict = plist?.children.find(node => node.name === 'dict');
  if (!dict) throw new Error('plist 主字典无效');
  const elements = dict.children.filter(node => node.name);
  if (elements.length % 2) throw new Error('plist 字典键值不匹配');
  for (let i = 0; i < elements.length; i += 2) if (elements[i].name !== 'key') throw new Error('plist key 无效');
  for (const [key, value] of Object.entries(properties)) {
    const replacement = parseDOM(`<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`, {xmlMode: true, decodeEntities: true});
    const index = elements.findIndex((node, i) => i % 2 === 0 && node.children.map(child => child.data || '').join('') === key);
    if (index < 0) elements.push(...replacement); else elements.splice(index, 2, ...replacement);
  }
  dict.children = elements;
  zip.file(name, '<?xml version="1.0" encoding="UTF-8"?>\n' + serialize(plist, {xmlMode: true, decodeEntities: true}));
};
let adaptedPackager;
const packagerAPI = async target => {
  const bundle = await fs.readFile(path.join(DIST, 'packager.js'));
  if (permission.sha256(bundle) !== BUNDLE_SHA256 || require('@turbowarp/packager/package.json').version !== VERSION) throw new Error('冻结Packager版本/SHA-256已变化；拒绝适配');
  if (!['nwjs-mac', 'electron-mac', 'webview-mac'].includes(target)) return Packager;
  if (!adaptedPackager) {
    // Compile only the hash-pinned trusted upstream library, not project/custom
    // code. Three browser ICNS calls are replaced by the native image adapter.
    let source = bundle.toString('utf8');
    for (const variable of ['d', 'g', 'i']) {
      const seam = `await b(${variable})`;
      if (source.split(seam).length !== 2) throw new Error('冻结ICNS适配边界已变化');
      source = source.replace(seam, `await this.nativeICNS(${variable})`);
    }
    const filename = path.join(DIST, 'packager.js');
    const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(DIST);
    compiled._compile(source, filename); adaptedPackager = compiled.exports;
  }
  return adaptedPackager;
};
const extensionURLs = async (settings, p) => {
  if (!settings.bakeExtensions) return settings.extensions;
  const result = [];
  for (const url of settings.extensions) {
    // Unlike upstream's catch-and-continue, failed downloads never silently leave
    // a remote extension in a supposedly offline package.
    const bytes = await network.fetchBytes(url, p, {maxBytes: 4 * 1024 * 1024});
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    result.push(`data:text/javascript;,${encodeURIComponent(`(function(Scratch) { ${text} })(Scratch);`)}`);
  }
  return result;
};
const preflight = async (session, command, args, options = {}) => {
  permission.validateInvocation(specs, command, args, options);
  const p = permission.createPolicy(session, options, `${command} ${args[0]} preflight`);
  if (!['build', 'preview'].includes(args[0])) return;
  if (args[1] && options.output) throw new Error('产物用positional或--output，不能同时指定');
  const output = args[1] || options.output;
  if (!output) throw new Error('缺少包输出路径');
  try {await permission.safePath(output, {missing: true});}
  catch (error) {return p.deny('write', output, error.message, error.code);}
  let settings = settingsFor(session);
  if (options.opt) {
    const index = options.opt.indexOf('=');
    if (index < 1) throw new Error('--opt 需要 完整选项路径=值');
    settings = applySet(settings, options.opt.slice(0, index), options.opt.slice(index + 1));
  }
  if (options.target) settings.target = options.target;
  if (args[0] === 'preview') settings.target = 'html';
  else if (!options.target && settings.target === 'html' && path.extname(output).toLowerCase() === '.zip') settings.target = 'zip';
  settings = validateSettings(settings);
  authorizeSettings(settings, p, {build: true});
  if (path.extname(output).toLowerCase() !== (settings.target === 'html' ? '.html' : '.zip')) throw new Error('输出后缀必须匹配html/.zip目标');
  if (Object.hasOwn(LARGE_ASSETS, settings.target)) {
    if (!options.cache) p.deny('write', null, '桌面target需要显式 --cache 目录', 'ERR_CACHE_REQUIRED');
    if (!p.grants.some(grant => grant.id === 'net' && ['packagerdata.turbowarp.org', 'blobs.turbowarp.xyz'].includes(grant.resource))) p.require('net', 'packagerdata.turbowarp.org');
  }
  if (options.cache) {
    try {await permission.safePath(options.cache, {directory: true, missing: true});}
    catch (error) {return p.deny('write', options.cache, error.message, error.code);}
  }
  for (const key of IMAGE_KEYS) {
    const descriptor = getAt(settings, key);
    if (descriptor) {
      p.require('read', permission.assertLocalPath(descriptor.file));
      try {await permission.safePath(descriptor.file);} catch (error) {return p.deny('read', descriptor.file, error.message, error.code);}
    }
  }
  if (options.project) {
    let full;
    try {full = permission.assertLocalPath(options.project); await permission.safePath(full);}
    catch (error) {return p.deny('read', options.project, error.message, error.code);}
    p.require('read', full, {explicit: true});
  }
};
const build = async (session, args, options, p) => {
  const positional = args[1];
  if (positional && options.output) throw new Error('产物用 positional 路径或 --output，不能同时指定；--out 保留项目持久化');
  const output = positional || options.output;
  if (!output) throw new Error('缺少包输出路径：pack build 输出.html 或 --output 输出.zip');
  let full;
  try {full = permission.assertLocalPath(output); await permission.safePath(full, {missing: true});}
  catch (error) {return p.deny('write', output, error.message, error.code);}
  let settings = settingsFor(session);
  if (options.opt) {
    const equals = options.opt.indexOf('=');
    if (equals < 1) throw new Error('--opt 需要 完整选项路径=值');
    settings = applySet(settings, options.opt.slice(0, equals), options.opt.slice(equals + 1));
  }
  if (options.target) settings.target = options.target;
  if (args[0] === 'preview') settings.target = 'html';
  else if (!options.target && settings.target === 'html' && path.extname(full).toLowerCase() === '.zip') settings.target = 'zip';
  settings = validateSettings(settings);
  if (path.extname(full).toLowerCase() !== (settings.target === 'html' ? '.html' : '.zip')) throw new Error('html目标输出必须.html；其他所有目标必须.zip');
  authorizeSettings(settings, p, {build: true});
  // Preflight sensitive target requirements before serializing project/images.
  if (Object.hasOwn(LARGE_ASSETS, settings.target)) {
    if (!options.cache) p.deny('write', null, '桌面target需要显式 --cache 目录', 'ERR_CACHE_REQUIRED');
    if (!p.grants.some(grant => grant.id === 'net' && ['packagerdata.turbowarp.org', 'blobs.turbowarp.xyz'].includes(grant.resource))) p.require('net', 'packagerdata.turbowarp.org');
  }
  if (!session.project?.vm || typeof session.snapshot !== 'function') throw new Error('先打开项目或 --project 项目.sb3');
  const source = Buffer.from(await session.snapshot());
  if (source.length > MAX_PROJECT_BYTES) throw new Error(`打包项目输入超过${MAX_PROJECT_BYTES / 1024 / 1024}MiB`);
  const archive = await validateArchive(source, {maxExpanded: MAX_EXPANDED_PROJECT_BYTES});
  if (!archive.file('project.json')) throw new Error('打包输入缺少project.json');
  // Project lists legitimately exceed command/config array sizes. This SB3 has
  // already passed archive and Project validation; retain the official list cap.
  const sourceJSON = permission.parseJSON(await archive.file('project.json').async('string'), {maxArray: 200000, maxBytes: 32 * 1024 * 1024});
  if (sourceJSON.extensionURLs && Object.keys(sourceJSON.extensionURLs).length) p.deny('extension-execute', null, '项目内自定义扩展未支持安全执行；不能绕过Project安全加载门');
  if (Array.isArray(sourceJSON.extensions) && sourceJSON.extensions.some(id => ['videoSensing', 'Gamepad'].includes(id))) p.deny('extension-execute', null,
    '未支持数据扩展打包转换 missing-data-provider-conversion：CLI预录videoSensing/Gamepad不能降格为产物实时摄像头/缺失opcode；这是未完产品能力');
  if (!Array.isArray(sourceJSON.extensions) || sourceJSON.extensions.some(id => !['pen', 'music'].includes(id))) p.deny('extension-execute', null, '打包项目只批准冻结pen/music扩展');
  if (!Array.isArray(sourceJSON.targets) || !sourceJSON.targets.some(target => target.isStage)) throw new Error('打包项目缺少舞台');
  // @turbowarp/sbdl otherwise fetches missing SB3 assets implicitly. Prove all
  // referenced bytes are local before invoking loadProject, even without the
  // process-wide network policy installed by the CLI entrypoint.
  const checkedAssets = new Set();
  for (const target of sourceJSON.targets) for (const asset of [...(target.costumes || []), ...(target.sounds || [])]) {
    const name = asset.md5ext || `${asset.assetId}.${asset.dataFormat}`;
    if (!/^[a-f\d]{32}\.(?:svg|png|jpe?g|gif|bmp|wav|mp3)$/i.test(name) || !archive.file(name)) {
      p.deny('net', 'assets.scratch.mit.edu', '拒绝隐式资产下载：SB3必须包含合法本地资产 ' + name);
    }
    if (!checkedAssets.has(name)) {
      const bytes = await archive.file(name).async('nodebuffer');
      if (createHash('md5').update(bytes).digest('hex') !== name.slice(0, 32).toLowerCase()) throw new Error('打包资产MD5不匹配：' + name);
      checkedAssets.add(name);
    }
  }
  const images = await materializeImages(settings, p);
  const API = await packagerAPI(settings.target);
  const packager = new API.Packager();
  const imageClass = API.Image;
  if (API !== Packager) for (const key of IMAGE_KEYS) {
    const image = getAt(settings, key);
    if (image) {
      const parts = keyParts(key), last = parts.pop();
      parts.reduce((object, part) => object[part], settings)[last] = new imageClass(image.mimeType, image.readAsBuffer());
    }
  }
  packager.project = await Packager.loadProject(source);
  Object.assign(packager.options, settings);
  packager.nativeICNS = nativeICNS;
  packager.updatePlist = function (zip, name, properties) {return updatePlist(zip, name, properties);};
  const downloads = [];
  packager.fetchLargeAsset = async (id, type) => {
    packager.ensureNotAborted();
    if (Object.hasOwn(LOCAL_ASSETS, id)) {
      const [filename, digest] = LOCAL_ASSETS[id];
      const bytes = await fs.readFile(path.join(DIST, 'scaffolding', filename));
      if (permission.sha256(bytes) !== digest) throw new Error('冻结本地scaffolding SHA-256不匹配');
      return type === 'text' ? bytes.toString('utf8') : bytes;
    }
    const result = await downloadAsset(id, p, options.cache);
    const {data, ...report} = result; downloads.push(report); return data;
  };
  const urls = await extensionURLs(settings, p);
  packager.generateExtensionURLs = async () => urls;
  const result = await packager.package();
  const bytes = Buffer.from(result.data);
  if (result.type === 'application/zip') await validateArchive(bytes);
  // Never trust upstream result.filename for filesystem paths (it is unsanitized).
  return {...await permission.writeFile(p, full, bytes, {explicit: true, force: options.force}), target: settings.target,
    mimeType: result.type, packagerVersion: VERSION, images, downloads, launched: false,
    acceptance: 'generated-artifact-only; no browser/Electron/device/platform-playback claim'};
};
const HELP = `打包器 ${VERSION}（配置会话保存在 session.packagerSettings）
  pack inspect [路径] / pack get 路径   查看全部选项/类型/默认值/安全边界
  pack set framerate 60                数字/布尔/数组严格JSON类型；字符串可不带JSON引号
  pack set controls.pause.enabled true
  pack config '{"app":{"windowTitle":"我的游戏"},"turbo":true}'
  pack set app.icon /绝对路径/icon.png  图片统一安全解码→PNG→Packager.Image
  pack reset [路径]                    全部/分组/叶选项恢复CLI安全默认
  pack reset-group runtime             冻结GUI八组局部重置（inspect查看字段）
  pack cursor-center --allow read:/光标.png  真实图片尺寸自动中心
  pack export 配置.json / pack import 配置.json  完整/部分嵌套JSON；未知/prototype键拒绝
  pack build 输出.html [--project 项目.sb3] [--output 输出.html]
  pack build 输出.zip --target zip-one-asset
  pack preview 预览.html               只写HTML，不启动浏览器/Electron
  pack targets                        全部官方target及下载许可；不表示全平台验收
  pack download webview-mac --cache /目录 --allow net:packagerdata.turbowarp.org
  pack build 桌面.zip --target electron-win64 --cache /目录 --allow net:packagerdata.turbowarp.org
  pack build 游戏.html --opt autoplay=true
默认云是local（localStorage）/也可none；无联网。custom-js、custom-css、extension-code、
cloud-network、unsafe-cloud、gamepad、pointerlock独立--allow；网络必须再net:精确主机。
配置导入中的图片路径不自动授权，build必须--allow read:/精确文件。--allow逗号列表或JSON数组。
敏感设置在配置时和build时均重新授权；本模块不执行自定义代码，产物本身不提供恶意代码沙箱。
包导出路径用positional或--output；--out只留给项目持久化。`;
const requiresProject = (command, args) => command === 'pack' && ['build', 'preview'].includes(args[0]);
const isReadOnly = () => true; // configuration is session-only; packages do not mutate SB3
const execute = async (session, command, args, options = {}) => {
  permission.validateInvocation(specs, command, args, options);
  const p = permission.createPolicy(session, options, `${command} ${args[0]}`);
  const [action, name, text] = args;
  if (action === 'help') return {text: HELP};
  if (action === 'targets') return {version: VERSION, targets: TARGETS.map(id => ({id,
    output: id === 'html' ? '.html' : '.zip', download: LARGE_ASSETS[id] || null,
    required: LARGE_ASSETS[id] ? ['--cache directory', '--allow net:packagerdata.turbowarp.org or net:blobs.turbowarp.xyz'] : [],
    launched: false, platformPlaybackTested: false}))};
  if (action === 'download') {
    const {data, ...result} = await downloadAsset(name, p, options.cache); return {...result, launched: false};
  }
  if (action === 'build' || action === 'preview') return build(session, args, options, p);
  const settings = settingsFor(session);
  if (action === 'cursor-center') {
    if (!settings.cursor.custom) throw new Error('自动设为中心需要当前 cursor.custom 图片');
    const bytes = await permission.readFile(p, settings.cursor.custom.file, {maxBytes: 16 * 1024 * 1024});
    const result = await imageBytes(bytes);
    settings.cursor.center = {x: Math.round(result.width / 2), y: Math.round(result.height / 2)};
    session.packagerSettings = validateSettings(settings);
    return {center: {...settings.cursor.center}, width: result.width, height: result.height, sourceSHA256: result.sourceSHA256, projectChanged: false};
  }
  if (action === 'get') return {path: name, value: getAt(settings, name)};
  if (action === 'inspect') {
    if (name) return {path: name, value: getAt(settings, name), upstreamDefault: getAt(upstreamDefaults(), name), cliDefault: getAt(defaults(), name)};
    return {packagerVersion: VERSION, settings, upstreamDefaults: upstreamDefaults(), leafOptionCount: OPTION_KEYS.length, resetGroups: RESET_GROUPS,
      schema: Object.fromEntries(OPTION_KEYS.map(key => [key, {type: IMAGE_KEYS.has(key) ? 'null|{file:string}' : typeof getAt(upstreamDefaults(), key),
        enum: ENUMS[key], range: NUMBERS[key]}])), grantLifetime: 'single-command', sandbox: 'custom extension execution unsupported-fail-closed'};
  }
  if (action === 'export') {
    if (name && options.output) throw new Error('配置输出用positional或--output，不能同时指定');
    const filename = name || options.output;
    if (!filename) throw new Error('缺少配置导出路径');
    return {...await permission.writeFile(p, filename, Buffer.from(JSON.stringify(settings, null, 2) + '\n'), {explicit: true, force: options.force}),
      format: 'PackagerOptions JSON', permissionsExported: false};
  }
  let candidate;
  if (action === 'reset-group') {
    if (!Object.hasOwn(RESET_GROUPS, name)) throw new Error('重置分组只能是 ' + Object.keys(RESET_GROUPS).join('/'));
    candidate = structuredClone(settings);
    for (const key of RESET_GROUPS[name]) putAt(candidate, key, getAt(defaults(), key));
  } else if (action === 'reset') {
    candidate = name ? structuredClone(settings) : defaults();
    if (name) putAt(candidate, name, getAt(defaults(), name));
    // Reset is always allowed to remove sensitive options; does not authorize
    // remaining sensitive settings for future builds.
  } else if (action === 'set') candidate = applySet(structuredClone(settings), name, text);
  else if (action === 'config') candidate = merge(structuredClone(settings), permission.parseJSON(name));
  else if (action === 'import') {
    const bytes = await permission.readFile(p, name, {explicit: true});
    candidate = merge(structuredClone(settings), permission.parseJSON(bytes.toString('utf8')));
  }
  candidate = validateSettings(candidate);
  if (!['reset', 'reset-group'].includes(action)) authorizeSettings(candidate, p);
  session.packagerSettings = candidate;
  return {action, settings: structuredClone(candidate), projectChanged: false, grantsPersisted: false};
};
module.exports = {specs, requiresProject, isReadOnly, usesProjectTarget: false, preflight, execute, HELP, defaults, upstreamDefaults, OPTION_KEYS, TARGETS,
  LARGE_ASSETS, RESET_GROUPS, validateSettings, validateArchive, imageBytes, nativeICNS, updatePlist, downloadAsset};
