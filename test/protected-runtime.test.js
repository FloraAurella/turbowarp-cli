const {test} = require('node:test');
const assert = require('node:assert/strict');
require('../src/native-environment');
const NativeVM = require('../src/native-vm');
const Thread = require('scratch-vm/src/engine/thread');
const execute = require('scratch-vm/src/compiler/jsexecute');
const MonitorRecord = require('scratch-vm/src/engine/monitor-record');
const {installAotRuntime, getRuntimeBundle, generateRuntime, seedAssets, renderInitialFrame} = require('../src/protected/runtime-source');
const JSZip = require('@turbowarp/jszip');
const {compileProject} = require('../src/protected/compiler');

const target = (name, isStage, variables = {}) => ({name, isStage, variables, lists: {}, broadcasts: {},
  blocks: {}, comments: {}, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: isStage ? 0 : 1,
  x: 0, y: 0, direction: 90, visible: true, size: 100, rotationStyle: 'all around'});
const factory = code => execute.scopedEval(`(function(thread){const target=thread.target;const runtime=target.runtime;
  return function*(){${code};thread.status=4;return;}})`);
const setup = async (events, code) => {
  const vm = new NativeVM();
  const project = {projectVersion: 3, targets: [target('Stage', true, {score: ['score', 0]}), target('Sprite', false)], monitors: []};
  await vm.deserializeProject(project);
  const manifest = {format: 1, project, events};
  installAotRuntime(vm, manifest, code.map(body => ({startingFunction: factory(body), procedures: {}, executableHat: false})),
    Thread, execute, MonitorRecord);
  return vm;
};

const rawBlock = (opcode, next = null, inputs = {}, fields = {}, parent = null) => ({opcode, next, inputs, fields,
  parent, shadow: false, topLevel: parent === null});
const compileAndInstall = async project => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  const compiled = await compileProject(await zip.generateAsync({type: 'nodebuffer'}));
  const vm = new NativeVM();
  await vm.deserializeProject({...structuredClone(compiled.manifest.project), projectVersion: 3, monitors: []});
  const programs = new Function(`return ${compiled.programSource}`)()(execute.scopedEval);
  installAotRuntime(vm, compiled.manifest, programs, Thread, execute, MonitorRecord);
  return {vm, compiled};
};
const prohibitBlockReads = vm => {
  for (const target of vm.runtime.targets) {
    for (const name of ['getBlock', 'getOpcode', 'getScripts', 'getNextBlock', 'getBranch', 'getInputs']) {
      target.blocks[name] = () => { throw new Error(`Runtime tried to read project blocks: ${name}`); };
    }
  }
};

test('compiled hats preserve broadcast-and-wait ordering without project blocks', async () => {
  const vm = await setup([
    {targetIndex: 0, id: 'a0', opcode: 'event_whenflagclicked', fields: {}, programIndex: 0},
    {targetIndex: 1, id: 'a1', opcode: 'event_whenbroadcastreceived', fields: {BROADCAST_OPTION: 'go'}, programIndex: 1}
  ], [
    `yield* waitThreads(startHats('event_whenbroadcastreceived',{BROADCAST_OPTION:'go'}));target.variables.score.value+=100`,
    `runtime.getTargetForStage().variables.score.value+=1;yield;runtime.getTargetForStage().variables.score.value+=10`
  ]);
  try {
    vm.greenFlag();
    for (let i = 0; i < 4; i++) vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 111);
    assert.equal(vm.runtime.threads.length, 0);
    for (const item of vm.runtime.targets) assert.deepEqual(Object.keys(item.blocks._blocks), []);
    assert.throws(() => vm.saveProjectSb3(), /editable Scratch project/);
  } finally {vm.runtime.dispose();}
});

test('clones inherit registrations and stop removes them; hats match case-insensitively', async () => {
  const vm = await setup([
    {targetIndex: 1, id: 'a0', opcode: 'event_whenkeypressed', fields: {KEY_OPTION: 'space'}, programIndex: 0},
    {targetIndex: 1, id: 'a1', opcode: 'control_start_as_clone', fields: {}, programIndex: 1}
  ], [
    `const clone=target.makeClone();runtime.addTarget(clone);runtime.startHats('control_start_as_clone',null,clone)`,
    `runtime.getTargetForStage().variables.score.value+=1`
  ]);
  try {
    vm.runtime.startHats('event_whenkeypressed', {KEY_OPTION: 'SPACE'});
    vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 1);
    assert.equal(vm.runtime.targets.filter(item => !item.isOriginal).length, 1);
    for (const item of vm.runtime.targets) assert.equal(Object.keys(item.blocks._blocks).length, 0);
    vm.stopAll();
    assert.equal(vm.runtime.targets.filter(item => !item.isOriginal).length, 0);
  } finally {vm.runtime.dispose();}
});

