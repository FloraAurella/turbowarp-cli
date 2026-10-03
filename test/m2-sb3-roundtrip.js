// M2 spike: SB3 roundtrip in pure Node (no DOM, no renderer).
// Builds a minimal valid sb3, loads it, re-saves, compares bytes.
const VirtualMachine = require('scratch-vm');
const ScratchStorage = require('@turbowarp/scratch-storage');
const JSZip = require('@turbowarp/jszip');

const makeVM = () => {
  const vm = new VirtualMachine();
  vm.attachStorage(new ScratchStorage());
  vm.setCompilerOptions({ enabled: false });
  return vm;
};

const stage = {
  isStage: true,
  name: 'Stage',
  variables: {},
  lists: {},
  broadcasts: {},
  blocks: {},
  comments: {},
  currentCostume: 0,
  costumes: [{
    assetId: 'cd21514d0531fdffb22204e0ec5ed84a',
    name: 'backdrop1',
    md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg',
    dataFormat: 'svg',
    rotationCenterX: 240,
    rotationCenterY: 180
  }],
  sounds: [],
  volume: 100,
  layerOrder: 0,
  tempo: 60,
  videoTransparency: 50,
  videoState: 'on',
  textToSpeechLanguage: null
};

const sprite = {
  isStage: false,
  name: 'Sprite1',
  variables: { '`jEk@4CIFR.kFp3r:~]:': ['my variable', 0] },
  lists: {},
  broadcasts: {},
  blocks: {},
  comments: {},
  currentCostume: 0,
  costumes: [{
    assetId: 'b7853f557e4426412e64bb3da653e992',
    name: 'costume1',
    md5ext: 'b7853f557e4426412e64bb3da653e992.svg',
    dataFormat: 'svg',
    rotationCenterX: 48,
    rotationCenterY: 50,
    bitmapResolution: 1
  }],
  sounds: [],
  volume: 100,
  layerOrder: 1,
  visible: true,
  x: 0,
  y: 0,
  size: 100,
  direction: 90,
  draggable: false,
  rotationStyle: 'all around'
};

const projectJson = {
  targets: [stage, sprite],
  monitors: [],
  extensions: [],
  meta: {
    semver: '3.0.0',
    vm: '2.1.46',
    agent: 'tw-cli-spike'
  }
};

// The backdrop sprite SVG asset (tiny valid SVG; content is irrelevant to the VM
// loader as long as md5ext matches, since serialization copies asset bytes).
const svgAsset = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>';

const buildSb3 = async () => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJson));
  zip.file('cd21514d0531fdffb22204e0ec5ed84a.svg', svgAsset);
  zip.file('b7853f557e4426412e64bb3da653e992.svg', svgAsset);
  return zip.generateAsync({ type: 'arraybuffer' });
};

const run = async () => {
  const original = await buildSb3();

  const vm = makeVM();
  await vm.loadProject(original);
  const resaved = await vm.saveProjectSb3('arraybuffer');

  const same = Buffer.compare(Buffer.from(original), Buffer.from(resaved)) === 0;
  console.log('original bytes:', original.byteLength);
  console.log('resaved bytes:', resaved.byteLength);
  console.log('byte-identical roundtrip:', same ? 'YES' : 'NO');

  // Semantic check: targets survive
  const vm2 = makeVM();
  await vm2.loadProject(resaved);
  const names = vm2.runtime.targets.map(t => t.getName()).sort();
  console.log('targets after roundtrip:', names.join(','));
  console.log('sprite variable preserved:', JSON.stringify(
    vm2.runtime.targets.find(t => !t.isStage).variables['`jEk@4CIFR.kFp3r:~]:'].value
  ));
  process.exit(0);
};

run().catch(e => {
  console.error('SPIKE FAIL:', e && (e.stack || e.message || e));
  process.exit(1);
});
