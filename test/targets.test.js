const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {CommandSession} = require('../src/commands');

test('sprite-pane order, folders, draggable property and layer order remain distinct', async () => {
  const session = new CommandSession(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-targets-'));
  try {
    await session.execute(['new']);
    await session.execute(['sprite', 'add', 'Other']);
    const first = session.project.target('Sprite1'); const second = session.project.target('Other');
    const originalLayers = [first.getLayerOrder(), second.getLayerOrder()];
    await session.execute(['targets', 'reorder', 'Other', '0']);
    assert.deepEqual(session.project.info().targets.map(target => target.name), ['Stage', 'Other', 'Sprite1']);
    assert.deepEqual([first.getLayerOrder(), second.getLayerOrder()], originalLayers);
    await session.execute(['targets', 'folder-add', 'Friends', '--target', 'Sprite1']);
    await session.execute(['targets', 'folder-rename', 'Friends', 'Team']);
    assert.ok(session.project.target('Team//Sprite1'));
    await session.execute(['targets', 'draggable', 'true', '--target', 'Team//Sprite1']);
    assert.equal(session.project.target('Team//Sprite1').draggable, true);
    await session.execute(['targets', 'folder-remove-all', 'Team']);
    const file = path.join(dir, 'sprites.sb3'); await session.execute(['save', file]); await session.execute(['open', file]);
    assert.deepEqual(session.project.info().targets.map(target => target.name), ['Stage', 'Other', 'Sprite1']);
    assert.equal(session.project.target('Sprite1').draggable, true);
    assert.equal(session.project.target(first.id).id, first.id);
    await assert.rejects(session.execute(['targets', 'reorder', 'Stage', '0']), /stage/i);
    assert.equal(session.project.info().targets[0].name, 'Stage');
  } finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
});
