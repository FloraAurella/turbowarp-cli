require('./native-environment');
const crypto = require('node:crypto');
const {readLocalFile} = require('./project');
const {resourceError} = require('./errors');
const MAX_MEDIA_BYTES=32*1024*1024;
const MAX_SVG_BYTES=16*1024*1024;
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const MonitorRecord = require('scratch-vm/src/engine/monitor-record');
const number = value => {
  if (value === undefined || !Number.isFinite(Number(value))) throw new Error('Expected a finite number');
  return Number(value);
};
const variable = (target, name, type) => {
  const matches = Object.values(target.variables).filter(item => (item.name === name || item.id === name) && item.type === type);
  if (matches.length !== 1) throw resourceError(matches.length, `Resource not found or ambiguous: ${name}`, name);
  return matches[0];
};
const value = text => {try {return JSON.parse(text);} catch {return text;}};
const blockObject = (id, opcode, extra = {}) => ({id, opcode, inputs: {}, fields: {}, next: null, parent: null, shadow: false, topLevel: true, x: 0, y: 0, ...extra});

const commands = {
  stage(session, args) {
    const runtime = session.project.vm.runtime;
    if (args[0] === 'info') return {width: runtime.stageWidth, height: runtime.stageHeight, tempo: runtime.getTargetForStage().tempo};
    if (args[0] === 'tempo') {
      const tempo = number(args[1]); if (tempo < 20 || tempo > 500) throw new Error('Tempo must be 20..500');
      runtime.getTargetForStage().setTempo(tempo); return {tempo};
    }
    throw new Error('Use stage info or stage tempo BPM');
  },
  list(session, args, options, target) {
    const [action, name, a, b] = args;
    if (action === 'all') return Object.values(target.variables).filter(item => item.type === 'list').map(item => ({id: item.id, name: item.name, value: item.value}));
    if (action === 'add') return session.variable(['add', name, a || '[]'], {type: 'list'}, target);
    const item = variable(target, name, 'list');
    if (action === 'get') return {name: item.name, value: item.value};
    if (action === 'append') item.value.push(value(a));
    else if (action === 'clear') item.value = [];
    else if (action === 'set') {
      const array = JSON.parse(a); if (!Array.isArray(array)) throw new Error('Expected JSON array'); item.value = array;
    } else if (['insert', 'replace', 'remove'].includes(action)) {
      const index = number(a);
      const max = action === 'insert' ? item.value.length + 1 : item.value.length;
      if (!Number.isInteger(index) || index < 1 || index > max) throw new Error('List index is 1-based and must be in bounds');
      if (action === 'insert') item.value.splice(index - 1, 0, value(b));
      if (action === 'replace') item.value[index - 1] = value(b);
      if (action === 'remove') item.value.splice(index - 1, 1);
    } else if (action === 'rename') target.renameVariable(item.id, a);
    else if (action === 'delete') target.deleteVariable(item.id);
    else throw new Error(`Unknown list action ${action}`);
    session.project.vm.runtime.emitProjectChanged();
    return {id: item.id, name: item.name, value: item.value};
  },
  broadcast(session, args) {
    const target = session.project.vm.runtime.getTargetForStage();
    const [action, name, newName] = args;
    if (action === 'list') return Object.values(target.variables).filter(item => item.type === 'broadcast_msg').map(item => ({id: item.id, name: item.name}));
    if (action === 'add') {
      if (!name || Object.values(target.variables).some(item => item.type === 'broadcast_msg' && item.name === name)) throw new Error('Missing or duplicate broadcast name');
      const id = crypto.randomUUID(); target.createVariable(id, name, 'broadcast_msg', false); return {id, name};
    }
    const item = variable(target, name, 'broadcast_msg');
    if (action === 'rename') {
      if (!newName) throw new Error('Missing name'); target.renameVariable(item.id, newName);
    } else if (action === 'delete') target.deleteVariable(item.id);
    else throw new Error('Use broadcast list/add/rename/delete');
    return {id: item.id, name: item.name};
  },
  comment(session, args, options, target) {
    const [action, id, text] = args;
    const blocks = target.blocks;
    if (action === 'list') return Object.values(target.comments);
    if (action === 'add') {
      if (!id) throw new Error('Missing comment text');
      if (options.block && !blocks.getBlock(options.block)) throw new Error('Block not found');
      const newId = crypto.randomUUID(); target.createComment(newId, options.block, id, 0, 0, 200, 200, false);
      return {id: newId};
    }
    const comment = target.comments[id]; if (!comment) throw new Error('Comment not found');
    if (action === 'set') {if (text === undefined) throw new Error('Missing text'); comment.text = text;}
    else if (action === 'move') {comment.x = number(text); comment.y = number(args[3]);}
    else if (action === 'delete') {
      if (comment.blockId && blocks.getBlock(comment.blockId)) delete blocks.getBlock(comment.blockId).comment;
      delete target.comments[id];
    } else throw new Error('Use comment list/add/set/move/delete');
    session.project.vm.runtime.emitProjectChanged(); return {id, action};
  },
  monitor(session, args, options, target) {
    const runtime = session.project.vm.runtime;
    const [action, name, field, raw] = args;
    if (action === 'list') return runtime.getMonitorState().valueSeq().map(item => ({...item}));
    if (action === 'add') {
      const matches = Object.values(target.variables).filter(item => item.name === name || item.id === name);
      if (matches.length !== 1 || matches[0].type === 'broadcast_msg') throw new Error('Variable/list not found');
      const item = matches[0];
      const list = item.type === 'list';
      const opcode = list ? 'data_listcontents' : 'data_variable';
      const key = list ? 'LIST' : 'VARIABLE';
      const fields = {[key]: {name: key, id: item.id, value: item.name, variableType: item.type}};
      runtime.monitorBlocks.createBlock(blockObject(item.id, opcode, {fields, isMonitored: true, targetId: target.id}));
      runtime.requestAddMonitor(new MonitorRecord({id: item.id, targetId: target.id,
        spriteName: target.isStage ? null : target.getName(), opcode,
        params: {[key]: item.name}, value: item.value, mode: list ? 'list' : 'default', x: 0, y: 0}));
      return {id: item.id};
    }
    const monitors = runtime.getMonitorState().valueSeq();
    const monitor = monitors.find(item => item.id === name || Object.values(item.params || {}).includes(name));
    if (!monitor) throw new Error('Monitor not found');
    if (action === 'delete') {runtime.requestRemoveMonitor(monitor.id); runtime.monitorBlocks.deleteBlock(monitor.id);}
    else if (action === 'set') {
      let parsed;
      if (['x', 'y', 'width', 'height', 'sliderMin', 'sliderMax'].includes(field)) parsed = number(raw);
      else if (field === 'visible' || field === 'isDiscrete') {
        if (!['true', 'false'].includes(raw)) throw new Error('Expected true/false'); parsed = raw === 'true';
      } else if (field === 'mode') {
        if (!['default', 'large', 'slider', 'list'].includes(raw)) throw new Error('Invalid monitor mode'); parsed = raw;
      } else throw new Error('Unknown monitor property');
      runtime.requestUpdateMonitor({id: monitor.id, [field]: parsed});
    } else throw new Error('Use monitor list/add/set/delete');
    return {id: monitor.id, action};
  },
  proc(session, args, options, target) {
    const [action, name] = args;
    const blocks = target.blocks;
    const definitions = Object.values(blocks._blocks).filter(block => block.opcode === 'procedures_prototype');
    if (action === 'list') return definitions.map(block => ({id: block.id, name: block.mutation.proccode, mutation: block.mutation}));
    if (!name) throw new Error('Missing procedure name');
    if (action === 'define') {
      if (definitions.some(block => block.mutation.proccode === name)) throw new Error('Procedure already exists');
      if (name.includes('%')) throw new Error('Use --params instead of raw procedure placeholders');
      const params = options.params ? JSON.parse(options.params) : [];
      if (!Array.isArray(params) || params.length > 32 || !params.every(param => typeof param.name === 'string' && param.name && ['number', 'text', 'boolean'].includes(param.type)) ||
        new Set(params.map(param => param.name)).size !== params.length) throw new Error('Params must be [{name,type:number|text|boolean}], max32, unique names');
      const argumentids = params.map(() => crypto.randomUUID());
      const proccode = name + params.map(param => param.type === 'boolean' ? ' %b' : ' %s').join('');
      const definition = crypto.randomUUID(), prototype = crypto.randomUUID();
      const inputs = {};
      const reporters = params.map((param, index) => {
        const id = crypto.randomUUID(); inputs[argumentids[index]] = {name: argumentids[index], block: id, shadow: id};
        return blockObject(id, param.type === 'boolean' ? 'argument_reporter_boolean' : 'argument_reporter_string_number',
          {fields: {VALUE: {name: 'VALUE', value: param.name}}, parent: prototype, shadow: true, topLevel: false});
      });
      blocks.createBlock(blockObject(definition, 'procedures_definition', {inputs: {custom_block: {name: 'custom_block', block: prototype, shadow: prototype}}}));
      blocks.createBlock(blockObject(prototype, 'procedures_prototype', {parent: definition, shadow: true, topLevel: false, inputs,
        mutation: {tagName: 'mutation', children: [], proccode, argumentids: JSON.stringify(argumentids),
          argumentnames: JSON.stringify(params.map(param => param.name)), argumentdefaults: JSON.stringify(params.map(param => param.type === 'boolean' ? false : '')), warp: 'false'}}));
      for (const reporter of reporters) blocks.createBlock(reporter);
      return {id: definition, prototype, name: proccode, params};
    }
    const candidates = definitions.filter(block => block.mutation.proccode === name || block.mutation.proccode.split(' %')[0] === name);
    const prototype = candidates.length === 1 ? candidates[0] : null;
    if (!prototype) throw new Error('Procedure not found');
    if (action === 'call') {
      const id = crypto.randomUUID();
      const argumentIds = JSON.parse(prototype.mutation.argumentids);
      const argumentNames = JSON.parse(prototype.mutation.argumentnames);
      const defaults = JSON.parse(prototype.mutation.argumentdefaults);
      const values = options.values ? JSON.parse(options.values) : {};
      if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Values must be a JSON object keyed by parameter name');
      for (const key of Object.keys(values)) if (!argumentNames.includes(key)) throw new Error(`Unknown parameter ${key}`);
      const inputs = {};
      const shadows = argumentIds.map((argId, index) => {
        const shadow = crypto.randomUUID();
        const supplied = values[argumentNames[index]] ?? defaults[index];
        const numeric = typeof supplied === 'number';
        const field = numeric ? 'NUM' : 'TEXT';
        inputs[argId] = {name: argId, block: shadow, shadow};
        return blockObject(shadow, numeric ? 'math_number' : 'text', {parent: id, topLevel: false, shadow: true,
          fields: {[field]: {name: field, value: String(supplied)}}});
      });
      blocks.createBlock(blockObject(id, 'procedures_call', {inputs, mutation: {...prototype.mutation}}));
      for (const shadow of shadows) blocks.createBlock(shadow);
      if (options.after) {
        const parent = blocks.getBlock(options.after); if (!parent || parent.next) throw new Error('Parent missing or already connected');
        blocks.moveBlock({id, newParent: options.after});
      }
      return {id, name};
    }
    if (action === 'rename') {
      const newName = args[2]; if (!newName || newName.includes('%')) throw new Error('Invalid simple procedure name');
      const oldCode = prototype.mutation.proccode;
      const suffix = oldCode.slice(oldCode.split(' %')[0].length);
      for (const block of Object.values(blocks._blocks)) if (block.mutation?.proccode === oldCode) {
        const attributes = Object.fromEntries(Object.entries({...block.mutation, proccode: newName + suffix})
          .filter(([key]) => key !== 'tagName' && key !== 'children'));
        blocks.changeBlock({id: block.id, element: 'mutation', value: {name: 'mutation', attribs: attributes, children: []}});
      }
      return {name: newName};
    }
    if (action === 'delete') {blocks.deleteBlock(prototype.parent); return {deleted: name};}
    throw new Error('Use proc list/define/call/rename/delete');
  },
  async bitmap(session, args, options, target) {
    const [action, selector, a, b] = args;
    const costumes = target.getCostumes();
    const index = require('./asset-commands').resolve(target,'costume',selector);
    if (index < 0) throw new Error('Costume not found');
    const costume = costumes[index];
    const image = await loadImage(Buffer.from(costume.asset.data));
    let width = image.width, height = image.height;
    if (action === 'resize') {width = number(a); height = number(b);}
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16000000) throw new Error('Invalid bitmap dimensions (max 16 million pixels)');
    const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
    if (action === 'flip-x') {ctx.translate(width, 0); ctx.scale(-1, 1);}
    if (action === 'flip-y') {ctx.translate(0, height); ctx.scale(1, -1);}
    if(costume.dataFormat==='svg') {
      const rendered=createCanvas(width,height);rendered.getContext('2d').putImageData(require('./native-renderer').rasterizeSVG(costume.asset.decodeText(),width,height),0,0);ctx.drawImage(rendered,0,0);
    } else ctx.drawImage(image, 0, 0, width, height);
    if (action === 'fill') {
      if (!/^#[0-9a-f]{6}$/i.test(a || '')) throw new Error('Fill color must be #rrggbb');
      ctx.fillStyle = a; ctx.fillRect(0, 0, width, height);
    } else if (!['resize', 'flip-x', 'flip-y', 'convert'].includes(action)) throw new Error('Use bitmap convert/resize/flip-x/flip-y/fill');
    const storage = session.project.vm.runtime.storage;
    const asset = storage.createAsset(storage.AssetType.ImageBitmap, storage.DataFormat.PNG, new Uint8Array(canvas.toBuffer('image/png')), null, true);
    const wasVector = costume.dataFormat === 'svg';
    const oldWidth = image.width, oldHeight = image.height;
    const resolution = wasVector ? 1 : costume.bitmapResolution || 2;
    costume.rotationCenterX = (costume.rotationCenterX ?? oldWidth / 2) * width / oldWidth;
    costume.rotationCenterY = (costume.rotationCenterY ?? oldHeight / 2) * height / oldHeight;
    costume.asset = asset; costume.assetId = asset.assetId; costume.md5 = `${asset.assetId}.png`; costume.dataFormat = 'png'; costume.bitmapResolution = resolution;
    const renderer = session.project.renderer;
    renderer.updateBitmapSkin(costume.skinId, canvas, resolution, [costume.rotationCenterX / resolution, costume.rotationCenterY / resolution]);
    costume.size = [width, height]; target.updateAllDrawableProperties();
    return {name: costume.name, width, height};
  },
  async vector(session, args, options, target) {
    const [action, selector, text] = args;
    const costumes = target.getCostumes();
    const index = require('./asset-commands').resolve(target,'costume',selector);
    if (index < 0 || costumes[index].dataFormat !== 'svg') throw new Error('SVG costume not found');
    const costume = costumes[index];
    if (action === 'source') return {svg: costume.asset.decodeText()};
    if (action !== 'replace') return require('./vector-editor').edit(session, args, target);
    const svg = (await readLocalFile(text,MAX_SVG_BYTES)).toString('utf8');
    const image = await loadImage(Buffer.from(svg));
    if (!image.width || !image.height) throw new Error('Invalid SVG');
    session.project.vm.setEditingTarget(target.id);
    session.project.vm.updateSvg(index, svg, costume.rotationCenterX, costume.rotationCenterY);
    return {name: costume.name, format: 'svg'};
  }
};

