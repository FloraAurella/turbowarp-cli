const assert = require('node:assert/strict');
const {test} = require('node:test');
const {ImageData, createCanvas, loadImage} = require('@napi-rs/canvas');
const {NativeRenderer: Renderer} = require('../src/native-renderer');
class NativeRenderer extends Renderer {
  constructor(...args) {super(...args); this.setLayerGroupOrdering(['pen', 'sprite']);}
}
const {Project, blankProject} = require('../src/project');
const JSZip = require('@turbowarp/jszip');

// Analytic fixtures, not captured GUI screenshots: +y is up in Scratch and down in PNG.
const rgba = (width, height, pixel) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return new ImageData(data, width, height);
};
const pixels = async renderer => {
  const image = await loadImage(renderer.png());
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data;
};
const at = (data, width, x, y) => Array.from(data.subarray((y * width + x) * 4, (y * width + x + 1) * 4));
const sprite = (renderer, skin, position = [0, 0], scale = [100, 100]) => {
  const id = renderer.createDrawable('sprite');
  renderer.updateDrawableSkinId(id, skin);
  renderer.updateDrawablePosition(id, position);
  renderer.updateDrawableDirectionScale(id, 90, scale);
  return id;
};
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">${body}</svg>`;

test('interleaved native renderers survive peer disposal and repeated disposal without handle aliasing', async () => {
  const a = new NativeRenderer(32, 24), b = new NativeRenderer(32, 24);
  try {
    a.setBackgroundColor(1, 0, 0); b.setBackgroundColor(0, 0, 1);
    sprite(a, a.createBitmapSkin(rgba(4, 4, () => [0, 255, 0, 255]), 1));
    sprite(b, b.createBitmapSkin(rgba(4, 4, () => [255, 255, 0, 255]), 1));
    for (let iteration = 0; iteration < 3; iteration++) {
      const ap = await pixels(a), bp = await pixels(b);
      assert.deepEqual(at(ap, 32, 4, 3), [255, 0, 0, 255]);
      assert.deepEqual(at(bp, 32, 4, 3), [0, 0, 255, 255]);
      assert.deepEqual(at(ap, 32, 16, 12), [0, 255, 0, 255]);
      assert.deepEqual(at(bp, 32, 16, 12), [255, 255, 0, 255]);
    }
    const texture = a.gl.createTexture();
    a.gl.bindTexture(a.gl.TEXTURE_2D, texture);
    assert.strictEqual(a.gl.getParameter(a.gl.TEXTURE_BINDING_2D), texture);
    assert.throws(() => b.gl.bindTexture(b.gl.TEXTURE_2D, texture), /context|handle/i);
    assert.throws(() => a.gl.bindTexture(a.gl.TEXTURE_2D, {nativeHandle: texture.nativeHandle}), /handle/i);
    const buffer = a.gl.createBuffer();
    assert.throws(() => a.gl.bindTexture(a.gl.TEXTURE_2D, buffer), /handle|Texture/i);
    a.gl.deleteBuffer(buffer);
    a.gl.deleteTexture(texture); a.gl.deleteTexture(texture);
    assert.equal(a.gl._nativeKinds.Texture.has(texture), false);
    a.dispose(); a.dispose();
    assert.deepEqual(at(await pixels(b), 32, 4, 3), [0, 0, 255, 255]);
    const c = new NativeRenderer(32, 24);
    try {c.setBackgroundColor(0, 1, 0); assert.deepEqual(at(await pixels(c), 32, 1, 1), [0, 255, 0, 255]);}
    finally {c.dispose();}
    assert.deepEqual(at(await pixels(b), 32, 4, 3), [0, 0, 255, 255]);
  } finally {a.dispose(); b.dispose();}
});

test('asymmetric bitmap fixture checks every PNG pixel, resolution, position and integer scaling', async () => {
  const r = new NativeRenderer(32, 24);
  try {
    const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0]];
    const skin = r.createBitmapSkin(rgba(4, 4, (x, y) => colors[(y >= 2 ? 2 : 0) + (x >= 2 ? 1 : 0)]), 2);
    sprite(r, skin, [5, 3], [400, 400]);
    assert.deepEqual(r.getSkinSize(skin), [2, 2]);
    const data = await pixels(r);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
      const inside = x >= 17 && x < 25 && y >= 5 && y < 13;
      const expected = inside ? colors[(y >= 9 ? 2 : 0) + (x >= 21 ? 1 : 0)] : [255, 255, 255, 255];
      assert.deepEqual(at(data, 32, x, y), expected[3] ? expected : [255, 255, 255, 255], `pixel ${x},${y}`);
    }
  } finally {r.dispose();}
});

