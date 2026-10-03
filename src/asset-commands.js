require('./native-environment');
const crypto = require('node:crypto');
const path = require('node:path');
const {createCanvas,loadImage} = require('@napi-rs/canvas');
const {atomicWrite} = require('./project');
const {resourceError} = require('./errors');
const {number} = require('./vector-editor');

const specs = require('./command-catalog').moduleSpecs['asset-commands.js'];
const kind = raw => {if(!['costume','sound'].includes(raw))throw new Error('Asset kind must be costume/sound');return raw;};
const resources=(target,type)=>kind(type)==='costume'?target.getCostumes():target.getSounds();
const locator=(target,type,resource)=>`${type}:${target.id}:${encodeURIComponent(resource.name)}`;
const resolve=(target,type,selector)=>{
  const items=resources(target,type);
  // Permanent cliId is authoritative even when a name resembles another resource's ID.
  const direct=items.findIndex(item=>item.cliId===selector);if(direct>=0)return direct;
  const matches=items.map((item,i)=>item.name===selector||String(i)===String(selector)||locator(target,type,item)===selector||item.assetId===selector||item.soundId===selector?i:-1).filter(i=>i>=0);
  if(matches.length!==1)throw resourceError(matches.length, `Asset not found or ambiguous: ${selector}`, selector);return matches[0];
};
const ensure=(session,target)=>session.project.ensureAssetIds?.(target);
const newId=resource=>Object.defineProperty(resource,'cliId',{value:crypto.randomUUID(),writable:true,configurable:true});
const describe=(target,type,resource,index)=>({id:resource.cliId || locator(target,type,resource),index,name:resource.name,kind:type,assetId:resource.assetId,md5:resource.md5,format:resource.dataFormat,
  ...(type==='costume'?{size:resource.size,center:[resource.rotationCenterX,resource.rotationCenterY],resolution:resource.bitmapResolution}:
    {samples:resource.sampleCount,rate:resource.rate,duration:resource.sampleCount/resource.rate})});
