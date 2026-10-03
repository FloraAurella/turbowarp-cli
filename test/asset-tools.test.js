const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const Module=require('node:module');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const JSZip=require('@turbowarp/jszip');
const {CommandSession,wav}=require('../src/commands');
const audio=require('../src/audio-editor');
const asset=require('../src/asset-commands');
const guiRoot=path.resolve(__dirname,'../../desktop-master/node_modules/scratch-gui/src/lib/audio');
const withSession=async fn=>{const s=new CommandSession(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'tw-m4-asset-'));try{await s.execute(['new']);await fn(s,dir);}finally{s.dispose();await fs.rm(dir,{recursive:true,force:true});}};
const sound=(s,id)=>{const t=s.project.target(),index=asset.resolve(t,'sound',id),item=t.getSounds()[index];return {item,index,buffer:audio.bufferFor(t,index)};};
const closeSamples=(actual,expected,tolerance=2e-6)=>{assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++)assert.ok(Number.isFinite(actual[i])&&Math.abs(actual[i]-expected[i])<=tolerance,`${i}: ${actual[i]} vs ${expected[i]}`);};
const makeSound=async(s,dir,name='tone',length=4410,rate=44100,channels=1,fn=(i,c)=>c?-0.25:Math.sin(i/17)*0.15)=>{
  const b=s.project.audio.audioContext.createBuffer(channels,length,rate);for(let c=0;c<channels;c++)b.getChannelData(c).set(Float32Array.from({length},(_,i)=>fn(i,c)));
  const file=path.join(dir,`${name}.wav`);await fs.writeFile(file,wav(b));await s.execute(['sound','add',file]);return (await s.execute(['asset','list','sound'])).at(-1);
};
const frozenEffect=async(buffer,action,start,end)=>{
  const {OfflineAudioContext}=require('node-web-audio-api');
  const load=filename=>{
    const full=path.join(guiRoot,filename);let source=syncFs.readFileSync(full,'utf8').replace(/^import (\w+) from '([^']+)';$/gm,'const $1 = require("$2");').replace(/^export default (\w+);$/gm,'module.exports = $1;');
    if(filename==='audio-effects.js') {const a=source.indexOf('        if (window.OfflineAudioContext) {'),b=source.indexOf('\n\n        // For the reverse',a);assert.ok(a>=0&&b>=0);source=source.slice(0,a)+'        this.audioContext = new OfflineAudioContext(1, sampleCount, buffer.sampleRate);'+source.slice(b);source=source.replace('        this.audioContext.startRendering();','').replace('            done(renderedBuffer, this.adjustedTrimStart, this.adjustedTrimEnd);\n        };','            done(renderedBuffer, this.adjustedTrimStart, this.adjustedTrimEnd);\n        };\n        this.audioContext.startRendering();');}
    const m=new Module(full,module);m.filename=full;m.paths=Module._nodeModulePaths(guiRoot);m.require=request=>request==='node-web-audio-api'?require(request):load(request.slice(2));m._compile('const {OfflineAudioContext}=require("node-web-audio-api");\n'+source,full);return m.exports;
  };
  const Processor=load('audio-effects.js'),context=new OfflineAudioContext(1,buffer.length,buffer.sampleRate),mono=context.createBuffer(1,buffer.length,buffer.sampleRate);mono.getChannelData(0).set(buffer.getChannelData(0));
  return new Promise(resolve=>new Processor(mono,{louder:'higher',softer:'lower','fade-in':'fade in','fade-out':'fade out'}[action]||action,start,end).process((result,a,b)=>resolve({buffer:result,range:[a*result.duration,b*result.duration]})));
};

