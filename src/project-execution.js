'use strict';
const path = require('node:path');
const {fork} = require('node:child_process');
const {readLocalFile} = require('./project');
const {checkedPath} = require('./file-boundaries');
const {CommandError} = require('./errors');
const {MAX_PROJECT_BYTES, MAX_PROJECT_BASE64_CHARS} = require('./project-limits');

// User-authored editor programs run as ordinary Node programs in a separate
// process. This boundary protects project commits; it is not a security sandbox.
const runProjectScript = async (bytes, filename, {workers} = {}) => {
  const scriptPath = await checkedPath(filename);
  await readLocalFile(scriptPath, 8 * 1024 * 1024);
  if (!['.js', '.cjs', '.mjs'].includes(path.extname(scriptPath))) {
    throw new CommandError('INVALID_ARGUMENT', 'Editor script must be .js, .cjs or .mjs', '导出一个接收 project 对象的异步函数。');
  }
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'project-exec-worker.js'), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json'
    });
    workers?.add(child);
    let settled = false, response = null;
    const timer = setTimeout(() => finish(new CommandError('RUNTIME_TIMEOUT', 'Project editor script exceeded 120 seconds', '缩短脚本工作量；项目尚未提交。')), 120000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {child.kill('SIGKILL'); reject(error);} else resolve(value);
    };
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.once('error', error => finish(error));
    child.on('message', message => {
      if (response || !message || typeof message.ok !== 'boolean') return finish(new CommandError('INTERNAL_ERROR', 'Invalid editor worker response', '检查脚本与 stderr。'));
      if (!message.ok) return finish(new CommandError(message.error?.code || 'INTERNAL_ERROR', message.error?.message || 'Editor script failed', message.error?.hint || '检查脚本与 stderr。', message.error?.details));
      if (typeof message.bytes !== 'string' || message.bytes.length > MAX_PROJECT_BASE64_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.bytes)) {
        return finish(new CommandError('INVALID_ARGUMENT', 'Editor worker output exceeds project limits or is invalid', '减少项目大小。'));
      }
      const output = Buffer.from(message.bytes, 'base64');
      if (output.length > MAX_PROJECT_BYTES) return finish(new CommandError('INVALID_ARGUMENT', 'Editor worker output exceeds project limits', '减少项目大小。'));
      response = {bytes: output, result: message.result};
    });
    child.once('close', (code, signal) => {
      workers?.delete(child);
      if (code === 0 && response) finish(null, response);
      else finish(new CommandError('INTERNAL_ERROR', `Editor worker exited ${code ?? signal} before completing`, '检查脚本与 stderr；项目尚未提交。'));
    });
    child.send({bytes: bytes.toString('base64'), scriptPath}, error => {if (error) finish(error);});
  });
};
module.exports = {runProjectScript};
