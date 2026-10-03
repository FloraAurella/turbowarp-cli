const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {readLocalFile} = require('./project');
const MAX_MEDIA_BYTES=32*1024*1024;
const audioRoot = path.resolve(__dirname, '../vendor/scratch-gui-audio');
const cache = new Map();

const load = filename => {
  if (cache.has(filename)) return cache.get(filename);
  const full = path.join(audioRoot, filename);
  let source = fs.readFileSync(full, 'utf8');
  source = source.replace(/^import (\w+) from '([^']+)';$/gm, 'const $1 = require("$2");');
  source = source.replace(/^export default (\w+);$/gm, 'module.exports = $1;');
  if (filename === 'audio-effects.js') {
    const start = source.indexOf('        if (window.OfflineAudioContext) {');
    const end = source.indexOf('\n\n        // For the reverse', start);
    if (start < 0 || end < 0) throw new Error('Frozen GUI offline audio boundary changed');
    source = source.slice(0, start) + '        this.audioContext = new OfflineAudioContext(1, sampleCount, buffer.sampleRate);' + source.slice(end);
    const rendering = '        this.audioContext.startRendering();';
    if (!source.includes(rendering)) throw new Error('Frozen GUI rendering boundary changed');
    // Install oncomplete before starting, and expose asynchronous rendering failures
    // to edit() rather than leaving an unhandled rejection plus a 10-second timeout.
    source = source.replace(rendering, '').replace(
      '            done(renderedBuffer, this.adjustedTrimStart, this.adjustedTrimEnd);\n        };',
      '            done(renderedBuffer, this.adjustedTrimStart, this.adjustedTrimEnd);\n        };\n        return this.audioContext.startRendering();');
  }
  const compiled = new Module(full, module);
  compiled.filename = full; compiled.paths = Module._nodeModulePaths(audioRoot);
  const original = compiled.require.bind(compiled);
  compiled.require = request => request === 'node-web-audio-api' ? require('node-web-audio-api') :
    request.startsWith('./effects/') ? load(request.slice(2)) : original(request);
  compiled._compile('const {OfflineAudioContext} = require("node-web-audio-api");\n' + source, full);
  cache.set(filename, compiled.exports);
  return compiled.exports;
};

const effects = {reverse: 'reverse', louder: 'higher', softer: 'lower', faster: 'faster', slower: 'slower',
  echo: 'echo', robot: 'robot', 'fade-in': 'fade in', 'fade-out': 'fade out', mute: 'mute'};