for(const effect of Object.keys(audio.effects))test(`selected ${effect}: numeric PCM differential against frozen GUI graph and undo/redo/SB3`,{timeout:20000},async()=>withSession(async(s,dir)=>{
  const info=await makeSound(s,dir),original=sound(s,info.id).buffer.getChannelData(0).slice(),buffer=sound(s,info.id).buffer;
  const expected=await frozenEffect(buffer,effect,0.2,0.7);
  const result=await s.execute(['asset','effect','sound',info.id,effect,'--range','0.2,0.7','--units','fraction']);
  const current=sound(s,info.id);closeSamples(current.buffer.getChannelData(0),expected.buffer.getChannelData(0));assert.equal(result.samples,expected.buffer.length);assert.equal(result.id,info.id);
  assert.ok(Math.abs(result.range.start-expected.range[0])<1e-9);assert.ok(Math.abs(result.range.end-expected.range[1])<1e-9);assert.deepEqual(buffer.getChannelData(0),original);
  if(effect==='reverse') {closeSamples(current.buffer.getChannelData(0).slice(0,882),original.slice(0,882),0);closeSamples(current.buffer.getChannelData(0).slice(882,3087),original.slice(882,3087).reverse(),0);closeSamples(current.buffer.getChannelData(0).slice(3087),original.slice(3087),0);}
  if(effect==='fade-in'){assert.ok(Math.abs(current.buffer.getChannelData(0)[882])<0.0001);assert.ok(Math.abs(current.buffer.getChannelData(0)[2000]-original[2000])>0.001);}
  if(effect==='mute'){assert.equal(current.buffer.getChannelData(0)[2000],0);closeSamples(current.buffer.getChannelData(0).slice(0,800),original.slice(0,800),0);}
  assert.ok(Array.from(current.buffer.getChannelData(0)).some((v,i)=>v!==(original[i]||0))||result.samples!==original.length,'effect must change actual PCM');
  await s.execute(['asset','undo']);closeSamples(sound(s,info.id).buffer.getChannelData(0),original,0);await s.execute(['asset','redo']);closeSamples(sound(s,info.id).buffer.getChannelData(0),expected.buffer.getChannelData(0),1/32767);
  const saved=path.join(dir,'edited.sb3');await s.execute(['save',saved]);await s.execute(['open',saved]);assert.equal(sound(s,info.id).item.cliId,info.id);closeSamples(sound(s,info.id).buffer.getChannelData(0),expected.buffer.getChannelData(0),1/32767);
  assert.equal(typeof document,'undefined');assert.equal(typeof window,'undefined');
}));

test('asset ID survives rename/content edits/reorder/reload; duplicate resources have unique persistent UUIDs and independent players',async()=>withSession(async(s,dir)=>{
  const costume=(await s.execute(['asset','list','costume']))[0],second=await s.execute(['asset','duplicate','costume',costume.id]);assert.notEqual(costume.id,second.id);assert.equal(costume.assetId,second.assetId);assert.equal(second.index,costume.index+1);
  await s.execute(['asset','rename','costume',costume.id,'renamed']);assert.equal((await s.execute(['asset','info','costume',costume.id])).name,'renamed');
  await s.execute(['asset','reorder','costume',second.id,'0']);assert.equal((await s.execute(['asset','info','costume',second.id])).index,0);assert.equal(s.project.target().getCostumes()[s.project.target().currentCostume].cliId,second.id);
  await s.execute(['asset','select','costume',costume.id]);assert.equal(s.project.target().getCostumes()[s.project.target().currentCostume].cliId,costume.id);
  const one=await makeSound(s,dir),two=await s.execute(['asset','duplicate','sound',one.id]);assert.notEqual(one.id,two.id);assert.equal(one.assetId,two.assetId);assert.notEqual(sound(s,one.id).item.soundId,sound(s,two.id).item.soundId);
  const original=sound(s,one.id).buffer.getChannelData(0).slice();await s.execute(['asset','mute','sound',two.id]);closeSamples(sound(s,one.id).buffer.getChannelData(0),original,0);assert.ok(sound(s,two.id).buffer.getChannelData(0).every(v=>v===0));
  await s.execute(['asset','rename','sound',one.id,'renamedTone']);await s.execute(['asset','reorder','sound',two.id,'0']);assert.equal((await s.execute(['asset','info','sound',one.id])).name,'renamedTone');
  const saved=path.join(dir,'identity.sb3');await s.execute(['save',saved]);const zip=await JSZip.loadAsync(await fs.readFile(saved)),identity=JSON.parse(await zip.file('tw-cli-state.json').async('string'));
  assert.ok(identity.assets);await s.execute(['open',saved]);for(const id of [one.id,two.id])assert.equal((await s.execute(['asset','info','sound',id])).id,id);
  for(const id of [costume.id,second.id])assert.equal((await s.execute(['asset','info','costume',id])).id,id);
  const selected=s.project.target().id,shared=await s.execute(['asset','share','sound',one.id,'stage']);assert.notEqual(shared.id,one.id);assert.equal(s.project.target().id,selected);assert.ok(s.project.target('stage').getSounds().some(item=>item.cliId===shared.id));
}));