test('cardinal rotations and mirrored bitmap scaling preserve asymmetric pixel placement', async () => {
  const r = new NativeRenderer(32, 24);
  try {
    const fixture = rgba(4, 2, (x, y) => [40 + x * 45, y * 160, 20 + x * 10, 255]);
    const id = sprite(r, r.createBitmapSkin(fixture, 1), [5, 3]);
    for (const direction of [90, 0, -90, 180]) for (const sx of [100, -100]) {
      r.updateDrawableDirectionScale(id, direction, [sx, 100]);
      const expected = rgba(32, 24, () => [255, 255, 255, 255]).data;
      const angle = (90 - direction) * Math.PI / 180;
      for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
        const localX = (x + 0.5 - 2) * sx / 100, localY = 1 - y - 0.5;
        const rotatedX = localX * Math.cos(angle) - localY * Math.sin(angle);
        const rotatedY = localX * Math.sin(angle) + localY * Math.cos(angle);
        const screenX = Math.round(16 + 5 + rotatedX - 0.5), screenY = Math.round(12 - 3 - rotatedY - 0.5);
        expected.set(at(fixture.data, 4, x, y), (screenY * 32 + screenX) * 4);
      }
      assert.deepEqual(await pixels(r), expected, `direction=${direction}, x scale=${sx}`);
    }
  } finally {r.dispose();}
});

test('premultiplied textures blend correctly; transparent PNG output is straight alpha', async () => {
  const r = new NativeRenderer(16, 16);
  try {
    sprite(r, r.createBitmapSkin(rgba(4, 4, () => [255, 0, 0, 128]), 1));
    assert.deepEqual(at(await pixels(r), 16, 8, 8), [255, 127, 127, 255]);
    r.setBackgroundColor(0, 0, 0, 0);
    assert.deepEqual(at(await pixels(r), 16, 8, 8), [255, 0, 0, 128]);
    assert.deepEqual(at(await pixels(r), 16, 0, 0), [0, 0, 0, 0]);
  } finally {r.dispose();}
});

test('snapshot reads the completed framebuffer once without recursively drawing', () => {
  const r = new NativeRenderer(16, 16);
  try {
    const snapshots = [];
    r.requestSnapshot(data => snapshots.push(data));
    r.png();
    assert.equal(snapshots.length, 1);
    assert.match(snapshots[0], /^data:image\/png;base64,/);
  } finally {r.dispose();}
});

test('SVG viewBox determines logical size/offset; zoom uses rerasterized power-of-two MIPs', async () => {
  const r = new NativeRenderer(64, 64);
  try {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="10 20 8 8"><rect x="10" y="20" width="8" height="8" fill="red"/></svg>';
    const id = r.createSVGSkin(source, [12, 23]);
    const skin = r._allSkins[id];
    assert.deepEqual(skin.size, [8, 8]);
    assert.deepEqual(Array.from(skin.rotationCenter).slice(0, 2), [2, 3]);
    skin.getTexture([400, 400]);
    assert.deepEqual(skin.size, [8, 8]);
    assert.equal(skin._silhouette._width, 32);
    assert.equal(skin.useNearest([100, 100], {_direction: 90, enabledEffects: 0}), true);
    assert.equal(skin.useNearest([400, 400], {_direction: 90, enabledEffects: 0}), false);
    r.updateBitmapSkin(id, rgba(2, 2, () => [0, 255, 0, 255]), 1);
    assert.equal(skin.vector, false, 'SVG -> bitmap clears vector state and cached MIPs');
    sprite(r, id);
    assert.deepEqual(at(await pixels(r), 64, 32, 32), [0, 255, 0, 255]);
  } finally {r.dispose();}
});

test('zoomed SVG image matches a fresh high-resolution native raster, not a stretched 1x bitmap', async () => {
  const r = new NativeRenderer(64, 64);
  try {
    const source = svg('<path d="M0 0 L8 8 L0 8 Z" fill="red"/>');
    sprite(r, r.createSVGSkin(source), [0, 0], [400, 400]);
    const {Image} = require('@napi-rs/canvas');
    const image = new Image(32, 32); image.src = Buffer.from(source);
    const canvas = createCanvas(32, 32); canvas.getContext('2d').drawImage(image, 0, 0);
    const oracle = canvas.getContext('2d').getImageData(0, 0, 32, 32).data;
    const data = await pixels(r);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const p = at(oracle, 32, x, y);
      const expected = p.slice(0, 3).map(c => Math.round(c * p[3] / 255 + 255 - p[3])).concat(255);
      assert.deepEqual(at(data, 64, x + 16, y + 16), expected, `scaled SVG pixel ${x},${y}`);
    }
  } finally {r.dispose();}
});

