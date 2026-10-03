'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync, spawn} = require('node:child_process');
const catalog = require('../src/command-catalog');
const {CommandSession} = require('../src/commands');
const {errorInfo} = require('../src/errors');
const {selectNode} = require('../src/node-runtime');
const root = path.resolve(__dirname, '..');
const cli = (args, input, env = {}) => spawnSync(process.execPath, [path.join(root, 'bin/tw.js'), ...args],
  {input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: {...process.env, ...env}});

test('doctor selects Node24 from the host PATH, checks native dependencies and honors invalid overrides', () => {
  const result = spawnSync('node', [path.join(root, 'bin/tw.js'), 'doctor', '--json'],
    {encoding: 'utf8', timeout: 30000, env: {...process.env, TW_NODE: process.execPath}});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1); assert.equal(report.selected.version.split('.')[0], '24');
  assert.equal(report.dependencies.length, 4); assert.ok(report.dependencies.every(item => item.loadable));
  const invalid = cli(['doctor', '--json'], undefined, {TW_NODE: '/does/not/exist/node24'});
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).selected, null);
  assert.equal(cli(['--version'], undefined, {TW_NODE: '/does/not/exist/node24'}).status, 1);
  assert.equal(cli(['doctor', '--json'], undefined, {TW_NODE: ''}).status, 1);
  const host = JSON.parse(spawnSync('node', ['-p', 'JSON.stringify({path:process.execPath,version:process.versions.node})'], {encoding: 'utf8'}).stdout);
  if (!host.version.startsWith('24.')) {
    const incompatible = cli(['doctor', '--json'], undefined, {TW_NODE: host.path});
    assert.equal(incompatible.status, 1); assert.equal(JSON.parse(incompatible.stdout).selected, null);
    const inherited = {...process.env}; delete inherited.TW_NODE;
    const auto = spawnSync('node', [path.join(root, 'bin/tw.js'), 'doctor', '--json'], {encoding: 'utf8', timeout: 30000, env: inherited});
    assert.equal(auto.status, 0, auto.stderr);
    assert.equal(JSON.parse(auto.stdout).current.version, host.version);
    assert.equal(JSON.parse(auto.stdout).selected.version.split('.')[0], '24');
  }
});

test('all entrypoints preserve a Node executable path containing spaces', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-node spaces-'));
  try {
    const executable = path.join(directory, 'node with spaces');
    await fs.symlink(process.execPath, executable);
    const result = cli(['--version'], undefined, {TW_NODE: executable});
    assert.equal(result.status, 0, result.stderr);
    const npm = spawnSync('npm', ['run', 'resources:check'], {cwd: root, encoding: 'utf8', timeout: 30000,
      env: {...process.env, TW_NODE: executable}});
    assert.equal(npm.status, 0, npm.stderr);
    const shell = spawnSync(path.join(root, 'tw'), ['doctor', '--json'], {encoding: 'utf8', timeout: 30000,
      env: {...process.env, TW_NODE: executable}});
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(JSON.parse(shell.stdout).selected.requestedPath, executable);
    const withoutPathNode = spawnSync(path.join(root, 'tw'), ['--version'], {encoding: 'utf8', timeout: 30000,
      env: {...process.env, PATH: '/usr/bin:/bin', TW_NODE: executable}});
    assert.equal(withoutPathNode.status, 0, withoutPathNode.stderr);
  } finally {await fs.rm(directory, {recursive: true, force: true});}
});

test('machine help shares every live rule and its annotated examples parse', () => {
  const report = catalog.commandHelp(undefined, true);
  let rules = 0;
  for (const [command, definition] of Object.entries(catalog.commandSpecs)) {
    const actions = definition.options ? [[null, definition]] : Object.entries(definition);
    for (const [action, rule] of actions) {
      rules++;
      const actual = report.commands.find(item => item.command === command && item.action === action);
      assert.equal(actual.minArguments, rule.min); assert.equal(actual.maxArguments, rule.max);
      assert.deepEqual(actual.options.map(item => item.name), rule.options);
      for (const example of actual.examples) assert.doesNotThrow(() => catalog.validateCommand(example));
    }
  }
  assert.equal(report.commands.length, rules);
  const filtered = JSON.parse(cli(['help', 'script', '--json']).stdout);
  assert.equal(filtered.commands.length, 3); assert.ok(filtered.commands.every(item => item.command === 'script'));
  const run = report.commands.find(item => item.command === 'run');
  assert.equal(run.options.find(item => item.name === 'frames').default, 30);
  assert.equal(run.options.find(item => item.name === 'seed').defaultKnown, false);
  const modules = require('../src/command-modules');
  assert.deepEqual([...catalog.BOOLEAN_OPTIONS].sort(), [...new Set(['force', 'compile', 'turbo', 'json', ...modules.booleanOptions])].sort());
  assert.equal(catalog.validateCommand(['gamepad', 'reset', '--empty', 'true']).options.empty, 'true');
  for (const [command, spec] of Object.entries(modules.specs)) assert.equal(catalog.commandSpecs[command], spec);
  assert.equal(errorInfo(new Error('Runtime exceeded 30 second limit')).code, 'RUNTIME_TIMEOUT');
});

test('catalog and help load no native runtime modules', () => {
  const source = `const Module=require('module'); const load=Module._load; Module._load=function(name,...args){
    if(/canvas|webgl|web-audio|scratch-vm|scratch-render/.test(name)||name.endsWith('/project'))throw Error('native load: '+name);
    return load.call(this,name,...args);}; process.argv=['node','tw','help','run','--json']; require('./src/cli-main').main();`;
  const result = spawnSync(process.execPath, ['-e', source], {cwd: root, encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).family, 'run');
});

