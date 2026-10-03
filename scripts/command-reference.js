const fs = require('node:fs');
const path = require('node:path');
const {commandSpecs, commandHelp} = require('../src/command-catalog');

const root = path.resolve(__dirname, '..');
const sections = ['# 实际 CLI 指令索引', '',
  '此文件由实际注册的命令 schema 生成。存在命令不等于对应全部 GUI 动作已经验收；完整状态以 completion-audit 和动作账本为准。', '',
  '示例：`./tw help paint` 查看绘图语法，`./tw help runtime` 查看运行控制；`--project` 读取指定项目，编辑命令 `--out` 保存 SB3。', ''];
for (const command of Object.keys(commandSpecs).sort()) {
  sections.push(`## ${command}`, '', '```text', commandHelp(command), '```', '');
}
fs.writeFileSync(path.join(root, 'docs/command-reference.md'), sections.join('\n'));
console.log(JSON.stringify({families: Object.keys(commandSpecs).length,
  commands: Object.values(commandSpecs).reduce((sum, command) => sum + (command.options ? 1 : Object.keys(command).length), 0)}));