test('SVG rejects encoded external/executable resources but accepts local paint references and raster data', () => {
  const r = new NativeRenderer(16, 16);
  try {
    const denied = [
      '<script/>', '<foreignObject/>', '<s:script xmlns:s="http://www.w3.org/2000/svg"/>', '<rect onload="alert(1)"/>',
      '<image href="https://example.invalid/image.png"/>', '<image href="&#104;ttps://example.invalid/image.png"/>',
      '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>', '<image href="data:image/png;base64,PHN2Zy8+"/>', '<image href="data:text/html,evil"/>',
      '<style>@import "https://example.invalid/font.css";</style>',
      '<style><![CDATA[@import "https://example.invalid/font.css";]]></style>',
      '<style>rect {fill: u\\72l(https://example.invalid/paint)}</style>',
      '<rect style="fill:url(&#104;ttps://example.invalid/paint)"/>',
      '<animate attributeName="href" to="https://example.invalid/image.png"/>'
    ];
    for (const body of denied) assert.throws(() => r.createSVGSkin(svg(body)), /denied|SVG/i, body);
    assert.throws(() => r.createSVGSkin('<!DOCTYPE svg [<!ENTITY x "evil">]>' + svg('')), /denied|SVG/i);
    assert.doesNotThrow(() => r.createSVGSkin(svg('<defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="8" height="8" fill="url(#g)"/>')));
    const canvas = createCanvas(1, 1);
    const raster = canvas.toBuffer('image/png').toString('base64');
    assert.doesNotThrow(() => r.createSVGSkin(svg(`<image width="8" height="8" href="data:image/png;base64,${raster}"/>`)));
  } finally {r.dispose();}
});

test('pen line, stamp, clear and CPU/GPU touching-color use the same asymmetric pixels', async () => {
  const r = new NativeRenderer(64, 64);
  try {
    const pen = r.createPenSkin();
    const penDrawable = r.createDrawable('pen'); r.updateDrawableSkinId(penDrawable, pen);
    r.penLine(pen, {color4f: [1, 0, 0, 1], diameter: 4}, -12, 10, 12, 10);
    const tester = sprite(r, r.createBitmapSkin(rgba(4, 4, () => [0, 0, 255, 255]), 1), [0, 10]);
    for (const mode of ['ForceCPU', 'ForceGPU']) {
      r.setUseGpuMode(Renderer.UseGpuModes[mode]);
      assert.equal(r.isTouchingColor(tester, [255, 0, 0]), true, mode);
      assert.equal(r.isTouchingColor(tester, [0, 255, 0]), false, mode);
    }
    r.updateDrawablePosition(tester, [0, -10]);
    assert.equal(r.isTouchingDrawables(tester, [penDrawable]), false);
    const data = await pixels(r);
    assert.deepEqual(at(data, 64, 32, 22), [255, 0, 0, 255]);
    assert.deepEqual(at(data, 64, 32, 42), [0, 0, 255, 255]);
    r.penStamp(pen, tester); r.updateDrawableVisible(tester, false);
    assert.deepEqual(at(await pixels(r), 64, 32, 42), [0, 0, 255, 255]);
    r.penClear(pen);
    assert.deepEqual(at(await pixels(r), 64, 32, 42), [255, 255, 255, 255]);
    assert.equal(r.gl.getError(), r.gl.NO_ERROR);
  } finally {r.dispose();}
});

test('transparent holes, visibility and ghost obey frozen Scratch collision and mask semantics', () => {
  const r = new NativeRenderer(64, 64);
  try {
    const hole = sprite(r, r.createBitmapSkin(rgba(16, 16, (x, y) => x >= 3 && x < 13 && y >= 3 && y < 13 ? [0, 0, 0, 0] : [255, 0, 0, 255]), 1));
    const tester = sprite(r, r.createBitmapSkin(rgba(2, 2, () => [0, 0, 255, 255]), 1));
    assert.equal(r.isTouchingDrawables(tester, [hole]), false);
    r.updateDrawablePosition(tester, [6, 0]);
    assert.equal(r.isTouchingDrawables(tester, [hole]), true);
    r.updateDrawableEffect(tester, 'ghost', 100);
    assert.equal(r.isTouchingDrawables(tester, [hole]), true, 'ghost is ignored for collisions');
    for (const mode of ['ForceCPU', 'ForceGPU']) {
      r.setUseGpuMode(Renderer.UseGpuModes[mode]);
      assert.equal(r.isTouchingColor(tester, [255, 0, 0], [0, 0, 255]), true);
      assert.equal(r.isTouchingColor(tester, [255, 0, 0], [0, 255, 0]), false);
    }
    r.updateDrawableVisible(tester, false);
    assert.equal(r.isTouchingDrawables(tester, [hole]), false);
    assert.equal(r.isTouchingColor(tester, [255, 0, 0]), true, 'color sensing ignores tester visibility');
  } finally {r.dispose();}
});

