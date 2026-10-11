'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const {checkedPath} = require('./file-boundaries');

// These are capability decisions, not an OS sandbox. Never execute untrusted
// JavaScript in this process (including in node:vm) based on these grants.
const CAPABILITIES = Object.freeze([
  ['read', '精确本地文件读取；命令直接指定输入路径即授权该文件', true, 'path'],
  ['write', '精确本地文件写入；命令直接指定输出路径即授权该文件', true, 'path'],
  ['net', '精确主机 HTTP(S)/云地址；不含子域、通配或重定向主机', true, 'host'],
  ['extension-code', '仅许可在产物中包含扩展代码；不许可在 CLI 中执行', true, null],
  ['custom-js', '仅许可把自定义 JavaScript 写入包；不是代码沙箱', true, null],
  ['custom-css', '许可自定义样式（可含联网资源）；不是样式沙箱', true, null],
  ['cloud-network', '许可输出联网云提供器；还必须逐主机授权 net', true, null],
  ['unsafe-cloud', '许可输出危险云行为（可打开链接/下载）；独立于云联网许可', true, null],
  ['builtin-extension', '只允许冻结pen/music及数据适配videoSensing/Gamepad加载', true, 'id'],
  ['gamepad', '许可输出打包器 gamepad 功能；不表示已连接/实测设备', true, null],
  ['pointerlock', '许可输出打包器 pointerlock 功能；不表示已实测交互', true, null],
  ['clipboard-read', '系统剪贴板读取未支持', false, null],
  ['clipboard-write', '系统剪贴板写入未支持；可改为显式文件输出', false, null],
  ['audio-input', '实时麦克风未支持；预录文件不等价实时采集', false, null],
  ['video-input', '实时摄像头未支持', false, null],
  ['bluetooth', 'Scratch Link/BLE 连接未支持', false, null],
  ['usb', 'USB 设备访问未支持', false, null],
  ['serial', '串口设备访问未支持', false, null],
  ['notifications', '系统通知未支持', false, null],
  ['location', '系统定位未支持', false, null],
  ['open-window', '自动打开外部窗口未支持；文档仅输出文本', false, 'url'],
  ['redirect', '页面重定向未支持', false, 'url'],
  ['embed', '嵌入外部页面未支持', false, 'url'],
  ['extension-execute', '缺少经验证独立受限子进程，任意扩展执行 fail-closed', false, null]
].map(([id, description, supported, scope]) => Object.freeze({id, description, supported, scope, default: 'deny'})));
const definitions = new Map(CAPABILITIES.map(item => [item.id, item]));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_DECISIONS = 1000;
const record = (session, decision) => {
  if (!session) return decision;
  session.permissionDecisions ||= [];
  session.permissionDecisions.push(Object.freeze({...decision}));
  if (session.permissionDecisions.length > MAX_DECISIONS) {
    session.permissionDecisions.splice(0, session.permissionDecisions.length - MAX_DECISIONS);
    session.permissionDecisionsDropped = (session.permissionDecisionsDropped || 0) + 1;
  }
  return decision;
};
const policyError = (message, code = 'ERR_PERMISSION_DENIED', decision) => {
  const error = new Error(message); error.code = code;
  if (decision) error.decision = decision;
  return error;
};
const assertLocalPath = value => {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) ||
    value.includes('\\') || value.split('/').includes('..') || /%2e|%2f|%5c/i.test(value) ||
    /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('~')) {
    throw policyError('拒绝不安全本地路径（path traversal/URL/控制字符/隐式 ~）：' + String(value), 'ERR_UNSAFE_PATH');
  }
  return path.resolve(value);
};
const hostName = value => {
  if (typeof value !== 'string' || !value || /[\s\/@?#%*\\]/.test(value) || value.endsWith('.')) {
    throw policyError('net 需要精确主机名，不允许通配、URL、端口或凭据', 'ERR_INVALID_PERMISSION');
  }
  let url;
  try {url = new URL(`https://${value}`);} catch {throw policyError('无效 net 主机', 'ERR_INVALID_PERMISSION');}
  if (url.port || url.username || url.password || url.hostname.toLowerCase() !== value.toLowerCase() && !/[^\x00-\x7f]/.test(value)) {
    throw policyError('net 需要规范化的精确主机名；不允许端口或缩写 IP', 'ERR_INVALID_PERMISSION');
  }
  return url.hostname.toLowerCase();
};
const safeURL = (value, protocols = ['https:', 'http:']) => {
  if (typeof value !== 'string' || /[\x00-\x20\x7f\\<>"'`]/.test(value) || /%(?:2e|2f|5c|00)/i.test(value)) {
    throw policyError('拒绝不安全 URL', 'ERR_UNSAFE_URL');
  }
  let url;
  try {url = new URL(value);} catch {throw policyError('需要完整 URL', 'ERR_UNSAFE_URL');}
  const rawPath = value.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0];
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || rawPath.split('/').includes('..')) {
    throw policyError('拒绝 URL 协议/凭据/片段/path traversal', 'ERR_UNSAFE_URL');
  }
  hostName(url.hostname);
  return url;
};
const parseGrant = token => {
  if (typeof token !== 'string' || !token || token.length > 8192) throw policyError('无效权限 token', 'ERR_INVALID_PERMISSION');
  const split = token.indexOf(':');
  const id = split < 0 ? token : token.slice(0, split);
  const raw = split < 0 ? null : token.slice(split + 1);
  const definition = definitions.get(id);
  if (!definition) throw policyError(`未知权限 ${id}；用 permission list 查看枚举`, 'ERR_INVALID_PERMISSION');
  let resource = raw;
  if (!definition.scope && raw !== null || definition.scope && !raw) throw policyError(`权限 ${id} 的资源范围无效`, 'ERR_INVALID_PERMISSION');
  if (definition.scope === 'path') resource = assertLocalPath(raw);
  if (definition.scope === 'host') resource = hostName(raw);
  if (definition.scope === 'url') resource = safeURL(raw).href;
  if (definition.scope === 'id' && !/^[a-zA-Z][a-zA-Z\d_-]{0,99}$/.test(raw)) throw policyError('无效扩展 ID', 'ERR_INVALID_PERMISSION');
  return {id, resource};
};
const parseAllow = value => {
  if (value === undefined) return [];
  if (typeof value !== 'string' || !value.trim()) throw policyError('--allow 需要逗号列表或 JSON 字符串数组', 'ERR_INVALID_PERMISSION');
  let tokens;
  if (value.trim().startsWith('[')) {
    try {tokens = JSON.parse(value);} catch {throw policyError('--allow JSON 无效', 'ERR_INVALID_PERMISSION');}
    if (!Array.isArray(tokens) || !tokens.every(item => typeof item === 'string')) throw policyError('--allow 必须是字符串数组', 'ERR_INVALID_PERMISSION');
  } else tokens = value.split(',').map(item => item.trim());
  if (tokens.length > 100) throw policyError('每条命令最多 100 项权限', 'ERR_INVALID_PERMISSION');
  const grants = tokens.map(parseGrant);
  const identities = grants.map(grant => JSON.stringify(grant));
  if (new Set(identities).size !== identities.length) throw policyError('--allow 包含重复权限', 'ERR_INVALID_PERMISSION');
  return grants;
};
const createPolicy = (session, options = {}, command = '') => {
  let grants;
  try {grants = parseAllow(options.allow);} catch (error) {
    record(session, {command, capability: 'allow', resource: null, allowed: false, reason: error.message}); throw error;
  }
  const decide = (id, resource = null, {explicit = false, reason, supported} = {}) => {
    const definition = definitions.get(id);
    if (!definition) throw policyError(`未知权限能力 ${id}`, 'ERR_INVALID_PERMISSION');
    const normalized = definition.scope ? parseGrant(`${id}:${resource}`).resource : null;
    const requested = explicit || grants.some(grant => grant.id === id && grant.resource === normalized);
    const available = (supported ?? definition.supported) && (id !== 'builtin-extension' || ['pen', 'music', 'videoSensing', 'Gamepad'].includes(normalized));
    const allowed = requested && available;
    return record(session, {command, capability: id, resource: normalized, allowed,
      reason: !available ? reason || '未实现安全能力；即使 --allow 也 fail-closed' :
        allowed ? reason || (explicit ? '显式命令路径/内置 ID 授权；无父目录或后续命令授权' : '本条命令精确 --allow 授权') :
          reason || `默认 deny；缺少 --allow ${id}${definition.scope ? ':' + normalized : ''}`});
  };
  const requirePermission = (id, resource, details) => {
    const decision = decide(id, resource, details);
    if (!decision.allowed) throw policyError(`权限拒绝 ${id}：${decision.reason}`,
      (details?.supported ?? definitions.get(id)?.supported) === false ? 'ERR_CAPABILITY_UNSUPPORTED' : 'ERR_PERMISSION_DENIED', decision);
    return decision;
  };
  const deny = (id, resource, reason, code = 'ERR_CAPABILITY_UNSUPPORTED') => {
    const decision = record(session, {command, capability: id, resource: resource ?? null, allowed: false, reason});
    throw policyError(`权限拒绝 ${id}：${reason}`, code, decision);
  };
  return Object.freeze({grants: Object.freeze(grants.map(Object.freeze)), decide, require: requirePermission, deny});
};

