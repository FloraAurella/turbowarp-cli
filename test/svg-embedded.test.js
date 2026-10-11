const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const {NativeRenderer, rasterizeSVG} = require('../src/native-renderer');
const JSZip = require('@turbowarp/jszip');
const {Project, blankProject, svgCostume} = require('../src/project');
const zeroSVGs = [
  ['0x0 viewport', '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"/>', [0, 0]],
  ['zero width', '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="8"><rect width="8" height="8" fill="red"/></svg>', [0, 8]],
  ['zero height', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="0"><rect width="8" height="8" fill="red"/></svg>', [8, 0]],
  ['zero viewBox', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 0 0"><rect width="8" height="8" fill="red"/></svg>', [0, 0]],
  ['zero viewBox width with offset', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 7 0 8"><rect width="8" height="8" fill="red"/></svg>', [0, 8]],
  ['explicit zero pixel lengths', '<svg xmlns="http://www.w3.org/2000/svg" width="0px" height="0px"/>', [0, 0]]
];

test('embedded PNG SVG rasterization preserves opaque and translucent pixel colors', () => {
  const canvas = createCanvas(2, 1); const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1);
  context.fillStyle = 'rgba(0,0,255,0.5)'; context.fillRect(1, 0, 1, 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><image width="2" height="1" href="data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}"/></svg>`;
  const image = rasterizeSVG(svg, 2, 1);
  assert.deepEqual(Array.from(image.data.subarray(0, 4)), [255, 0, 0, 255]);
  assert.ok(image.data[6] >= 250); assert.ok(image.data[7] >= 126 && image.data[7] <= 128);
  const scaled = rasterizeSVG(svg, 4, 2);
  assert.equal(scaled.width, 4); assert.equal(scaled.height, 2);
  assert.ok(scaled.data.some((value, index) => index % 4 === 3 && value > 0));
  assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
});

test('embedded PNG skin is visible in actual ANGLE stage output', async () => {
  const source = createCanvas(8, 8); source.getContext('2d').fillStyle = '#00ff00'; source.getContext('2d').fillRect(0, 0, 8, 8);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><image width="8" height="8" href="data:image/png;base64,${source.toBuffer('image/png').toString('base64')}"/></svg>`;
  const renderer = new NativeRenderer(32, 32);
  try {
    renderer.setLayerGroupOrdering(['sprite']);
    const skin = renderer.createSVGSkin(svg);
    const drawable = renderer.createDrawable('sprite'); renderer.updateDrawableSkinId(drawable, skin);
    const image = await loadImage(renderer.png());
    const canvas = createCanvas(32, 32); canvas.getContext('2d').drawImage(image, 0, 0);
    assert.deepEqual(Array.from(canvas.getContext('2d').getImageData(16, 16, 1, 1).data), [0, 255, 0, 255]);
    assert.equal(renderer.isTouchingColor(drawable, [255, 255, 255]), true);
  } finally {renderer.dispose();}
});

test('zero-dimension SVGs are empty transparent skins with no sprite or color collision', async () => {
  const renderer = new NativeRenderer(32, 32);
  try {
    renderer.setLayerGroupOrdering(['sprite']);
    const solidSkin = renderer.createSVGSkin('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>');
    const solid = renderer.createDrawable('sprite'); renderer.updateDrawableSkinId(solid, solidSkin);
    for (const [name, source, dimensions] of zeroSVGs) {
      const skinId = renderer.createSVGSkin(source, [17, 23]);
      const skin = renderer._allSkins[skinId];
      assert.deepEqual(skin.size, dimensions, name);
      assert.deepEqual(Array.from(skin.rotationCenter).slice(0, 2), [0, 0], name);
      assert.equal(skin.getTexture([100, 100]), null, name);
      const drawable = renderer.createDrawable('sprite'); renderer.updateDrawableSkinId(drawable, skinId);
      assert.equal(renderer.isTouchingDrawables(drawable, [solid]), false, name);
      assert.equal(renderer.isTouchingDrawables(solid, [drawable]), false, name);
      assert.equal(renderer.isTouchingColor(drawable, [255, 255, 255]), false, name);
      assert.equal(renderer.pick(16, 16), solid, name);
      renderer.destroyDrawable(drawable, 'sprite'); renderer.destroySkin(skinId);
    }
    // Becoming empty must discard the previous opaque silhouette and MIPs.
    renderer.updateSVGSkin(solidSkin, zeroSVGs[0][1]);
    assert.equal(renderer.isTouchingColor(solid, [255, 255, 255]), false);
    assert.equal(renderer.pick(16, 16), -1);
    const image = await loadImage(renderer.png()), canvas = createCanvas(32, 32);
    canvas.getContext('2d').drawImage(image, 0, 0);
    assert.deepEqual(Array.from(canvas.getContext('2d').getImageData(16, 16, 1, 1).data), [255, 255, 255, 255]);
    renderer.updateSVGSkin(solidSkin, '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" viewBox="0 0 8 8"><rect width="8" height="8" fill="red"/></svg>');
    assert.deepEqual(renderer._allSkins[solidSkin].size, [8, 8], 'positive viewBox remains authoritative');
    assert.equal(renderer.pick(16, 16), solid);
  } finally {renderer.dispose();}
});

test('zero-dimension SVG still rejects executable resources and invalid dimensions', () => {
  const renderer = new NativeRenderer(32, 32);
  try {
    for (const body of ['<script>alert(1)</script>', '<image href="file:///etc/passwd"/>', '<rect onclick="alert(1)"/>', '<style>@import "https://example.invalid/x";</style>',
      '<image href="data:image/png;base64,PHN2Zz48c2NyaXB0Pjwv c2NyaXB0Pjwvc3ZnPg=="/>']) {
      assert.throws(() => renderer.createSVGSkin(`<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0">${body}</svg>`), /denied/, body);
    }
    assert.throws(() => renderer.createSVGSkin('<!DOCTYPE svg [<!ENTITY x "bad">]><svg width="0" height="0"/>'), /denied/);
    for (const dimensions of ['viewBox="0 0 -1 0"', 'viewBox="0 0 NaN 0"', 'viewBox="0 0 0 Infinity"', 'viewBox="0 0 0"',
      'width="-1" height="0"', 'width="-1em" height="0"', 'width="NaN" height="0"', 'width="invalid" height="0"', 'width="1e309" height="0"']) {
      assert.throws(() => renderer.createSVGSkin(`<svg xmlns="http://www.w3.org/2000/svg" ${dimensions}/>`), /invalid/);
    }
  } finally {renderer.dispose();}
});

test('real SB3 loads, renders and saves zero-size SVG costumes without changing asset bytes', async () => {
  const project = new Project();
  try {
    for (const [name, source, dimensions] of zeroSVGs) {
      const zip = await JSZip.loadAsync(await blankProject()), json = JSON.parse(await zip.file('project.json').async('string'));
      const costume = svgCostume(name, source);
      json.targets[1].costumes = [costume];
      zip.file(costume.md5ext, source); zip.file('project.json', JSON.stringify(json));
      await project.load(await zip.generateAsync({type: 'nodebuffer'}));
      for (let round = 0; round < 2; round++) {
        const target = project.target('Sprite1'), loaded = target.getCostumes()[0];
        assert.deepEqual(project.renderer._allSkins[loaded.skinId].size, dimensions, name);
        assert.equal(loaded.asset.decodeText(), source, name);
        assert.equal(project.renderer.isTouchingColor(target.drawableID, [255, 255, 255]), false, name);
        const rendered = await loadImage(project.renderer.png()), canvas = createCanvas(480, 360);
        canvas.getContext('2d').drawImage(rendered, 0, 0);
        assert.deepEqual(Array.from(canvas.getContext('2d').getImageData(240, 180, 1, 1).data), [255, 255, 255, 255], name);
        const saved = await project.bytes(), archive = await JSZip.loadAsync(saved);
        assert.equal(await archive.file(costume.md5ext).async('string'), source, name);
        await project.load(saved);
      }
    }
  } finally {project.dispose();}
});
