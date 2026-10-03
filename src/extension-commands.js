'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {brotliDecompressSync} = require('node:zlib');
const {parseDOM} = require('htmlparser2');
const policy = require('./permission-policy');
const specs = require('./command-catalog').moduleSpecs['extension-commands.js'];
const SHIPPED_ROOT = path.resolve(__dirname, '../resources/extensions');
const ROOT = require('node:fs').existsSync(SHIPPED_ROOT) ? SHIPPED_ROOT : path.resolve(__dirname, '../../desktop-master/dist-extensions');
const APPROVED = new Set(['pen', 'music', 'videoSensing', 'Gamepad']);
const BUILTINS = Object.freeze([
  ['pen', '画笔', '已支持冻结内置积木；舞台画笔/印章，无联网'],
  ['music', '音乐', '可加载冻结内置积木；CLI乐器采样音色未对拍，打包器含本地音乐运行库'],
  ['videoSensing', '视频侦测（预录帧）', '已支持安全预录PNG/JPEG帧及冻结motion识别；不请求实时摄像头'],
  ['Gamepad', '手柄（记录数据）', '已支持CLI数据factory的按钮/轴reporter；不执行画廊JS，真实设备/振动仍拒绝'],
  ['faceSensing', '人脸侦测', '画廊提供；不在本CLI冻结VM内置加载白名单'],
  ['text2speech', '文字朗读', '联网服务及语音输出未支持'],
  ['translate', '翻译', '联网服务未支持'],
  ['makeymakey', 'Makey Makey', '未纳入本CLI项目安全加载白名单'],
  ['microbit', 'micro:bit', '真实BLE/Scratch Link/固件更新未支持'],
  ['ev3', 'LEGO EV3', '真实硬件连接未支持'],
  ['boost', 'LEGO BOOST', '真实硬件连接未支持'],
  ['wedo2', 'LEGO WeDo 2.0', '真实硬件连接未支持'],
  ['gdxfor', 'Go Direct Force & Acceleration', '真实硬件连接未支持'],
  ['tw', 'TurboWarp', '本CLI不另行加载此分类；过程返回能力由其他模块负责']
].map(([id, name, reason]) => Object.freeze({id, name, reason, source: 'builtin', supported: APPROVED.has(id),
  docsURL: `https://extensions.turbowarp.org/${id === 'pen' || id === 'music' ? '' : id}`,
  vmBuiltin: !['faceSensing', 'Gamepad'].includes(id),
  source: id === 'faceSensing' ? 'frozen-offline-gallery' : id === 'Gamepad' || id === 'videoSensing' ? 'cli-data-adapter' : 'builtin'})));
