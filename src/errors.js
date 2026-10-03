'use strict';

class CommandError extends Error {
  constructor(code, message, hint, details = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

const errorInfo = error => {
  if (error instanceof CommandError || error.hint) {
    return {code: error.code || 'INTERNAL_ERROR', message: error.message, hint: error.hint, details: error.details || {}};
  }
  const message = error?.message || String(error);
  if (['EACCES', 'EPERM', 'ELOOP'].includes(error?.code)) return {code: 'PERMISSION_DENIED', message,
    hint: '检查文件权限、精确授权及安全路径。', details: {path: error.path}};
  // Compatibility adapter for upstream and legacy command errors. New command
  // boundaries use CommandError; unknown failures never masquerade as validation.
  const cases = [
    ['UNSAVED_CHANGES', /Unsaved changes|Save or discard|needs --out/i, '先保存项目，或显式丢弃未保存修改。'],
    ['UNKNOWN_COMMAND', /Unknown command|Unknown .* action/, '使用 help --json 查询命令和子命令。'],
    ['UNKNOWN_OPTION', /Unknown option|Unsupported option|Option .*not allowed/, '使用 help <命令族> --json 查询接受的选项。'],
    ['PERMISSION_DENIED', /permission denied|defaultsafe|symlink|ELOOP|Unsafe local path|denied|not approved/i, '检查精确授权及输入路径；不能用 --force 绕过权限或符号链接限制。'],
    ['NOT_SUPPORTED', /NOT_YET_SUPPORTED|not supported|unsupported|unavailable input shape/i, '使用 capabilities --json 查看可用能力及替代方式。'],
    ['RESOURCE_AMBIGUOUS', /ambiguous|conflict/i, '使用资源稳定 ID，或先查询资源列表消除歧义。'],
    ['RESOURCE_NOT_FOUND', /not found|Open a project first|Open or create a project|Clipboard empty/i, '检查资源 ID/名称，并先打开或创建项目。'],
    ['RUNTIME_TIMEOUT', /timed? out|timeout|deadline|exceeded.*wall.clock|Runtime exceeded \d+ second limit/i, '检查运行状态，减少工作量并重新启动运行副本。'],
    ['INVALID_ARGUMENT', /must be|requires? |Expected |Invalid |Unknown input|Unknown field|Duplicate option|Missing value|Unclosed|exceeds|too many|outside range|^Use (?:either |a positional |block positional |tw )/i, '查询命令帮助，检查参数类型、范围和数量。']
  ];
  if (error?.code === 'ENOENT') return {code: 'RESOURCE_NOT_FOUND', message, hint: '检查输入文件是否存在。', details: {path: error.path}};
  if (error?.code === 'EEXIST') return {code: 'OUTPUT_EXISTS', message, hint: '选择其他路径，或显式使用 --force。', details: {}};
  const match = cases.find(([, pattern]) => pattern.test(message));
  return {code: match?.[0] || 'INTERNAL_ERROR', message, hint: match?.[2] || '查看 stderr 诊断信息；不要自动重试会产生写入的命令。', details: {}};
};

const resourceError = (count, message, selector) => new CommandError(count ? 'RESOURCE_AMBIGUOUS' : 'RESOURCE_NOT_FOUND',
  message, count ? '查询资源列表，使用稳定 ID 消除名称歧义。' : '查询资源列表，检查项目、目标和资源是否存在。',
  selector === undefined ? {} : {selector});

module.exports = {CommandError, errorInfo, resourceError};