test('asset size/center and SVG/PNG conversion preserve stage dimensions and real colors, not vector tracing',async()=>withSession(async(s,dir)=>{
  const c=await s.execute(['asset','blank','costume','paint','--width','20','--height','10']);await s.execute(['asset','center','costume',c.id,'5','3']);
  await s.execute(['paint','rect',c.id,'--spec','{"x":0,"y":0,"width":20,"height":10,"fill":"#123456"}']);
  await s.execute(['asset','size','costume',c.id,'40','30']);let i=await s.execute(['asset','info','costume',c.id]);assert.deepEqual(i.size,[40,30]);assert.deepEqual(i.center,[10,9]);
  await s.execute(['asset','convert','costume',c.id,'bitmap']);i=await s.execute(['asset','info','costume',c.id]);assert.deepEqual(i.size,[80,60]);assert.deepEqual(i.center,[20,18]);assert.equal(i.resolution,2);assert.deepEqual((await s.execute(['paint','sample',c.id,'40','30'])).rgba,[18,52,86,255]);
  const png=path.join(dir,'copy.png');await s.execute(['asset','export','costume',c.id,'--output',png]);const image=await loadImage(await fs.readFile(png));assert.deepEqual([image.width,image.height],[80,60]);
  await s.execute(['asset','convert','costume',c.id,'vector']);i=await s.execute(['asset','info','costume',c.id]);assert.deepEqual(i.size,[40,30]);assert.deepEqual(i.center,[10,9]);assert.equal(i.format,'svg');assert.ok((await s.execute(['paint','source',c.id])).svg.includes('data:image/png;base64,'));
  await s.execute(['asset','convert','costume',c.id,'bitmap']);assert.deepEqual((await s.execute(['paint','sample',c.id,'40','30'])).rgba,[18,52,86,255]);
  await s.execute(['asset','size','costume',c.id,'20','20']);i=await s.execute(['asset','info','costume',c.id]);assert.deepEqual(i.center,[5,6]);
  await s.project.load(await s.project.bytes());assert.deepEqual((await s.execute(['asset','info','costume',c.id])).center,[5,6]);
}));

test('embedded bitmap SVG alpha/layer order is numerically visible on stage and survives SB3/undo/redo',async()=>withSession(async(s,dir)=>{
  const c=await s.execute(['asset','blank','costume','alpha','--mode','bitmap','--width','20','--height','20','--resolution','1']);
  await s.execute(['paint','rect',c.id,'--spec','{"x":0,"y":0,"width":20,"height":20,"color":"#ff0000","alpha":0.5}']);
  await s.execute(['asset','convert','costume',c.id,'vector']);
  const stage=async()=>{const image=await loadImage(s.project.renderer.png()),canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);return Array.from(canvas.getContext('2d').getImageData(240,180,1,1).data);};
  let sample=await stage();assert.ok(sample[0]>250&&sample[1]>=125&&sample[1]<=130&&sample[2]>=125&&sample[2]<=130);assert.equal(sample[3],255);
  const node=(await s.execute(['paint','rect',c.id,'--spec','{"x":0,"y":0,"width":20,"height":20,"fill":"#0000ff"}'])).ids[0];assert.deepEqual(await stage(),[0,0,255,255]);
  await s.execute(['paint','order',c.id,'--nodes',node,'--direction','back']);sample=await stage();assert.ok(sample[0]>=126&&sample[0]<=130&&sample[1]===0&&sample[2]>=125&&sample[2]<=129);
  await s.execute(['undo']);assert.deepEqual(await stage(),[0,0,255,255]);await s.execute(['redo']);
  const saved=path.join(dir,'embedded.sb3');await s.execute(['save',saved]);await s.execute(['open',saved]);assert.deepEqual(await stage(),sample);
  await s.execute(['asset','convert','costume',c.id,'bitmap']);const actual=(await s.execute(['paint','sample',c.id,'20','20'])).rgba;assert.ok(actual[0]>=126&&actual[0]<=130&&actual[1]===0&&actual[2]>=125&&actual[2]<=129&&actual[3]===255);
  const history=s.undoStack.length;await assert.rejects(s.execute(['paint','paste',c.id,'--from',path.join(dir,'missing.png')]),/ENOENT/);assert.equal(s.undoStack.length,history);assert.deepEqual((await s.execute(['paint','sample',c.id,'20','20'])).rgba,actual);
}));

