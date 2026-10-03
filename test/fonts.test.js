const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const {Resvg} = require('@resvg/resvg-js');
const JSZip = require('@turbowarp/jszip');
const {Project, blankProject, md5, readProject} = require('../src/project');
const {CommandSession} = require('../src/commands');
const {NativeRenderer} = require('../src/native-renderer');
const fonts = require('../src/font-commands');
require('../src/network-policy').install();
const withSession = async operation => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-fonts-'));
  const session = new CommandSession();
  try {await session.execute(['new']); return await operation(session, dir);} finally {session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
};
const imagePixels = async bytes => {
  const image = await loadImage(bytes); const canvas = createCanvas(image.width, image.height); canvas.getContext('2d').drawImage(image, 0, 0);
  return {width: image.width, height: image.height, data: canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data};
};
const textSVG = family => `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="70" viewBox="0 0 180 70"><text x="4" y="48" font-family="${family}" font-size="32" fill="black">Hello WWW</text></svg>`;
const cssFor = (family, data, format = 'woff2') => ({[`"${family}", sans-serif`]: `@font-face { font-family: "${family}"; src: url("data:font/${format};base64,${data.toString('base64')}"); }`});

test('pinned builtin WOFF2 binary hashes decode without evaluating DOM/base64-loader font entry', () => {
  const binaries = fonts.readBuiltinFonts(); assert.equal(binaries.length, 7);
  for (const font of binaries) {
    assert.equal(md5(font.data), font.md5); assert.equal(createHash('sha256').update(font.data).digest('hex'), font.sha256);
    assert.equal(font.metadata.nativeDecoded, true); assert.equal(font.metadata.format, 'woff2');
  }
  assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
});

test('binary validator rejects type lies, malformed table bounds and decompression size bombs', () => {
  const data = fonts.readBuiltinFonts()[0].data;
  assert.throws(() => fonts.validateFontBytes(Buffer.from('<svg onload="evil"/>'), 'ttf'), /signature/);
  assert.throws(() => fonts.validateFontBytes(data, 'ttf'), /mismatched/);
  const wrongLength = Buffer.from(data); wrongLength.writeUInt32BE(data.length + 1, 8);
  assert.throws(() => fonts.validateFontBytes(wrongLength), /length/);
  const bomb = Buffer.from(data); bomb.writeUInt32BE(0xffffffff, 16);
  assert.throws(() => fonts.validateFontBytes(bomb), /expanded/);
  assert.throws(() => fonts.validateFontBytes(data.subarray(0, 80)), /length/);
  const sfnt = Buffer.alloc(28); sfnt.writeUInt32BE(0x00010000); sfnt.writeUInt16BE(1, 4); sfnt.write('name', 12); sfnt.writeUInt32BE(0xffff, 20); sfnt.writeUInt32BE(64, 24);
  assert.throws(() => fonts.validateFontBytes(sfnt), /bounds/);
});

test('CSS parser only accepts validated canonical binary font data; executable/external/nested content fails', () => {
  const data = fonts.readBuiltinFonts()[0].data;
  assert.equal(fonts.parseFontCSS(cssFor('Safe Font', data))[0].metadata.md5, md5(data));
  for (const rule of [
    '@font-face { font-family: "Safe Font"; src: url("https://example.invalid/f.woff2"); }',
    '@font-face { font-family: "Safe Font"; src: url("file:///tmp/f.woff2"); }',
    '@font-face { font-family: "Safe Font"; src: url("data:image/svg+xml;base64,PHN2Zy8+"); }',
    Object.values(cssFor('Safe Font', data))[0] + '@import "https://example.invalid/css";',
    Object.values(cssFor('Safe Font', data))[0].replace('font-family: "Safe Font"', 'font-family: "Other Font"')
  ]) assert.throws(() => fonts.parseFontCSS({'"Safe Font", sans-serif': rule}), /denied|safe subset/);
  assert.throws(() => fonts.validateFallback('serif; src:url(https://example.invalid)'), /denied/);
  assert.throws(() => fonts.validateFamily('Bad\";src:'), /family/);
});

test('builtin fonts produce real distinct glyph metrics and native preview pixels with exact geometry', async () => {
  const renderer = new NativeRenderer(200, 100);
  try {
    const text = 'Hello WWW iii';
    const pixel = renderer.measureFontText('Pixel', text, 24), sans = renderer.measureFontText('Sans Serif', text, 24);
    assert.equal(pixel.width, 144); assert.equal(pixel.bounds.ascent, 21); assert.equal(pixel.bounds.descent, 0);
    assert.ok(Math.abs(sans.width - 159.1699981689453) < 0.0001); assert.notEqual(pixel.width, sans.width);
    const image = await imagePixels(renderer.fontPreview('Pixel', text, {size: 24, width: 200, height: 60}));
    const black = []; for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4; if (image.data[i] < 128 && image.data[i + 1] < 128 && image.data[i + 2] < 128) black.push([x, y]);
    }
    assert.ok(black.length > 400); const xs = black.map(p => p[0]), ys = black.map(p => p[1]);
    assert.equal(Math.min(...xs), 8); assert.equal(Math.min(...ys), 12); assert.equal(Math.max(...xs), 148); assert.equal(Math.max(...ys), 32);
    assert.equal(renderer.measureFontText('Uninstalled Host Font', text, 24).width, sans.width, 'portable renderer does not discover host fonts');
  } finally {renderer.dispose();}
});

