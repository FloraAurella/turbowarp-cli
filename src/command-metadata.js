'use strict';
const {CommandError} = require('./errors');

// Unknown semantics remain null rather than claiming guessed defaults.
const annotations = {
  help: {parameters: ['family'], project: 'none', access: 'read', examples: [['help', 'run', '--json']]},
  doctor: {parameters: [], project: 'none', access: 'read', examples: [['doctor', '--json']]},
  capabilities: {parameters: [], project: 'none', access: 'read', examples: [['capabilities', '--json']]},
  check: {parameters: [], project: 'none', access: 'read'},
  new: {parameters: ['output'], project: 'creates', access: 'write', examples: [['new', 'demo.sb3']]},
  open: {parameters: ['file'], project: 'opens', access: 'session', examples: [['open', 'demo.sb3']]},
  save: {parameters: ['output'], project: 'required', access: 'save', examples: [['save', 'demo.sb3']]},
  info: {parameters: [], project: 'required', access: 'read', examples: [['info', '--project', 'demo.sb3']]},
  run: {parameters: [], project: 'required', access: 'runtime-copy', examples: [['run', '--project', 'demo.sb3', '--frames', '2', '--seed', '1234', '--trace', '100', '--out', 'result.png']]},
  render: {parameters: ['output'], project: 'required', access: 'read', examples: [['render', 'stage.png']]},
  package: {parameters: ['output'], project: 'required', access: 'read', examples: [['package', 'demo.html']]},
  'sprite select': {parameters: ['selector'], project: 'required', access: 'session'},
  'sprite rename': {parameters: ['name'], project: 'required', access: 'write'},
  'sprite set': {parameters: ['property', 'value'], project: 'required', access: 'write', examples: [['sprite', 'set', 'x', '-120']]},
  'var add': {parameters: ['name', 'value'], project: 'required', access: 'write', examples: [['var', 'add', '得分', '0']]},
  'list add': {parameters: ['name', 'value'], project: 'required', access: 'write', examples: [['list', 'add', '背包', '["钥匙"]']]},
  'script demo': {parameters: ['distance'], project: 'required', access: 'write', examples: [['script', 'demo', '25']]},
  'script validate': {parameters: ['file'], project: 'required', access: 'read', examples: [['script', 'validate', 'script.json', '--project', 'demo.sb3']]},
  'script apply': {parameters: ['file'], project: 'required', access: 'write', examples: [['script', 'apply', 'script.json', '--project', 'demo.sb3', '--out', 'edited.sb3']]},
  'blocks schema': {parameters: ['opcode'], project: 'optional', access: 'read', examples: [['blocks', 'schema', 'motion_movesteps']]},
  'library status': {parameters: [], project: 'none', access: 'read'},
  'library search': {parameters: ['kind', 'query'], project: 'none', access: 'read', examples: [['library', 'search', 'sprite', 'Cat', '--limit', '5']]},
  'library load': {parameters: ['kind', 'selector'], project: 'required', access: 'write', examples: [['library', 'load', 'sprite', 'Cat 2']]},
  'device replay': {parameters: ['file'], project: 'optional', access: 'session', examples: [['device', 'replay', 'inputs.jsonl']]},
  'runtime start': {parameters: [], project: 'required', access: 'runtime-copy', examples: [['runtime', 'start', '--paused', '--no-compile', '--trace', '100']]},
  'runtime breakpoint': {parameters: ['action', 'blockId'], project: 'running-copy', access: 'runtime-copy'},
  'runtime step': {parameters: ['count'], project: 'running-copy', access: 'runtime-copy', examples: [['runtime', 'step']]},
  'runtime status': {parameters: [], project: 'none', access: 'read'},
  'runtime trace': {parameters: ['action'], project: 'running-copy', access: 'runtime-copy'},
  'runtime stop': {parameters: [], project: 'none', access: 'runtime-copy'},
  quit: {parameters: [], project: 'none', access: 'session'}, exit: {parameters: [], project: 'none', access: 'session'}
};
const optionSemantics = {
  project: {type: 'path', description: '打开本地项目；script validate 使用独立只读项目，不替换原会话。'},
  target: {type: 'selector', description: '目标名称或稳定 ID；pack build 中为打包目标。'},
  out: {type: 'path', description: '编辑命令保存 SB3；run/render 输出 PNG；package 输出打包文件。'},
  output: {type: 'path', description: '导出资源、配置或打包文件。'},
  frames: {type: 'integer', description: '运行/推进帧数；run 默认 30。'},
  fps: {type: 'integer', description: '帧率；未提供时继承项目设置。'},
  seed: {type: 'integer', description: '显式随机种子，范围 0..4294967295。'},
  trace: {type: 'integer', description: '解释器 trace 容量 1..10000。'},
  force: {type: 'boolean', description: '显式覆盖输出或丢弃修改，不能绕过文件/权限限制。'},
  inputs: {type: 'json', description: '积木输入对象。'}, fields: {type: 'json', description: '积木字段对象。'},
  json: {type: 'boolean', description: '输出机器可读的版本化 JSON。'}
};
const describe = (specs, booleans, family) => {
  if (family && !Object.hasOwn(specs, family)) throw new CommandError('UNKNOWN_COMMAND', `Unknown command family ${family}`, '使用 help --json 查询命令目录。');
  const commands = [];
  for (const [command, definition] of Object.entries(specs)) {
    if (family && command !== family) continue;
    for (const [action, rule] of definition.options ? [[null, definition]] : Object.entries(definition)) {
      const name = [command, action].filter(Boolean).join(' '), annotation = annotations[name];
      commands.push({command, action, minArguments: rule.min, maxArguments: rule.max,
        parameters: Array.from({length: rule.max}, (_, index) => ({name: annotation?.parameters[index] || `argument${index + 1}`,
          type: 'string', semanticType: null, required: index < rule.min, semanticKnown: !!annotation?.parameters[index]})),
        options: rule.options.map(option => ({name: option, takesValue: !booleans.has(option),
          type: booleans.has(option) ? 'boolean' : 'string', semantic: optionSemantics[option] || null,
          default: command === 'run' && option === 'frames' ? 30 : null,
          defaultKnown: command === 'run' && option === 'frames'})),
        project: annotation?.project || null, access: annotation?.access || null,
        persistence: annotation?.access === 'write' ? 'session: save; one-shot: --out .sb3' :
          annotation ? (annotation.access === 'save' ? 'explicit project save' : 'does not edit project') : null,
        examples: annotation?.examples || [], semanticKnown: !!annotation});
    }
  }
  return {schemaVersion: 1, family: family || null, commands,
    transport: {protocol: 'JSONL', request: {id: 'caller-supplied', command: 'string', args: 'string[]'},
      session: ['session', '--jsonl'], failFastSession: ['session', '--jsonl', '--fail-fast'],
      exitCodes: {0: 'completed; inspect each reply.ok', 1: 'failure', 2: 'unsaved changes'}}};
};
module.exports = {describe};