test('sound copy/render/select/trim/delete/keep/paste/copy-to-new have sample-exact GUI slicing and mono channel-zero semantics',async()=>withSession(async(s,dir)=>{
  const info=await makeSound(s,dir,'ramp',20,8000,2,(i,c)=>c?-0.4:i/40),original=sound(s,info.id).buffer.getChannelData(0).slice();
  const range=await s.execute(['asset','range','sound',info.id,'--range','5,12','--units','samples']);assert.deepEqual([range.range.start,range.range.end],[5,12]);assert.equal(range.selection.startsWith('explicit'),true);
  const copy=path.join(dir,'clip.wav');await s.execute(['asset','copy','sound',info.id,'--range','5,12','--units','samples','--output',copy]);const bytes=await fs.readFile(copy);assert.equal(bytes.readUInt16LE(22),1);assert.equal(bytes.length,44+7*2);for(let j=0;j<7;j++)assert.ok(Math.abs(bytes.readInt16LE(44+j*2)/32767-original[5+j])<=1/32767);
  await s.execute(['asset','mute','sound',info.id]);assert.deepEqual(await fs.readFile(copy),bytes,'copied WAV remains a snapshot after editing its source');await s.execute(['undo']);
  const newSound=await s.execute(['asset','copy-to-new','sound',info.id,'--range','5,12','--units','samples']);assert.notEqual(newSound.id,info.id);closeSamples(sound(s,newSound.id).buffer.getChannelData(0),original.slice(5,12),1/32767);
  await s.execute(['asset','delete-range','sound',info.id,'--range','5,12','--units','samples']);closeSamples(sound(s,info.id).buffer.getChannelData(0),Float32Array.from([...original.slice(0,5),...original.slice(12)]),0);
  await s.execute(['undo']);await s.execute(['asset','trim','sound',info.id,'--range','5,12','--units','samples']);closeSamples(sound(s,info.id).buffer.getChannelData(0),original.slice(5,12),0);
  await s.execute(['undo']);await s.execute(['asset','keep-range','sound',info.id,'--range','5,12','--units','samples']);closeSamples(sound(s,info.id).buffer.getChannelData(0),original.slice(5,12),0);
  await s.execute(['undo']);await s.execute(['asset','paste','sound',info.id,'--from',copy,'--range','3,8','--units','samples']);const replacement=sound(s,info.id).buffer.getChannelData(0);closeSamples(replacement,Float32Array.from([...original.slice(0,3),...original.slice(5,12),...original.slice(8)]),1/32767);
  await s.execute(['undo']);await s.execute(['asset','paste','sound',info.id,'--from',copy]);closeSamples(sound(s,info.id).buffer.getChannelData(0),Float32Array.from([...original,...original.slice(5,12)]),1/32767);
  await s.execute(['undo']);await s.execute(['asset','delete-range','sound',info.id,'--range',`0,${original.length}`,'--units','samples']);assert.equal(sound(s,info.id).buffer.length,1);assert.equal(sound(s,info.id).buffer.getChannelData(0)[0],0);
  await s.execute(['undo']);await s.execute(['asset','keep-range','sound',info.id,'--range','5,5','--units','samples']);assert.equal(sound(s,info.id).buffer.length,1);assert.equal(sound(s,info.id).buffer.getChannelData(0)[0],0);
  await s.execute(['undo']);await s.execute(['asset','paste','sound',info.id,'--from',copy,'--range','5,5','--units','samples']);closeSamples(sound(s,info.id).buffer.getChannelData(0),Float32Array.from([...original.slice(0,5),...original.slice(5,12),...original.slice(5)]),1/32767);
  const render=path.join(dir,'render.wav');await s.execute(['asset','render','sound',newSound.id,render]);assert.equal((await fs.readFile(render)).length,44+7*2);
}));

