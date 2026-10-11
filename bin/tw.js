#!/usr/bin/env node
'use strict';
const {selectNode, requireNode, runNode, doctor} = require('../src/node-runtime');
const {CommandError, errorInfo} = require('../src/errors');
const main = async () => {
  const argv = process.argv.slice(2);
  const selection = selectNode();
  if (argv[0] === 'doctor') {
    if (argv.length > 2 || argv.length === 2 && argv[1] !== '--json') throw new CommandError('INVALID_ARGUMENT', 'Use tw doctor [--json]', '使用 doctor --json 获取环境诊断。');
    const result = doctor(selection);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const executable = requireNode(selection);
  if (executable !== process.execPath || process.versions.node.split('.')[0] !== '24') {
    runNode(selection, [__filename, ...argv]); return;
  }
  await require('../src/cli-main').main();
};
if (require.main === module) main().catch(error => {
  const info = errorInfo(error);
  if (process.argv[2] === 'project' && ['read', 'find', 'validate', 'apply', 'exec'].includes(process.argv[3])) {
    process.stdout.write(JSON.stringify({ok: false, error: info.message, errorInfo: info}) + '\n');
  }
  console.error(`tw: ${info.message}\n${info.hint}`);
  process.exitCode = 1;
});
module.exports = {main, tokenize: require('../src/cli-main').tokenize};
