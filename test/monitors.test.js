const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {CommandSession} = require('../src/commands');

test('monitor ranges, modes, positions and list CSV survive project reload and undo', async () => {
  const session = new CommandSession(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-monitors-'));
  try {
    await session.execute(['new']);
    await session.execute(['var', 'add', 'score', '0']);
    await session.execute(['monitor', 'add', 'score']);
    await session.execute(['monitors', 'mode', 'score', 'slider']);
    await session.execute(['monitors', 'range', 'score', '0.0', '10.0']);
    await session.execute(['monitors', 'move', 'score', '12', '34']);
    await session.execute(['monitors', 'size', 'score', '80', '40']);
    await session.execute(['monitors', 'hide', 'score']);
    let monitor = (await session.execute(['monitors', 'list']))[0];
    assert.equal(monitor.isDiscrete, false); assert.equal(monitor.visible, false);
    assert.equal(monitor.x, 12); assert.equal(monitor.y, 34);
    await session.execute(['list', 'add', 'items', '[]']);
    const csv = path.join(dir, 'items.csv'); await fs.writeFile(csv, 'name,count\r\n"a,b",1\r\n"quote""d",2\r\n');
    await session.execute(['monitors', 'import-list', 'items', csv, '--column', '1']);
    assert.deepEqual((await session.execute(['list', 'get', 'items'])).value, ['name', 'a,b', 'quote"d']);
    const output = path.join(dir, 'export.json');
    await session.execute(['monitors', 'export-list', 'items', output, '--format', 'json']);
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), ['name', 'a,b', 'quote"d']);
    await session.execute(['monitors', 'delete-item', 'items', '1']);
    await session.execute(['undo']);
    assert.equal((await session.execute(['list', 'get', 'items'])).value[0], 'name');
    const project = path.join(dir, 'project.sb3'); await session.execute(['save', project]); await session.execute(['open', project]);
    monitor = (await session.execute(['monitors', 'list']))[0];
    assert.equal(monitor.mode, 'slider'); assert.equal(monitor.sliderMax, 10); assert.equal(monitor.isDiscrete, false);
    await assert.rejects(session.execute(['monitors', 'range', 'score', '10', '0']), /minimum/);
    assert.equal((await session.execute(['monitors', 'list']))[0].sliderMax, 10);
  } finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
});