test('sound paste resamples across rates with frozen OfflineAudioContext graph and convert changes rate/length',async()=>withSession(async(s,dir)=>{
  const destination=await makeSound(s,dir,'dest',4410,44100,1,()=>0.1),source=await makeSound(s,dir,'source',4410,44100,1,i=>Math.sin(i/17)*0.2),clip=path.join(dir,'clip.wav');
  await s.execute(['asset','convert','sound',destination.id,'wav','--rate','8000']);
  await s.execute(['asset','copy','sound',source.id,'--output',clip]);
  const bytes=await fs.readFile(clip),decoded=await s.project.audio.audioContext.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  // Use a separately constructed native resampling graph as numeric oracle.
  const {OfflineAudioContext}=require('node-web-audio-api'),context=new OfflineAudioContext(1,800,8000),node=context.createBufferSource();node.buffer=decoded;node.connect(context.destination);node.start();const expected=await context.startRendering();node.disconnect();
  const previous=sound(s,destination.id).buffer.length;
  await s.execute(['asset','paste','sound',destination.id,'--from',clip]);assert.equal(sound(s,destination.id).buffer.length,previous+800);closeSamples(sound(s,destination.id).buffer.getChannelData(0).slice(previous),expected.getChannelData(0));
  await s.execute(['asset','convert','sound',source.id,'wav','--rate','8000']);assert.equal(sound(s,source.id).buffer.sampleRate,8000);assert.equal(sound(s,source.id).buffer.length,800);closeSamples(sound(s,source.id).buffer.getChannelData(0),expected.getChannelData(0),1/32767);
}));

test('invalid effects/ranges/files/refused outputs roll back PCM, asset IDs, dirty state and history',async()=>withSession(async(s,dir)=>{
  const info=await makeSound(s,dir);await s.execute(['save',path.join(dir,'base.sb3')]);const original=sound(s,info.id).buffer.getChannelData(0).slice(),id=sound(s,info.id).item.assetId,history=s.undoStack.length;
  for(const args of [ ['asset','effect','sound',info.id,'unknown'],['asset','effect','sound',info.id,'reverse','--range','4,2'],['asset','trim','sound',info.id,'--range','0,0.0000001'] ])await assert.rejects(s.execute(args));
  const bad=path.join(dir,'bad.wav');await fs.writeFile(bad,'not audio');await assert.rejects(s.execute(['asset','paste','sound',info.id,'--from',bad]),/WAV/);
  const occupied=path.join(dir,'occupied.sb3');await fs.writeFile(occupied,'sentinel');await assert.rejects(s.execute(['asset','mute','sound',info.id,'--out',occupied]),/EEXIST/);
  closeSamples(sound(s,info.id).buffer.getChannelData(0),original,0);assert.equal(sound(s,info.id).item.assetId,id);assert.equal(s.undoStack.length,history);assert.equal(s.dirty,false);assert.equal(await fs.readFile(occupied,'utf8'),'sentinel');
  const clip=path.join(dir,'occupied.wav');await fs.writeFile(clip,'sentinel');await assert.rejects(s.execute(['asset','copy','sound',info.id,'--output',clip]),/EEXIST/);assert.equal(s.dirty,false);assert.equal(s.undoStack.length,history);
  await assert.rejects(s.execute(['asset','convert','sound',info.id,'wav','--rate','0']),/rate/);
}));

