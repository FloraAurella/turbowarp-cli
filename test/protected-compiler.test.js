'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('@turbowarp/jszip');
const {compileProject} = require('../src/protected/compiler');
const {createDemo} = require('../src/protected/demo');
const NativeVM = require('../src/native-vm');
const Thread = require('scratch-vm/src/engine/thread');
const execute = require('scratch-vm/src/compiler/jsexecute');
const MonitorRecord = require('scratch-vm/src/engine/monitor-record');
const {installAotRuntime} = require('../src/protected/runtime-source');

const baseTarget = (name, isStage, blocks = {}) => ({name, isStage, blocks, comments: {}, variables: {}, lists: {}, broadcasts: {},
  costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: isStage ? 0 : 1, x: 0, y: 0, direction: 90,
  size: 100, visible: true, draggable: false, rotationStyle: 'all around', tempo: 60});
const block = (opcode, inputs = {}, fields = {}, next = null, parent = null, extra = {}) => ({opcode, inputs, fields, next, parent, shadow: false, topLevel: parent === null, ...extra});
const number = value => [1, [4, String(value)]];
const project = targets => ({targets, monitors: [], extensions: [], meta: {semver: '3.0.0'}});
async function archive(data, otherFiles = {}) {
  const zip = new JSZip(); zip.file('project.json', JSON.stringify(data));
  for (const [name, bytes] of Object.entries(otherFiles)) zip.file(name, bytes);
  return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
}
async function setup(compiled) {
  const vm = new NativeVM();
  for (const id of compiled.manifest.project.extensions) vm.extensionManager.loadExtensionIdSync(id);
  const metadata = {...compiled.manifest.project, projectVersion: 3, monitors: [],
    targets: compiled.manifest.project.targets.map(target => ({...target, costumes: [], sounds: []}))};
  await vm.deserializeProject(metadata);
  const programs = new Function(`return ${compiled.programSource}`)()(execute.scopedEval);
  installAotRuntime(vm, compiled.manifest, programs, Thread, execute, MonitorRecord);
  return vm;
}

test('actual demo compiles every event and strips source graph, original block IDs, comments and HTML injection', async () => {
  const bytes = await createDemo();
  const zip = await JSZip.loadAsync(bytes);
  const original = JSON.parse(await zip.file('project.json').async('string'));
  original.targets[0].comments = {secret_comment: {text: 'AUTHOR_SECRET_LAYOUT', x: 15, y: 20}};
  zip.file('project.json', JSON.stringify(original));
  const compiled = await compileProject(await zip.generateAsync({type: 'nodebuffer'}), {title: '</script><h1>literal title</h1>'});
  assert.equal(compiled.report.protection, 'ahead-of-time');
  assert.equal(compiled.report.sourceGraphIncluded, false);
  assert.equal(compiled.manifest.events.length, 2);
  const output = JSON.stringify(compiled);
  assert.ok(!output.includes('demo_author_block_'));
  assert.ok(!output.includes('AUTHOR_SECRET_LAYOUT'));
  assert.equal(compiled.manifest.title, '</script><h1>literal title</h1>');
  assert.ok(!compiled.programSource.includes('<'));
  for (const target of compiled.manifest.project.targets) assert.deepEqual(target.blocks, {});
  const vm = await setup(compiled);
  try {
    vm.greenFlag(); vm.runtime._step();
    assert.equal(vm.runtime.targets[1].x, 0);
    assert.equal(vm.runtime.targets[1].y, 10);
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 0);
    vm.runtime.startHats('event_whenthisspriteclicked', {}, vm.runtime.targets[1]); vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 1);
  } finally {vm.runtime.dispose();}
});

