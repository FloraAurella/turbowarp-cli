const readline = require('node:readline');
const {CommandError, errorInfo} = require('./errors');

const tokenize = line => {
  const tokens = [];
  let current = '', quote = null, escaped = false, started = false;
  for (const character of line) {
    if (escaped) {current += character; escaped = false; started = true; continue;}
    if (character === '\\' && quote !== "'") {escaped = true; started = true; continue;}
    if (quote) {if (character === quote) quote = null; else current += character; started = true; continue;}
    if (character === '"' || character === "'") {quote = character; started = true; continue;}
    if (/\s/.test(character)) {if (started) {tokens.push(current); current = ''; started = false;} continue;}
    current += character; started = true;
  }
  if (quote || escaped) throw new Error('Unclosed quote or escape');
  if (started) tokens.push(current);
  return tokens;
};
const emit = value => {
  if (value && value.text) process.stdout.write(value.text + '\n');
  else process.stdout.write(JSON.stringify(value) + '\n');
};

const main = async () => {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24 is required for the validated native addon ABI');
  const argv = process.argv.slice(2);
  const {commandHelp, validateCommand} = require('./command-catalog');
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length > 1) throw new Error('Use tw --help without other arguments');
    emit({text: commandHelp()}); return;
  }
  if (argv[0] === '--version') {
    if (argv.length !== 1) throw new Error('Use tw --version without other arguments');
    emit({version: require('../package.json').version, status: 'experimental-not-full-parity'}); return;
  }
  if (argv[0] === 'help' || argv[0] === 'capabilities') {
    const parsed = validateCommand(argv);
    const result = parsed.command === 'help' ? commandHelp(parsed.args[0], parsed.options.json) : require('./capabilities').describe();
    emit(typeof result === 'string' ? {text: result} : result); return;
  }
  require('./native-environment');
  require('./network-policy').install();
  const {CommandSession} = require('./commands');
  const session = new CommandSession();
  const originalLog = console.log;
  console.log = (...args) => console.error(...args);
  try {
    if (argv[0] !== 'session') {
      const invocation = validateCommand(argv);
      if (invocation.command === 'project' && ['apply', 'exec'].includes(invocation.args[0]) && !invocation.options.out) {
        throw new CommandError('INVALID_ARGUMENT', 'Project editing needs an explicit --out result.sb3', '使用 --out 指定输出项目；会话和 SDK 可以随后显式保存。');
      }
      const result = await session.execute(argv);
      if (session.dirty) {console.error('Editing command needs --out 项目.sb3 to persist changes.'); process.exitCode = 2;}
      emit(result); return;
    }
    const jsonl = argv.includes('--jsonl');
    const failFast = argv.includes('--fail-fast');
    if (argv.slice(1).some(option => !['--jsonl', '--fail-fast'].includes(option)) ||
      new Set(argv).size !== argv.length || failFast && !jsonl) {
      throw new CommandError('INVALID_ARGUMENT', 'Use tw session [--jsonl [--fail-fast]]', '--fail-fast 只用于 JSONL 自动化会话。');
    }
    const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity, terminal: false});
    session.stdinOwned = true;
    for await (const line of lines) {
      if (!line.trim()) continue;
      let id = null;
      try {
        let command;
        if (jsonl) {
          let request;
          try {request = JSON.parse(line);} catch {throw new CommandError('INVALID_ARGUMENT', 'Expected valid JSON request', '每行提供一个 {id, command, args} JSON 对象。');}
          if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected {id, command: string, args: string[]}');
          id = request.id ?? null;
          const args = request.args === undefined ? [] : request.args;
          if (typeof request.command !== 'string' || !request.command || request.command.startsWith('-') || /\s/.test(request.command) ||
            !Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
            throw new Error('Expected {id, command: string, args: string[]}');
          }
          command = [request.command, ...args];
        } else command = tokenize(line);
        const parsed = validateCommand(command);
        if (parsed.command === 'quit' || parsed.command === 'exit') {
          if (session.dirty && !parsed.options.force) throw new Error('Unsaved changes; save first or quit --force');
          if (jsonl) emit({id, ok: true, result: {closed: true}});
          session.dirty = false;
          break;
        }
        const result = await session.execute(command);
        emit(jsonl ? {id, ok: true, result} : result);
      } catch (error) {
        const info = errorInfo(error);
        emit(jsonl ? {id, ok: false, error: error.message, errorInfo: info} : {error: error.message, errorInfo: info});
        if (failFast) {process.exitCode = session.dirty ? 2 : 1; break;}
      }
    }
    lines.close();
    if (session.dirty) {console.error('Unsaved changes were not written (stdin closed).'); process.exitCode = 2;}
  } finally {try {session.dispose();} finally {console.log = originalLog;}}
};

module.exports = {main, tokenize};
