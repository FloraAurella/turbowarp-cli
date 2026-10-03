const {atomicWrite,readLocalFile} = require('./project');
const MAX_CONFIG_BYTES=4*1024*1024;
const vector = require('./vector-editor');
const specs = require('./command-catalog').moduleSpecs['paint-commands.js'];
const requiresProject=(command,args)=>args[0]!=='defaults';
const isReadOnly=(command,args)=>['nodes','source','select','points','copy','sample','defaults','history','undo','redo'].includes(args[0]);
const execute=async (session,command,args,options={})=>{
  if(command!=='paint')throw new Error(`Unknown paint command ${command}`);
  const [action,selector,...values]=args;
  if(action==='defaults') {
    const base=options.config?JSON.parse((await readLocalFile(options.config,MAX_CONFIG_BYTES)).toString('utf8')):{};
    if(!base||Array.isArray(base)||typeof base!=='object')throw new Error('Defaults config must be an object');
    if(options.spec!==undefined) {
      const data=typeof options.spec==='string'?JSON.parse(options.spec):options.spec;
      const allowed=new Set(['brush','eraser','thickness','fill','stroke','font','fontSize','alpha','filled']);
      if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!allowed.has(k)))throw new Error('Invalid defaults keys');
      for(const key of ['brush','eraser','thickness','fontSize'])if(data[key]!==undefined&&vector.number(data[key])<=0)throw new Error(`${key} must be positive`);
      for(const key of ['fill','stroke'])if(data[key]!==undefined)vector.rgba(data[key]);if(data.alpha!==undefined)vector.alpha(data.alpha);
      if(data.filled!==undefined&&typeof data.filled!=='boolean')throw new Error('filled must be boolean');Object.assign(base,data);
    }
    const output=options.output;if(output)return {...await atomicWrite(output,Buffer.from(JSON.stringify(base,null,2)+'\n'),options.force),defaults:base};
    return {defaults:base,persistence:'explicit --output file; pass values in drawing --spec'};
  }
  if(['history','undo','redo'].includes(action))return require('./asset-commands').execute(session,'asset',args,options);
  const target=session.project.target(options.target);session.project.ensureAssetIds?.(target);
  const asset=require('./asset-commands'),index=asset.resolve(target,'costume',selector),costume=target.getCostumes()[index];
  const actual=costume.dataFormat==='svg'?'vector':'bitmap',mode=options.mode || actual;
  if(!['vector','bitmap'].includes(mode)||mode!==actual)throw new Error(`Paint mode must match costume (${actual}); use asset convert explicitly`);
  if(options.output&&values[0]&&['copy','cut'].includes(action))throw new Error('Use --output or positional clipboard path, not both');
  if(action==='eyedropper') {
    if(mode!=='vector'||!options.nodes)throw new Error('Eyedropper apply requires vector --nodes; use bitmap sample for explicit draw/default colors');
    const property=options.property || 'fill';if(!['fill','stroke'].includes(property))throw new Error('Eyedropper property must be fill/stroke');
    const x=vector.number(values[0]),y=vector.number(values[1]),width=Math.ceil(costume.size[0]),height=Math.ceil(costume.size[1]);
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=width||y>=height)throw new Error('Eyedropper coordinates must be integer pixels in the SVG viewport');
    const source=session.project.renderer._allSkins[costume.skinId]._svg,data=require('./native-renderer').rasterizeSVG(source,width,height),offset=(y*width+x)*4,rgba=Array.from(data.data.subarray(offset,offset+4));
    const color=rgba[3]===0?'none':`rgba(${rgba.slice(0,3).join(',')},${rgba[3]/255})`;
    const result=await vector.execute(session,target,['style',selector],{nodes:options.nodes,[property]:color});
    return {...result,color,rgba,applied:property,costumeId:costume.cliId};
  }
  let result;
  if(mode==='vector') {
    // New paint commands use nodes options; legacy vector edit retains its positional API.
    if(['copy','cut'].includes(action))result=await vector.execute(session,target,[action,selector],{...options,output:options.output || values[0]});
    else if(['rotate','scale','skew'].includes(action))result=await vector.execute(session,target,[action,selector,options.nodes,...values],options);
    else if(['align','distribute','order'].includes(action))result=await vector.execute(session,target,[action,selector,options.nodes,...values],options);
    else if(action==='move')result=await vector.execute(session,target,['transform',selector],options);
    else if(action==='text-set')result=await vector.execute(session,target,[action,selector,options.nodes,...values],options);
    else if(['sample','crop','resize','flood','fill-all','replace-color','opacity'].includes(action))throw new Error(`${action} is bitmap-only`);
    else result=await vector.execute(session,target,args,options);
  } else {
    if(['nodes','source','group','ungroup','clone','order','align','distribute','style','text-style','text-set','gradient-swap','points','point-add','point-delete','point-set','pointed','curved','skew','add','path','circle','snap-move','snap-scale'].includes(action))throw new Error(`${action} is vector-only`);
    result=await require('./editor-commands').bitmapTools.execute(session,target,args,options);
  }
  return Array.isArray(result)?result:{...result,costumeId:costume.cliId || `costume:${target.id}:${encodeURIComponent(costume.name)}`};
};
module.exports={specs,requiresProject,isReadOnly,execute,booleanOptions:['outlined','smoothing','expand']};