test('JSONL keeps legacy envelopes, adds stable errors, and fail-fast stops consumption', () => {
  const requests = [{id: 1, command: 'help', args: ['run', '--json']},
    {id: 2, command: 'run', args: ['--framse', '2']}, {id: 3, command: 'help', args: []}];
  const input = requests.map(JSON.stringify).join('\n') + '\n';
  const continued = cli(['session', '--jsonl'], input);
  assert.equal(continued.status, 0, continued.stderr);
  const replies = continued.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 3); assert.match(replies[1].error, /Unknown option/);
  assert.equal(replies[1].errorInfo.code, 'UNKNOWN_OPTION'); assert.equal(replies[2].ok, true);
  const stopped = cli(['session', '--jsonl', '--fail-fast'], input);
  assert.equal(stopped.status, 1); assert.equal(stopped.stdout.trim().split('\n').length, 2);
  const dirty = cli(['session', '--jsonl', '--fail-fast'],
    [{command: 'new', args: []}, {command: 'sprite', args: ['set', 'x', 'bad']}, {command: 'quit', args: ['--force']}].map(JSON.stringify).join('\n')+'\n');
  assert.equal(dirty.status, 2); assert.equal(dirty.stdout.trim().split('\n').length, 2);
  const malformed = cli(['session', '--jsonl', '--fail-fast'], '{\n');
  assert.equal(malformed.status, 1); assert.equal(JSON.parse(malformed.stdout).errorInfo.code, 'INVALID_ARGUMENT');
  assert.equal(cli(['session', '--fail-fast']).status, 1);
});

test('normal native project loading stays quiet and output conflicts expose the target path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-errors-'));
  const session = new CommandSession();
  try {
    const project = path.join(directory, 'demo.sb3');
    const created = cli(['new', project]); assert.equal(created.status, 0, created.stderr);
    assert.doesNotMatch(created.stderr, /No rendering module present/);
    await session.execute(['open', project]);
    const output = path.join(directory, 'stage.png'); await session.execute(['render', output]);
    await assert.rejects(session.execute(['render', output]), error => {
      const info = errorInfo(error);
      assert.equal(info.code, 'OUTPUT_EXISTS'); assert.equal(info.details.path, output);
      assert.doesNotMatch(info.message, /\.tmp/); return true;
    });
    const capabilities = await session.execute(['capabilities', '--json']);
    assert.ok(capabilities.unsupported.find(item => item.id === 'whole-project-audio'));
    assert.equal((await session.execute(['check'])).releaseReady, false);
  } finally {session.dispose(); await fs.rm(directory, {recursive: true, force: true});}
});

test('fail-fast exits after a streamed failure even when the caller keeps stdin open', async () => {
  const child = spawn(process.execPath, [path.join(root, 'bin/tw.js'), 'session', '--jsonl', '--fail-fast'], {stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', stderr = '';
  child.stdout.on('data', bytes => {output += bytes;}); child.stderr.on('data', bytes => {stderr += bytes;});
  child.stdin.on('error', () => {});
  let timer;
  try {
    const closed = new Promise((resolve, reject) => {
      child.once('close', code => resolve(code)); child.once('error', reject);
      timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('fail-fast waited for stdin EOF'));}, 5000);
    });
    child.stdin.write('{"id":1,"command":"run","args":["--typo"]}\n{"id":2,"command":"help","args":[]}\n');
    assert.equal(await closed, 1, stderr);
    const replies = output.trim().split('\n').map(JSON.parse);
    assert.equal(replies.length, 1); assert.equal(replies[0].errorInfo.code, 'UNKNOWN_OPTION');
  } finally {clearTimeout(timer); child.stdin.destroy(); if (child.exitCode === null) child.kill('SIGKILL');}
});

test('selection explicitly prefers the current Node24 over the pinned fallback', () => {
  const before = process.env.TW_NODE; delete process.env.TW_NODE;
  try {assert.equal(selectNode().selected.path, process.execPath);}
  finally {if (before === undefined) delete process.env.TW_NODE; else process.env.TW_NODE = before;}
});

test('target-dependent block schema needs an open project and parser mistakes have stable codes', async () => {
  const session = new CommandSession();
  try {
    await assert.rejects(session.execute(['blocks', 'schema', 'looks_costume', '--target', 'Sprite1']), error => {
      assert.equal(errorInfo(error).code, 'RESOURCE_NOT_FOUND'); return true;
    });
    for (const argv of [['run', '--frames'], ['run', 'extra'], ['new', 'a.sb3', '--out', 'b.sb3']]) {
      assert.throws(() => catalog.validateCommand(argv), error => {assert.equal(errorInfo(error).code, 'INVALID_ARGUMENT'); return true;});
    }
    assert.throws(() => catalog.validateCommand(['help', '--out', 'x.sb3']), error => {assert.equal(errorInfo(error).code, 'UNKNOWN_OPTION'); return true;});
    await session.execute(['new']);
    for (const argv of [['var', 'set', 'missing', '1'], ['costume', 'use', 'missing'], ['sprite', 'select', 'missing'], ['list', 'get', 'missing']]) {
      await assert.rejects(session.execute(argv), error => {assert.equal(errorInfo(error).code, 'RESOURCE_NOT_FOUND'); return true;});
    }
    await session.execute(['runtime', 'start', '--paused', '--no-compile']);
    await assert.rejects(session.execute(['runtime', 'breakpoint', 'add', 'missing']), error => {
      assert.equal(errorInfo(error).code, 'RESOURCE_NOT_FOUND'); return true;
    });
    await session.execute(['runtime', 'stop']);
  } finally {session.dispose();}
});