const safePath = async (value, {directory = false, missing = false} = {}) => {
  const full = assertLocalPath(value);
  try {return await checkedPath(full, {directory, missing});} catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw policyError('拒绝符号链接或非普通文件/目录：' + error.message, 'ERR_UNSAFE_PATH');
  }
};
const readFile = async (policy, value, {explicit = false, maxBytes = 4 * 1024 * 1024} = {}) => {
  let full;
  try {full = assertLocalPath(value);} catch (error) {return policy.deny('read', value, error.message, error.code);}
  policy.require('read', full, {explicit});
  try {await safePath(full);} catch (error) {
    if (error.code === 'ENOENT') throw error;
    return policy.deny('read', value, error.message, error.code);
  }
  try {return await require('./project').readLocalFile(full, maxBytes);} catch (error) {
    if (/within .* bytes|exceeds .* bytes/.test(error.message)) throw policyError(`输入必须是普通文件且不超过 ${maxBytes} 字节`, 'ERR_INPUT_LIMIT');
    throw error;
  }
};
const writeFile = async (policy, value, bytes, {explicit = false, force = false} = {}) => {
  let full;
  try {full = assertLocalPath(value); await safePath(full, {missing: true});} catch (error) {return policy.deny('write', value, error.message, error.code);}
  policy.require('write', full, {explicit});
  return require('./project').atomicWrite(full, bytes, force);
};
const assertData = (value, depth = 0, maxArray = 10000) => {
  if (depth > 24) throw new Error('JSON 嵌套深度超出限制');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {if (!Number.isFinite(value)) throw new Error('JSON 数字必须有限'); return;}
  if (Array.isArray(value)) {if (value.length > maxArray) throw new Error('JSON 数组超限'); for (const item of value) assertData(item, depth + 1, maxArray); return;}
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('只允许普通 JSON 数据对象');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || /[\x00-\x1f\x7f]/.test(key)) throw new Error('拒绝 prototype pollution 键');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('拒绝 JSON getter/setter');
    assertData(descriptor.value, depth + 1, maxArray);
  }
};
const parseJSON = (text, {maxArray = 10000, maxBytes = 4 * 1024 * 1024} = {}) => {
  if (!Number.isInteger(maxArray) || maxArray < 1 || maxArray > 200000) throw new Error('JSON 数组限额无效');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('JSON 字节限额无效');
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new Error('JSON 输入类型/大小无效');
  const value = JSON.parse(text); assertData(value, 0, maxArray); return value;
};
const validateInvocation = (specs, command, args, options) => {
  if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) throw new Error('命令参数必须是字符串数组');
  assertData(options);
  const rule = Object.hasOwn(specs, command) && Object.hasOwn(specs[command], args[0]) && specs[command][args[0]];
  if (!rule) throw new Error('未知子命令；用 help 子命令查看用法');
  if (args.length - 1 < rule.min || args.length - 1 > rule.max) throw new Error(`参数数量应为 ${rule.min}..${rule.max}（不计子命令）`);
  for (const [key, value] of Object.entries(options)) {
    if (!rule.options.includes(key)) throw new Error(`不允许 --${key}`);
    if (key === 'force' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error(`--${key} 类型错误`);
  }
  return rule;
};
module.exports = {CAPABILITIES, createPolicy, parseAllow, parseGrant, record, policyError, assertLocalPath, safePath,
  hostName, safeURL, readFile, writeFile, sha256, assertData, parseJSON, validateInvocation};
