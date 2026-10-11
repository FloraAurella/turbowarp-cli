'use strict';

const JSZip = require('@turbowarp/jszip');
const {createHash} = require('node:crypto');

function makeWav() {
  const rate = 22050, count = Math.floor(rate * 0.18);
  const data = Buffer.alloc(44 + count * 2);
  data.write('RIFF', 0);data.writeUInt32LE(data.length - 8, 4);data.write('WAVE', 8);
  data.write('fmt ', 12);data.writeUInt32LE(16, 16);data.writeUInt16LE(1, 20);data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);data.writeUInt32LE(rate * 2, 28);data.writeUInt16LE(2, 32);data.writeUInt16LE(16, 34);
  data.write('data', 36);data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const envelope = Math.min(i / (rate * 0.015), (count - i) / (rate * 0.025), 1);
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 660 * i / rate) * 9000 * envelope), 44 + i * 2);
  }
  return {data, rate, count};
}

async function createFeatureFixture() {
  const zip = new JSZip();
  const asset = (name, data, format) => {
    const assetId = createHash('md5').update(data).digest('hex');
    const md5ext = `${assetId}.${format}`;
    zip.file(md5ext, data);
    return {name, assetId, md5ext, dataFormat: format};
  };
  const background = asset('Feature test', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#ddeaf5"/><rect x="30" y="40" width="420" height="250" rx="20" fill="#ffffff"/><text x="240" y="110" text-anchor="middle" font-size="24" fill="#243a4f" font-family="sans-serif">AOT browser feature test</text><text x="240" y="155" text-anchor="middle" font-size="15" fill="#446077" font-family="sans-serif">Answer → note → drum → WAV → completed</text></svg>', 'svg');
  Object.assign(background, {bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180});
  const wav = makeWav();
  const sound = asset('beep', wav.data, 'wav');
  Object.assign(sound, {format: '', rate: wav.rate, sampleCount: wav.count});
  const blocks = {};
  let sequence = 0;
  const make = (opcode, inputs = {}, fields = {}) => {
    const id = `feature_original_${sequence++}`;
    blocks[id] = {opcode, inputs, fields, next: null, parent: null, shadow: false, topLevel: false};
    return id;
  };
  const number = value => [1, [4, String(value)]];
  const text = value => [1, [10, String(value)]];
  const set = (id, value) => make('data_setvariableto', {VALUE: value}, {VARIABLE: [id, id]});
  const chain = (...ids) => {
    blocks[ids[0]].topLevel = true;
    for (let i = 1; i < ids.length; i++) {blocks[ids[i - 1]].next = ids[i];blocks[ids[i]].parent = ids[i - 1];}
  };
  const flag = make('event_whenflagclicked');
  const ask = make('sensing_askandwait', {QUESTION: text('输入测试答案（例如 AOT-ok）')});
  const answerReporter = make('sensing_answer');
  const saveAnswer = set('answer', [2, answerReporter]);blocks[answerReporter].parent = saveAnswer;
  const note = make('music_playNoteForBeats', {NOTE: number(60), BEATS: number(0.15)});
  const drum = make('music_playDrumForBeats', {DRUM: number(1), BEATS: number(0.15)});
  const wavPlay = make('sound_playuntildone', {SOUND_MENU: text('beep')});
  chain(flag, set('qdone', number(0)), set('musicdone', number(0)), set('sounddone', number(0)), set('score', number(0)),
    set('answer', text('')), make('music_setTempo', {TEMPO: number(120)}), ask, saveAnswer, set('qdone', number(1)),
    note, drum, set('musicdone', number(1)), wavPlay, set('sounddone', number(1)), set('score', number(123)));
  const variables = {qdone: ['qdone', 0], musicdone: ['musicdone', 0], sounddone: ['sounddone', 0], answer: ['answer', ''], score: ['score', 0]};
  const project = {targets: [{isStage: true, name: 'Stage', variables, lists: {}, broadcasts: {}, blocks,
    comments: {}, costumes: [background], sounds: [sound], currentCostume: 0, volume: 100, layerOrder: 0, tempo: 120,
    videoState: 'off', videoTransparency: 50}], extensions: ['music'], meta: {semver: '3.0.0'},
    monitors: Object.keys(variables).map((id, i) => ({id, opcode: 'data_variable', params: {VARIABLE: id}, spriteName: null,
      mode: 'default', value: variables[id][1], visible: true, x: 36, y: 190 + i * 25, width: 0, height: 0}))};
  zip.file('project.json', JSON.stringify(project));
  return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
}

module.exports = {createFeatureFixture};
