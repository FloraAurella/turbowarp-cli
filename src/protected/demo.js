'use strict';

const JSZip = require('@turbowarp/jszip');
const {createHash} = require('node:crypto');

async function createDemo() {
  const archive = new JSZip();
  const asset = (name, svg, x, y) => {
    const id = createHash('md5').update(svg).digest('hex');
    archive.file(`${id}.svg`, svg);
    return {name, assetId: id, md5ext: `${id}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: x, rotationCenterY: y};
  };
  const background = asset('轨道实验室', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#edf2f6"/><g fill="none" stroke="#c8d6e0"><circle cx="240" cy="170" r="110"/><circle cx="240" cy="170" r="65"/><path d="M25 170h430M240 50v240"/></g><circle cx="240" cy="170" r="7" fill="#8098aa"/><g font-family="sans-serif" fill="#364e64"><text x="24" y="36" font-size="20">ORBIT / 轨道实验室</text><text x="24" y="315" font-size="12">方向键移动 · 空格画线 · 点击飞船增加分数</text><text x="24" y="336" font-size="11">编译后，作品依然可以互动。</text></g></svg>', 240, 180);
  const ship = asset('探测器', '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="21" fill="#e77539"/><path d="m15 32 9-22 9 22-9-5z" fill="#fff"/><circle cx="24" cy="23" r="3" fill="#367591"/></svg>', 24, 24);
  const blocks = {};
  let sequence = 0;
  const make = (opcode, inputs = {}, fields = {}) => {
    const id = `demo_author_block_${sequence++}`;
    blocks[id] = {opcode, next: null, parent: null, inputs, fields, shadow: false, topLevel: false};
    return id;
  };
  const text = value => [1, [10, String(value)]];
  const number = value => [1, [4, String(value)]];
  const chain = (...ids) => {
    for (let i = 1; i < ids.length; i++) {blocks[ids[i - 1]].next = ids[i]; blocks[ids[i]].parent = ids[i - 1];}
    return ids[0];
  };
  const script = (...ids) => {chain(...ids); blocks[ids[0]].topLevel = true;};
  const sub = (owner, child) => {blocks[owner].inputs.SUBSTACK = [2, child]; blocks[child].parent = owner;};
  const keyCondition = key => {
    const menu = make('sensing_keyoptions', {}, {KEY_OPTION: [key, null]});
    blocks[menu].shadow = true;
    const report = make('sensing_keypressed', {KEY_OPTION: [1, menu]});
    blocks[menu].parent = report;
    return report;
  };
  const directional = (key, opcode, axis, delta) => {
    const cond = keyCondition(key);
    const branch = make('control_if', {CONDITION: [2, cond]});
    blocks[cond].parent = branch;
    sub(branch, make(opcode, {[axis]: number(delta)}));
    return branch;
  };
  const flag = make('event_whenflagclicked');
  const erase = make('pen_clear');
  const center = make('motion_gotoxy', {X: number(0), Y: number(10)});
  const size = make('pen_setPenSizeTo', {SIZE: number(3)});
  const color = make('pen_setPenColorToColor', {COLOR: [1, [9, '#e77539']]});
  const score = make('data_setvariableto', {VALUE: number(0)}, {VARIABLE: ['分数', 'score']});
  const loop = make('control_forever');
  const lineCond = keyCondition('space');
  const line = make('control_if_else', {CONDITION: [2, lineCond]});
  blocks[lineCond].parent = line;
  const down = make('pen_penDown'), up = make('pen_penUp');
  sub(line, down); blocks[line].inputs.SUBSTACK2 = [2, up]; blocks[up].parent = line;
  const directions = [directional('right arrow', 'motion_changexby', 'DX', 4), directional('left arrow', 'motion_changexby', 'DX', -4), directional('up arrow', 'motion_changeyby', 'DY', 4), directional('down arrow', 'motion_changeyby', 'DY', -4)];
  sub(loop, chain(line, ...directions));
  script(flag, erase, center, size, color, score, loop);
  script(make('event_whenthisspriteclicked'), make('data_changevariableby', {VALUE: number(1)}, {VARIABLE: ['分数', 'score']}));
  const project = {
    targets: [
      {isStage: true, name: 'Stage', variables: {score: ['分数', 0]}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [background], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'off'},
      {isStage: false, name: '探测器', variables: {}, lists: {}, broadcasts: {}, blocks, comments: {private: {blockId: flag, x: 30, y: 30, width: 200, height: 80, minimized: false, text: 'EDITOR_ONLY_PROTECTED_DEMO'}}, currentCostume: 0, costumes: [ship], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 10, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'}
    ],
    monitors: [{id: 'score', mode: 'default', opcode: 'data_variable', params: {VARIABLE: '分数'}, spriteName: null, value: 0, width: 0, height: 0, x: 350, y: 16, visible: true, sliderMin: 0, sliderMax: 100, isDiscrete: true}],
    extensions: ['pen'], meta: {semver: '3.0.0', vm: '0.2.0', agent: 'EDITOR_ONLY_PROTECTED_DEMO'}
  };
  archive.file('project.json', JSON.stringify(project));
  return archive.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
}

module.exports = {createDemo};
