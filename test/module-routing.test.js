const assert = require('node:assert/strict');
const {test} = require('node:test');
const {CommandSession, commandHelp, commandSpecs, validateCommand} = require('../src/commands');

test('registered module rules reject unknown options before mutating a session', async () => {
  const session = new CommandSession();
  try {
    await session.execute(['new']);
    const before = await session.snapshot();
    await assert.rejects(session.execute(['settings', 'set', 'turbo', 'on', '--evil', 'yes']), /Unknown option/);
    assert.deepEqual(await session.snapshot(), before);
    assert.ok(commandHelp('settings').includes('settings size'));
    assert.ok(commandHelp().includes('settings'));
    for (const [command, rules] of Object.entries(commandSpecs)) {
      if (rules.options) continue;
      for (const [action, rule] of Object.entries(rules)) {
        assert.ok(Number.isInteger(rule.min) && rule.min >= 0 && Number.isInteger(rule.max) && rule.max >= rule.min);
        assert.ok(Array.isArray(rule.options));
        assert.equal(new Set(rule.options).size, rule.options.length, `${command} ${action} option duplicate`);
      }
    }
  } finally {session.dispose();}
});

test('history keeps 99 small snapshots and bounds total retained bytes', () => {
  const session = new CommandSession();
  try {
    const small = Array.from({length: 101}, (_, index) => ({label: String(index), bytes: Buffer.alloc(1)}));
    session.trimHistory(small);
    assert.equal(small.length, 99);
    assert.equal(small[0].label, '2');
    const large = [{bytes: {length: 120 * 1024 * 1024}}, {bytes: {length: 120 * 1024 * 1024}}];
    session.trimHistory(large);
    assert.equal(large.length, 1);
  } finally {session.dispose();}
});

test('project output and external resource output options are distinct', () => {
  assert.throws(() => validateCommand(['settings', 'export', 'state.json', '--out', 'state.sb3']), /not allowed/);
  assert.throws(() => validateCommand(['settings', 'size', '640', '480', '--out', 'project.png']), /sb3/);
  assert.equal(validateCommand(['settings', 'set', 'turbo', 'on', '--out', 'project.sb3']).options.out, 'project.sb3');
});