test('variable monitors use direct state and show/hide without a monitor block graph', async () => {
  const vm = await setup([], []);
  try {
    assert.equal(vm.runtime._monitorState.get('score').visible, false);
    vm.runtime.monitorBlocks.changeBlock({id: 'score', element: 'checkbox', value: true});
    vm.runtime.getTargetForStage().variables.score.value = 19;
    vm.runtime._pushMonitors();
    assert.equal(vm.runtime._monitorState.get('score').value, 19);
    assert.deepEqual(Object.keys(vm.runtime.monitorBlocks._blocks), []);
    vm.runtime.monitorBlocks.changeBlock({id: 'score', element: 'checkbox', value: false});
    assert.equal(vm.runtime._monitorState.get('score').visible, false);
  } finally {vm.runtime.dispose();}
});

test('frozen transformed runtime parses and generated player has private module access', () => {
  const source = getRuntimeBundle();
  new Function('aotInternals', source);
  assert.match(source, /Browser compiler omitted/);
  const player = generateRuntime({manifest: {format: 1, project: {targets: []}, events: []}, assets: {}, programSource: 'function(){return []}'});
  new Function(player);
  assert.match(player, /window\.protectedPlayer/);
  assert.doesNotMatch(player, /window\.__protectedDebug=/);
});

test('real compiled executable timer and touching hats trigger only on rising edges without block reads', async () => {
  const project = {targets: [target('Stage', true, {score: ['score', 0]}), target('Sprite', false)], monitors: [], extensions: []};
  project.targets[1].blocks = {
    timerHat: rawBlock('event_whengreaterthan', 'timerAdd', {VALUE: [1, [4, '1']]}, {WHENGREATERTHANMENU: ['TIMER', null]}),
    timerAdd: rawBlock('data_changevariableby', null, {VALUE: [1, [4, '1']]}, {VARIABLE: ['score', 'score']}, 'timerHat'),
    touchHat: rawBlock('event_whentouchingobject', 'touchAdd', {TOUCHINGOBJECTMENU: [1, [10, '_mouse_']]}),
    touchAdd: rawBlock('data_changevariableby', null, {VALUE: [1, [4, '10']]}, {VARIABLE: ['score', 'score']}, 'touchHat')
  };
  const {vm, compiled} = await compileAndInstall(project);
  try {
    assert.equal(compiled.manifest.events.every(event => event.executableHat), true);
    let time = 0, touching = false;
    vm.runtime.ioDevices.clock.projectTimer = () => time;
    vm.runtime.targets[1].isTouchingObject = () => touching;
    prohibitBlockReads(vm);
    vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 0);
    time = 2; touching = true;
    vm.runtime._step();vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 11);
    time = 0; touching = false;vm.runtime._step();
    time = 2; touching = true;vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 22);
  } finally {vm.runtime.dispose();}
});

test('broadcast restarts replace yielding threads in their current position', async () => {
  const vm = await setup([
    {targetIndex: 1, id: 'a0', opcode: 'event_whenbroadcastreceived', fields: {BROADCAST_OPTION: 'go'}, programIndex: 0}
  ], [`runtime.getTargetForStage().variables.score.value+=1;thread.status=3;yield;runtime.getTargetForStage().variables.score.value+=10`]);
  try {
    const first = vm.runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: 'go'})[0];
    vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 1);
    const index = vm.runtime.threads.indexOf(first);
    const restarted = vm.runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: 'go'})[0];
    assert.notEqual(restarted, first);
    assert.equal(vm.runtime.threads[index], restarted);
    assert.equal(vm.runtime.isActiveThread(first), false);
    vm.runtime._step();vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 12);
    assert.equal(vm.runtime.threads.length, 0);
  } finally {vm.runtime.dispose();}
});

