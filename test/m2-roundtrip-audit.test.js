const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createHash} = require('node:crypto');
const VirtualMachine = require('scratch-vm');
const ScratchStorage = require('@turbowarp/scratch-storage');
const JSZip = require('@turbowarp/jszip');

const fixture = async () => {
  const zip = new JSZip();
  const targets = [true, false, false].map((isStage, index) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="${['white', 'red', 'blue'][index]}"/></svg>`;
    const assetId = createHash('md5').update(svg).digest('hex');
    zip.file(`${assetId}.svg`, svg);
    return {
      isStage, name: isStage ? 'Stage' : `Sprite${index}`, variables: {}, lists: {},
      broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0,
      costumes: [{assetId, name: 'costume', md5ext: `${assetId}.svg`, dataFormat: 'svg',
        bitmapResolution: 1, rotationCenterX: 20, rotationCenterY: 10}],
      sounds: [], volume: 100, layerOrder: index,
      ...(isStage ? {tempo: 60, videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null} :
        {visible: true, x: index * 10, y: -index * 10, size: 100, direction: 90,
          draggable: false, rotationStyle: 'all around'})
    };
  });
  zip.file('project.json', JSON.stringify({targets, monitors: [], extensions: [], meta: {semver: '3.0.0'}}));
  return {zip, targets, bytes: await zip.generateAsync({type: 'nodebuffer'})};
};

test('renderer-free VM preserves SVG bytes and metadata but loses relative layer ordering', async () => {
  const input = await fixture();
  const vm = new VirtualMachine();
  vm.attachStorage(new ScratchStorage());
  vm.setCompilerOptions({enabled: false});
  try {
    await vm.loadProject(input.bytes);
    const saved = await JSZip.loadAsync(await vm.saveProjectSb3('arraybuffer'));
    const json = JSON.parse(await saved.file('project.json').async('string'));
    assert.equal(json.targets.length, input.targets.length);
    for (let index = 0; index < input.targets.length; index++) {
      const original = input.targets[index];
      const actual = json.targets[index];
      assert.equal(actual.name, original.name);
      assert.deepEqual(actual.costumes, original.costumes);
      const asset = original.costumes[0].md5ext;
      assert.ok(saved.file(asset), `asset ${asset} survives`);
      assert.deepEqual(await saved.file(asset).async('nodebuffer'), await input.zip.file(asset).async('nodebuffer'));
      if (!original.isStage) {
        for (const field of ['x', 'y', 'size', 'direction', 'visible', 'rotationStyle']) {
          assert.deepEqual(actual[field], original[field]);
        }
      }
    }
    // This regression records the unresolved M2 gate, not a lossless-save acceptance.
    assert.notDeepEqual(json.targets.map(target => target.layerOrder), input.targets.map(target => target.layerOrder));
    assert.ok(json.targets.every(target => !Object.hasOwn(target, 'layerOrder')));

    const layerState = new Map();
    for (const target of vm.runtime.targets) {
      const source = input.targets.find(item => item.name === target.getName());
      layerState.set(target.id, source.layerOrder);
      const toJSON = target.toJSON.bind(target);
      target.toJSON = () => ({...toJSON(), layerOrder: layerState.get(target.id)});
    }
    const withLayers = await JSZip.loadAsync(await vm.saveProjectSb3('arraybuffer'));
    const layerJson = JSON.parse(await withLayers.file('project.json').async('string'));
    assert.deepEqual(layerJson.targets.map(target => target.layerOrder), [0, 1, 2]);
    const sprites = vm.runtime.targets.filter(target => !target.isStage);
    layerState.set(sprites[0].id, 2);
    layerState.set(sprites[1].id, 1);
    const reordered = await JSZip.loadAsync(await vm.saveProjectSb3('arraybuffer'));
    const reorderedJson = JSON.parse(await reordered.file('project.json').async('string'));
    assert.deepEqual(reorderedJson.targets.map(target => target.layerOrder), [0, 2, 1]);
  } finally {
    vm.quit();
  }
});