test('custom font command serializes exact real SB3 assets/ID and reload registers before SVG hydration', async () => withSession(async (session, dir) => {
  const source = fonts.readBuiltinFonts().find(font => font.family === 'Pixel');
  const filename = path.join(dir, 'font.woff2'); await fs.writeFile(filename, source.data);
  const beforePixels = await imagePixels(session.project.renderer.fontPreview('My Pixel', 'Hello WWW', {size: 32}));
  const added = await session.execute(['font', 'from-file', 'My Pixel', filename, '--fallback', 'sans-serif']);
  assert.equal(added.assetId, source.md5);
  assert.equal(session.project.vm.runtime.fontManager.serializeAssets()[0].assetId, source.md5);
  const costume = session.project.target().getCostumes()[0], storage = session.project.vm.runtime.storage;
  const svg = textSVG('My Pixel'); const asset = storage.createAsset(storage.AssetType.ImageVector, 'svg', new Uint8Array(Buffer.from(svg)), null, true);
  Object.assign(costume, {asset, assetId: asset.assetId, md5: `${asset.assetId}.svg`, rotationCenterX: 90, rotationCenterY: 35});
  await session.project.hydrateCostume(costume); session.project.target().updateAllDrawableProperties();
  const currentPNG = await imagePixels(session.project.renderer.png());
  const customPixels = await imagePixels(session.project.renderer.fontPreview('My Pixel', 'Hello WWW', {size: 32}));
  assert.notDeepEqual(customPixels.data, beforePixels.data, 'custom glyph shape genuinely changed');
  const bytes = await session.snapshot(), zip = await JSZip.loadAsync(bytes), json = JSON.parse(await zip.file('project.json').async('string'));
  assert.deepEqual(json.customFonts, [{system: false, family: 'My Pixel', fallback: 'sans-serif', md5ext: `${source.md5}.woff2`}]);
  assert.deepEqual(await zip.file(`${source.md5}.woff2`).async('nodebuffer'), source.data);
  await session.restore(bytes);
  assert.deepEqual((await imagePixels(session.project.renderer.png())).data, currentPNG.data, 'reload must use fonts at first costume rasterization');
  assert.deepEqual((await imagePixels(session.project.renderer.fontPreview('My Pixel', 'Hello WWW', {size: 32}))).data, customPixels.data);
  await session.execute(['font', 'export', 'My Pixel', '--output', path.join(dir, 'export.woff2')]);
  assert.deepEqual(await fs.readFile(path.join(dir, 'export.woff2')), source.data);
  assert.equal((await session.execute(['font', 'inspect', 'My Pixel'])).md5, source.md5);
  await session.execute(['font', 'delete', 'My Pixel']); assert.equal(session.project.vm.runtime.fontManager.fonts.length, 0);
  await session.execute(['undo']); assert.equal(session.project.vm.runtime.fontManager.fonts[0].family, 'My Pixel');
  assert.deepEqual((await imagePixels(session.project.renderer.png())).data, currentPNG.data);
}));

test('existing SVG MIPs invalidate on font updates/reset and alias isolation survives peer disposal', () => {
  const a = new NativeRenderer(200, 100), b = new NativeRenderer(200, 100);
  try {
    const id = a.createSVGSkin(textSVG('Same Name')), skin = a._allSkins[id];
    const before = skin._silhouette._colorData.slice();
    const pixel = fonts.readBuiltinFonts().find(font => font.family === 'Pixel');
    const serif = fonts.readBuiltinFonts().find(font => font.family === 'Serif');
    a.setCustomFonts(cssFor('Same Name', pixel.data)); b.setCustomFonts(cssFor('Same Name', serif.data));
    assert.equal(skin._scaledMIPs.size, 0); skin.getTexture([100, 100]);
    const custom = skin._silhouette._colorData.slice(); assert.notDeepEqual(custom, before);
    const aWidth = a.measureFontText('Same Name', 'Hello WWW', 32).width, bWidth = b.measureFontText('Same Name', 'Hello WWW', 32).width;
    assert.notEqual(aWidth, bWidth); b.dispose();
    assert.equal(a.measureFontText('Same Name', 'Hello WWW', 32).width, aWidth);
    a.setCustomFonts({}); skin.getTexture([100, 100]); assert.deepEqual(skin._silhouette._colorData, before);
  } finally {a.dispose(); b.dispose();}
});

