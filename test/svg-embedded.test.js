const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const {NativeRenderer, rasterizeSVG} = require('../src/native-renderer');

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