const textSafe = value => String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200000);
const bundled = async name => {
  if (!/^[\w./-]+$/.test(name) || name.split('/').includes('..')) throw new Error('拒绝资源 path traversal');
  const full = path.join(ROOT, name);
  await policy.safePath(full);
  const bytes = await fs.readFile(full);
  const hashes = require('../baseline.json').distExtensions.files;
  if (!Object.hasOwn(hashes, name) || policy.sha256(bytes) !== hashes[name]) throw new Error('冻结扩展资源 SHA-256 不匹配：' + name);
  return bytes;
};
const catalog = async () => {
  const bytes = await bundled('generated-metadata/extensions-v0.json.br');
  const data = policy.parseJSON(brotliDecompressSync(bytes, {maxOutputLength: 4 * 1024 * 1024}).toString('utf8'));
  if (!Array.isArray(data.extensions)) throw new Error('冻结扩展目录格式错误');
  return data.extensions.map(item => {
    if (typeof item.slug !== 'string' || !/^[a-zA-Z\d_.-]+(?:\/[a-zA-Z\d_.-]+)*$/.test(item.slug) ||
      item.slug.split('/').some(part => ['.', '..'].includes(part))) throw new Error('冻结目录含不安全 slug');
    return {id: textSafe(item.id), slug: item.slug, name: textSafe(item.nameTranslations?.['zh-cn'] || item.name),
      description: textSafe(item.descriptionTranslations?.['zh-cn'] || item.description), source: 'frozen-offline-gallery',
      url: `https://extensions.turbowarp.org/${item.slug}.js`,
      docsURL: item.docs ? `https://extensions.turbowarp.org/${item.slug}` : null,
      supported: false, reason: '目录/字节存在不等于可安全执行；自定义扩展加载 fail-closed'};
  });
};
const find = async selector => {
  if (typeof selector !== 'string' || !selector || /[\x00-\x1f\x7f\\%]/.test(selector) || selector.split('/').includes('..')) throw new Error('拒绝扩展 ID path traversal');
  const builtin = BUILTINS.find(item => item.id === selector);
  if (builtin && builtin.source !== 'frozen-offline-gallery') return builtin;
  const entries = (await catalog()).filter(item => item.id === selector || item.slug === selector);
  if (entries.length !== 1) throw new Error('扩展不存在或 ID 不唯一；可用精确 slug');
  return entries[0];
};
const plainHTML = html => {
  const walk = nodes => nodes.map(node => {
    if (['script', 'style', 'iframe', 'object', 'embed', 'noscript'].includes(node.name)) return '';
    if (node.type === 'text') return node.data;
    const text = walk(node.children || []);
    return ['p', 'div', 'h1', 'h2', 'h3', 'li', 'pre', 'br', 'tr'].includes(node.name) ? '\n' + text + '\n' : text;
  }).join('');
  return textSafe(walk(parseDOM(html, {decodeEntities: true}))).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
};
// Persistence of approved loaded IDs (even with no blocks) belongs to
// Project's validated tw-cli-state.json metadata, not a global toJSON patch.
const HELP = `扩展与权限（默认 deny，不交互授权）
  ext list [builtin|offline|gallery|loaded]  冻结目录；gallery 不访问远程
  ext inspect ID或slug                     说明可用状态与拒绝理由
  ext doc ID或slug [文本.txt] [--output 文本.txt]  纯文本/安全URL；不执行HTML/开浏览器
  ext load pen / ext load music            批准的冻结内置扩展
  ext load videoSensing / ext load Gamepad  安全预录帧/记录数据适配；不采集实时设备
  ext load-file 恶意.js --allow extension-code  仍明确未支持；不会读取/执行代码
  permission list / inspect / log           能力枚举、策略、最近1000条决定
  permission check net:example.org --allow net:example.org
--allow 用单个逗号列表或JSON字符串数组；无通配/持久授权。read:/精确路径 与
write:/精确路径分开；显式输入/输出命令只授权该路径，配置文件中的路径不自动授权。
任意JS执行缺少经过验证的独立受限子进程，始终fail-closed；node:vm不是恶意JS沙箱。`;
const requiresProject = (command, args) => command === 'ext' && (args[0] === 'load' || args[0] === 'list' && args[1] === 'loaded');
const isReadOnly = (command, args) => command !== 'ext' || args[0] !== 'load';
const preflight = async (session, command, args, options = {}) => {
  policy.validateInvocation(specs, command, args, options);
  const p = policy.createPolicy(session, options, `${command} ${args[0]} preflight`);
  if (command !== 'ext' || args[0] !== 'load') return;
  const item = await find(args[1]);
  if (!APPROVED.has(item.id) || !['builtin', 'cli-data-adapter'].includes(item.source)) return p.deny('builtin-extension', item.id, item.reason);
  if (options.out) {
    let full;
    try {full = policy.assertLocalPath(options.out); await policy.safePath(full, {missing: true});}
    catch (error) {return p.deny('write', options.out, error.message, error.code);}
    p.require('write', full, {explicit: true});
  }
  if (options.project) {
    let full;
    try {full = policy.assertLocalPath(options.project); await policy.safePath(full);}
    catch (error) {return p.deny('read', options.project, error.message, error.code);}
    p.require('read', full, {explicit: true});
  }
};
const execute = async (session, command, args, options = {}) => {
  policy.validateInvocation(specs, command, args, options);
  const p = policy.createPolicy(session, options, `${command} ${args[0]}`);
  const [action, selector, positional] = args;
  if (action === 'help') return {text: HELP};
  if (command === 'permission') {
    if (action === 'list') return {default: 'deny', capabilities: policy.CAPABILITIES};
    if (action === 'log') return {decisions: [...(session.permissionDecisions || [])], dropped: session.permissionDecisionsDropped || 0};
    if (action === 'inspect') return {default: 'deny', grantLifetime: 'single-command', paths: 'explicit exact file; no symlinks/traversal',
      customExtensionSandbox: 'unsupported-fail-closed', vmIsSecuritySandbox: false, runtimeIntegration: 'existing runtime/project default-deny; no device implementation'};
    const grant = policy.parseGrant(selector);
    return p.decide(grant.id, grant.resource);
  }
  if (action.startsWith('load-')) return p.deny('extension-execute', selector,
    '未支持自定义扩展执行：缺少经验证独立受限子进程；不会读取文件、下载或执行源码；--allow 不能降格为通过');
  if (action === 'list') {
    const mode = selector || 'builtin';
    if (mode === 'loaded') {
      const vm = session.project?.vm;
      if (!vm) throw new Error('先打开项目');
      return {extensions: [...vm.extensionManager._loadedExtensions.keys()].filter(id => APPROVED.has(id))};
    }
    if (mode === 'builtin') return {frozen: true, extensions: BUILTINS};
    if (!['offline', 'gallery'].includes(mode)) throw new Error('目录应为 builtin/offline/gallery/loaded');
    return {frozen: true, network: false, root: ROOT, extensions: await catalog()};
  }
  const item = await find(selector);
  if (action === 'inspect') {
    if (!item.slug) return item;
    const source = await bundled(item.slug + '.js.br');
    return {...item, compressedBytes: source.length, compressedSHA256: policy.sha256(source)};
  }
  if (action === 'doc') {
    if (positional && options.output) throw new Error('输出用 positional 或 --output，不能同时指定');
    let text = `${item.name}\n${item.reason}\n${item.docsURL || item.url || ''}`;
    if (item.slug && item.docsURL) {
      const html = brotliDecompressSync(await bundled(item.slug + '.html.br'), {maxOutputLength: 4 * 1024 * 1024}).toString('utf8');
      text = plainHTML(html);
    }
    const output = positional || options.output;
    return output ? {...await policy.writeFile(p, output, Buffer.from(text + '\n'), {explicit: true, force: options.force}), format: 'text/plain'} : {text};
  }
  if (!APPROVED.has(item.id) || !['builtin', 'cli-data-adapter'].includes(item.source)) return p.deny('builtin-extension', item.id,
    item.reason || '未纳入批准的冻结/安全数据扩展白名单；硬件或联网能力未支持');
  const vm = session.project?.vm;
  if (!vm) throw new Error('先打开项目');
  p.require('builtin-extension', item.id, {explicit: true});
  const alreadyLoaded = vm.extensionManager.isExtensionLoaded(item.id);
  if (!alreadyLoaded) await vm.extensionManager.loadExtensionURL(item.id);
  if (!vm.extensionManager.isExtensionLoaded(item.id)) throw new Error('内置扩展加载未完成');
  vm.runtime.emitProjectChanged();
  return {id: item.id, loaded: true, alreadyLoaded, serialized: true, customSandbox: false};
};
module.exports = {specs, requiresProject, isReadOnly, preflight, execute, HELP, BUILTINS, catalog, plainHTML};
