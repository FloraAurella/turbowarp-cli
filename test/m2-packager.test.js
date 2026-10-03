const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createHash} = require('node:crypto');
const Packager = require('@turbowarp/packager');
const JSZip = require('@turbowarp/jszip');
const {Socket} = require('node:net');
const {createCanvas} = require('@napi-rs/canvas');
const {Script} = require('node:vm');
const {parseDOM} = require('htmlparser2');
const {wav, CommandSession} = require('../src/commands');
const {Project} = require('../src/project');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Decode the emitted base85 payload as data. Never evaluate packaged runtime or
// create a browser/Electron. Successful generation alone is not playback parity.
const embeddedProject = html => {
  const chunks = [...html.matchAll(/<script data="([^"]*)">decodeChunk\((\d+)\)<\/script>/g)];
  assert.ok(chunks.length, 'actual standalone SB3 payload must be present');
  return Buffer.concat(chunks.map(([, encoded, size]) => {
    assert.equal(encoded.length % 5, 0);
    const output = Buffer.alloc(encoded.length / 5 * 4);
    for (let i = 0; i < encoded.length; i += 5) {
      let word = 0;
      for (let digit = 4; digit >= 0; digit--) {
        let code = encoded.charCodeAt(i + digit);
        if (code === 0x28) code = 0x3c; if (code === 0x29) code = 0x3e;
        assert.ok(code >= 42 && code <= 126);
        word = word * 85 + code - 42;
      }
      output.writeUInt32LE(word >>> 0, i / 5 * 4);
    }
    return output.subarray(0, Number(size));
  }));
};
const verifyProjectAssets = async (archive, prefix, source) => {
  const expected = await JSZip.loadAsync(source);
  const json = JSON.parse(await archive.file(`${prefix}project.json`).async('string'));
  const canonical = project => {
    // Packager deliberately compacts block IDs and removes editor coordinates,
    // false flags and agent metadata. Compare graph/values, not ZIP identity.
    const result = structuredClone(project);
    delete result.meta.vm; delete result.meta.agent;
    for (const target of result.targets) {
      const ids = new Map(Object.keys(target.blocks).map((id, i) => [id, String(i)]));
      const input = value => Array.isArray(value) ? value.map(input) : typeof value === 'string' && ids.has(value) ? ids.get(value) : value;
      target.blocks = Object.fromEntries(Object.entries(target.blocks).map(([id, block]) => {
        const normalized = {...block, next: block.next ? ids.get(block.next) : null,
          parent: block.parent ? ids.get(block.parent) : null,
          inputs: Object.fromEntries(Object.entries(block.inputs).map(([key, value]) => [key, input(value)])),
          shadow: !!block.shadow, topLevel: !!block.topLevel};
        delete normalized.x; delete normalized.y;
        return [ids.get(id), normalized];
      }));
    }
    return result;
  };
  assert.deepEqual(canonical(json), canonical(JSON.parse(await expected.file('project.json').async('string'))));
  for (const target of json.targets) for (const asset of [...target.costumes, ...target.sounds]) {
    const bytes = await archive.file(prefix + asset.md5ext).async('nodebuffer');
    assert.deepEqual(bytes, await expected.file(asset.md5ext).async('nodebuffer'), asset.md5ext);
    assert.equal(createHash('md5').update(bytes).digest('hex'), asset.assetId);
  }
};
const verifyScripts = html => {
  const pending = parseDOM(html); let scripts = 0;
  while (pending.length) {
    const node = pending.pop(); pending.push(...(node.children || []));
    if (node.name !== 'script' || node.attribs.src) continue;
    const text = (node.children || []).map(child => child.data || '').join('');
    if (node.attribs.type && !/javascript|module/.test(node.attribs.type)) continue;
    assert.doesNotThrow(() => new Script(text), 'inline packaged JavaScript must parse without running it');
    scripts++;
  }
  assert.ok(scripts > 1);
};

const buildProject = async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="white"/></svg>';
  const assetId = createHash('md5').update(svg).digest('hex');
  const zip = new JSZip();
  zip.file(`${assetId}.svg`, svg);
  zip.file('project.json', JSON.stringify({
    targets: [{
      isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
      blocks: {}, comments: {}, currentCostume: 0,
      costumes: [{assetId, name: 'backdrop', md5ext: `${assetId}.svg`,
        dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180}],
      sounds: [], volume: 100, layerOrder: 0, tempo: 60,
      videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null
    }],
    monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '2.1.46'}
  }));
  const json = JSON.parse(await zip.file('project.json').async('string'));
  const canvas = createCanvas(4, 4); canvas.getContext('2d').fillStyle = '#123456'; canvas.getContext('2d').fillRect(0, 0, 4, 4);
  const bitmap = canvas.toBuffer('image/png');
  const sound = wav({length: 4, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array([0.25, -0.5, 0.125, 0])});
  for (const [format, bytes] of [['png', bitmap], ['wav', sound]]) {
    const id = createHash('md5').update(bytes).digest('hex'), md5ext = `${id}.${format}`;
    zip.file(md5ext, bytes);
    if (format === 'png') json.targets[0].costumes.push({assetId: id, name: 'bitmap', md5ext, dataFormat: format,
      bitmapResolution: 2, rotationCenterX: 2, rotationCenterY: 2});
    else json.targets[0].sounds.push({assetId: id, name: 'asymmetric', md5ext, dataFormat: format, rate: 44100, sampleCount: 4});
  }
  json.targets[0].variables.score = ['score', 17];
  json.targets[0].lists.items = ['items', ['one', 2]];
  json.targets[0].blocks = {
    hat: {opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 20},
    set: {opcode: 'data_setvariableto', next: null, parent: 'hat', inputs: {VALUE: [1, [10, '23']]},
      fields: {VARIABLE: ['score', 'score']}, shadow: false, topLevel: false}
  };
  zip.file('project.json', JSON.stringify(json));
  return zip.generateAsync({type: 'nodebuffer'});
};