test('real compiled procedures, broadcasts and clones preserve results without reading source blocks', async () => {
  const stage = baseTarget('Stage', true, {
    original_flag: block('event_whenflagclicked', {}, {}, 'original_call'),
    original_call: block('procedures_call', {arg0: number(7)}, {}, 'original_broadcast', 'original_flag', {mutation: {tagName: 'mutation', children: [], proccode: 'increase score %s', argumentids: '["arg0"]', warp: 'false'}}),
    original_broadcast: block('event_broadcastandwait', {BROADCAST_INPUT: [1, [11, 'go', 'go']]}, {}, 'original_clone', 'original_call'),
    original_clone: block('control_create_clone_of', {CLONE_OPTION: [1, 'clone_menu']}, {}, null, 'original_broadcast'),
    clone_menu: block('control_create_clone_of_menu', {}, {CLONE_OPTION: ['Sprite', null]}, null, 'original_clone', {shadow: true}),
    original_def: block('procedures_definition', {custom_block: [1, 'original_proto']}, {}, 'original_add'),
    original_proto: block('procedures_prototype', {arg0: [1, 'original_shadow']}, {}, null, 'original_def', {shadow: true, mutation: {tagName: 'mutation', children: [], proccode: 'increase score %s', argumentids: '["arg0"]', argumentnames: '["amount"]', argumentdefaults: '[""]', warp: 'false'}}),
    original_shadow: block('argument_reporter_string_number', {}, {VALUE: ['amount', null]}, null, 'original_proto', {shadow: true}),
    original_add: block('data_changevariableby', {VALUE: [2, 'original_arg']}, {VARIABLE: ['score', 'score']}, null, 'original_def'),
    original_arg: block('argument_reporter_string_number', {}, {VALUE: ['amount', null]}, null, 'original_add')
  });
  stage.variables = {score: ['score', 0]}; stage.broadcasts = {go: 'go'};
  const sprite = baseTarget('Sprite', false, {
    recv: block('event_whenbroadcastreceived', {}, {BROADCAST_OPTION: ['go', 'go']}, 'add_recv'),
    add_recv: block('data_changevariableby', {VALUE: number(10)}, {VARIABLE: ['score', 'score']}, null, 'recv'),
    clone: block('control_start_as_clone', {}, {}, 'add_clone'),
    add_clone: block('data_changevariableby', {VALUE: number(100)}, {VARIABLE: ['score', 'score']}, 'delete_clone', 'clone'),
    delete_clone: block('control_delete_this_clone', {}, {}, null, 'add_clone')
  });
  const compiled = await compileProject(await archive(project([stage, sprite])));
  assert.equal(compiled.report.compiledScripts, 4);
  assert.ok(!compiled.programSource.includes('increase score'));
  assert.ok(!compiled.programSource.includes('original_'));
  const vm = await setup(compiled);
  try {
    for (const target of vm.runtime.targets) {
      target.blocks.getBlock = () => {throw new Error('No source block reads allowed');};
      target.blocks.getScripts = () => {throw new Error('No source script reads allowed');};
    }
    vm.greenFlag(); for (let i = 0; i < 12; i++) vm.runtime._step();
    assert.equal(vm.runtime.getTargetForStage().variables.score.value, 117);
    assert.equal(vm.runtime.targets.length, 2);
    assert.equal(vm.runtime.threads.length, 0);
  } finally {vm.runtime.dispose();}
});

test('detached compact reporters are accepted and custom stage geometry preserves only numbers', async () => {
  const stage = baseTarget('Stage', true, {detached: [12, 'score', 'score', 40, 20]});
  stage.variables = {score: ['score', 0]};
  stage.comments = {config: {text: 'author words\n{"width":640,"height":480} // _twconfig_'}};
  const compiled = await compileProject(await archive(project([stage])));
  assert.deepEqual(compiled.manifest.stageSize, {width: 640, height: 480});
  assert.ok(!JSON.stringify(compiled).includes('author words'));
  assert.equal(compiled.report.blockCount, 0);
});

test('rejects unsupported extensions, cloud variables, loudness hats and unknown native opcodes', async () => {
  const cases = [
    [data => data.extensions.push('videoSensing'), 'UNSUPPORTED_EXTENSION'],
    [data => data.targets[0].variables.cloud = ['cloud', 0, true], 'UNSUPPORTED_CLOUD'],
    [data => data.targets[0].blocks.hat = block('event_whengreaterthan', {VALUE: number(1)}, {WHENGREATERTHANMENU: ['LOUDNESS', null]}), 'UNSUPPORTED_BLOCK'],
    [data => data.targets[0].blocks.unknown = block('motion_nonexistent'), 'UNSUPPORTED_BLOCK']
  ];
  for (const [change, code] of cases) {
    const data = project([baseTarget('Stage', true)]); change(data);
    await assert.rejects(() => archive(data).then(bytes => compileProject(bytes)), error => error.code === code);
  }
});

test('rejects missing assets, cyclic source graph and unsafe SVG content', async () => {
  const stage = baseTarget('Stage', true); stage.costumes = [{name: 'costume', assetId: 'test', md5ext: 'test.svg', dataFormat: 'svg'}];
  await assert.rejects(() => archive(project([stage])).then(bytes => compileProject(bytes)), {code: 'MISSING_ASSET'});
  await assert.rejects(() => archive(project([stage]), {'test.svg': '<svg onload="alert(1)"></svg>'}).then(bytes => compileProject(bytes)), {code: 'UNSAFE_ASSET'});
  stage.costumes = []; stage.blocks = {cycle: block('motion_movesteps', {STEPS: number(1)}, {}, 'cycle')};
  await assert.rejects(() => archive(project([stage])).then(bytes => compileProject(bytes)), {code: 'INVALID_BLOCK'});
});

test('ZIP path traversal entries and malformed input are rejected before parsing', async () => {
  const zip = new JSZip(); zip.file('../project.json', '{}');
  await assert.rejects(() => zip.generateAsync({type: 'nodebuffer'}).then(bytes => compileProject(bytes)), {code: 'INVALID_SB3'});
  await assert.rejects(() => compileProject(Buffer.from('not a zip')), {code: 'INVALID_SB3'});
});

