const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {loadImage, createCanvas} = require('@napi-rs/canvas');
const {CommandSession} = require('../src/commands');

test('settings changes use VM project-options comment and survive SB3 reload', async () => {
  const session = new CommandSession();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-settings-'));
  try {
    await session.execute(['new']);
    await session.execute(['settings', 'set', 'fps', '60']);
    await session.execute(['settings', 'set', 'turbo', 'on']);
    await session.execute(['settings', 'set', 'fencing', 'off']);
    await session.execute(['settings', 'set', 'maxClones', '500']);
    await session.execute(['settings', 'set', 'highQuality', 'on']);
    await session.execute(['settings', 'size', '640', '480']);
    const image = await loadImage(session.project.renderer.png());
    assert.equal(image.width, 640); assert.equal(image.height, 480);
    const canvas = createCanvas(640, 480); canvas.getContext('2d').drawImage(image, 0, 0);
    const pixel = canvas.getContext('2d').getImageData(320, 240, 1, 1).data;
    assert.ok(pixel[0] > 200 && pixel[1] < 150);
    const file = path.join(dir, 'settings.sb3'); await session.execute(['save', file]);
    await session.execute(['open', file]);
    const result = (await session.execute(['settings', 'list'])).values;
    assert.equal(result.fps, 60); assert.equal(result.turbo, true); assert.equal(result.fencing, false);
    assert.equal(result.maxClones, 500); assert.equal(result.highQuality, true);
    assert.equal(result.width, 640); assert.equal(result.height, 480);
    await assert.rejects(session.execute(['settings', 'size', '4096', '4096']), /limit/);
    assert.equal((await session.execute(['settings', 'get', 'width'])).value, 640);
    assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
  } finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
});

test('settings validates types and editor compiler stays disabled', async () => {
  const session = new CommandSession();
  try {
    await session.execute(['new']);
    await assert.rejects(session.execute(['settings', 'set', 'maxClones', '1.5']), /integer/);
    await assert.rejects(session.execute(['settings', 'set', 'turbo', 'yes']), /true/);
    await session.execute(['settings', 'set', 'compiler', 'true']);
    await session.execute(['settings', 'set', 'username', '测试用户']);
    assert.equal(session.project.vm.runtime.compilerOptions.enabled, false);
    assert.equal((await session.execute(['settings', 'get', 'compiler'])).value, true);
    assert.equal(session.inputs.find(input => input.device === 'userData').data.username, '测试用户');
    await session.execute(['undo']);
    assert.equal(session.inputs.some(input => input.device === 'userData'), false);
    await session.execute(['undo']);
    assert.equal((await session.execute(['settings', 'get', 'compiler'])).value, false);
    await session.execute(['redo']);
    assert.equal((await session.execute(['settings', 'get', 'compiler'])).value, true);
  } finally {session.dispose();}
});
