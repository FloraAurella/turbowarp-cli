'use strict';
const path = require('node:path');
const os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');
const {CommandError} = require('./errors');

const cleanEnv = () => {
  const env = {...process.env};
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
};
const inspectNode = executable => {
  const result = spawnSync(executable, ['-p', 'JSON.stringify({path:process.execPath,version:process.versions.node})'],
    {encoding: 'utf8', timeout: 3000, maxBuffer: 65536, env: cleanEnv(), windowsHide: true});
  try {
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr.trim());
    const value = JSON.parse(result.stdout);
    return {requestedPath: executable, ...value, compatible: value.version.split('.')[0] === '24'};
  } catch (error) {return {requestedPath: executable, compatible: false, error: error.message};}
};
const selectNode = () => {
  const current = {path: process.execPath, version: process.versions.node};
  const explicit = process.env.TW_NODE;
  const candidates = explicit !== undefined ? [explicit] : [process.execPath,
    path.join(os.homedir(), '.nvm', 'versions', 'node', 'v24.18.0', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')];
  const attempts = [];
  for (const candidate of [...new Set(candidates)]) {
    const inspected = candidate ? inspectNode(candidate) : {requestedPath: candidate, compatible: false, error: 'TW_NODE is empty'};
    attempts.push(inspected);
    if (inspected.compatible) return {current, selected: inspected, attempts};
  }
  return {current, selected: null, attempts, hint: '需要 Node.js 24；设置 TW_NODE 为有效的 Node 24 可执行文件路径。显式 TW_NODE 不会被自动替换。'};
};
const requireNode = selection => {
  if (!selection.selected) throw new CommandError('NODE_RUNTIME_UNAVAILABLE', 'Node.js 24 is required for the validated native addon ABI', selection.hint, selection);
  return selection.selected.path;
};
const runNode = (selection, args) => {
  const child = spawn(requireNode(selection), args, {stdio: 'inherit', env: cleanEnv(), windowsHide: true});
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const cleanup = () => {for (const [signal, handler] of handlers) process.removeListener(signal, handler);};
  child.once('error', error => {cleanup(); console.error(`tw: ${error.message}`); process.exitCode = 1;});
  child.once('exit', (code, signal) => {cleanup(); process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);});
};
const doctor = selection => {
  let dependencies = [];
  if (selection.selected) {
    const probe = spawnSync(selection.selected.path, [path.join(__dirname, 'doctor-probe.js')],
      {encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, env: cleanEnv(), windowsHide: true});
    try {
      dependencies = JSON.parse(probe.stdout);
      if (!Array.isArray(dependencies) || dependencies.length !== 4 || probe.status !== 0) throw new Error('Invalid native probe result');
    } catch {
      dependencies = [{name: 'native-probe', loadable: false, error: probe.error?.message || probe.stderr.trim() || 'Probe failed'}];
    }
  }
  const ok = !!selection.selected && dependencies.every(item => item.loadable);
  return {schemaVersion: 1, ok, platform: process.platform, arch: process.arch, ...selection, dependencies,
    hints: [...(!selection.selected ? [selection.hint] : []), ...dependencies.filter(item => !item.loadable)
      .map(item => `检查 ${item.name} 的安装和 ${process.platform}/${process.arch} 原生 ABI；使用选中的 Node 24 安装锁定依赖。`)]};
};
module.exports = {selectNode, requireNode, runNode, doctor, inspectNode};