test('pen and music compatibility calls run with direct state, loops, lists and no block reads', async () => {
  const stage = baseTarget('Stage', true, {
    flag: block('event_whenflagclicked', {}, {}, 'tempo'),
    tempo: block('music_setTempo', {TEMPO: number(120)}, {}, 'repeat', 'flag'),
    repeat: block('control_repeat', {TIMES: number(3), SUBSTACK: [2, 'append']}, {}, 'save', 'tempo'),
    append: block('data_addtolist', {ITEM: number(9)}, {LIST: ['items', 'items']}, null, 'repeat'),
    save: block('data_setvariableto', {VALUE: [2, 'gettempo']}, {VARIABLE: ['score', 'score']}, 'volume', 'repeat'),
    gettempo: block('music_getTempo', {}, {}, null, 'save'),
    volume: block('sound_setvolumeto', {VOLUME: number(35)}, {}, 'pen', 'save'),
    pen: block('pen_setPenSizeTo', {SIZE: number(4)}, {}, null, 'volume')
  });
  stage.variables = {score: ['score', 0]}; stage.lists = {items: ['items', []]};
  const data = project([stage]); data.extensions = ['pen', 'music'];
  const compiled = await compileProject(await archive(data));
  const vm = await setup(compiled);
  try {
    vm.runtime.getTargetForStage().blocks.getBlock = () => {throw new Error('No source block reads allowed');};
    vm.greenFlag(); for (let i = 0; i < 20; i++) {vm.runtime._step(); await Promise.resolve();}
    const result = vm.runtime.getTargetForStage();
    assert.equal(result.tempo, 120);
    assert.equal(result.variables.score.value, 120);
    assert.deepEqual(result.variables.items.value, [9, 9, 9]);
    assert.equal(result.volume, 35);
    assert.equal(vm.runtime.threads.length, 0);
  } finally {vm.runtime.dispose();}
});

test('generated factories escape authored script-closing strings without changing displayed text', async () => {
  const text = '</script><script>window.injected=true</script>';
  const stage = baseTarget('Stage', true, {
    flag: block('event_whenflagclicked', {}, {}, 'set'),
    set: block('data_setvariableto', {VALUE: [1, [10, text]]}, {VARIABLE: ['message', 'message']}, null, 'flag')
  });
  stage.variables = {message: ['message', '']};
  const compiled = await compileProject(await archive(project([stage])));
  assert.ok(!compiled.programSource.includes('<'));
  const vm = await setup(compiled);
  try {vm.greenFlag(); vm.runtime._step(); assert.equal(vm.runtime.getTargetForStage().variables.message.value, text);}
  finally {vm.runtime.dispose();}
});

test('runtime metadata includes compiler-repaired missing variables/lists and canonical IDs', async () => {
  const stage = baseTarget('Stage', true, {
    flag: block('event_whenflagclicked', {}, {}, 'increment'),
    increment: block('data_changevariableby', {VALUE: number(3)}, {VARIABLE: ['existing', '<score>&']}, null, 'flag')
  });
  stage.variables = {'<score>&': ['existing', 4]};
  const sprite = baseTarget('Sprite', false, {
    flag: block('event_whenflagclicked', {}, {}, 'read'),
    read: block('data_setvariableto', {VALUE: [3, [12, 'missing', 'missing-id'], [4, '0']]}, {VARIABLE: ['copied', 'copied-id']}, 'increment', 'flag'),
    increment: block('data_changevariableby', {VALUE: number(2)}, {VARIABLE: ['missing', 'missing-id']}, 'append', 'read'),
    append: block('data_addtolist', {ITEM: number(8)}, {LIST: ['missing list', 'missing-list-id']}, null, 'increment')
  });
  const data = project([stage, sprite]);
  data.monitors = [{id: '<score>&', opcode: 'data_variable', params: {VARIABLE: 'existing'}, visible: true, spriteName: null, mode: 'default'}];
  const compiled = await compileProject(await archive(data));
  assert.deepEqual(compiled.manifest.project.targets[0].variables.ltscoregtamp, ['existing', 4]);
  assert.deepEqual(compiled.manifest.project.targets[1].variables['missing-id'], ['missing', 0]);
  assert.deepEqual(compiled.manifest.project.targets[1].lists['missing-list-id'], ['missing list', []]);
  assert.equal(compiled.manifest.project.monitors[0].id, 'ltscoregtamp');
  const vm = await setup(compiled);
  try {
    for (const target of vm.runtime.targets) target.blocks.getBlock = () => {throw new Error('No block graph');};
    vm.greenFlag(); for (let i = 0; i < 4; i++) vm.runtime._step();
    const [actualStage, actualSprite] = vm.runtime.targets;
    assert.equal(actualStage.variables.ltscoregtamp.value, 7);
    assert.equal(actualSprite.variables['copied-id'].value, 0);
    assert.equal(actualSprite.variables['missing-id'].value, 2);
    assert.deepEqual(actualSprite.variables['missing-list-id'].value, [8]);
    assert.equal(vm.runtime._monitorState.get('ltscoregtamp').get('value'), 7);
  } finally {vm.runtime.dispose();}
});