test('text SVG mixed with embedded bitmap retains native custom glyphs with Resvg system fonts disabled', () => {
  const renderer = new NativeRenderer(240, 100);
  try {
    const canvas = createCanvas(1, 1); canvas.getContext('2d').fillStyle = 'red'; canvas.getContext('2d').fillRect(0, 0, 1, 1);
    const svg = textSVG('Pixel').replace('</svg>', `<image x="160" y="0" width="10" height="10" href="data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}"/></svg>`);
    const id = renderer.createSVGSkin(svg), skin = renderer._allSkins[id];
    const outlined = renderer._outlineFontSVG(Buffer.from(svg));
    assert.doesNotMatch(outlined.toString('utf8'), /<text\b/);
    const oracle = new Resvg(outlined, {font: {loadSystemFonts: false}, logLevel: 'off'}).render();
    // Native silhouette is straight alpha, whereas Resvg pixels are premultiplied.
    const expected = new Uint8ClampedArray(oracle.pixels);
    for (let i = 0; i < expected.length; i += 4) for (let c = 0; c < 3; c++) expected[i + c] = expected[i + 3] ? Math.round(expected[i + c] * 255 / expected[i + 3]) : 0;
    assert.deepEqual(skin._silhouette._colorData, expected);
    assert.ok(expected.some((value, i) => i % 4 === 3 && value > 0));
  } finally {renderer.dispose();}
});

test('bad/missing/font-hash/fallback SB3 cannot silently substitute fonts or alter current project', async () => withSession(async (session, dir) => {
  await session.execute(['font', 'builtin', 'Pixel', 'Safe Font']);
  const before = await session.snapshot(); const targetId = session.project.target().id;
  const zip = await JSZip.loadAsync(before); const json = JSON.parse(await zip.file('project.json').async('string')); const name = json.customFonts[0].md5ext;
  zip.remove(name); await assert.rejects(session.project.load(await zip.generateAsync({type: 'nodebuffer'})), /Missing.*asset/);
  const bad = await JSZip.loadAsync(before); bad.file(name, Buffer.from('invalid fonts'));
  await assert.rejects(session.project.load(await bad.generateAsync({type: 'nodebuffer'})), /font|signature/i);
  const hash = await JSZip.loadAsync(before); const other = fonts.readBuiltinFonts().find(font => font.family === 'Serif'); hash.file(name, other.data);
  await assert.rejects(readProject(await hash.generateAsync({type: 'nodebuffer'})), /MD5 mismatch/);
  const css = await JSZip.loadAsync(before); json.customFonts[0].fallback = 'serif; src:url(https://example.invalid/font)'; css.file('project.json', JSON.stringify(json));
  await assert.rejects(session.project.load(await css.generateAsync({type: 'nodebuffer'})), /fallback/);
  assert.equal(session.project.target().id, targetId); assert.equal(session.project.vm.runtime.fontManager.fonts[0].family, 'Safe Font');
  const invalid = path.join(dir, 'bad.woff2'); await fs.writeFile(invalid, 'not a font');
  await assert.rejects(session.execute(['font', 'add', 'Bad Font', invalid]), /signature|size/);
  const link = path.join(dir, 'font-link.woff2'); await fs.symlink(invalid, link);
  await assert.rejects(session.execute(['font', 'from-file', 'Bad Font', link]), /ELOOP/);
  assert.equal(session.project.vm.runtime.fontManager.fonts.length, 1);
}));

test('system font metadata, load/reset and explicit PNG output follow module transaction/option semantics', async () => withSession(async (session, dir) => {
  const builtins = await session.execute(['font', 'builtins']); assert.equal(builtins.fonts.length, 7);
  await session.execute(['font', 'system', 'Portable Unknown', '--fallback', 'serif']);
  const list = await session.execute(['font', 'list']); assert.equal(list.fonts[0].system, true); assert.equal(list.fonts[0].portableSystemAccess, false);
  await session.execute(['font', 'builtin', 'Marker']); await session.execute(['font', 'load']);
  const measured = await session.execute(['font', 'measure', 'Marker', 'Hello', '--size', '24']); assert.ok(measured.width > 20);
  const output = path.join(dir, 'preview.png'); await session.execute(['font', 'render', 'Marker', 'Hello', '--output', output]);
  assert.equal((await imagePixels(await fs.readFile(output))).width, 320); assert.equal(session.project.file, null);
  await assert.rejects(session.execute(['font', 'render', 'Marker', 'Hello', '--out', path.join(dir, 'bad.sb3')]), /not supported|not allowed|Unknown|Unsupported/);
  const bytes = await session.snapshot(); await session.restore(bytes); assert.equal(session.project.vm.runtime.fontManager.fonts.length, 2);
  await session.execute(['font', 'reset']); assert.equal(session.project.vm.runtime.fontManager.fonts.length, 0);
  await session.execute(['undo']); assert.equal(session.project.vm.runtime.fontManager.fonts.length, 2);
}));