for (const target of ['html', 'zip']) {
  test(`packager 3.13.0 generates ${target} with no DOM or network`, async t => {
    t.mock.method(Socket.prototype, 'connect', () => {throw new Error('Network is forbidden in this spike');});
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
    const source = await buildProject();
    const project = await Packager.loadProject(source);
    assert.equal(project.type, 'sb3');
    assert.equal(project.analysis.usesMusic, false);
    const packager = new Packager.Packager();
    packager.project = project;
    packager.options.target = target;
    packager.options.app.packageName = 'cli-spike';
    packager.options.app.windowTitle = 'CLI spike <safe title>';
    packager.options.cloudVariables.mode = 'none';
    const result = await packager.package();
    assert.ok(result.data instanceof Uint8Array);
    assert.ok(result.data.byteLength > 0);
    assert.equal(result.filename, `CLI spike <safe title>.${target}`);
    let html;
    if (target === 'zip') {
      assert.equal(result.type, 'application/zip');
      const archive = await JSZip.loadAsync(result.data);
      assert.ok(archive.file('index.html'));
      assert.ok(archive.file('assets/project.json'));
      const json = JSON.parse(await archive.file('assets/project.json').async('string'));
      const costume = json.targets[0].costumes[0];
      assert.ok(archive.file(`assets/${costume.md5ext}`));
      const script = await archive.file('script.js').async('string');
      assert.ok(Buffer.byteLength(script) > 1000000);
      assert.ok(script.includes('Scaffolding'));
      assert.doesNotThrow(() => new Script(script));
      await verifyProjectAssets(archive, 'assets/', source);
      html = await archive.file('index.html').async('string');
    } else {
      assert.equal(result.type, 'text/html');
      html = Buffer.from(result.data).toString('utf8');
      const payload = embeddedProject(html);
      assert.deepEqual(payload, Buffer.from(project.arrayBuffer), 'standalone embeds the actual packager SB3 bytes');
      await verifyProjectAssets(await JSZip.loadAsync(payload), '', source);
      assert.ok(Buffer.byteLength(html) > 1000000, 'includes actual bundled runtime');
    }
    verifyScripts(html);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('CLI spike &lt;safe title&gt;'));
    assert.ok(html.includes('Scaffolding'));
    await assert.rejects(packager.package(), /already used/);
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
  });
}

test('package command preserves edited SB3 semantics/assets in HTML and ZIP, safely escaping the output title', async t => {
  t.mock.method(Socket.prototype, 'connect', () => {throw new Error('Network is forbidden');});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-m2-packager-'));
  const session = new CommandSession();
  const loaded = new Project();
  try {
    await session.project.load(await buildProject());
    await session.execute(['var', 'set', 'score', '29', '--target', 'stage']);
    const source = await session.project.bytes();
    for (const extension of ['html', 'zip']) {
      const title = 'M2 <safe> & "quoted"';
      const file = path.join(dir, `${title}.${extension}`);
      await session.execute(['package', file]);
      const output = await fs.readFile(file);
      let json, archive, html;
      if (extension === 'html') {
        html = output.toString('utf8'); archive = await JSZip.loadAsync(embeddedProject(html));
        json = JSON.parse(await archive.file('project.json').async('string'));
        await verifyProjectAssets(archive, '', source);
        await loaded.load(embeddedProject(html));
      } else {
        archive = await JSZip.loadAsync(output); html = await archive.file('index.html').async('string');
        json = JSON.parse(await archive.file('assets/project.json').async('string'));
        await verifyProjectAssets(archive, 'assets/', source);
      }
      assert.equal(json.targets[0].variables.score[1], 29);
      verifyScripts(html);
      const titleNode = parseDOM(html, {decodeEntities: true}).flatMap(function walk(node) {return [node, ...(node.children || []).flatMap(walk)];})
        .find(node => node.name === 'title');
      assert.equal(titleNode.children.map(node => node.data || '').join(''), title);
      await assert.rejects(session.execute(['package', file]), /EEXIST/);
      assert.deepEqual(await fs.readFile(file), output, 'failed overwrite must not change output');
    }
    assert.equal(loaded.target('stage').variables.score.value, 29);
  } finally {
    loaded.dispose(); session.dispose(); await fs.rm(dir, {recursive: true, force: true});
  }
});