// Native bitmap editing is isolated from the legacy command registry. Coordinates and
// rotation centers are in asset pixels (not stage units); SVG conversion is explicit.
const bitmapNumber = require('./vector-editor').number;
const bitmapAlpha = require('./vector-editor').alpha;
const dimensions = (width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16000000) {
    throw new Error('Invalid bitmap dimensions (max 16 million pixels)');
  }
};
const rectangle = (raw, width, height) => {
  let rect = raw;
  if (typeof rect === 'string') rect = rect.trim().startsWith('[') || rect.trim().startsWith('{') ? JSON.parse(rect) : rect.split(',').map(bitmapNumber);
  if (!rect) return {x:0,y:0,width,height};
  if (Array.isArray(rect)) {if(rect.length!==4)throw new Error('Rect must be x,y,width,height');rect={x:rect[0],y:rect[1],width:rect[2],height:rect[3]};}
  const result=Object.fromEntries(['x','y','width','height'].map(k=>[k,bitmapNumber(rect[k])]));
  if (!Object.values(result).every(Number.isInteger) || result.x<0 || result.y<0 || result.width<1 || result.height<1 || result.x+result.width>width || result.y+result.height>height) throw new Error('Rect must be positive integer pixels inside the bitmap');
  return result;
};
const bitmapOpen = async (session,target,selector) => {
  const index=require('./asset-commands').resolve(target,'costume',selector),costume=target.getCostumes()[index];
  if(costume.dataFormat==='svg')throw new Error('Bitmap costume required; use asset convert to bitmap explicitly');
  const image=await loadImage(Buffer.from(costume.asset.data));dimensions(image.width,image.height);
  const canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);
  return {index,costume,canvas};
};
const bitmapCommit = (session,target,costume,canvas,center,resolution=costume.bitmapResolution || 2) => {
  dimensions(canvas.width,canvas.height);
  const x=bitmapNumber(center?.[0] ?? costume.rotationCenterX ?? canvas.width/2),y=bitmapNumber(center?.[1] ?? costume.rotationCenterY ?? canvas.height/2);
  if(!Number.isFinite(resolution)||resolution<=0)throw new Error('Bitmap resolution must be positive');
  const storage=session.project.vm.runtime.storage;
  const asset=storage.createAsset(storage.AssetType.ImageBitmap,storage.DataFormat.PNG,new Uint8Array(canvas.toBuffer('image/png')),null,true);
  // Validate/update the native skin before publishing the new asset metadata.
  session.project.renderer.updateBitmapSkin(costume.skinId,canvas,resolution,[x/resolution,y/resolution]);
  Object.assign(costume,{asset,assetId:asset.assetId,md5:`${asset.assetId}.png`,dataFormat:'png',bitmapResolution:resolution,rotationCenterX:x,rotationCenterY:y,size:[canvas.width,canvas.height]});
  delete costume.broken;target.updateAllDrawableProperties();session.project.vm.emitTargetsUpdate();
  return {width:canvas.width,height:canvas.height,assetId:asset.assetId,center:[x,y],resolution};
};
const bitmapCopy = (canvas,rect) => {
  const copy=createCanvas(rect.width,rect.height);copy.getContext('2d').putImageData(canvas.getContext('2d').getImageData(rect.x,rect.y,rect.width,rect.height),0,0);return copy;
};
const paintColor = (context,spec,bounds) => {
  const {rgba,gradientSpec}=require('./vector-editor');
  const color=spec.color ?? spec.fill ?? '#000000';rgba(color);
  if(!spec.gradient)return color==='none'?'transparent':color;
  const g=gradientSpec(spec.gradient),x=bounds.x,y=bounds.y,w=bounds.width,h=bounds.height;
  const gradient=g.type==='radial'?context.createRadialGradient(x+w/2,y+h/2,0,x+w/2,y+h/2,Math.max(w,h)/2 || 1):
    context.createLinearGradient(x,y,g.type==='horizontal'?x+w:x,g.type==='vertical'?y+h:y);
  for(const s of g.stops) {const c=rgba(s.color);gradient.addColorStop(s.offset,`rgba(${c.slice(0,3).join(',')},${c[3]/255*(s.alpha ?? 1)})`);}
  return gradient;
};
const flood = (canvas,spec,rect) => {
  const {rgba,gradientSpec}=require('./vector-editor'),ctx=canvas.getContext('2d'),data=ctx.getImageData(0,0,canvas.width,canvas.height);
  const {width,height}=canvas,x=bitmapNumber(spec.x),y=bitmapNumber(spec.y),tolerance=bitmapNumber(spec.tolerance ?? 0);
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<rect.x||y<rect.y||x>=rect.x+rect.width||y>=rect.y+rect.height)throw new Error('Flood seed must be integer pixels inside the selection');
  if(tolerance<0||tolerance>255)throw new Error('Flood tolerance must be 0..255');
  const old=Array.from(data.data.slice((y*width+x)*4,(y*width+x)*4+4)),seen=new Uint8Array(width*height),queue=new Int32Array(rect.width*rect.height);
  let count=1,read=0,minX=x,minY=y,maxX=x,maxY=y;queue[0]=y*width+x;seen[queue[0]]=1;
  const matches=index=>old.every((v,c)=>Math.abs(v-data.data[index*4+c])<=tolerance);
  while(read<count) {
    const index=queue[read++],px=index%width,py=Math.floor(index/width);minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);
    for(const [nx,ny] of [[px-1,py],[px+1,py],[px,py-1],[px,py+1]])if(nx>=rect.x&&ny>=rect.y&&nx<rect.x+rect.width&&ny<rect.y+rect.height) {
      const next=ny*width+nx;if(!seen[next]&&matches(next)){seen[next]=1;queue[count++]=next;}
    }
  }
  const color=rgba(spec.color ?? spec.fill ?? '#000000'),gradient=spec.gradient?gradientSpec(spec.gradient):null,alpha=bitmapAlpha(spec.alpha ?? 1);
  for(let i=0;i<count;i++) {
    const index=queue[i],px=index%width,py=Math.floor(index/width);let c=color;
    if(gradient) {
      const t=Math.max(0,Math.min(1,gradient.type==='horizontal'?(px-minX)/Math.max(1,maxX-minX):gradient.type==='vertical'?(py-minY)/Math.max(1,maxY-minY):
        Math.hypot(px-(minX+maxX)/2,py-(minY+maxY)/2)/(Math.max(maxX-minX,maxY-minY)/2 || 1)));
      let left=gradient.stops[0],right=gradient.stops.at(-1);
      if(t<=left.offset)right=left;else if(t>=right.offset)left=right;else for(let j=1;j<gradient.stops.length;j++)if(gradient.stops[j].offset>=t){left=gradient.stops[j-1];right=gradient.stops[j];break;}
      const a=rgba(left.color),b=rgba(right.color),f=right.offset===left.offset?0:(t-left.offset)/(right.offset-left.offset);
      a[3]*=left.alpha ?? 1;b[3]*=right.alpha ?? 1;c=a.map((v,j)=>Math.round(v+(b[j]-v)*f));
    }
    data.data.set([c[0],c[1],c[2],Math.round(c[3]*alpha)],index*4);
  }
  ctx.putImageData(data,0,0);return count;
};
const bitmapExecute = async (session,target,args,options={}) => {
  const [action,selector,...values]=args,opened=await bitmapOpen(session,target,selector),{costume}=opened;
  let canvas=opened.canvas,ctx=canvas.getContext('2d'),center=[costume.rotationCenterX,costume.rotationCenterY];
  const rawSpec=typeof options.spec==='string'?JSON.parse(options.spec):options.spec || {};
  if(!rawSpec||typeof rawSpec!=='object'||Array.isArray(rawSpec))throw new Error('Bitmap --spec must be an object');
  const spec={...Object.fromEntries(['fill','stroke','gradient','alpha','font','size'].filter(k=>options[k]!==undefined).map(k=>[k,options[k]])),...rawSpec};
  const rect=rectangle(options.rect ?? spec.rect,canvas.width,canvas.height);
  let pixels;
  if(action==='select')return {costume:costume.name,rect,selection:'explicit; pass --rect to subsequent commands'};
  if(action==='sample') {const x=bitmapNumber(spec.x ?? values[0]),y=bitmapNumber(spec.y ?? values[1]);if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=canvas.width||y>=canvas.height)throw new Error('Sample coordinates must be inside bitmap');return {x,y,rgba:Array.from(ctx.getImageData(x,y,1,1).data)};}
  if(action==='copy'||action==='cut') {
    const output=options.output || values[0];if(!output)throw new Error('Copy/cut requires --output PNG file');
    if(action==='cut'&&options.out)throw new Error('Cut cannot combine clipboard output and project --out; use save separately');
    const result=await require('./project').atomicWrite(output,bitmapCopy(canvas,rect).toBuffer('image/png'),options.force);
    if(action==='copy')return {...result,rect};ctx.clearRect(rect.x,rect.y,rect.width,rect.height);
  } else if(action==='crop') {
    canvas=bitmapCopy(canvas,rect);center=[center[0]-rect.x,center[1]-rect.y];
  } else if(action==='paste') {
    const file=options.from || values[0];if(!file)throw new Error('Paste requires --from PNG file');const bytes=await readLocalFile(file,MAX_MEDIA_BYTES);
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Bitmap clipboard must be a PNG within 32 MiB');
    const image=await loadImage(bytes);dimensions(image.width,image.height);
    const x=bitmapNumber(spec.x ?? options.x ?? 0),y=bitmapNumber(spec.y ?? options.y ?? 0),width=bitmapNumber(spec.width ?? image.width),height=bitmapNumber(spec.height ?? image.height);
    if(width<=0||height<=0)throw new Error('Paste dimensions must be positive');
    ctx.globalAlpha=bitmapAlpha(spec.alpha ?? options.alpha ?? 1);ctx.imageSmoothingEnabled=options.smoothing===true||spec.smoothing===true;ctx.drawImage(image,x,y,width,height);
  } else if(action==='resize'||action==='scale') {
    const full=options.rect===undefined&&spec.rect===undefined,scaleX=bitmapNumber(spec.scaleX ?? values[0] ?? 1),scaleY=bitmapNumber(spec.scaleY ?? values[1] ?? scaleX);
    const width=action==='resize'?bitmapNumber(spec.width ?? values[0]):Math.round(rect.width*scaleX),height=action==='resize'?bitmapNumber(spec.height ?? values[1]):Math.round(rect.height*scaleY);dimensions(width,height);
    const copy=bitmapCopy(canvas,rect);
    if(full){canvas=createCanvas(width,height);ctx=canvas.getContext('2d');center=[center[0]*width/copy.width,center[1]*height/copy.height];}
    else ctx.clearRect(rect.x,rect.y,rect.width,rect.height);
    ctx.imageSmoothingEnabled=options.smoothing===true||spec.smoothing===true;ctx.drawImage(copy,full?0:rect.x,full?0:rect.y,width,height);
  } else if(['rotate','flip-x','flip-y','transform','move'].includes(action)) {
    const full=options.rect===undefined&&spec.rect===undefined,copy=bitmapCopy(canvas,rect);
    const angle=bitmapNumber(spec.rotate ?? (action==='rotate'?values[0]:0))*Math.PI/180;
    let matrix=spec.matrix;
    if(matrix) {if(!Array.isArray(matrix)||matrix.length!==6)throw new Error('Matrix requires six finite values');matrix=matrix.map(bitmapNumber);}
    else {
      const sx=bitmapNumber(spec.scaleX ?? (action==='flip-x'?-1:1)),sy=bitmapNumber(spec.scaleY ?? (action==='flip-y'?-1:1));if(!sx||!sy)throw new Error('Scale cannot be zero');
      const a=Math.cos(angle)*sx,b=Math.sin(angle)*sx,c=-Math.sin(angle)*sy,d=Math.cos(angle)*sy;
      const pivot=spec.pivot || [rect.x+rect.width/2,rect.y+rect.height/2];if(!Array.isArray(pivot)||pivot.length!==2)throw new Error('Pivot must be [x,y]');const [px,py]=pivot.map(bitmapNumber);
      matrix=[a,b,c,d,px-a*px-c*py+bitmapNumber(spec.dx ?? options.dx ?? 0),py-b*px-d*py+bitmapNumber(spec.dy ?? options.dy ?? 0)];
    }
    if(Math.abs(matrix[0]*matrix[3]-matrix[1]*matrix[2])<1e-12)throw new Error('Singular bitmap transform');
    const transform=(x,y)=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]];
    if(full && action==='rotate' && options.expand!==false && spec.expand!==false) {
      const corners=[[0,0],[canvas.width,0],[0,canvas.height],[canvas.width,canvas.height]].map(p=>transform(...p)),x=Math.min(...corners.map(p=>p[0])),y=Math.min(...corners.map(p=>p[1]));
      const w=Math.ceil(Math.max(...corners.map(p=>p[0]))-x-1e-9),h=Math.ceil(Math.max(...corners.map(p=>p[1]))-y-1e-9);dimensions(w,h);canvas=createCanvas(w,h);ctx=canvas.getContext('2d');matrix[4]-=x;matrix[5]-=y;center=transform(...center);
    } else {
      ctx.clearRect(rect.x,rect.y,rect.width,rect.height);if(full)center=transform(...center);
    }
    ctx.imageSmoothingEnabled=options.smoothing===true||spec.smoothing===true;ctx.setTransform(...matrix);ctx.drawImage(copy,rect.x,rect.y);ctx.resetTransform();
  } else if(action==='clear'||action==='delete')ctx.clearRect(rect.x,rect.y,rect.width,rect.height);
  else if(action==='fill'||action==='flood')pixels=flood(canvas,{...spec,alpha:spec.alpha ?? options.alpha},rect);
  else if(action==='fill-all') {
    ctx.fillStyle=paintColor(ctx,spec,rect);ctx.globalAlpha=bitmapAlpha(spec.alpha ?? options.alpha ?? 1);ctx.fillRect(rect.x,rect.y,rect.width,rect.height);
  } else if(action==='replace-color'||action==='opacity') {
    const {rgba}=require('./vector-editor'),data=ctx.getImageData(rect.x,rect.y,rect.width,rect.height),opacity=bitmapAlpha(spec.alpha ?? options.alpha ?? 1);
    let old,next,tolerance=bitmapNumber(spec.tolerance ?? 0);if(tolerance<0||tolerance>255)throw new Error('Color tolerance must be 0..255');
    if(action==='replace-color'){old=rgba(spec.from ?? options['from-color']);next=rgba(spec.to ?? options['to-color']);}
    pixels=0;
    for(let i=0;i<data.data.length;i+=4) {
      if(action==='opacity')data.data[i+3]=Math.round(data.data[i+3]*opacity);
      else if(old.every((v,j)=>Math.abs(v-data.data[i+j])<=tolerance)){data.data.set(next,i);data.data[i+3]=Math.round(next[3]*opacity);pixels++;}
    }
    ctx.putImageData(data,rect.x,rect.y);
  } else if(['brush','erase','eraser','line','rect','rectangle','ellipse','text'].includes(action)) {
    const {trajectory}=require('./vector-editor');ctx.save();ctx.beginPath();ctx.rect(rect.x,rect.y,rect.width,rect.height);ctx.clip();
    ctx.globalAlpha=bitmapAlpha(spec.alpha ?? options.alpha ?? 1);ctx.fillStyle=paintColor(ctx,spec,rect);ctx.strokeStyle=ctx.fillStyle;
    const thickness=bitmapNumber(spec.size ?? spec.thickness ?? (['brush','erase','eraser','line'].includes(action)?spec.width:undefined) ?? options.size ?? 1);
    if(thickness<=0||thickness>10000)throw new Error('Brush/thickness must be in (0,10000]');ctx.lineWidth=thickness;ctx.lineCap='round';ctx.lineJoin='round';
    if(action==='erase'||action==='eraser')ctx.globalCompositeOperation='destination-out';
    ctx.beginPath();
    if(['brush','erase','eraser'].includes(action)) {
      const points=trajectory(spec);if(points.length===1){ctx.arc(...points[0],thickness/2,0,Math.PI*2);ctx.fill();}
      else {ctx.moveTo(...points[0]);for(const p of points.slice(1))ctx.lineTo(...p);ctx.stroke();}
    } else if(action==='line') {ctx.moveTo(bitmapNumber(spec.x1),bitmapNumber(spec.y1));ctx.lineTo(bitmapNumber(spec.x2),bitmapNumber(spec.y2));ctx.stroke();}
    else if(action==='rect'||action==='rectangle'||action==='ellipse') {
      const x=bitmapNumber(spec.x),y=bitmapNumber(spec.y),w=bitmapNumber(spec.width),h=bitmapNumber(spec.height);if(w<=0||h<=0)throw new Error('Shape dimensions must be positive');
      ctx.fillStyle=paintColor(ctx,spec,{x,y,width:w,height:h});ctx.strokeStyle=ctx.fillStyle;
      if(action==='ellipse')ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);else ctx.rect(x,y,w,h);
      if(spec.filled===false||options.outlined)ctx.stroke();else ctx.fill();
    } else {
      const font=spec.font || options.font || 'sans-serif',size=bitmapNumber(spec.fontSize ?? options['font-size'] ?? 16);if(size<=0||/[;{}<>]/.test(font))throw new Error('Invalid font');
      if(typeof spec.text!=='string')throw new Error('Text must be a string');ctx.font=`${size}px ${font}`;ctx.textBaseline='alphabetic';
      ctx.fillText(spec.text,bitmapNumber(spec.x),bitmapNumber(spec.y));
    }
    ctx.restore();
  } else throw new Error(`Unknown bitmap paint action ${action}`);
  return {action,name:costume.name,...bitmapCommit(session,target,costume,canvas,center),...(pixels===undefined?{}:{pixels})};
};
Object.defineProperty(commands,'bitmapTools',{value:{open:bitmapOpen,commit:bitmapCommit,execute:bitmapExecute,rectangle,dimensions},enumerable:false});
module.exports = commands;
