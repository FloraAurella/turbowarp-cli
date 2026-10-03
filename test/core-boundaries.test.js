const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {CommandSession} = require('../src/commands');
const {blankProject} = require('../src/project');

const withSession = async operation => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-core-boundary-')));
  const session = new CommandSession();
  try {await operation(session, dir);} finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
};

test('core imports refuse symlink files and retain the current project', async () => withSession(async (session, dir) => {
  const file = path.join(dir, 'safe.sb3'); await fs.writeFile(file, await blankProject());
  await session.execute(['open', file]);
  const link = path.join(dir, 'alias.sb3'); await fs.symlink(file, link);
  const before = await session.snapshot(), history = await session.execute(['history']);
  for (const args of [['open', link], ['sprite', 'add', 'Alias', '--file', link], ['costume', 'add', link], ['sound', 'add', link]]) {
    await assert.rejects(session.execute(args), /ELOOP|symlink|regular file/);
    assert.deepEqual(await session.snapshot(), before);
    assert.deepEqual(await session.execute(['history']), history);
    assert.equal(session.dirty, false);
  }
}));

test('--project semantic failure restores file identity, history and session settings', async () => withSession(async (session, dir) => {
  const alpha = path.join(dir, 'alpha.sb3'), beta = path.join(dir, 'beta.sb3');
  await session.execute(['new', alpha]);
  await session.execute(['sprite', 'rename', 'Alpha']);
  await session.execute(['settings', 'set', 'compiler', 'true']);
  await session.execute(['settings', 'set', 'username', 'User Alpha']);
  await session.execute(['save']);
  const other = new CommandSession();
  try {
    await other.execute(['new', beta]); await other.execute(['sprite', 'rename', 'Beta']); await other.execute(['save']);
  } finally {other.dispose();}
  const before = await session.snapshot(), state = session.sessionState(), history = await session.execute(['history']);
  const originalVM = session.project.vm;
  await assert.rejects(session.execute(['sprite', 'set', 'size', '-1', '--project', beta]), /Size/);
  assert.equal(session.project.vm, originalVM);
  assert.deepEqual(await session.snapshot(), before);
  assert.equal(session.project.file, alpha); assert.equal(session.dirty, false);
  assert.deepEqual(session.sessionState(), state);
  assert.deepEqual(await session.execute(['history']), history);
  assert.equal((await session.execute(['settings', 'get', 'username'])).value, 'User Alpha');
}));

test('preferences and monitor list imports use bounded no-symlink files', async () => withSession(async (session, dir) => {
  const config = path.join(dir, 'prefs.json'), link = path.join(dir, 'prefs-link.json');
  await session.execute(['pref', 'set', 'locale', 'zh-cn', '--config', config]);
  await fs.symlink(config, link);
  await assert.rejects(session.execute(['pref', 'list', '--config', link]), /symlink/);
  const oversized = path.join(dir, 'large.json'); await fs.writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(session.execute(['pref', 'list', '--config', oversized]), /bytes/);
  const invalid = path.join(dir, 'prototype.json'); await fs.writeFile(invalid, '{"v2":{"__proto__":{}}}');
  await assert.rejects(session.execute(['pref', 'list', '--config', invalid]), /prototype/);
  await session.execute(['new']); await session.execute(['list', 'add', 'Items', '[1,2]']);
  const csv = path.join(dir, 'list.csv'), csvLink = path.join(dir, 'list-link.csv');
  await fs.writeFile(csv, 'item\n'); await fs.symlink(csv, csvLink);
  const before = await session.snapshot();
  await assert.rejects(session.execute(['monitors', 'import-list', 'Items', csvLink]), /symlink/);
  assert.deepEqual(await session.snapshot(), before);
}));

test('one-shot library load persists its actual sprite through --out and rejected output restores the original VM', async () => withSession(async (session, dir) => {
  const input = path.join(dir, 'input.sb3'), output = path.join(dir, 'library.sb3');
  await session.execute(['new', input]);
  const result = await session.execute(['library', 'load', 'sprite', 'Cat 2', '--project', input, '--out', output]);
  assert.ok(result); assert.equal(session.dirty, false); assert.equal(session.project.file, output);
  const loaded = new CommandSession();
  try {
    await loaded.execute(['open', output]);
    assert.ok(loaded.project.info().targets.some(target => target.name === 'Cat 2'));
  } finally {loaded.dispose();}
  const vm = session.project.vm, state = session.sessionState(), before = await session.snapshot();
  await assert.rejects(session.execute(['library', 'load', 'sprite', 'Cat 2', '--project', input, '--out', output]), /EEXIST/);
  assert.equal(session.project.vm, vm); assert.deepEqual(await session.snapshot(), before);
  assert.deepEqual(session.sessionState(), state); assert.equal(session.project.file, output);
}));

test('simple package alias uses shared safe options and refuses missing data-provider conversion', async () => withSession(async (session, dir) => {
  await session.execute(['new']);
  await session.execute(['pack', 'set', 'app.windowTitle', 'Shared title']);
  const output = path.join(dir, 'safe.html');
  const result = await session.execute(['package', output]);
  assert.equal(result.target, 'html'); assert.equal(result.launched, false);
  const html = await fs.readFile(output, 'utf8'); assert.ok(html.includes('Shared title'));
  await session.execute(['ext', 'load', 'videoSensing']);
  await session.execute(['block', 'add', 'videoSensing_videoOn', '--fields', '{"ATTRIBUTE":"motion","SUBJECT":"Stage"}']);
  const denied = path.join(dir, 'denied.html');
  await assert.rejects(session.execute(['package', denied]), /missing-data-provider-conversion/);
  await assert.rejects(fs.stat(denied), {code: 'ENOENT'});
  await assert.rejects(session.execute(['package', dir + '/../escape.html']), /traversal|不安全/);
}));