test('bubble rerasterization preserves logical size and matches its frozen canvas geometry', async () => {
  const r = new NativeRenderer(200, 160);
  try {
    for (const type of ['say', 'think']) for (const left of [true, false]) {
      const id = r.createTextSkin(type, 'hello\n世界', left), skin = r._allSkins[id];
      const size = skin.size.slice();
      for (const scale of [100, 200, 50, 100]) {
        skin.getTexture([scale, scale]);
        assert.deepEqual(skin.size, size);
        assert.deepEqual(Array.from(skin.rotationCenter).slice(0, 2), [0, 0]);
        assert.equal(skin._silhouette._width, Math.ceil(size[0] * scale / 100));
      }
      const drawable = sprite(r, id, [-80, 60]);
      const data = await pixels(r);
      const oracle = skin._canvas.getContext('2d').getImageData(0, 0, skin._canvas.width, skin._canvas.height).data;
      for (let y = 0; y < skin._canvas.height; y++) for (let x = 0; x < skin._canvas.width; x++) {
        const p = at(oracle, skin._canvas.width, x, y);
        const expected = p.slice(0, 3).map(c => Math.round(c * p[3] / 255 + 255 - p[3])).concat(255);
        const actual = at(data, 200, x + 20, y + 20);
        assert.ok(actual.every((c, i) => Math.abs(c - expected[i]) <= 1), `${type}/${left}: pixel ${x},${y}`);
      }
      r.destroyDrawable(drawable, 'sprite'); r.destroySkin(id);
    }
  } finally {r.dispose();}
});

test('pen skin resize/disposal releases native textures, framebuffers and attribute buffers', () => {
  const r = new NativeRenderer(32, 32);
  try {
    // Warm the persistent shader cache before checking per-skin resource counts.
    const warm = r.createPenSkin(); r.destroySkin(warm);
    const counts = () => ['Texture', 'Buffer', 'Framebuffer'].map(kind => r.gl._nativeKinds[kind].size);
    const baseline = counts();
    for (let i = 0; i < 3; i++) {
      const id = r.createPenSkin(), skin = r._allSkins[id];
      const initial = counts();
      r.penPoint(id, {color4f: [1, 0, 0, 1], diameter: 4}, 3, 5);
      skin.setRenderQuality(2); skin.setRenderQuality(1);
      skin.updateSilhouette();
      const color = skin._silhouette.colorAtNearest([19 / 31, 11 / 31], new Uint8ClampedArray(4));
      assert.equal(color[0], 255); assert.equal(color[3], 255, 'resize preserves queued pen content');
      assert.deepEqual(counts(), initial, 'resizing must retire previous FBO and texture');
      r.destroySkin(id);
      assert.deepEqual(counts(), baseline, 'destroySkin must retire all owned handles');
    }
  } finally {r.dispose();}
});

test('query framebuffer has real stencil storage and client-space picking has finite coordinates', () => {
  const r = new NativeRenderer(32, 24);
  try {
    for (const info of [r._pickBufferInfo, r._queryBufferInfo]) {
      r.gl.bindFramebuffer(r.gl.FRAMEBUFFER, info.framebuffer);
      assert.equal(r.gl.checkFramebufferStatus(r.gl.FRAMEBUFFER), r.gl.FRAMEBUFFER_COMPLETE);
      r.gl.bindRenderbuffer(r.gl.RENDERBUFFER, info.attachments[1]);
      assert.equal(r.gl.getRenderbufferParameter(r.gl.RENDERBUFFER, r.gl.RENDERBUFFER_STENCIL_SIZE), 8);
    }
    const id = sprite(r, r.createBitmapSkin(rgba(4, 4, () => [255, 0, 0, 255]), 1), [5, 3]);
    assert.equal(r.pick(21, 9), id);
    assert.equal(r.pick(1, 1), -1);
  } finally {r.dispose();}
});

test('project hydration and save/reload preserve explicit SVG rotation centers', async () => {
  const zip = await JSZip.loadAsync(await blankProject());
  const json = JSON.parse(await zip.file('project.json').async('string'));
  json.targets[1].costumes[0].rotationCenterX = 7;
  json.targets[1].costumes[0].rotationCenterY = 13;
  zip.file('project.json', JSON.stringify(json));
  const project = new Project();
  try {
    await project.load(await zip.generateAsync({type: 'nodebuffer'}));
    for (let iteration = 0; iteration < 2; iteration++) {
      const costume = project.target('Sprite1').getCostumes()[0];
      assert.deepEqual([costume.rotationCenterX, costume.rotationCenterY], [7, 13]);
      assert.deepEqual(Array.from(project.renderer._allSkins[costume.skinId].rotationCenter).slice(0, 2), [7, 13]);
      await project.load(await project.bytes());
    }
  } finally {project.dispose(); project.dispose();}
});
