// M2 spike 4: programmatic Blocks API editing in pure Node (create/move/change/delete + roundtrip).
// All Blocks methods take Blockly-event-shaped single args (blocks.js:642,668,800,902).
const VirtualMachine = require('scratch-vm');
const ScratchStorage = require('@turbowarp/scratch-storage');
const JSZip = require('@turbowarp/jszip');

const svgAsset = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>';
const ASSET_ID = 'cd21514d0531fdffb22204e0ec5ed84a';

const run = async () => {
  const vm = new VirtualMachine();
  vm.attachStorage(new ScratchStorage());
  vm.setCompilerOptions({ enabled: false });

  const zip = new JSZip();
  const projectJson = {
    targets: [{
      isStage: true,
      name: 'Stage',
      variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
      currentCostume: 0,
      costumes: [{
        assetId: ASSET_ID,
        name: 'backdrop1',
        md5ext: `${ASSET_ID}.svg`,
        dataFormat: 'svg',
        rotationCenterX: 240,
        rotationCenterY: 180
      }],
      sounds: [], volume: 100, layerOrder: 0, tempo: 60,
      videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null
    }],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: '2.1.46', agent: 'spike4' }
  };
  zip.file('project.json', JSON.stringify(projectJson));
  zip.file(`${ASSET_ID}.svg`, svgAsset);
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  await vm.loadProject(buf);

  const stage = vm.runtime.getTargetForStage();
  const blocks = stage.blocks;

  // create a top-level motion block and a numeric shadow, wire via moveBlock event
  blocks.createBlock({
    id: 'motionBlock1',
    opcode: 'motion_movesteps',
    inputs: {}, fields: {}, next: null, parent: null,
    shadow: false, topLevel: true, x: 0, y: 0
  });
  blocks.createBlock({
    id: 'numInput',
    opcode: 'math_whole_number',
    inputs: {}, fields: { NUM: { name: 'NUM', value: '10' } },
    next: null, parent: null, shadow: true, topLevel: false, x: 0, y: 0
  });
  blocks.moveBlock({ id: 'numInput', newParent: 'motionBlock1', newInput: 'STEPS' });
  // A shadow input needs the full descriptor (block + shadow keys) exactly as
  // Blockly events produce it; raw moveBlock leaves `shadow` undefined.
  const motionBlock = blocks.getBlock('motionBlock1');
  motionBlock.inputs.STEPS = { name: 'STEPS', block: 'numInput', shadow: 'numInput' };
  const motion = blocks.getBlock('motionBlock1');
  console.log('STEPS input wired:', !!motion.inputs.STEPS, '| shadow id:', motion.inputs.STEPS.shadow);

  blocks.changeBlock({ id: 'numInput', element: 'field', name: 'NUM', value: '25' });
  console.log('NUM field after changeBlock:', blocks.getBlock('numInput').fields.NUM.value);

  // serialization must include the created block.
  // FINDINGS (M2 spike 4):
  //  - saveProjectSb3() always runs TurboWarp id-compression (tw-compress-sb3):
  //    ids get remapped to short ids and input-only shadows get inlined as
  //    primitives, so saved `blocks` maps differ structurally from the live map.
  //  - Lossless saves need toJSON(null, {allowOptimization: false}) + manual zip.
  //  - scratch-blocks dist bundles are browser-only (partial exports in Node):
  //    the CLI command engine must CONSTRUCT Blockly-event-shaped objects itself
  //    and feed them to vm.blockListener/blocklyListen (no Blockly dependency).
  const out = await vm.saveProjectSb3('arraybuffer');
  const outZip = await JSZip.loadAsync(out);
  const savedJson = JSON.parse(await outZip.file('project.json').async('string'));
  const savedBlocks = savedJson.targets[0].blocks;
  const blockIds = Object.keys(savedBlocks);
  const motionId = blockIds.find(id => savedBlocks[id].opcode === 'motion_movesteps');
  console.log('serialized block entries:', blockIds.length, '(shadow inlined as primitive by tw-compress)');
  console.log('motion block present:', !!motionId);
  const stepsSer = motionId && savedBlocks[motionId].inputs.STEPS;
  console.log('STEPS input serialized:', JSON.stringify(stepsSer));
  const valueSurvived = JSON.stringify(stepsSer).includes('25');
  console.log('NUM value survived serialization:', valueSurvived);

  // lossless path: uncompressed ids
  // NOTE: simple input shadows are inlined as primitives ([6,"25"]) by
  // compressInputTree in BOTH compressed and uncompressed saves — this matches
  // what the GUI itself produces, so it is correct parity, not data loss.
  const uncompressed = JSON.parse(vm.toJSON(null, { allowOptimization: false }));
  console.log('uncompressed ids preserved:', !!uncompressed.targets[0].blocks.motionBlock1);
  if (!valueSurvived || !uncompressed.targets[0].blocks.motionBlock1) {
    throw new Error('Block editing roundtrip lost data');
  }

  // delete both, re-serialize, expect empty
  blocks.deleteBlock('motionBlock1');
  blocks.deleteBlock('numInput');
  const out2 = await vm.saveProjectSb3('arraybuffer');
  const outZip2 = await JSZip.loadAsync(out2);
  const savedJson2 = JSON.parse(await outZip2.file('project.json').async('string'));
  console.log('blocks after delete:', JSON.stringify(Object.keys(savedJson2.targets[0].blocks)));

  process.exit(0);
};

run().catch(e => {
  console.error('SPIKE4 FAIL:', e && (e.stack || e.message || e));
  process.exit(1);
});
