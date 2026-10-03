const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createCanvas,loadImage,Path2D}=require('@napi-rs/canvas');
const {CommandSession}=require('../src/commands');
const vector=require('../src/vector-editor');
const modulePaint=require('../src/paint-commands');
const withSession=async fn=>{const s=new CommandSession(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'tw-m4-paint-'));try{await s.execute(['new']);await fn(s,dir);}finally{s.dispose();await fs.rm(dir,{recursive:true,force:true});}};
const paint=(s,action,id,options={},values=[])=>s.execute(['paint',action,id,...values,...Object.entries(options).flatMap(([k,v])=>v===true?[`--${k}`]:[`--${k}`,typeof v==='object'?JSON.stringify(v):String(v)])]);
const blank=(s,mode='vector',width=100,height=80)=>s.execute(['asset','blank','costume','canvas','--mode',mode,'--width',String(width),'--height',String(height)]);
const addRect=async(s,id,x,y,width=10,height=10,fill='#ff0000')=>(await paint(s,'rect',id,{spec:{x,y,width,height,fill}})).ids[0];
const nodes=(s,id)=>paint(s,'nodes',id);
const pixels=async(s,id)=>{
  const t=s.project.target(),c=t.getCostumes()[require('../src/asset-commands').resolve(t,'costume',id)],image=await loadImage(Buffer.from(c.asset.data)),canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);return {canvas,width:image.width,height:image.height,data:canvas.getContext('2d').getImageData(0,0,image.width,image.height).data};
};
const pixel=(data,width,x,y)=>Array.from(data.subarray((y*width+x)*4,(y*width+x)*4+4));
const close=(a,b,tolerance=1e-5)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} vs ${b}`);
const geometry=(actual,expected)=>{for(const k of ['x','y','width','height'])close(actual[k],expected[k]);};
const reload=async(s)=>{await s.project.load(await s.project.bytes());};

test('paint contract validates min/max without counting action and read-only exports do not dirty history',async()=>withSession(async(s,dir)=>{
  assert.equal(modulePaint.specs.paint.rect.min,1);assert.ok(Array.isArray(modulePaint.specs.paint.rect.options));assert.equal(modulePaint.requiresProject('paint',['defaults']),false);
  const c=await blank(s),r=await addRect(s,c.id,2,3);await s.execute(['save',path.join(dir,'base.sb3')]);const history=s.undoStack.length;
  await paint(s,'nodes',c.id);await paint(s,'select',c.id,{nodes:r});await paint(s,'copy',c.id,{nodes:r,output:path.join(dir,'clipboard.json')});
  assert.equal(s.dirty,false);assert.equal(s.undoStack.length,history);
  await assert.rejects(paint(s,'rect',c.id,{spec:{x:1,y:2,width:-1,height:2}}),/positive/);
  await assert.rejects(s.execute(['paint','rect',c.id,'extra','--spec','{}']),/arguments/);assert.equal(s.undoStack.length,history);assert.equal(s.dirty,false);
}));

test('vector multi-selection group/order/ungroup, world transforms and clipboard survive reload and undo/redo',async()=>withSession(async(s,dir)=>{
  const c=await blank(s),a=await addRect(s,c.id,0,0),b=await addRect(s,c.id,20,10),d=await addRect(s,c.id,40,20);
  const grouped=await paint(s,'group',c.id,{nodes:[a,b]}),g=grouped.ids[0];assert.equal((await nodes(s,c.id)).find(n=>n.id===a).parent,g);
  await paint(s,'transform',c.id,{nodes:g,spec:{dx:7,dy:8,pivot:[0,0],scaleX:2,scaleY:3}});
  geometry((await nodes(s,c.id)).find(n=>n.id===a).bounds,{x:7,y:8,width:20,height:30});
  const before=(await nodes(s,c.id)).filter(n=>[a,b].includes(n.id)).map(n=>n.bounds);
  await paint(s,'ungroup',c.id,{nodes:g});const after=await nodes(s,c.id);geometry(after.find(n=>n.id===a).bounds,before[0]);geometry(after.find(n=>n.id===b).bounds,before[1]);
  await paint(s,'order',c.id,{nodes:[a,b],direction:'front'});assert.deepEqual((await nodes(s,c.id)).map(n=>n.id),[d,a,b]);
  await paint(s,'order',c.id,{nodes:[a,b],direction:'backward'});assert.deepEqual((await nodes(s,c.id)).map(n=>n.id),[a,b,d]);
  await paint(s,'order',c.id,{nodes:[a,b],direction:'forward'});assert.deepEqual((await nodes(s,c.id)).map(n=>n.id),[d,a,b]);
  const file=path.join(dir,'vector-clip.json');await paint(s,'copy',c.id,{nodes:[a,b],output:file});const count=(await nodes(s,c.id)).length;
  const pasted=await paint(s,'paste',c.id,{from:file,dx:5,dy:6});assert.equal(pasted.ids.length,2);assert.equal(new Set((await nodes(s,c.id)).map(n=>n.id)).size,count+2);
  geometry((await nodes(s,c.id)).find(n=>n.id===pasted.ids[0]).bounds,{...before[0],x:before[0].x+5,y:before[0].y+6});
  await s.execute(['paint','undo']);assert.equal((await nodes(s,c.id)).length,count);await s.execute(['paint','redo']);assert.equal((await nodes(s,c.id)).length,count+2);
  await reload(s);assert.equal((await nodes(s,c.id)).length,count+2);assert.equal((await s.execute(['asset','info','costume',c.id])).id,c.id);
  const cutFile=path.join(dir,'cut.json');await paint(s,'cut',c.id,{nodes:a,output:cutFile});assert.ok(!(await nodes(s,c.id)).some(n=>n.id===a));
  await s.execute(['undo']);assert.ok((await nodes(s,c.id)).some(n=>n.id===a));assert.equal(JSON.parse(await fs.readFile(cutFile,'utf8')).type,'tw-vector-clipboard');
  assert.equal(typeof document,'undefined');assert.equal(typeof window,'undefined');
}));

test('explicit clipboard is a snapshot and eyedropper applies sampled RGBA to selected vector nodes',async()=>withSession(async(s,dir)=>{
  const c=await blank(s,'vector',40,20),a=await addRect(s,c.id,0,0,10,10,'#ff0000'),b=await addRect(s,c.id,20,0,10,10,'#0000ff');
  const file=path.join(dir,'snapshot.json');await paint(s,'copy',c.id,{nodes:a,output:file});await paint(s,'style',c.id,{nodes:a,fill:'#00ff00'});
  const pasted=await paint(s,'paste',c.id,{from:file,dy:10});assert.equal((await nodes(s,c.id)).find(n=>n.id===pasted.ids[0]).attributes.fill,'#ff0000');
  const applied=await paint(s,'eyedropper',c.id,{nodes:b},['2','2']);assert.deepEqual(applied.rgba,[0,255,0,255]);assert.equal(applied.applied,'fill');
  await s.execute(['asset','convert','costume',c.id,'bitmap']);assert.deepEqual((await paint(s,'sample',c.id,{},['44','4'])).rgba,[0,255,0,255]);assert.deepEqual((await paint(s,'sample',c.id,{},['4','24'])).rgba,[255,0,0,255]);
  await s.execute(['undo']);await s.execute(['undo']);assert.equal((await nodes(s,c.id)).find(n=>n.id===b).attributes.fill,'#0000ff');
}));

test('point-delete selection keeps neighbor handles; double-click adjustment scales them by frozen HANDLE_RATIO',async()=>withSession(async s=>{
  const c=await blank(s),id=(await paint(s,'path',c.id,{spec:{d:'M0 0 C10 0 10 0 20 0 C30 0 30 0 40 0'}})).ids[0];
  let points=(await paint(s,'points',c.id,{path:id}))[0].points;await paint(s,'point-delete',c.id,{path:id,segments:points[1].id});let remaining=(await paint(s,'points',c.id,{path:id}))[0].points;assert.deepEqual(remaining[0].handleOut,[10,0]);assert.deepEqual(remaining[1].handleIn,[-10,0]);
  await s.execute(['undo']);points=(await paint(s,'points',c.id,{path:id}))[0].points;
  await paint(s,'point-delete',c.id,{path:id,segments:points[1].id,spec:{adjustNeighbors:true}});remaining=(await paint(s,'points',c.id,{path:id}))[0].points;close(remaining[0].handleOut[0],40*0.3902628565,1e-8);close(remaining[1].handleIn[0],-40*0.3902628565,1e-8);
}));

test('vector align/distribute/rotate/skew and clones produce exact geometric deltas',async()=>withSession(async s=>{
  const c=await blank(s),a=await addRect(s,c.id,0,1,10,10),b=await addRect(s,c.id,25,8,10,20),d=await addRect(s,c.id,80,50,20,10);
  await paint(s,'align',c.id,{nodes:[a,b,d],direction:'top'});assert.ok((await nodes(s,c.id)).every(n=>n.bounds.y===1));
  await paint(s,'distribute',c.id,{nodes:[a,b,d],direction:'horizontal'});geometry((await nodes(s,c.id)).find(n=>n.id===b).bounds,{x:40,y:1,width:10,height:20});
  await paint(s,'rotate',c.id,{nodes:a,spec:{pivot:[0,0]}},['90']);geometry((await nodes(s,c.id)).find(n=>n.id===a).bounds,{x:-11,y:0,width:10,height:10});
  await paint(s,'skew',c.id,{nodes:b,spec:{pivot:[0,0]}},['45','0']);geometry((await nodes(s,c.id)).find(n=>n.id===b).bounds,{x:41,y:1,width:30,height:20});
  const clone=await paint(s,'clone',c.id,{nodes:d,dx:-5,dy:10});assert.notEqual(clone.ids[0],d);geometry((await nodes(s,c.id)).find(n=>n.id===clone.ids[0]).bounds,{x:75,y:11,width:20,height:10});
}));

test('vector segment insertion preserves cubic curve geometry; IDs, handles and deletion are persistent',async()=>withSession(async s=>{
  const c=await blank(s),id=(await paint(s,'path',c.id,{spec:{d:'M 0 0 C 0 30 40 30 40 0 L 60 0',fill:'none',stroke:'#000000'}})).ids[0];
  const original=new Path2D((await nodes(s,c.id)).find(n=>n.id===id).attributes.d),initial=(await paint(s,'points',c.id,{path:id}))[0].points;
  await paint(s,'point-add',c.id,{path:id,after:initial[0].id,t:0.5});const split=(await paint(s,'points',c.id,{path:id}))[0].points;assert.equal(split.length,4);close(split[1].x,20);close(split[1].y,22.5);
  const edited=new Path2D((await nodes(s,c.id)).find(n=>n.id===id).attributes.d);assert.deepEqual(edited.computeTightBounds(),original.computeTightBounds());
  const ctx=createCanvas(80,50).getContext('2d');for(let y=0;y<35;y++)for(let x=0;x<65;x++)assert.equal(ctx.isPointInStroke(edited,x,y),ctx.isPointInStroke(original,x,y),`${x},${y}`);
  await reload(s);assert.deepEqual((await paint(s,'points',c.id,{path:id}))[0].points.map(p=>p.id),split.map(p=>p.id));
  await paint(s,'pointed',c.id,{path:id,segments:split[1].id});assert.deepEqual((await paint(s,'points',c.id,{path:id}))[0].points[1].handleIn,[0,0]);
  await paint(s,'curved',c.id,{path:id,segments:split[1].id});assert.ok((await paint(s,'points',c.id,{path:id}))[0].points[1].handleIn.some(v=>v!==0));
  await paint(s,'point-set',c.id,{path:id,segments:split[1].id,spec:{x:25,y:20,handleIn:[-5,-2],handleOut:[5,2]}});assert.equal((await paint(s,'points',c.id,{path:id}))[0].points[1].x,25);
  await paint(s,'point-delete',c.id,{path:id,segments:split[1].id});assert.equal((await paint(s,'points',c.id,{path:id}))[0].points.length,3);
  await s.execute(['undo']);assert.equal((await paint(s,'points',c.id,{path:id}))[0].points[1].id,split[1].id);
}));

test('legacy vector add returns original shape tags and text empty commit removes node',async()=>withSession(async s=>{
  const c=await blank(s),circle=await s.execute(['vector','add',c.id,'circle','10','10','5','#ff0000']);assert.equal((await nodes(s,c.id)).find(n=>n.id===circle.id).tag,'circle');
  await s.execute(['vector','set',c.id,circle.id,'r','8']);geometry((await nodes(s,c.id)).find(n=>n.id===circle.id).bounds,{x:2,y:2,width:16,height:16});
  const text=(await paint(s,'text',c.id,{spec:{x:2,y:20,text:'abc'}})).ids[0];await paint(s,'text-set',c.id,{nodes:text},['']);assert.ok(!(await nodes(s,c.id)).some(n=>n.id===text));
  const optionText=(await paint(s,'text',c.id,{spec:{x:2,y:20,text:'option'}})).ids[0];await paint(s,'text-set',c.id,{nodes:optionText,text:''});assert.ok(!(await nodes(s,c.id)).some(n=>n.id===optionText));
}));

test('path parser supports relative/smooth/quadratic/arcs and rejects incomplete commands',()=>{
  for(const d of ['m 2 3 l 4 0 h 3 v 5 z','M0 0 Q 10 20 20 0 T40 0','M0 0 C1 2 3 4 5 6 S7 8 9 10','M0 10 A10 10 0 0 1 20 10']) {
    const n={name:'path',attribs:{id:'p',d}},model=vector.pathModel(n),canonical=vector.pathText(model);assert.ok(canonical.startsWith('M'));
    const a=new Path2D(d).computeTightBounds(),b=new Path2D(canonical).computeTightBounds();for(let i=0;i<4;i++)close(a[i],b[i],0.01);
  }
  for(const d of ['L 1 2','M 0','M0 0 C1 2 3','M0 0 A1 1 0 3 0 5 5'])assert.throws(()=>vector.pathModel({name:'path',attribs:{id:'p',d}}));
});

test('vector style/alpha/HSV/gradient and swap change actual pixels; eraser performs path subtraction',async()=>withSession(async(s,dir)=>{
  const c=await blank(s,'vector',40,20),a=await addRect(s,c.id,0,0,40,20,'#ff0000');
  const render=async()=>{const file=path.join(dir,`image-${Math.random()}.svg`);await s.execute(['asset','export','costume',c.id,file]);const im=await loadImage(await fs.readFile(file)),canvas=createCanvas(im.width,im.height);canvas.getContext('2d').drawImage(im,0,0);return canvas.getContext('2d').getImageData(0,0,im.width,im.height).data;};
  await paint(s,'style',c.id,{nodes:a,alpha:0.5,gradient:{type:'horizontal',stops:[{offset:0,color:'#ff0000'},{offset:1,color:'#0000ff'}]}});
  const first=await render();assert.ok(pixel(first,40,2,10)[0]>pixel(first,40,2,10)[2]);assert.ok(pixel(first,40,37,10)[2]>pixel(first,40,37,10)[0]);close(pixel(first,40,20,10)[3],128,1);
  await paint(s,'gradient-swap',c.id,{nodes:a});const swapped=await render();assert.ok(pixel(swapped,40,2,10)[2]>pixel(swapped,40,2,10)[0]);
  await paint(s,'style',c.id,{nodes:a,fill:'#ff0000',alpha:1,hue:100/3,saturation:100,brightness:100});assert.deepEqual(pixel(await render(),40,20,10),[0,255,0,255]);
  await paint(s,'erase',c.id,{nodes:a,spec:{points:[[20,0],[20,20]],width:6}});const erased=await render();assert.equal(pixel(erased,40,20,10)[3],0);assert.deepEqual(pixel(erased,40,5,10),[0,255,0,255]);
  await s.execute(['undo']);assert.deepEqual(pixel(await render(),40,20,10),[0,255,0,255]);await s.execute(['redo']);assert.equal(pixel(await render(),40,20,10)[3],0);
}));

test('bitmap primitives, flood mask, gradients, brush, eraser, text and color alpha alter real pixels',async()=>withSession(async s=>{
  const c=await blank(s,'bitmap',40,30);
  await paint(s,'rect',c.id,{spec:{x:2,y:2,width:12,height:10,color:'#ff0000'}});let p=await pixels(s,c.id);assert.deepEqual(pixel(p.data,p.width,5,5),[255,0,0,255]);assert.equal(pixel(p.data,p.width,0,0)[3],0);
  const f=await paint(s,'flood',c.id,{spec:{x:3,y:3,color:'#0000ff'}});assert.equal(f.pixels,120);p=await pixels(s,c.id);assert.deepEqual(pixel(p.data,p.width,5,5),[0,0,255,255]);
  await paint(s,'ellipse',c.id,{spec:{x:20,y:2,width:12,height:10,color:'#00ff00'}});p=await pixels(s,c.id);assert.deepEqual(pixel(p.data,p.width,26,7),[0,255,0,255]);assert.equal(pixel(p.data,p.width,20,2)[3],0);
  await paint(s,'line',c.id,{spec:{x1:2,y1:20,x2:15,y2:20,width:3,color:'#00ff00'}});
  await paint(s,'brush',c.id,{spec:{points:[[20,20],[30,20],[30,26]],size:4,color:'#ff0000'}});p=await pixels(s,c.id);assert.deepEqual(pixel(p.data,p.width,25,20),[255,0,0,255]);
  await paint(s,'erase',c.id,{spec:{points:[[25,18],[25,24]],size:4}});p=await pixels(s,c.id);assert.equal(pixel(p.data,p.width,25,20)[3],0);
  await paint(s,'replace-color',c.id,{spec:{from:'#0000ff',to:'#ffff00'}});p=await pixels(s,c.id);assert.deepEqual(pixel(p.data,p.width,5,5),[255,255,0,255]);
  await paint(s,'opacity',c.id,{rect:'2,2,12,10',alpha:0.5});p=await pixels(s,c.id);assert.equal(pixel(p.data,p.width,5,5)[3],128);
  await paint(s,'text',c.id,{spec:{x:1,y:29,text:'A',fontSize:10,color:'#ffffff'}});p=await pixels(s,c.id);assert.ok(Array.from(p.data).some((v,i)=>i%4===0&&v===255&&p.data[i+1]===255&&p.data[i+2]===255));
  await reload(s);const reloaded=await pixels(s,c.id);assert.deepEqual(reloaded.data,p.data);
  await paint(s,'clear',c.id);await paint(s,'flood',c.id,{spec:{x:0,y:0,gradient:{type:'vertical',stops:[{offset:0,color:'#ff0000'},{offset:1,color:'#0000ff'}]}}});p=await pixels(s,c.id);assert.deepEqual(pixel(p.data,p.width,10,0),[255,0,0,255]);assert.deepEqual(pixel(p.data,p.width,10,29),[0,0,255,255]);
}));

test('bitmap rect crop/copy/cut/paste, selected move, resize/rotate/flip preserve numeric pixels and centers',async()=>withSession(async(s,dir)=>{
  const c=await blank(s,'bitmap',8,6);await s.execute(['asset','center','costume',c.id,'3','2']);
  await paint(s,'rect',c.id,{spec:{x:1,y:1,width:2,height:2,color:'#ff0000'}});
  await paint(s,'copy',c.id,{rect:'1,1,2,2',output:path.join(dir,'clip.png')});let p=await pixels(s,c.id);const before=p.data.slice();
  const snapshot=await fs.readFile(path.join(dir,'clip.png'));await paint(s,'replace-color',c.id,{spec:{from:'#ff0000',to:'#0000ff'}});assert.deepEqual(await fs.readFile(path.join(dir,'clip.png')),snapshot);await s.execute(['undo']);
  await paint(s,'paste',c.id,{from:path.join(dir,'clip.png'),spec:{x:5,y:3}});p=await pixels(s,c.id);assert.deepEqual(pixel(p.data,p.width,6,4),[255,0,0,255]);
  await s.execute(['undo']);assert.deepEqual((await pixels(s,c.id)).data,before);await s.execute(['redo']);
  await paint(s,'move',c.id,{rect:'5,3,2,2',dx:-1,dy:0});p=await pixels(s,c.id);assert.equal(pixel(p.data,p.width,6,4)[3],0);assert.equal(pixel(p.data,p.width,4,4)[0],255);
  await paint(s,'cut',c.id,{rect:'1,1,2,2',output:path.join(dir,'cut.png')});assert.equal(pixel((await pixels(s,c.id)).data,8,1,1)[3],0);
  await s.execute(['undo']);await paint(s,'crop',c.id,{rect:'1,1,6,4'});p=await pixels(s,c.id);assert.deepEqual([p.width,p.height],[6,4]);assert.deepEqual((await s.execute(['asset','center','costume',c.id])).center,[2,1]);
  await paint(s,'resize',c.id,{},['12','8']);p=await pixels(s,c.id);assert.deepEqual([p.width,p.height],[12,8]);assert.deepEqual((await s.execute(['asset','center','costume',c.id])).center,[4,2]);
  await paint(s,'flip-x',c.id);p=await pixels(s,c.id);assert.equal(pixel(p.data,p.width,11,0)[0],255);assert.deepEqual((await s.execute(['asset','center','costume',c.id])).center,[8,2]);
  await paint(s,'rotate',c.id,{},['90']);p=await pixels(s,c.id);assert.deepEqual([p.width,p.height],[8,12]);assert.deepEqual((await s.execute(['asset','center','costume',c.id])).center,[6,8]);
  await reload(s);assert.deepEqual((await pixels(s,c.id)).data,p.data);
}));

test('drawing failures and refused project/clipboard outputs roll back actual assets, selection and history',async()=>withSession(async(s,dir)=>{
  const c=await blank(s),a=await addRect(s,c.id,2,3),targetId=s.project.target().id;const before=await paint(s,'source',c.id),history=s.undoStack.length,dirty=s.dirty;
  const occupied=path.join(dir,'occupied.sb3');await fs.writeFile(occupied,'sentinel');
  await assert.rejects(paint(s,'style',c.id,{nodes:a,fill:'#00ff00',out:occupied}),/EEXIST/);assert.deepEqual(await paint(s,'source',c.id),before);assert.equal(s.undoStack.length,history);assert.equal(s.dirty,dirty);assert.equal(s.project.target().id,targetId);
  await assert.rejects(paint(s,'style',c.id,{nodes:a,fill:'#000000','stroke-width':-4}),/Stroke/);assert.deepEqual(await paint(s,'source',c.id),before);
  const clipboard=path.join(dir,'refused.json');await fs.writeFile(clipboard,'sentinel');await assert.rejects(paint(s,'cut',c.id,{nodes:a,output:clipboard}),/EEXIST/);assert.deepEqual(await paint(s,'source',c.id),before);assert.equal(await fs.readFile(clipboard,'utf8'),'sentinel');
  const bad=path.join(dir,'bad.json');await fs.writeFile(bad,JSON.stringify({type:'tw-vector-clipboard',version:1,nodes:['<image id="x" href="https://example.invalid/x.png"/>'],defs:[]}));await assert.rejects(paint(s,'paste',c.id,{from:bad}),/denied/);assert.deepEqual(await paint(s,'source',c.id),before);assert.equal(s.undoStack.length,history);
  const bit=await blank(s,'bitmap',10,10);const original=(await pixels(s,bit.id)).data.slice(),stack=s.undoStack.length;
  await assert.rejects(paint(s,'rect',bit.id,{spec:{x:1,y:1,width:4,height:4,color:'#00ff00',alpha:3}}),/Alpha/);assert.deepEqual((await pixels(s,bit.id)).data,original);assert.equal(s.undoStack.length,stack);
}));

test('paint filesystem rejects symlink config inputs and enforces config limits without session changes',async()=>withSession(async(s,dir)=>{
  const c=await blank(s),node=await addRect(s,c.id,2,3),config=path.join(dir,'defaults.json');
  await fs.writeFile(config,JSON.stringify({brush:5,fill:'#ff0000'}));
  assert.deepEqual((await s.execute(['paint','defaults','--config',config])).defaults,{brush:5,fill:'#ff0000'});
  const link=path.join(dir,'linked-config.json');await fs.symlink(config,link);
  const oversized=path.join(dir,'oversized-config.json');await fs.writeFile(oversized,' '.repeat(4*1024*1024+1));
  const source=await paint(s,'source',c.id),history=await s.execute(['history']),selected=s.project.target().id,dirty=s.dirty,file=s.project.file;
  for(const input of [link,oversized]) {
    await assert.rejects(s.execute(['paint','defaults','--config',input]),/symlink|symbolic|ELOOP|regular file|bytes|size/i);
    await assert.rejects(paint(s,'snap-move',c.id,{config:input},[node,'1','2']),/symlink|symbolic|ELOOP|regular file|bytes|size/i);
    assert.deepEqual(await paint(s,'source',c.id),source);assert.deepEqual(await s.execute(['history']),history);assert.equal(s.project.target().id,selected);assert.equal(s.dirty,dirty);assert.equal(s.project.file,file);
  }
  const real=path.join(dir,'input-parent');await fs.mkdir(real);await fs.writeFile(path.join(real,'config.json'),JSON.stringify({brush:3}));
  const parent=path.join(dir,'linked-input-parent');await fs.symlink(real,parent,'dir');
  await assert.rejects(s.execute(['paint','defaults','--config',path.join(parent,'config.json')]),/symlink|symbolic|parent/i);
  assert.deepEqual(await paint(s,'source',c.id),source);assert.deepEqual(await s.execute(['history']),history);assert.equal(s.dirty,dirty);
}));

test('paint filesystem rejects symlink clipboards and legacy SVG source plus oversize inputs with real asset rollback',async()=>withSession(async(s,dir)=>{
  const c=await blank(s),node=await addRect(s,c.id,2,3),clipboard=path.join(dir,'clip.json'),svg=path.join(dir,'source.svg');
  await paint(s,'copy',c.id,{nodes:node,output:clipboard});await s.execute(['asset','export','costume',c.id,svg]);
  const vectorLink=path.join(dir,'linked-vector.json'),svgLink=path.join(dir,'linked.svg');await fs.symlink(clipboard,vectorLink);await fs.symlink(svg,svgLink);
  const source=await paint(s,'source',c.id),history=await s.execute(['history']),dirty=s.dirty,selected=s.project.target().id;
  await assert.rejects(paint(s,'paste',c.id,{from:vectorLink}),/symlink|symbolic|ELOOP/i);
  await assert.rejects(s.execute(['vector','replace',c.id,svgLink]),/symlink|symbolic|ELOOP/i);
  const bigVector=path.join(dir,'big-vector.json');await fs.writeFile(bigVector,' '.repeat(16*1024*1024+1));
  await assert.rejects(paint(s,'paste',c.id,{from:bigVector}),/regular file|bytes|size/i);
  await assert.rejects(s.execute(['vector','replace',c.id,bigVector]),/regular file|bytes|size/i);
  assert.deepEqual(await paint(s,'source',c.id),source);assert.deepEqual(await s.execute(['history']),history);assert.equal(s.dirty,dirty);assert.equal(s.project.target().id,selected);
  const bitmap=await blank(s,'bitmap',6,6),png=path.join(dir,'clip.png');await paint(s,'rect',bitmap.id,{spec:{x:1,y:1,width:2,height:2,color:'#ff0000'}});await paint(s,'copy',bitmap.id,{output:png});
  const bitmapLink=path.join(dir,'linked.png');await fs.symlink(png,bitmapLink);const before=(await pixels(s,bitmap.id)).data.slice(),bitHistory=await s.execute(['history']);
  const bigMedia=path.join(dir,'big-media.png');const handle=await fs.open(bigMedia,'wx');try{await handle.truncate(32*1024*1024+1);}finally{await handle.close();}
  for(const input of [bitmapLink,bigMedia])await assert.rejects(paint(s,'paste',bitmap.id,{from:input}),/symlink|symbolic|ELOOP|regular file|bytes|size/i);
  assert.deepEqual((await pixels(s,bitmap.id)).data,before);assert.deepEqual(await s.execute(['history']),bitHistory);assert.equal(s.dirty,dirty);assert.equal(s.project.target().id,selected);
}));

test('paint filesystem parent-symlink outputs are rejected before cut/defaults/project writes and preserve session state',async()=>withSession(async(s,dir)=>{
  const c=await blank(s),node=await addRect(s,c.id,2,3),bitmap=await blank(s,'bitmap',6,6);await paint(s,'rect',bitmap.id,{spec:{x:1,y:1,width:2,height:2,color:'#ff0000'}});
  const real=path.join(dir,'real-output');await fs.mkdir(real);const parent=path.join(dir,'linked-output');await fs.symlink(real,parent,'dir');
  const saved=path.join(dir,'base.sb3');await s.execute(['save',saved]);
  const source=await paint(s,'source',c.id),before=(await pixels(s,bitmap.id)).data.slice(),history=await s.execute(['history']),selected=s.project.target().id,state=s.sessionState();
  const operations=[()=>paint(s,'copy',c.id,{nodes:node,output:path.join(parent,'copy.json')}),()=>paint(s,'cut',c.id,{nodes:node,output:path.join(parent,'cut.json')}),
    ()=>paint(s,'cut',bitmap.id,{rect:'1,1,2,2',output:path.join(parent,'cut.png')}),
    ()=>s.execute(['paint','defaults','--spec','{"brush":4}','--output',path.join(parent,'defaults.json')]),
    ()=>s.execute(['asset','export','costume',c.id,'--output',path.join(parent,'asset.svg')]),
    ()=>paint(s,'style',c.id,{nodes:node,fill:'#00ff00',out:path.join(parent,'result.sb3')})];
  for(const operation of operations) {
    await assert.rejects(operation(),/symlink|symbolic|parent/i);assert.deepEqual(await paint(s,'source',c.id),source);assert.deepEqual((await pixels(s,bitmap.id)).data,before);
    assert.deepEqual(await s.execute(['history']),history);assert.equal(s.dirty,false);assert.equal(s.project.target().id,selected);assert.equal(s.project.file,path.resolve(saved));assert.deepEqual(s.sessionState(),state);
  }
  assert.deepEqual(await fs.readdir(real),[],'no output or temporary file may be created through the linked parent');
}));

test('vector forward/backward ignores XML whitespace and rejected composited ungroup preserves original appearance',async()=>withSession(async s=>{
  const c=await blank(s),a=await addRect(s,c.id,0,0),b=await addRect(s,c.id,20,0),d=await addRect(s,c.id,40,0);
  const target=s.project.target(),doc=vector.open(target,c.id);
  doc.root.children=doc.root.children.flatMap(n=>[{type:'text',data:'\n  ',parent:doc.root},n]);vector.save(s,target,doc);
  await paint(s,'order',c.id,{nodes:a,direction:'forward'});assert.deepEqual((await nodes(s,c.id)).map(n=>n.id),[b,a,d]);
  await paint(s,'order',c.id,{nodes:a,direction:'backward'});assert.deepEqual((await nodes(s,c.id)).map(n=>n.id),[a,b,d]);
  const group=(await paint(s,'group',c.id,{nodes:[a,b]})).ids[0];await paint(s,'style',c.id,{nodes:group,alpha:0.5});const source=await paint(s,'source',c.id),history=s.undoStack.length;
  await assert.rejects(paint(s,'ungroup',c.id,{nodes:group}),/opacity/);assert.deepEqual(await paint(s,'source',c.id),source);assert.equal(s.undoStack.length,history);
}));

test('snap uses frozen priority, strict thresholds/zoom and size-first scale without recursive peers',async()=>withSession(async s=>{
  const c=await blank(s,'vector',100,80),a=await addRect(s,c.id,0,0,10,10),b=await addRect(s,c.id,35,20,20,20);
  const moved=await paint(s,'snap-move',c.id,{},[a,'37','17']);assert.deepEqual(moved.delta,[40,25]);assert.equal(moved.snap.type,'point');geometry((await nodes(s,c.id)).find(n=>n.id===a).bounds,{x:40,y:25,width:10,height:10});
  await s.execute(['undo']);const config={...Object.fromEntries(['pageCenter','pageAxes','pageEdges','pageCorners','objectCenters','objectMidlines','objectCorners'].map(k=>[k,false])),objectEdges:true,boxCenter:true,boxCorners:false,boxEdgeMids:false,threshold:10,zoom:2};
  const directTarget=s.project.target();await s.transaction('direct snap',()=>vector.execute(s,directTarget,['snap-move',c.id,a,'25','15'],{snapSettings:config}));
  // Center (30,20) is exactly five from peer left x=35: strict threshold/zoom rejects equality.
  geometry((await nodes(s,c.id)).find(n=>n.id===a).bounds,{x:25,y:15,width:10,height:10});
  await s.execute(['undo']);const scaled=await s.transaction('direct scale',()=>vector.execute(s,s.project.target(),['snap-scale',c.id,a,'1.7','1.6'],{snapSettings:{...config,zoom:1},spec:{shift:true}}));assert.deepEqual(scaled.scale,[2,2]);geometry((await nodes(s,c.id)).find(n=>n.id===a).bounds,{x:0,y:0,width:20,height:20});
  await s.execute(['undo']);const min=await s.transaction('direct min scale',()=>vector.execute(s,s.project.target(),['snap-scale',c.id,a,'0','0'],{snapSettings:{enabled:false},spec:{shift:true}}));assert.deepEqual(min.scale,[-0.0001,-0.0001]);
  assert.ok((await nodes(s,c.id)).some(n=>n.id===b));
}));