const duplicate = async (session,target,type,index,destination=target,name) => {
  const original=resources(target,type)[index],vm=session.project.vm;
  if(type==='costume') {
    const copy={...original,name:name || original.name};delete copy.skinId;delete copy.broken;newId(copy);
    await session.project.hydrateCostume(copy);
    destination.addCostume(copy,destination===target?index+1:undefined);destination.setCostume(destination.getCostumes().indexOf(copy));
    vm.emitTargetsUpdate();ensure(session,destination);return describe(destination,type,copy,destination.getCostumes().indexOf(copy));
  }
  const copy={...original,name:name || original.name};delete copy.soundId;delete copy.broken;
  // addSound decodes a fresh SoundPlayer; do not let edits to a duplicate mutate the original player.
  await vm.addSound(copy,destination.id);newId(copy);
  if(destination===target)vm.reorderSound(target.id,destination.getSounds().indexOf(copy),index+1);
  ensure(session,destination);return describe(destination,type,copy,destination.getSounds().indexOf(copy));
};
const convertCostume=async (session,target,index,format,options={})=>{
  const costume=target.getCostumes()[index],tools=require('./editor-commands').bitmapTools;
  if(['bitmap','png'].includes(format)) {
    if(costume.dataFormat!=='svg') {
      const opened=await tools.open(session,target,costume.cliId || String(index));
      return tools.commit(session,target,costume,opened.canvas,undefined,costume.bitmapResolution || 2);
    }
    const root=require('htmlparser2').parseDOM(costume.asset.decodeText(),{xmlMode:true}).find(n=>n.name==='svg');
    const viewBox=root?.attribs?.viewBox?.trim().split(/[\s,]+/).map(Number) || [0,0,...costume.size];
    if(viewBox.length!==4||!viewBox.every(Number.isFinite)||viewBox[2]<=0||viewBox[3]<=0)throw new Error('Invalid SVG viewBox');
    const resolution=number(options.resolution ?? 2);if(resolution!==1&&resolution!==2)throw new Error('Conversion resolution must be 1 or 2');
    const width=Math.round(viewBox[2]*resolution),height=Math.round(viewBox[3]*resolution);tools.dimensions(width,height);
    // Use the already validated native SVG source, rasterizing directly at requested resolution.
    const source=session.project.renderer._allSkins[costume.skinId]._svg;
    const canvas=createCanvas(width,height);canvas.getContext('2d').putImageData(require('./native-renderer').rasterizeSVG(source,width,height),0,0);
    return tools.commit(session,target,costume,canvas,[(costume.rotationCenterX-viewBox[0])*resolution,(costume.rotationCenterY-viewBox[1])*resolution],resolution);
  }
  if(!['vector','svg'].includes(format))throw new Error('Costume conversion must be bitmap/png or vector/svg');
  if(costume.dataFormat==='svg')return {unchanged:true,format:'svg'};
  const image=await loadImage(Buffer.from(costume.asset.data));tools.dimensions(image.width,image.height);
  const canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);
  const resolution=costume.bitmapResolution || 2,width=image.width/resolution,height=image.height/resolution;
  // Keep PNG pixels, not an invented vector tracing. SVG coordinates use stage units.
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${width} ${height}"><image id="node-${crypto.randomUUID()}" x="0" y="0" width="${width}" height="${height}" xlink:href="data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}"/></svg>`;
  session.project.vm.setEditingTarget(target.id);session.project.vm.updateSvg(index,svg,costume.rotationCenterX/resolution,costume.rotationCenterY/resolution);target.updateAllDrawableProperties();
  return {format:'svg',width,height,embeddedBitmap:true};
};
const requiresProject=()=>true;
const isReadOnly=(command,args)=>['list','info','export','copy','range','render','history','undo','redo'].includes(args[0]) || ['size','center'].includes(args[0])&&args.length===3 || args[0]==='select'&&args[1]==='sound';
const execute=async (session,command,args,options={})=>{
  if(command!=='asset')throw new Error(`Unknown asset command ${command}`);
  const [action,rawKind,selector,...values]=args;
  if(['history','undo','redo'].includes(action)) {
    if(action==='history')return {undo:session.undoStack.map(item=>item.label),redo:session.redoStack.map(item=>item.label),limit:session.constructor.HISTORY_LIMIT ?? 30,byteLimit:session.constructor.HISTORY_BYTE_LIMIT ?? null,guiSoundEditorLimit:99,scope:'shared project transactions, not per-editor GUI history'};
    // Routed as read-only so the existing history command owns its transaction/rollback.
    const argv=[action];if(options.out)argv.push('--out',options.out);if(options.force)argv.push('--force');return session.execute(argv);
  }
  const type=kind(rawKind),target=session.project.target(options.target);ensure(session,target);
  const items=resources(target,type);
  if(action==='list')return items.map((item,i)=>describe(target,type,item,i));
  if(action==='blank') {
    if(type!=='costume')throw new Error('Blank supports costumes only');
    const width=number(options.width ?? 60),height=number(options.height ?? 60),tools=require('./editor-commands').bitmapTools;tools.dimensions(width,height);
    const storage=session.project.vm.runtime.storage,format=options.mode==='bitmap'?'png':'svg';if(options.mode&&!['vector','bitmap'].includes(options.mode))throw new Error('Mode must be vector/bitmap');
    const bytes=format==='png'?createCanvas(width,height).toBuffer('image/png'):Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`);
    const asset=storage.createAsset(format==='png'?storage.AssetType.ImageBitmap:storage.AssetType.ImageVector,format,new Uint8Array(bytes),null,true);
    const costume={name:selector || 'costume',asset,assetId:asset.assetId,md5:`${asset.assetId}.${format}`,dataFormat:format,bitmapResolution:format==='svg'?1:number(options.resolution ?? 2)};
    if(![1,2].includes(costume.bitmapResolution))throw new Error('Bitmap resolution must be 1 or 2');
    newId(costume);await session.project.hydrateCostume(costume);target.addCostume(costume);target.setCostume(items.length-1);ensure(session,target);session.project.vm.emitTargetsUpdate();return describe(target,type,costume,items.length-1);
  }
  const index=resolve(target,type,selector),item=items[index],vm=session.project.vm;
  const info=()=>describe(target,type,item,items.indexOf(item));
  if(action==='info')return info();
  if(action==='export') {
    const output=options.output || values[0];if(!output)throw new Error('Export requires --output or positional file');
    if(options.output&&values[0])throw new Error('Use --output or positional file, not both');return {...await atomicWrite(output,Buffer.from(item.asset.data),options.force),asset:info()};
  }
  if(action==='duplicate')return duplicate(session,target,type,index,target,options.name);
  if(action==='share')return duplicate(session,target,type,index,session.project.target(values[0]),options.name);
  if(action==='reorder') {
    const to=number(values[0]);if(!Number.isInteger(to)||to<0||to>=items.length)throw new Error('Reorder index must be 0-based and in bounds');
    if(type==='costume')vm.reorderCostume(target.id,index,to);else vm.reorderSound(target.id,index,to);return info();
  }
  if(action==='select'&&type==='sound')return {id:item.cliId || locator(target,type,item),selected:item.name,selection:'explicit sound selector; no persisted GUI selection'};
  vm.setEditingTarget(target.id);
  if(action==='rename'){if(!values[0])throw new Error('Missing name');if(type==='costume')vm.renameCostume(index,values[0]);else vm.renameSound(index,values[0]);return info();}
  if(action==='delete'){if(type==='costume'){if(items.length<2)throw new Error('Cannot delete final costume');vm.deleteCostume(index);}else vm.deleteSound(index);return {id:item.cliId || locator(target,type,item),deleted:true};}
  if(action==='select') {
    target.setCostume(index);return info();
  }
  if(action==='size') {
    if(!values.length)return type==='costume'?info():{...info(),bytes:item.asset.data.length};
    if(type!=='costume'||values.length!==2)throw new Error('Size edit requires costume width height');
    if(item.dataFormat==='svg') {
      const vector=require('./vector-editor'),doc=vector.open(target,selector),width=number(values[0]),height=number(values[1]);require('./editor-commands').bitmapTools.dimensions(width,height);
      const vb=doc.root.attribs.viewBox?doc.root.attribs.viewBox.trim().split(/[\s,]+/).map(Number):[0,0,...item.size],sx=width/vb[2],sy=height/vb[3];
      const nodes=doc.root.children.filter(n=>n.type==='tag'&&!['defs','style','metadata','title','desc'].includes(n.name));
      for(const n of nodes) {const matrix=vector.parseTransform(n.attribs.transform);n.attribs.transform=`matrix(${matrix[0]*sx} ${matrix[1]*sy} ${matrix[2]*sx} ${matrix[3]*sy} ${(matrix[4]-vb[0])*sx} ${(matrix[5]-vb[1])*sy})`;}
      doc.root.attribs.width=String(width);doc.root.attribs.height=String(height);doc.root.attribs.viewBox=`0 0 ${width} ${height}`;
      item.rotationCenterX=(item.rotationCenterX-vb[0])*sx;item.rotationCenterY=(item.rotationCenterY-vb[1])*sy;vector.save(session,target,doc);
    } else await require('./editor-commands').bitmapTools.execute(session,target,['resize',selector,...values],options);
    return info();
  }
  if(action==='center') {
    if(type!=='costume')throw new Error('Center applies to costumes only');if(!values.length)return info();if(values.length!==2)throw new Error('Center requires x y');
    const x=number(values[0]),y=number(values[1]);
    if(item.dataFormat==='svg')vm.updateSvg(index,item.asset.decodeText(),x,y);
    else {const opened=await require('./editor-commands').bitmapTools.open(session,target,selector);require('./editor-commands').bitmapTools.commit(session,target,item,opened.canvas,[x,y]);}
    target.updateAllDrawableProperties();return info();
  }
  if(action==='convert') {
    if(type==='costume'){await convertCostume(session,target,index,values[0],options);return info();}
    if(values[0]!=='wav')throw new Error('Sound conversion output must be wav');
    const audio=require('./audio-editor'),buffer=audio.bufferFor(target,index),rate=number(options.rate ?? buffer.sampleRate);
    if(!Number.isInteger(rate)||rate<3000||rate>384000)throw new Error('Audio rate must be 3000..384000');
    await audio.submit(session,target,index,await audio.resample(session,buffer.getChannelData(0),buffer.sampleRate,rate));return info();
  }
  if(type!=='sound')throw new Error(`${action} requires sound kind`);
  const allowed=new Set(['effect','trim','fade','mute','delete-range','keep-range','copy','paste','copy-to-new','range','render']);
  if(!allowed.has(action))throw new Error(`Unknown asset action ${action}`);
  if(['copy','render'].includes(action)&&options.output&&values[0])throw new Error('Use --output or positional file, not both');
  if(action==='paste'&&options.from&&values[0])throw new Error('Use --from or positional clipboard, not both');
  const audio=require('./audio-editor');let audioAction=action;
  if(action==='effect'){if(!Object.hasOwn(audio.effects,values[0]))throw new Error('Unknown sound effect');audioAction=values[0];}
  if(action==='fade'){if(!['in','out'].includes(values[0]))throw new Error('Fade must be in/out');audioAction=`fade-${values[0]}`;}
  if(action==='range')audioAction='select';
  const result=await audio.edit(session,target,index,audioAction,values,options);ensure(session,target);
  return {...result,id:action==='copy-to-new'?result.id:item.cliId || locator(target,type,item)};
};
module.exports={specs,requiresProject,isReadOnly,execute,booleanOptions:['smoothing'],resolve,describe,convertCostume};
