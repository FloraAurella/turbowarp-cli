'use strict';

require('../src/native-environment');
const fs = require('node:fs/promises');
const path = require('node:path');
const {buildHTML} = require('../src/protected');

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4 || path.extname(input).toLowerCase() !== '.sb3' || path.extname(output).toLowerCase() !== '.html') {
    throw new Error('用法：npm run build:protected -- 作品.sb3 发布.html（输出文件须不存在）');
  }
  const info = await fs.stat(input);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('输入须为不超过 32 MiB 的 SB3 文件。');
  const result = await buildHTML(await fs.readFile(input), {title: path.basename(input, path.extname(input))});
  await fs.writeFile(output, result.html, {flag: 'wx'});
  console.log(JSON.stringify({output: path.resolve(output), ...result.report}, null, 2));
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