test('asset filesystem sound clipboard symlinks and oversized media fail closed without PCM/history changes',async()=>withSession(async(s,dir)=>{
  const info=await makeSound(s,dir),clip=path.join(dir,'clip.wav');await s.execute(['asset','copy','sound',info.id,'--output',clip]);
  const link=path.join(dir,'linked.wav');await fs.symlink(clip,link);
  const real=path.join(dir,'input-parent');await fs.mkdir(real);await fs.copyFile(clip,path.join(real,'clip.wav'));const parent=path.join(dir,'linked-input-parent');await fs.symlink(real,parent,'dir');
  const oversized=path.join(dir,'oversized.wav'),handle=await fs.open(oversized,'wx');try{await handle.truncate(32*1024*1024+1);}finally{await handle.close();}
  await s.execute(['save',path.join(dir,'saved.sb3')]);
  const pcm=sound(s,info.id).buffer.getChannelData(0).slice(),assetId=sound(s,info.id).item.assetId,history=await s.execute(['history']),selected=s.project.target().id,file=s.project.file,state=s.sessionState();
  for(const input of [link,path.join(parent,'clip.wav'),oversized]) {
    await assert.rejects(s.execute(['asset','paste','sound',info.id,'--from',input]),/symlink|symbolic|ELOOP|regular file|bytes|size|parent/i);
    closeSamples(sound(s,info.id).buffer.getChannelData(0),pcm,0);assert.equal(sound(s,info.id).item.assetId,assetId);assert.deepEqual(await s.execute(['history']),history);
    assert.equal(s.dirty,false);assert.equal(s.project.target().id,selected);assert.equal(s.project.file,file);assert.deepEqual(s.sessionState(),state);
  }
}));

test('asset filesystem linked-parent sound outputs fail closed and project output rollback preserves PCM/session',async()=>withSession(async(s,dir)=>{
  const info=await makeSound(s,dir),real=path.join(dir,'real-output');await fs.mkdir(real);const parent=path.join(dir,'linked-output');await fs.symlink(real,parent,'dir');
  await s.execute(['save',path.join(dir,'base.sb3')]);const pcm=sound(s,info.id).buffer.getChannelData(0).slice(),assetId=sound(s,info.id).item.assetId,history=await s.execute(['history']),selected=s.project.target().id,file=s.project.file,state=s.sessionState();
  const commands=[['asset','copy','sound',info.id,'--output',path.join(parent,'clip.wav')],['asset','render','sound',info.id,'--output',path.join(parent,'render.wav')],
    ['asset','export','sound',info.id,'--output',path.join(parent,'export.wav')],['asset','mute','sound',info.id,'--out',path.join(parent,'muted.sb3')]];
  for(const args of commands) {
    await assert.rejects(s.execute(args),/symlink|symbolic|parent/i);closeSamples(sound(s,info.id).buffer.getChannelData(0),pcm,0);assert.equal(sound(s,info.id).item.assetId,assetId);
    assert.deepEqual(await s.execute(['history']),history);assert.equal(s.dirty,false);assert.equal(s.project.target().id,selected);assert.equal(s.project.file,file);assert.deepEqual(s.sessionState(),state);
  }
  assert.deepEqual(await fs.readdir(real),[],'no outputs or temporary files may appear under a linked parent');
}));

test('native submit applies frozen 10MB downsample threshold once, and history states its actual shared capacity',async()=>withSession(async s=>{
  const fake=s.project.audio.audioContext.createBuffer(1,5000000,44100);fake.getChannelData(0).fill(0.1);
  const observed=[],target={id:'mock'};const session={project:{audio:s.project.audio,vm:{setEditingTarget(){},updateSoundBuffer(index,b,bytes){observed.push({index,b,bytes});}}}};
  const result=await audio.submit(session,target,0,fake);assert.equal(result.downsampled,true);assert.equal(result.buffer.sampleRate,22050);assert.equal(result.buffer.length,2500000);assert.equal(observed[0].bytes.length,44+5000000);
  const history=await s.execute(['asset','history']);assert.equal(history.limit,CommandSession.HISTORY_LIMIT);assert.equal(history.byteLimit,CommandSession.HISTORY_BYTE_LIMIT);assert.match(history.scope,/shared/);
}));