const range = (buffer, raw, units = 'seconds', allowEmpty = false) => {
  let values = raw;
  if (typeof values === 'string') values = values.trim().startsWith('[') ? JSON.parse(values) : values.split(',');
  if (values === undefined) return {start:0,end:buffer.length,trimStart:0,trimEnd:1,explicit:false};
  if (!Array.isArray(values) || values.length !== 2 || !['seconds','samples','fraction'].includes(units)) throw new Error('Range must be [start,end], units seconds/samples/fraction');
  const [a,b] = values.map(value => {
    if (!['string','number'].includes(typeof value) || typeof value === 'string' && !value.trim() || !Number.isFinite(Number(value))) throw new Error('Range must contain finite numbers');
    return Number(value);
  });
  const limit = units === 'seconds' ? buffer.duration : units === 'samples' ? buffer.length : 1;
  if (a < 0 || b < a || b > limit || !allowEmpty && b === a || units === 'samples' && (!Number.isInteger(a) || !Number.isInteger(b))) throw new Error('Range must satisfy 0 <= start < end <= sound length');
  const trimStart = units === 'fraction' ? a : units === 'samples' ? a / buffer.length : a / buffer.duration;
  const trimEnd = units === 'fraction' ? b : units === 'samples' ? b / buffer.length : b / buffer.duration;
  const start = Math.floor(trimStart * buffer.length + 1e-10), end = Math.min(buffer.length,Math.floor(trimEnd * buffer.length + 1e-10));
  if (!allowEmpty && end <= start) throw new Error('Range must contain at least one sample');
  return {start,end,trimStart,trimEnd,explicit:true};
};
const bufferFor = (target,index) => {
  const sound=target.getSounds()[index];if(!sound)throw new Error('Sound index is out of range');
  const buffer=target.sprite.soundBank.getSoundPlayer(sound.soundId)?.buffer;if(!buffer)throw new Error('Sound has no decoded audio buffer');return buffer;
};
const monoBuffer = (session,samples,rate) => {
  if (!samples.length || samples.length > 50000000 || !Number.isInteger(rate) || rate < 3000 || rate > 384000 || !samples.every(Number.isFinite)) throw new Error('Invalid audio buffer (1..50 million finite samples, rate 3000..384000)');
  const buffer=session.project.audio.audioContext.createBuffer(1,samples.length,rate);buffer.getChannelData(0).set(samples);return buffer;
};
const resample = async (session,samples,rate,newRate) => {
  if (rate === newRate) return monoBuffer(session,samples,rate);
  const {OfflineAudioContext}=require('node-web-audio-api');
  const length=Math.floor(samples.length*newRate/rate);if(length<1||length>50000000)throw new Error('Resampled audio length is out of bounds');
  const context=new OfflineAudioContext(1,length,newRate),source=context.createBufferSource();source.buffer=monoBuffer(session,samples,rate);source.connect(context.destination);source.start();
  try {return await context.startRendering();} finally {source.disconnect();context.oncomplete=null;}
};
const submit = async (session,target,index,buffer) => {
  // Frozen GUI downsampleIfNeeded: >=10,000,000 PCM bytes resamples once to 22050 Hz.
  const originalRate=buffer.sampleRate;
  if (buffer.length*2 >= 10000000) buffer=await resample(session,buffer.getChannelData(0),buffer.sampleRate,22050);
  session.project.vm.setEditingTarget(target.id);
  session.project.vm.updateSoundBuffer(index,buffer,new Uint8Array(require('./commands').wav(buffer)));
  return {buffer,downsampled:buffer.sampleRate!==originalRate};
};
const edit = async (session, target, index, action, args = [], options = {}) => {
  const sound = target.getSounds()[index];
  if (!sound) throw new Error('Sound index is out of range');
  const player = target.sprite.soundBank.getSoundPlayer(sound.soundId);
  if (!player?.buffer) throw new Error('Sound has no decoded audio buffer');
  const buffer = player.buffer;
  let result, adjustedRange;
  const selection = range(buffer,options.range,options.units || 'seconds',['paste','select','keep','keep-range'].includes(action));
  if (['delete','delete-range','keep','keep-range','copy','copy-to-new','paste','select','render'].includes(action)) {
    const original=buffer.getChannelData(0),samples=original.slice(selection.start,selection.end);
    if (action==='select') return {name:sound.name,range:selection,rate:buffer.sampleRate,samples:buffer.length,selection:'explicit; pass --range to subsequent edits'};
    if (action==='copy'||action==='render') {
      const output=options.output || args[0];if(!output)throw new Error('Audio copy/render requires --output WAV file');
      const copied=monoBuffer(session,samples,buffer.sampleRate);
      return {...await require('./project').atomicWrite(output,require('./commands').wav(copied),options.force),range:selection,samples:copied.length,rate:copied.sampleRate};
    }
    if (action==='copy-to-new') {
      const storage=session.project.vm.runtime.storage,bytes=require('./commands').wav(monoBuffer(session,samples,buffer.sampleRate));
      const asset=storage.createAsset(storage.AssetType.Sound,storage.DataFormat.WAV,new Uint8Array(bytes),null,true);
      await session.project.vm.addSound({name:options.name || sound.name,asset,assetId:asset.assetId,md5:`${asset.assetId}.wav`,dataFormat:'wav',format:'',rate:buffer.sampleRate,sampleCount:samples.length},target.id);
      const newSound=target.getSounds().at(-1);Object.defineProperty(newSound,'cliId',{value:require('node:crypto').randomUUID(),writable:true,configurable:true});
      session.project.ensureAssetIds?.(target);return {id:newSound.cliId,name:newSound.name,samples:samples.length,rate:buffer.sampleRate};
    }
    if (action==='keep'||action==='keep-range') result=monoBuffer(session,samples.length?samples:new Float32Array(1),buffer.sampleRate);
    else if (action==='delete'||action==='delete-range') {
      if(!selection.explicit)throw new Error('Delete-range requires an explicit --range');
      const count=selection.start+original.length-selection.end,data=new Float32Array(Math.max(1,count));data.set(original.subarray(0,selection.start));data.set(original.subarray(selection.end),selection.start);result=monoBuffer(session,data,buffer.sampleRate);
    } else if (action==='paste') {
      const filename=options.from || args[0];if(!filename)throw new Error('Paste requires --from WAV file');
      const bytes=await readLocalFile(filename,MAX_MEDIA_BYTES);if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new Error('Audio clipboard must be WAV within 32 MiB');
      if(bytes.length<36)throw new Error('WAV clipboard header is incomplete');
      const clipboardRate=bytes.readUInt32LE(24);if(clipboardRate<3000||clipboardRate>384000)throw new Error('WAV clipboard sample rate is out of bounds');
      // Decode at the clipboard's rate, then perform exactly one GUI resampling pass to the destination rate.
      const {OfflineAudioContext}=require('node-web-audio-api'),decoder=new OfflineAudioContext(1,1,clipboardRate);
      const decoded=await decoder.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
      const clip=await resample(session,decoded.getChannelData(0),decoded.sampleRate,buffer.sampleRate),start=selection.explicit?selection.start:original.length,end=selection.explicit?selection.end:original.length;
      const length=start+clip.length+original.length-end;if(length>50000000)throw new Error('Pasted sound exceeds 50 million samples');
      const data=new Float32Array(length);data.set(original.subarray(0,start));data.set(clip.getChannelData(0),start);data.set(original.subarray(end),start+clip.length);result=monoBuffer(session,data,buffer.sampleRate);adjustedRange={start,end:start+clip.length,units:'samples'};
    }
  } else if (action === 'trim') {
    const start = options.range !== undefined ? selection.start / buffer.sampleRate : Number(args[0]), end = options.range !== undefined ? selection.end / buffer.sampleRate : Number(args[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > buffer.duration) {
      throw new Error('Trim requires 0 <= start < end <= duration (seconds)');
    }
    const first = options.range !== undefined ? selection.start : Math.floor(start * buffer.sampleRate), last = options.range !== undefined ? selection.end : Math.min(buffer.length, Math.floor(end * buffer.sampleRate));
    if (last <= first) throw new Error('Trim must retain at least one sample');
    // The frozen GUI editor edits channel 0 via a mono AudioBufferPlayer, not a
    // stereo downmix (which would change amplitudes and even cancel phase).
    result = session.project.audio.audioContext.createBuffer(1, last - first, buffer.sampleRate);
    result.getChannelData(0).set(buffer.getChannelData(0).subarray(first, last));
  } else {
    if (!Object.hasOwn(effects, action)) throw new Error('Effect must be reverse/louder/softer/faster/slower/echo/robot/fade-in/fade-out/mute');
    if (buffer.length < 2) return {name: sound.name, samples: buffer.length, rate: buffer.sampleRate, unchanged: true};
    const mono = session.project.audio.audioContext.createBuffer(1, buffer.length, buffer.sampleRate);
    mono.getChannelData(0).set(buffer.getChannelData(0));
    const AudioEffects = load('audio-effects.js');
    const processor = new AudioEffects(mono, effects[action], selection.trimStart, selection.trimEnd);
    try {
      result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Audio editor rendering timed out')), 10000);
        const fail = error => {clearTimeout(timer); reject(error);};
        try {
          const rendering = processor.process((rendered,trimStart,trimEnd) => {clearTimeout(timer); adjustedRange={start:trimStart*rendered.duration,end:trimEnd*rendered.duration,units:'seconds'};resolve(rendered);});
          Promise.resolve(rendering).catch(fail);
        } catch (error) {fail(error);}
      });
    } finally {
      processor.audioContext.oncomplete = null;
      processor.source.disconnect();
    }
  }
  const updated=await submit(session,target,index,result);
  if(updated.downsampled && adjustedRange?.units==='samples')adjustedRange={start:adjustedRange.start/result.sampleRate,end:adjustedRange.end/result.sampleRate,units:'seconds'};
  return {name:sound.name,samples:updated.buffer.length,rate:updated.buffer.sampleRate,downsampled:updated.downsampled,...(selection.explicit&&adjustedRange?{range:adjustedRange}:{})};
};

module.exports = {edit,effects,range,bufferFor,monoBuffer,resample,submit};