test('compiled event iteration preserves upstream target and script execution order', async () => {
  const project = {projectVersion: 3, targets: [target('Stage', true), target('Back', false), target('Front', false)], monitors: []};
  project.targets[1].layerOrder = 3;project.targets[2].layerOrder = 1;
  for (const item of project.targets) item.blocks = {
    flag1: rawBlock('event_whenflagclicked'), flag2: rawBlock('event_whenflagclicked'),
    key: rawBlock('event_whenkeypressed', null, {}, {KEY_OPTION: ['space', null]})
  };
  const baseline = new NativeVM();await baseline.deserializeProject(structuredClone(project));
  const {vm} = await compileAndInstall(project);
  try {
    const originalAll = [], compiledAll = [], originalFlags = [], compiledFlags = [];
    baseline.runtime.allScriptsDo((id, item) => originalAll.push(item.getName()));
    vm.runtime.allScriptsDo((id, item) => compiledAll.push(item.getName()));
    baseline.runtime.allScriptsByOpcodeDo('event_whenflagclicked', (script, item) => originalFlags.push(item.getName()));
    vm.runtime.allScriptsByOpcodeDo('event_whenflagclicked', (script, item) => compiledFlags.push(item.getName()));
    assert.deepEqual(compiledAll, originalAll);
    assert.deepEqual(compiledFlags, originalFlags);
  } finally {baseline.runtime.dispose();vm.runtime.dispose();}
});

test('sprite reporter monitors bind originals and clone local variables cannot overwrite them', async () => {
  const project = {targets: [target('Stage', true), target('Sprite', false, {local: ['local', 3]})], extensions: [],
    monitors: [{id: 'x', opcode: 'motion_xposition', params: {}, spriteName: 'Sprite', visible: true},
      {id: 'local', opcode: 'data_variable', params: {VARIABLE: 'local'}, spriteName: 'Sprite', visible: true}]};
  const {vm} = await compileAndInstall(project);
  try {
    const original = vm.runtime.targets[1];
    original.setXY(25, -10); original.setDraggable(true);
    const clone = original.makeClone();vm.runtime.addTarget(clone);
    clone.setXY(-50, 40);clone.variables.local.value = 99;
    assert.equal(clone.draggable, true);
    prohibitBlockReads(vm);
    vm.runtime._pushMonitors();
    const reporter = Array.from(vm.runtime._monitorState.valueSeq()).find(record => record.opcode === 'motion_xposition');
    assert.equal(reporter.value, 25);
    assert.equal(vm.runtime._monitorState.get('local').value, 3);
    assert.deepEqual(Object.keys(vm.runtime.monitorBlocks._blocks), []);
  } finally {vm.runtime.dispose();}
});

test('offline asset seeding populates lookup storage rather than merely constructing asset objects', async () => {
  const ScratchStorage = require('@turbowarp/scratch-storage');
  const storage = new ScratchStorage();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
  const manifest = {project: {targets: [{costumes: [{assetId: 'test-vector', md5ext: 'test-vector.svg', dataFormat: 'svg'}],
    sounds: [{assetId: 'test-sound', md5ext: 'test-sound.wav', dataFormat: 'wav'}]}]}};
  const wav = Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
  seedAssets(storage, manifest, {'test-vector.svg': Buffer.from(svg).toString('base64'), 'test-sound.wav': wav.toString('base64')},
    value => Uint8Array.from(Buffer.from(value, 'base64')));
  const costume = await storage.load(storage.AssetType.ImageVector, 'test-vector', 'svg');
  const sound = await storage.load(storage.AssetType.Sound, 'test-sound', 'wav');
  assert.ok(costume, 'costume is discoverable through the same load API used by VM deserialization');
  assert.equal(Buffer.from(costume.data).toString('utf8'), svg);
  assert.deepEqual(Buffer.from(sound.data), wav);
});

test('initial frame waits for SVG load and redraws before reporting ready', async () => {
  const image = new EventTarget();image.complete = false;
  const calls = [];
  const renderer = {_allSkins: [{_svgImage: image}, undefined], draw: () => calls.push('draw')};
  const pending = renderInitialFrame(renderer, {requestRedraw: () => calls.push('requestRedraw')});
  await Promise.resolve();
  assert.deepEqual(calls, []);
  image.dispatchEvent(new Event('load'));
  await pending;
  assert.deepEqual(calls, ['requestRedraw', 'draw']);
});
