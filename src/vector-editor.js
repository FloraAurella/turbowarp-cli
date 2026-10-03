const {parseDOM} = require('htmlparser2');
const serialize = require('dom-serializer');
const crypto = require('node:crypto');
const {readLocalFile} = require('./project');
const MAX_CONFIG_BYTES=4*1024*1024;
const MAX_CLIPBOARD_BYTES=16*1024*1024;
const {Path2D, PathOp, FillType, StrokeCap, StrokeJoin, createCanvas} = require('@napi-rs/canvas');

const number = (value, label = 'geometry') => {
  if (!['string','number'].includes(typeof value) || typeof value === 'string' && !value.trim() || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e9) {
    throw new Error(`Expected finite ${label} number (absolute value <= 1e9)`);
  }
  return Number(value);
};
const positive = value => {const n = number(value); if (n <= 0) throw new Error('Dimensions must be positive'); return n;};
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const walk = nodes => {
  const result = [], pending = [...nodes].reverse();
  while (pending.length) {
    const node = pending.pop(); result.push(node);
    if (result.length > 100000) throw new Error('SVG has too many nodes');
    pending.push(...(node.children || []).slice().reverse());
  }
  return result;
};
const tag = (name, attributes = {}, children = []) => {
  const node = {type: 'tag', name, attribs: Object.fromEntries(Object.entries(attributes).map(([k,v]) => [k,String(v)])), children};
  for (const child of children) child.parent = node;
  return node;
};
const clone = node => {
  const shallow=n=>n.type==='tag'?tag(n.name,{...n.attribs}):{type:n.type,name:n.name,data:n.data,parent:null,prev:null,next:null};
  const root=shallow(node),pending=[[node,root]];
  while(pending.length) {const [from,to]=pending.pop();for(const child of from.children || []){const copy=shallow(child);copy.parent=to;(to.children || (to.children=[])).push(copy);pending.push([child,copy]);}}
  return root;
};
const append = (parent, node) => {node.parent = parent; parent.children.push(node); return node;};
const fmt = n => String(Math.abs(n) < 1e-12 ? 0 : Number(n.toPrecision(13)));
const identity = () => [1,0,0,1,0,0];
const multiply = (a,b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3],
  a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const inverse = m => {
  const d = m[0]*m[3]-m[1]*m[2]; if (Math.abs(d) < 1e-12) throw new Error('Singular parent transform');
  return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];
};
const point = (m,x,y) => [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
const translation = (x,y) => [1,0,0,1,x,y];
const matrixText = m => `matrix(${m.map(fmt).join(' ')})`;
const parseTransform = (text = '') => {
  let m = identity(), end = 0;
  for (const match of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    if (text.slice(end,match.index).trim().replace(/,/g,'')) throw new Error('Unsupported SVG transform');
    end = match.index + match[0].length;
    const v = match[2].trim().split(/[\s,]+/).filter(Boolean).map(number); let next;
    const angle = (v[0] || 0)*Math.PI/180;
    if (match[1] === 'matrix' && v.length === 6) next = v;
    else if (match[1] === 'translate' && v.length >= 1 && v.length <= 2) next = translation(v[0],v[1] || 0);
    else if (match[1] === 'scale' && v.length >= 1 && v.length <= 2) next = [v[0],0,0,v[1] ?? v[0],0,0];
    else if (match[1] === 'rotate' && [1,3].includes(v.length)) {
      next = [Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0];
      if (v.length === 3) next = multiply(multiply(translation(v[1],v[2]),next),translation(-v[1],-v[2]));
    } else if (match[1] === 'skewX' && v.length === 1) next = [1,0,Math.tan(angle),1,0,0];
    else if (match[1] === 'skewY' && v.length === 1) next = [1,Math.tan(angle),0,1,0,0];
    else throw new Error('Invalid SVG transform arguments');
    m = multiply(m,next);
  }
  if (text.slice(end).trim()) throw new Error('Unsupported SVG transform');
  return m;
};
const worldMatrix = node => {
  const ancestors=[];for(let n=node;n?.type==='tag';n=n.parent) {if(ancestors.length>1024)throw new Error('SVG hierarchy is too deep');ancestors.push(n);}
  return ancestors.reverse().reduce((m,n)=>multiply(m,parseTransform(n.attribs.transform)),identity());
};
const transformWorld = (node, delta) => {
  const parent = worldMatrix(node.parent);
  const m = multiply(multiply(multiply(inverse(parent),delta),parent),parseTransform(node.attribs.transform));
  if (!m.every(Number.isFinite)) throw new Error('Transform is not finite');
  node.attribs.transform = matrixText(m);
};
const asNative = m => ({a:m[0],b:m[1],c:m[2],d:m[3],e:m[4],f:m[5]});
const excluded = new Set(['svg','defs','style','metadata','title','desc','linearGradient','radialGradient','stop','clipPath','mask']);
const editable = node => node.type === 'tag' && !excluded.has(node.name);
const underDefinition = node => {
  for (let p = node.parent; p; p = p.parent) if (['defs','clipPath','mask'].includes(p.name)) return true;
  return false;
};
const sceneNodes = root => walk(root.children).filter(n => editable(n) && !underDefinition(n));
const open = (target, selector) => {
  const {resolve} = require('./asset-commands');
  const index = resolve(target,'costume',selector), costume = target.getCostumes()[index];
  if (costume.dataFormat !== 'svg') throw new Error('SVG costume required');
  const nodes = parseDOM(costume.asset.decodeText(), {xmlMode:true,decodeEntities:true});
  const all = walk(nodes), root = all.find(n => n.name === 'svg'); if (!root) throw new Error('SVG root is missing');
  const pending=nodes.map(n=>[n,0]);while(pending.length){const [n,depth]=pending.pop();if(depth>1024)throw new Error('SVG hierarchy is too deep');pending.push(...(n.children || []).map(c=>[c,depth+1]));}
  const used = new Set();
  for (const n of all) if (n.attribs?.id) {if (used.has(n.attribs.id)) throw new Error(`Duplicate SVG id: ${n.attribs.id}`); used.add(n.attribs.id);}
  let i = 0;
  for (const n of all) if (n.type === 'tag' && !n.attribs.id) {
    while (used.has(`node-${i}`)) i++;
    n.attribs.id = `node-${i++}`; used.add(n.attribs.id);
  }
  const byId = id => {const found = walk(nodes).find(n => n.attribs?.id === id); if (!found) throw new Error(`SVG element id not found: ${id}`); return found;};
  return {index,costume,nodes,root,byId};
};
const save = (session,target,doc) => {
  const source = doc.nodes.map(n => serialize(n,{xmlMode:true})).join('');
  session.project.vm.setEditingTarget(target.id);
  session.project.vm.updateSvg(doc.index,source,doc.costume.rotationCenterX,doc.costume.rotationCenterY);
  target.updateAllDrawableProperties();
  return source;
};
const renderedClone = node => {
  const copy=clone(node);
  for(const key of styleNames)if(key!=='opacity'&&inherited(node,key,undefined)!==undefined)setAttribute(copy,key,inherited(node,key));
  let opacity=1;for(let n=node;n?.type==='tag';n=n.parent)opacity*=Number(inherited({attribs:n.attribs,type:'tag'},'opacity',1));
  if(opacity!==1)setAttribute(copy,'opacity',opacity);copy.attribs.transform=matrixText(worldMatrix(node));return copy;
};
const select = (doc, raw, allowAll = false) => {
  let ids = raw;
  if (typeof raw === 'string') ids = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',');
  if (ids === undefined && allowAll || ids === 'all' || Array.isArray(ids) && ids.length === 1 && ids[0] === 'all') return sceneNodes(doc.root).filter(n => n.parent === doc.root);
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && id)) throw new Error('Specify --nodes id,id or a JSON array');
  const nodes = [...new Set(ids)].map(doc.byId);
  if (nodes.some(n => !editable(n) || underDefinition(n))) throw new Error('Selection must contain drawable SVG nodes');
  return nodes.filter(n => {for (let p = n.parent; p; p = p.parent) if (nodes.includes(p)) return false; return true;});
};
const pathFor = node => {
  const a = node.attribs, get = (k,d=0) => a[k] === undefined ? d : number(a[k]);
  const p = new Path2D();
  if (node.name === 'path') return new Path2D(a.d || '');
  if (node.name === 'rect' || node.name === 'image') {
    const x=get('x'),y=get('y'),w=get('width'),h=get('height');
    if (get('rx') || get('ry')) p.roundRect(x,y,w,h,[Math.min(get('rx',get('ry')),w/2,h/2)]); else p.rect(x,y,w,h);
  } else if (node.name === 'circle' || node.name === 'ellipse') {
    p.ellipse(get('cx'),get('cy'),get(node.name === 'circle' ? 'r' : 'rx'),get(node.name === 'circle' ? 'r' : 'ry'),0,0,Math.PI*2);
  } else if (node.name === 'line') {p.moveTo(get('x1'),get('y1')); p.lineTo(get('x2'),get('y2'));}
  else if (node.name === 'polygon' || node.name === 'polyline') {
    const v = (a.points || '').trim().split(/[\s,]+/).filter(Boolean).map(number);
    if (v.length % 2) throw new Error('Invalid SVG points');
    for (let i=0;i<v.length;i+=2) {if (i) p.lineTo(v[i],v[i+1]); else p.moveTo(v[i],v[i+1]);}
    if (node.name === 'polygon') p.closePath();
  } else if (node.name === 'text') {
    if ((node.children || []).some(n => n.type === 'tag')) throw new Error('Bounds for nested SVG text are unsupported');
    const ctx = createCanvas(1,1).getContext('2d'); ctx.font = `${get('font-size',16)}px ${a['font-family'] || 'sans-serif'}`;
    const metrics = ctx.measureText((node.children || []).map(n => n.data || '').join(''));
    const shift = a['text-anchor'] === 'middle' ? metrics.width/2 : a['text-anchor'] === 'end' ? metrics.width : 0;
    p.rect(get('x')-shift-metrics.actualBoundingBoxLeft,get('y')-metrics.actualBoundingBoxAscent,
      metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight,metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent);
  } else throw new Error(`Geometry unsupported for SVG ${node.name}`);
  return p;
};
const union = boxes => {
  if (!boxes.length) return {x:0,y:0,width:0,height:0};
  const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
  return {x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
};
const bounds = node => {
  if (node.name === 'g') return union(walk(node.children || []).filter(n=>editable(n)&&n.name!=='g'&&!underDefinition(n)).map(bounds));
  const [x,y,right,bottom] = pathFor(node).transform(asNative(worldMatrix(node))).computeTightBounds();
  return {x,y,width:right-x,height:bottom-y};
};
const styleNames = new Set(['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','fill-rule','stroke-linecap','stroke-linejoin',
  'font-size','font-family','font-weight','font-style','text-anchor']);
const setAttribute = (node,key,value) => {
  // Inline style beats presentation attributes. Remove the old inline property so edits actually render.
  if (node.attribs.style && styleNames.has(key)) node.attribs.style = node.attribs.style.split(';').filter(s => s.split(':')[0].trim() !== key).join(';');
  node.attribs[key] = String(value);
};
const inherited = (node,key,fallback) => {
  for (let n=node;n?.type==='tag';n=n.parent) {
    const inline = n.attribs.style?.split(';').map(s=>s.split(':')).find(s=>s[0].trim()===key);
    if (inline) return inline.slice(1).join(':').trim();
    if (n.attribs[key] !== undefined) return n.attribs[key];
  }
  return fallback;
};
const rgba = value => {
  if (value === 'none' || value === 'transparent') return [0,0,0,0];
  if (typeof value !== 'string' || !/^(?:#[\da-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%+-]+\))$/i.test(value)) throw new Error('Invalid color (hex, named, rgb/rgba or none)');
  const c = createCanvas(1,1).getContext('2d');
  c.fillStyle='#010203'; c.fillStyle=value; const first=c.fillStyle;
  c.fillStyle='#040506'; c.fillStyle=value; if (first !== c.fillStyle) throw new Error(`Invalid color: ${value}`);
  c.fillRect(0,0,1,1); return Array.from(c.getImageData(0,0,1,1).data);
};
const colorText = value => {rgba(value); return value === 'transparent' ? 'none' : value;};
const alpha = v => {const n=number(v,'alpha'); if (n<0 || n>1) throw new Error('Alpha must be 0..1'); return n;};
const hsvColor = (color,options) => {
  const [r,g,b,a] = rgba(color).map((v,i)=>i<3?v/255:v);
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
  let h=d===0?0:max===r?((g-b)/d+6)%6:max===g?(b-r)/d+2:(r-g)/d+4;
  let s=max===0?0:d/max, v=max; h/=6;
  for (const [key,assign] of [['hue',n=>{h=n;}],['saturation',n=>{s=n;}],['brightness',n=>{v=n;}]]) if (options[key] !== undefined) {
    const n=number(options[key]); if (n<0 || n>100) throw new Error(`${key} must be 0..100`); assign(n/100);
  }
  const sector=h*6,k=Math.floor(sector),f=sector-k,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s);
  const rgb=[[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][k%6].map(n=>Math.round(n*255));
  return `rgba(${rgb.join(',')},${a/255})`;
};
const gradientSpec = raw => {
  const original=json(raw);
  if (!original || !['horizontal','vertical','radial'].includes(original.type) || !Array.isArray(original.stops) || original.stops.length<2 || original.stops.length>128 || !original.stops.every(s=>s&&typeof s==='object'&&!Array.isArray(s))) throw new Error('Gradient requires type and 2..128 stops');
  const g={...original,stops:original.stops.map(s=>({...s}))};let previous=-1;
  for (const s of g.stops) {s.offset=alpha(s.offset); if (s.offset<previous) throw new Error('Gradient offsets must be sorted'); previous=s.offset; colorText(s.color); if (s.alpha!==undefined) alpha(s.alpha);}
  return g;
};
const applyGradient = (doc,node,raw,property='fill') => {
  if (!['fill','stroke'].includes(property)) throw new Error('Gradient property must be fill/stroke');
  const g=gradientSpec(raw),id=`gradient-${crypto.randomUUID()}`;
  let defs=doc.root.children.find(n=>n.name==='defs'); if (!defs) defs=append(doc.root,tag('defs',{id:`defs-${crypto.randomUUID()}`}));
  const attrs=g.type==='radial'?{cx:'50%',cy:'50%',r:'50%'}:{x1:'0%',y1:'0%',x2:g.type==='horizontal'?'100%':'0%',y2:g.type==='vertical'?'100%':'0%'};
  append(defs,tag(g.type==='radial'?'radialGradient':'linearGradient',{id,...attrs},g.stops.map(s=>{const color=rgba(s.color);return tag('stop',{'offset':s.offset,'stop-color':`rgb(${color.slice(0,3).join(',')})`,'stop-opacity':color[3]/255*(s.alpha ?? 1)});})));
  setAttribute(node,property,`url(#${id})`);
};
const applyStyle = (doc,nodes,options) => {
  for (const node of nodes) {
    for (const key of ['fill','stroke']) if (options[key] !== undefined) setAttribute(node,key,colorText(options[key]));
    for (const key of ['alpha','fill-alpha','stroke-alpha']) if (options[key] !== undefined) setAttribute(node,{'alpha':'opacity','fill-alpha':'fill-opacity','stroke-alpha':'stroke-opacity'}[key],alpha(options[key]));
    if (options['stroke-width'] !== undefined) {
      const w=number(options['stroke-width']); if (w<0 || w>10000) throw new Error('Stroke width must be 0..10000');
      setAttribute(node,'stroke-width',w); if (w>0 && inherited(node,'stroke','none')==='none') setAttribute(node,'stroke','#000000');
    }
    for (const [option,attr] of [['font','font-family'],['font-size','font-size'],['font-weight','font-weight'],['text-anchor','text-anchor']]) if (options[option]!==undefined) {
      if (node.name!=='text') throw new Error('Text style requires text nodes');
      const v=option==='font-size'?positive(options[option]):options[option];
      if (typeof v==='string' && /[;{}<>]|url\(|javascript:/i.test(v)) throw new Error('Invalid text style'); setAttribute(node,attr,v);
    }
    if (['hue','saturation','brightness'].some(k=>options[k]!==undefined)) {
      const property=options.property || 'fill'; if (!['fill','stroke'].includes(property)) throw new Error('Color property must be fill/stroke');
      setAttribute(node,property,hsvColor(inherited(node,property,'#000000'),options));
    }
    if (options.gradient!==undefined) applyGradient(doc,node,options.gradient,options.property || 'fill');
  }
};

// Editable paths use cubic segments and stable IDs in XML. Arc input is converted to cubic pieces (<=90 degrees).
const pathModel = node => {
  const source=node.attribs.d || '',tokens=source.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
  if (source.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g,'')) throw new Error('Invalid SVG path data');
  const subs=[]; let sub=null,x=0,y=0,command,prevCommand,control=null,quad=null,i=0,count=0;
  const add=(nx,ny,c1=[x,y],c2=[nx,ny])=>{if (!sub) throw new Error('Path must start with M'); const prev=sub.points.at(-1); prev.out=[c1[0]-x,c1[1]-y]; sub.points.push({x:nx,y:ny,in:[c2[0]-nx,c2[1]-ny],out:[0,0]}); x=nx;y=ny;if (++count>100000) throw new Error('Too many path segments');};
  const arcto=(rx,ry,deg,large,sweep,nx,ny)=>{
    rx=Math.abs(rx);ry=Math.abs(ry); if (!rx || !ry || x===nx&&y===ny) {if (x!==nx||y!==ny) add(nx,ny); return;}
    if (![0,1].includes(large) || ![0,1].includes(sweep)) throw new Error('Arc flags must be 0/1');
    const phi=deg*Math.PI/180,co=Math.cos(phi),si=Math.sin(phi),dx=(x-nx)/2,dy=(y-ny)/2;
    const xp=co*dx+si*dy,yp=-si*dx+co*dy,lambda=xp*xp/(rx*rx)+yp*yp/(ry*ry);
    if (lambda>1) {rx*=Math.sqrt(lambda);ry*=Math.sqrt(lambda);}
    const f=(large===sweep?-1:1)*Math.sqrt(Math.max(0,(rx*rx*ry*ry-rx*rx*yp*yp-ry*ry*xp*xp)/(rx*rx*yp*yp+ry*ry*xp*xp)));
    const cxp=f*rx*yp/ry,cyp=-f*ry*xp/rx,cx=co*cxp-si*cyp+(x+nx)/2,cy=si*cxp+co*cyp+(y+ny)/2;
    let start=Math.atan2((yp-cyp)/ry,(xp-cxp)/rx),end=Math.atan2((-yp-cyp)/ry,(-xp-cxp)/rx),delta=end-start;
    if (!sweep&&delta>0) delta-=Math.PI*2; if (sweep&&delta<0) delta+=Math.PI*2;
    const pieces=Math.ceil(Math.abs(delta)/(Math.PI/2)),step=delta/pieces;
    const ellipse=t=>[cx+rx*co*Math.cos(t)-ry*si*Math.sin(t),cy+rx*si*Math.cos(t)+ry*co*Math.sin(t)];
    const tangent=t=>[-rx*co*Math.sin(t)-ry*si*Math.cos(t),-rx*si*Math.sin(t)+ry*co*Math.cos(t)];
    for(let j=0;j<pieces;j++) {const a=start+j*step,b=a+step,k=4/3*Math.tan(step/4),p=ellipse(a),q=ellipse(b),u=tangent(a),v=tangent(b); add(q[0],q[1],[p[0]+k*u[0],p[1]+k*u[1]],[q[0]-k*v[0],q[1]-k*v[1]]);}
    x=nx;y=ny;sub.points.at(-1).x=nx;sub.points.at(-1).y=ny;
  };
  while (i<tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) command=tokens[i++]; else if (!command) throw new Error('Missing path command');
    const upper=command.toUpperCase(),relative=command!==upper;
    if (upper==='Z') {
      if (!sub) throw new Error('Invalid close path'); sub.closed=true;
      const first=sub.points[0],last=sub.points.at(-1);
      if (sub.points.length>1&&Math.abs(last.x-first.x)<1e-9&&Math.abs(last.y-first.y)<1e-9) {first.in=last.in; sub.points.pop();}
      x=first.x;y=first.y; command=null;control=null;quad=null;prevCommand='Z';continue;
    }
    const n={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7}[upper];
    if (!n || i+n>tokens.length || tokens.slice(i,i+n).some(t=>/^[a-z]$/i.test(t))) throw new Error('Invalid or incomplete path command');
    const v=tokens.slice(i,i+n).map(number); i+=n;
    const xy=(a,b)=>[a+(relative?x:0),b+(relative?y:0)];
    if (upper==='M') {const p=xy(v[0],v[1]);x=p[0];y=p[1];sub={closed:false,points:[{x,y,in:[0,0],out:[0,0]}]};subs.push(sub); command=relative?'l':'L';}
    else if (upper==='L') add(...xy(v[0],v[1]));
    else if (upper==='H') add(v[0]+(relative?x:0),y);
    else if (upper==='V') add(x,v[0]+(relative?y:0));
    else if (upper==='C'||upper==='S') {
      const c1=upper==='C'?xy(v[0],v[1]):['C','S'].includes(prevCommand)&&control?[2*x-control[0],2*y-control[1]]:[x,y];
      const offset=upper==='C'?2:0,c2=xy(v[offset],v[offset+1]),p=xy(v[offset+2],v[offset+3]); add(...p,c1,c2);control=c2;
    } else if (upper==='Q'||upper==='T') {
      const q=upper==='Q'?xy(v[0],v[1]):['Q','T'].includes(prevCommand)&&quad?[2*x-quad[0],2*y-quad[1]]:[x,y];
      const p=upper==='Q'?xy(v[2],v[3]):xy(v[0],v[1]);add(...p,[x+(q[0]-x)*2/3,y+(q[1]-y)*2/3],[p[0]+(q[0]-p[0])*2/3,p[1]+(q[1]-p[1])*2/3]);quad=q;
    } else if (upper==='A') arcto(...v.slice(0,5),...xy(v[5],v[6]));
    if (!['C','S'].includes(upper)) control=null; if (!['Q','T'].includes(upper)) quad=null;prevCommand=upper;
  }
  const flat=subs.flatMap(s=>s.points),raw=node.attribs['data-tw-segments'];
  const ids=raw?JSON.parse(raw):[];
  if (!Array.isArray(ids) || new Set(ids).size!==ids.length || !ids.every(id=>typeof id==='string')) throw new Error('Invalid path segment identity metadata');
  flat.forEach((p,j)=>{p.id=ids[j] || `${node.attribs.id}:p${j}`;});
  return subs;
};
const pathText = subs => subs.map(s=>{
  if (!s.points.length) return '';
  let d=`M ${fmt(s.points[0].x)} ${fmt(s.points[0].y)}`;
  const length=s.closed?s.points.length+1:s.points.length;
  for(let i=1;i<length;i++) {const a=s.points[i-1],b=s.points[i%s.points.length];
    if (a.out.some(Boolean)||b.in.some(Boolean)) d+=` C ${fmt(a.x+a.out[0])} ${fmt(a.y+a.out[1])} ${fmt(b.x+b.in[0])} ${fmt(b.y+b.in[1])} ${fmt(b.x)} ${fmt(b.y)}`;
    else if (i<s.points.length) d+=` L ${fmt(b.x)} ${fmt(b.y)}`;
  }
  return d+(s.closed?' Z':'');
}).join(' ');
const savePath = (node,subs) => {node.attribs.d=pathText(subs);node.attribs['data-tw-segments']=JSON.stringify(subs.flatMap(s=>s.points.map(p=>p.id)));};
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const curveLength=(a,b)=>{
  // Gaussian quadrature approximates Paper's cubic arc-length integral without a DOM/Paper runtime.
  const xs=[0.0950125098376374,0.281603550779259,0.458016777657227,0.617876244402644,0.755404408355003,0.865631202387832,0.944575023073233,0.98940093499165];
  const ws=[0.189450610455069,0.182603415044924,0.169156519395003,0.149595988816577,0.124628971255534,0.095158511682493,0.062253523938648,0.027152459411754];
  const p=[a.x,a.y],q=[a.x+a.out[0],a.y+a.out[1]],r=[b.x+b.in[0],b.y+b.in[1]],s=[b.x,b.y];let sum=0;
  for(let i=0;i<xs.length;i++)for(const sign of [-1,1]){const t=(1+sign*xs[i])/2,u=1-t,derivative=[0,1].map(k=>3*(u*u*(q[k]-p[k])+2*u*t*(r[k]-q[k])+t*t*(s[k]-r[k])));sum+=ws[i]*Math.hypot(...derivative)/2;}
  return sum;
};
const editPoints = (node,action,options) => {
  if (node.name!=='path') throw new Error('Points require a path node');
  const subs=pathModel(node),flat=subs.flatMap(s=>s.points);
  if (action==='points') return subs.map(s=>({closed:s.closed,points:s.points.map(p=>({id:p.id,x:p.x,y:p.y,handleIn:p.in,handleOut:p.out}))}));
  const spec=options.spec?json(options.spec):{};
  if (action==='point-add') {
    const at=spec.after ?? options.after,first=flat.find(p=>p.id===at); if(!first) throw new Error('Specify existing segment --after ID');
    const sub=subs.find(s=>s.points.includes(first)),index=sub.points.indexOf(first),next=sub.points[(index+1)%sub.points.length];
    if (!sub.closed&&index===sub.points.length-1) throw new Error('Cannot split after open endpoint');
    const t=alpha(spec.t ?? options.t ?? 0.5); if(t===0||t===1) throw new Error('Split t must be strictly between 0 and 1');
    const a=[first.x,first.y],b=[first.x+first.out[0],first.y+first.out[1]],c=[next.x+next.in[0],next.y+next.in[1]],d=[next.x,next.y];
    const ab=mix(a,b,t),bc=mix(b,c,t),cd=mix(c,d,t),abc=mix(ab,bc,t),bcd=mix(bc,cd,t),p=mix(abc,bcd,t);
      first.out=ab.map((v,i)=>v-a[i]);next.in=cd.map((v,i)=>v-d[i]);
    sub.points.splice(index+1,0,{id:`segment-${crypto.randomUUID()}`,x:p[0],y:p[1],in:abc.map((v,i)=>v-p[i]),out:bcd.map((v,i)=>v-p[i])});
  } else {
    let ids=options.segments || spec.segments;
    if(typeof ids==='string') ids=ids.startsWith('[')?JSON.parse(ids):ids.split(',');
    if (!Array.isArray(ids)||!ids.length||!ids.every(id=>flat.some(p=>p.id===id))) throw new Error('Specify valid --segments IDs');
    for(const id of new Set(ids)) {
      const p=flat.find(p=>p.id===id),sub=subs.find(s=>s.points.includes(p)),i=sub.points.indexOf(p);
      const prev=i>0?sub.points[i-1]:sub.closed?sub.points.at(-1):null,next=i<sub.points.length-1?sub.points[i+1]:sub.closed?sub.points[0]:null;
      if(action==='point-delete') {
        sub.points.splice(i,1);
        if(spec.adjustNeighbors===true) {
          // Frozen point-tool.removePoint (double-click) differs from selection.js seg.remove (Delete).
          const before=sub.points[i-1],after=sub.points[i],length=before&&after?curveLength(before,after):0;
          if(before){const old=Math.hypot(...before.out);before.out=after&&old?before.out.map(v=>v*length*0.3902628565/old):[0,0];}
          if(after){const old=Math.hypot(...after.in);after.in=before&&old?after.in.map(v=>v*length*0.3902628565/old):[0,0];}
        }
        continue;
      }
      if(action==='point-set') {
        for (const k of ['x','y']) if(spec[k]!==undefined) p[k]=number(spec[k]);
        for (const [k,key] of [['handleIn','in'],['handleOut','out']]) if(spec[k]!==undefined) {if(!Array.isArray(spec[k])||spec[k].length!==2) throw new Error('Handle must be [dx,dy]');p[key]=spec[k].map(number);}
      } else if(action==='pointed') {p.in=[0,0];p.out=[0,0];}
      else if(action==='curved') {
        const noHandles=!p.in.some(Boolean)&&!p.out.some(Boolean);
        if(prev&&next&&noHandles) {
          const dx=prev.x-next.x,dy=prev.y-next.y,len=Math.hypot(dx,dy),l=curveLength(prev,p)*0.3902628565;
          if(len) p.in=[dx/len*l,dy/len*l];
        } else if(prev&&!next&&!p.in.some(Boolean)||next&&!prev&&!p.out.some(Boolean)) {
          const q=prev||next,dx=q.x-p.x,dy=q.y-p.y,len=Math.hypot(dx,dy),l=curveLength(prev || p,next || p)*0.3902628565;
          // Endpoint normal/tangent for straight curves; curved-normal Paper parity remains limited.
          if(len) {const normal=prev?[dy/len,-dx/len]:[-dy/len,dx/len],tangent=[dx/len,dy/len],direction=mix(normal,tangent,0.5),norm=Math.hypot(...direction);p[prev?'in':'out']=direction.map(v=>v/norm*l);}
        }
        if(p.in.some(Boolean)&&next)p.out=p.in.map(v=>-v);else if(p.out.some(Boolean)&&prev)p.in=p.out.map(v=>-v);
      } else throw new Error('Unknown points action');
    }
  }
  if(subs.every(s=>!s.points.length)) node.parent.children.splice(node.parent.children.indexOf(node),1); else savePath(node,subs.filter(s=>s.points.length));
  return subs.flatMap(s=>s.points.map(p=>p.id));
};
const remap = nodes => {
  const mapping=new Map();for(const n of walk(nodes))if(n.type==='tag') {if(!n.attribs.id)n.attribs.id=`node-${crypto.randomUUID()}`;if(mapping.has(n.attribs.id))throw new Error('Duplicate ID in copied SVG nodes');mapping.set(n.attribs.id,`node-${crypto.randomUUID()}`);}
  for(const n of walk(nodes)) if(n.attribs) {
    for(const [k,v] of Object.entries(n.attribs)) {
      if(k==='id') n.attribs[k]=mapping.get(v);
      else if(k==='data-tw-segments') n.attribs[k]=JSON.stringify(JSON.parse(v).map(()=>`segment-${crypto.randomUUID()}`));
      else n.attribs[k]=v.replace(/url\(#([^)]*)\)/g,(m,id)=>mapping.has(id)?`url(#${mapping.get(id)})`:m).replace(/^#(.+)$/,(m,id)=>/(?:^|:)href$/.test(k)&&mapping.has(id)?`#${mapping.get(id)}`:m);
    }
  }
};
const clipboard = (doc,nodes) => {
  const copies=nodes.map(renderedClone);
  return {type:'tw-vector-clipboard',version:1,nodes:copies.map(n=>serialize(n,{xmlMode:true})),defs:doc.root.children.filter(n=>n.name==='defs').map(n=>serialize(n,{xmlMode:true}))};
};
const trajectory = spec => {
  if (!Array.isArray(spec.points)||!spec.points.length||spec.points.length>100000||!spec.points.every(p=>Array.isArray(p)&&p.length===2)) throw new Error('Trajectory requires 1..100000 [x,y] points');
  return spec.points.map(p=>p.map(number));
};
const brushPath = spec => {
  const points=trajectory(spec),p=new Path2D(),width=positive(spec.width ?? spec.size ?? 1);
  p.moveTo(...points[0]); if(points.length===1) {p.arc(points[0][0],points[0][1],width/2,0,Math.PI*2);return p;}
  for(const xy of points.slice(1))p.lineTo(...xy);
  return p.stroke({width,cap:StrokeCap.Round,join:StrokeJoin.Round});
};
const addShape = (doc,type,spec,options) => {
  if (!spec || typeof spec!=='object' || Array.isArray(spec)) throw new Error('Shape spec must be an object');
  const id=`node-${crypto.randomUUID()}`;let node;
  if(type==='rectangle'||type==='rect') node=tag('rect',{id,x:number(spec.x),y:number(spec.y),width:positive(spec.width),height:positive(spec.height)});
  else if(type==='ellipse') node=tag('ellipse',{id,cx:number(spec.cx),cy:number(spec.cy),rx:positive(spec.rx),ry:positive(spec.ry)});
  else if(type==='circle') node=tag('circle',{id,cx:number(spec.cx),cy:number(spec.cy),r:positive(spec.r)});
  else if(type==='line') node=tag('line',{id,x1:number(spec.x1),y1:number(spec.y1),x2:number(spec.x2),y2:number(spec.y2),fill:'none',stroke:spec.stroke||spec.color||'#000000','stroke-width':positive(spec.width ?? 1)});
  else if(type==='path') {node=tag('path',{id,d:spec.d,fill:'#000000'});if(typeof spec.d!=='string'||!spec.d)throw new Error('Missing path data');pathModel(node);}
  else if(type==='brush') node=tag('path',{id,d:brushPath(spec).toSVGString(),fill:spec.color||'#000000'});
  else if(type==='text') {if(typeof spec.text!=='string')throw new Error('Text must be a string');node=tag('text',{id,x:number(spec.x),y:number(spec.y),'font-size':positive(spec.fontSize ?? 16),'font-family':spec.font||'sans-serif'},[{type:'text',data:spec.text}]);}
  else throw new Error('Shape must be rectangle/ellipse/line/path/brush/text');
  if(!node.attribs.fill) node.attribs.fill=spec.color||'#000000';
  append(doc.root,node);
  const style={...options};for(const k of ['fill','stroke','alpha','gradient','stroke-width','fill-alpha','stroke-alpha'])if(spec[k]!==undefined)style[k]=spec[k];
  applyStyle(doc,[node],style); return node;
};
const snapDefaults = {pageCenter:true,pageAxes:true,pageEdges:true,pageCorners:false,objectEdges:true,objectCenters:true,objectMidlines:true,objectCorners:false,boxCenter:true,boxCorners:false,boxEdgeMids:false,threshold:10,zoom:1,enabled:true};
const snap = async (doc,nodes,action,values,options) => {
  let config={};if(options.config) {const data=JSON.parse((await readLocalFile(options.config,MAX_CONFIG_BYTES)).toString('utf8'));config=data.addons?.['paint-snap']?.settings || data['paint-snap'] || data;}
  const settings={...snapDefaults,...config,...options.snapSettings},spec=options.spec?json(options.spec):{},box=union(nodes.map(bounds));
  const zoom=positive(options.zoom ?? settings.zoom),threshold=number(settings.threshold);if(threshold<0)throw new Error('Snap threshold must be nonnegative');
  for(const k of Object.keys(snapDefaults).filter(k=>typeof snapDefaults[k]==='boolean'))if(typeof settings[k]!=='boolean')throw new Error(`Snap ${k} must be boolean`);
  const peers=doc.root.children.filter(n=>editable(n)&&!nodes.includes(n)&&!['data-helper','data-locked','data-guide'].some(k=>n.attribs[k]==='true')).map(n=>({id:n.attribs.id,b:bounds(n)}));
  // Explicit asset coordinate artboard; Paper's view zoom / 2x editor placement is not guessed.
  const vb=spec.artboard || (doc.root.attribs.viewBox?doc.root.attribs.viewBox.trim().split(/[\s,]+/).map(number):[0,0,...doc.costume.size]);
  if(!Array.isArray(vb)||vb.length!==4)throw new Error('Artboard must be [x,y,width,height]');vb.forEach(number);
  const page={x:vb[0],y:vb[1],width:positive(vb[2]),height:positive(vb[3])},cx=page.x+page.width/2,cy=page.y+page.height/2,limit=threshold/zoom;
  const targets=[];
  const pt=(id,x,y)=>targets.push({id,type:'point',point:[x,y]});
  const axis=(id,type,value,min=-Infinity,max=Infinity)=>targets.push({id,type,value,min,max});
  if(action==='snap-move') {
    const dx=number(values[0]),dy=number(values[1]),from=[];
    if(settings.boxCenter)from.push([box.x+box.width/2,box.y+box.height/2]);
    if(settings.boxCorners)from.push([box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]);
    if(settings.boxEdgeMids)from.push([box.x,box.y+box.height/2],[box.x+box.width,box.y+box.height/2],[box.x+box.width/2,box.y],[box.x+box.width/2,box.y+box.height]);
    if(settings.pageCenter)pt('page-center',cx,cy);
    if(settings.pageAxes){axis('page-x','xcoord',cx);axis('page-y','ycoord',cy);}
    if(settings.pageEdges){axis('page-left','xcoord',page.x,page.y,page.y+page.height);axis('page-right','xcoord',page.x+page.width,page.y,page.y+page.height);axis('page-top','ycoord',page.y,page.x,page.x+page.width);axis('page-bottom','ycoord',page.y+page.height,page.x,page.x+page.width);pt('page-left-center',page.x,cy);pt('page-right-center',page.x+page.width,cy);pt('page-top-center',cx,page.y);pt('page-bottom-center',cx,page.y+page.height);}
    if(settings.pageCorners)for(const [x,y] of [[page.x,page.y],[page.x+page.width,page.y],[page.x,page.y+page.height],[page.x+page.width,page.y+page.height]])pt('page-corner',x,y);
    for(const {id,b} of peers) {
      if(settings.objectEdges){axis(`${id}-right`,'itemSideVert',b.x+b.width,b.y,b.y+b.height);axis(`${id}-left`,'itemSideVert',b.x,b.y,b.y+b.height);axis(`${id}-top`,'itemSideHoriz',b.y,b.x,b.x+b.width);axis(`${id}-bottom`,'itemSideHoriz',b.y+b.height,b.x,b.x+b.width);}
      if(settings.objectCenters)pt(`${id}-center`,b.x+b.width/2,b.y+b.height/2);
      if(settings.objectMidlines){axis(`${id}-x`,'xcoord',b.x+b.width/2);axis(`${id}-y`,'ycoord',b.y+b.height/2);}
      if(settings.objectCorners)for(const [x,y] of [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]])pt(`${id}-corner`,x,y);
    }
    const priority=['point','itemSideVert','itemSideHoriz','xcoord','ycoord'],candidates=[];
    if(settings.enabled&&!spec.shift)for(const p of from)for(const t of targets) {
      const moved=[p[0]+dx,p[1]+dy],q=t.type==='point'?t.point:['xcoord','itemSideVert'].includes(t.type)?[t.value,Math.max(t.min,Math.min(t.max,moved[1]))]:[Math.max(t.min,Math.min(t.max,moved[0])),t.value];
      if(Math.abs(q[0]-moved[0])<limit&&Math.abs(q[1]-moved[1])<limit)candidates.push({target:t.id,type:t.type,distance:Math.hypot(q[0]-moved[0],q[1]-moved[1]),dx:q[0]-p[0],dy:q[1]-p[1]});
    }
    candidates.sort((a,b)=>priority.indexOf(a.type)-priority.indexOf(b.type)||a.distance-b.distance);
    let actual=candidates[0] || {dx,dy};
    if(spec.shift){const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*Math.PI/4,length=Math.hypot(dx,dy);actual={dx:Math.cos(angle)*length,dy:Math.sin(angle)*length};}
    for(const n of nodes)transformWorld(n,translation(actual.dx,actual.dy));return {delta:[actual.dx,actual.dy],snap:actual.target?actual:null};
  }
  let sx=number(values[0]),sy=number(values[1] ?? values[0]);
  const handle=spec.handle || 'bottom-right',corner=handle.includes('-'),doesX=!['top','bottom'].includes(handle),doesY=!['left','right'].includes(handle);
  if(!['top','bottom','left','right','top-left','top-right','bottom-left','bottom-right'].includes(handle))throw new Error('Invalid scale handle');
  const centered=spec.alt===true,pivot=centered?[box.x+box.width/2,box.y+box.height/2]:[handle.includes('left')?box.x+box.width:box.x,handle.includes('top')?box.y+box.height:box.y];
  const origSize=[(handle.includes('left')?-1:1)*box.width,(handle.includes('top')?-1:1)*box.height],signX=sx>0?1:-1,signY=sy>0?1:-1;
  if(!doesX)sx=1;if(!doesY)sy=1;if(centered){if(doesX)sx=2*sx-1;if(doesY)sy=2*sy-1;}
  const addScale=(id,type,value)=>targets.push({id,type,value});
  if(settings.pageAxes){addScale('page-x','xcoord',cx);addScale('page-y','ycoord',cy);}
  if(settings.pageEdges){addScale('page-left','xcoord',page.x);addScale('page-right','xcoord',page.x+page.width);addScale('page-top','ycoord',page.y);addScale('page-bottom','ycoord',page.y+page.height);addScale('page-width','width',page.width);addScale('page-height','height',page.height);}
  for(const {id,b} of peers) {
    if(settings.objectEdges){addScale(`${id}-right`,'xcoord',b.x+b.width);addScale(`${id}-left`,'xcoord',b.x);addScale(`${id}-top`,'ycoord',b.y);addScale(`${id}-bottom`,'ycoord',b.y+b.height);addScale(`${id}-width`,'width',b.width);addScale(`${id}-height`,'height',b.height);}
    if(settings.objectMidlines){addScale(`${id}-x`,'xcoord',b.x+b.width/2);addScale(`${id}-y`,'ycoord',b.y+b.height/2);}
  }
  const choose=(axisIndex,scale,enabled)=>{
    if(!settings.enabled||!enabled||!origSize[axisIndex])return null;
    const types=axisIndex===0?['width','xcoord']:['height','ycoord'],size=origSize[axisIndex]*scale,coord=pivot[axisIndex]+size/(centered?2:1);
    return targets.filter(t=>types.includes(t.type)).map(t=>({...t,distance:t.type===types[0]?Math.abs(Math.abs(size)-t.value):Math.abs(coord-t.value)})).filter(t=>t.distance<limit).sort((a,b)=>types.indexOf(a.type)-types.indexOf(b.type)||a.distance-b.distance)[0];
  };
  const snapX=choose(0,sx,doesX),snapY=choose(1,sy,doesY);
  if(snapX)sx=snapX.type==='width'?snapX.value/origSize[0]:(snapX.value-pivot[0])/origSize[0]*(centered?2:1);
  if(snapY)sy=snapY.type==='height'?snapY.value/origSize[1]:(snapY.value-pivot[1])/origSize[1]*(centered?2:1);
  if(corner&&!spec.shift){const max=Math.max(Math.abs(sx),Math.abs(sy));sx=max*signX;sy=max*signY;}
  sx=signX*Math.max(Math.abs(sx),0.0001);sy=signY*Math.max(Math.abs(sy),0.0001);
  const delta=multiply(multiply(translation(...pivot),[sx,0,0,sy,0,0]),translation(-pivot[0],-pivot[1]));for(const n of nodes)transformWorld(n,delta);
  return {scale:[sx,sy],pivot,snapX:snapX || null,snapY:snapY || null};
};
const execute = async (session,target,args,options={}) => {
  const [action,selector,...values]=args,doc=open(target,selector);let selected,ids,details;
  const info=()=>({costume:doc.costume.name,assetId:doc.costume.assetId,action,ids:ids || selected?.map(n=>n.attribs.id),...details});
  if(action==='snap-move'||action==='snap-scale') {
    selected=select(doc,options.nodes || values[0]);details=await snap(doc,selected,action,values.slice(1),options);save(session,target,doc);return info();
  }
  if(action==='source') return {svg:doc.costume.asset.decodeText()};
  if(sceneNodes(doc.root).length===0&&['clear','delete','flip-x','flip-y'].includes(action))return {...info(),unchanged:true};
  if(action==='nodes'||action==='select') {
    selected=action==='select'?select(doc,options.nodes,true):sceneNodes(doc.root);
    return selected.map(n=>({id:n.attribs.id,tag:n.name,parent:n.parent?.attribs?.id,attributes:{...n.attribs},bounds:bounds(n)}));
  }
  if(['points','point-add','point-delete','point-set','pointed','curved'].includes(action)) {
    const node=doc.byId(options.path || values[0]);const result=editPoints(node,action,options);if(action==='points')return result;ids=result;
  } else if(['add','rectangle','rect','ellipse','circle','line','path','brush','text'].includes(action)) {
    const type=action==='add'?values[0]:action;
    selected=[addShape(doc,type,json(options.spec),options)];
  } else if(action==='paste') {
    const file=options.from || values[0];if(!file)throw new Error('Paste requires --from clipboard file');
    const data=JSON.parse((await readLocalFile(file,MAX_CLIPBOARD_BYTES)).toString('utf8'));
    if(data.type!=='tw-vector-clipboard'||data.version!==1||!Array.isArray(data.nodes)||!Array.isArray(data.defs)||data.nodes.length>10000||!data.nodes.every(n=>typeof n==='string')||!data.defs.every(n=>typeof n==='string')||Buffer.byteLength(data.nodes.join('')+data.defs.join(''))>16*1024*1024)throw new Error('Invalid vector clipboard (max 16 MiB SVG)');
    const defs=parseDOM(data.defs.join(''),{xmlMode:true,decodeEntities:true}),copies=parseDOM(data.nodes.join(''),{xmlMode:true,decodeEntities:true});
    remap([...defs,...copies]); for(const n of defs)append(doc.root,n);
    selected=copies.filter(n=>n.type==='tag');for(const n of selected) {append(doc.root,n);transformWorld(n,translation(number(options.dx ?? 0),number(options.dy ?? 0)));}
  } else {
    selected=select(doc,options.nodes || values[0],['clear','delete','erase','flip-x','flip-y'].includes(action));
    if(action==='copy'||action==='cut') {
      const output=options.output || values[1];if(!output)throw new Error('Copy/cut requires --output clipboard file');
      if(action==='cut'&&options.out)throw new Error('Cut cannot combine clipboard output and project --out; use save separately');
      // Export before changing the tree: refused output must not delete the selection.
      const written=await require('./project').atomicWrite(output,Buffer.from(JSON.stringify(clipboard(doc,selected))),options.force);
      if(action==='copy')return {...info(),output:written};
    }
    if(['delete','clear','cut'].includes(action))for(const node of selected)node.parent.children.splice(node.parent.children.indexOf(node),1);
    else if(action==='clone') {
      const originals=selected;selected=originals.map(n=>{const c=clone(n);remap([c]);n.parent.children.splice(n.parent.children.indexOf(n)+1,0,c);c.parent=n.parent;transformWorld(c,translation(number(options.dx ?? 0),number(options.dy ?? 0)));return c;});
    } else if(action==='group') {
      if(selected.length<2||selected.some(n=>n.parent!==selected[0].parent))throw new Error('Group requires at least two sibling nodes');
      const parent=selected[0].parent,ordered=parent.children.filter(n=>selected.includes(n)),index=parent.children.indexOf(ordered.at(-1));
      const group=tag('g',{id:`group-${crypto.randomUUID()}`},ordered);parent.children.splice(index+1,0,group);group.parent=parent;
      parent.children=parent.children.filter(n=>!selected.includes(n));selected=[group];
    } else if(action==='ungroup') {
      if(selected.some(n=>n.name!=='g'))throw new Error('Ungroup requires groups');const result=[];
      for(const n of selected) {
        if(Number(inherited({type:'tag',attribs:n.attribs},'opacity',1))!==1)throw new Error('Ungroup of composited opacity is unsupported; set group alpha to 1 first');
        if(['clip-path','mask','filter'].some(k=>inherited({type:'tag',attribs:n.attribs},k,'none')!=='none'))throw new Error('Ungroup of clipped/masked/filtered groups is unsupported');
        const children=n.children;for(const c of children.filter(c=>c.type==='tag')) {
          c.attribs.transform=matrixText(multiply(parseTransform(n.attribs.transform),parseTransform(c.attribs.transform)));
          for(const key of styleNames)if(key!=='opacity' && inherited({type:'tag',attribs:c.attribs},key,undefined)===undefined&&inherited({type:'tag',attribs:n.attribs},key,undefined)!==undefined)setAttribute(c,key,inherited({type:'tag',attribs:n.attribs},key));c.parent=n.parent;
        }
        for(const c of children)c.parent=n.parent;n.parent.children.splice(n.parent.children.indexOf(n),1,...children);result.push(...children.filter(c=>c.type==='tag'));
      }selected=result;
    } else if(['order','front','back'].includes(action)) {
      const direction=action==='order'?(options.direction || values[1]):action;if(!['front','back','forward','backward'].includes(direction))throw new Error('Order must be front/back/forward/backward');
      for(const parent of new Set(selected.map(n=>n.parent))) {
        const chosen=new Set(selected.filter(n=>n.parent===parent)),slots=parent.children.map((n,i)=>editable(n)?i:-1).filter(i=>i>=0),siblings=slots.map(i=>parent.children[i]);
        if(direction==='front'||direction==='back') {const moved=siblings.filter(n=>chosen.has(n)),rest=siblings.filter(n=>!chosen.has(n));siblings.splice(0,siblings.length,...(direction==='front'?[...rest,...moved]:[...moved,...rest]));}
        else if(direction==='forward') {for(let i=siblings.length-2;i>=0;i--)if(chosen.has(siblings[i])&&!chosen.has(siblings[i+1]))[siblings[i],siblings[i+1]]=[siblings[i+1],siblings[i]];}
        else {for(let i=1;i<siblings.length;i++)if(chosen.has(siblings[i])&&!chosen.has(siblings[i-1]))[siblings[i],siblings[i-1]]=[siblings[i-1],siblings[i]];}
        slots.forEach((slot,i)=>{parent.children[slot]=siblings[i];});
      }
    } else if(action==='style'||action==='fill'||action==='text-style') applyStyle(doc,selected,action==='fill'?{...options,fill:options.fill || values[1]}:options);
    else if(action==='text-set') {for(const n of selected){if(n.name!=='text')throw new Error('Text-set requires text');const text=values[1] ?? options.text;if(typeof text!=='string')throw new Error('Missing text');if(text==='')n.parent.children.splice(n.parent.children.indexOf(n),1);else n.children=[{type:'text',data:text,parent:n}];}}
    else if(action==='gradient-swap') {
      const property=options.property || 'fill';if(!['fill','stroke'].includes(property))throw new Error('Property must be fill/stroke');
      for(const n of selected) {const match=inherited(n,property,'').match(/^url\(#([^)]*)\)$/);if(!match)throw new Error('Selection has no gradient');const g=clone(doc.byId(match[1]));remap([g]);const stops=g.children.filter(c=>c.name==='stop'),colors=stops.map(s=>[s.attribs['stop-color'],s.attribs['stop-opacity']]).reverse();stops.forEach((s,i)=>{s.attribs['stop-color']=colors[i][0];if(colors[i][1]===undefined)delete s.attribs['stop-opacity'];else s.attribs['stop-opacity']=colors[i][1];});append(doc.byId(match[1]).parent,g);setAttribute(n,property,`url(#${g.attribs.id})`);}
    } else if(action==='align'||action==='distribute') {
      if(selected.length<2)throw new Error('Align/distribute requires multiple nodes');const boxes=selected.map(bounds),box=union(boxes),direction=options.direction || values[1];
      if(action==='align') {
        if(!['left','right','top','bottom','center-x','center-y'].includes(direction))throw new Error('Invalid alignment');
        selected.forEach((n,i)=>{const b=boxes[i];const dx=direction==='left'?box.x-b.x:direction==='right'?box.x+box.width-b.x-b.width:direction==='center-x'?box.x+box.width/2-b.x-b.width/2:0;const dy=direction==='top'?box.y-b.y:direction==='bottom'?box.y+box.height-b.y-b.height:direction==='center-y'?box.y+box.height/2-b.y-b.height/2:0;transformWorld(n,translation(dx,dy));});
      } else {
        if(selected.length<3||!['horizontal','vertical'].includes(direction))throw new Error('Distribute requires >=3 nodes and horizontal/vertical');
        const key=direction==='horizontal'?'x':'y',size=direction==='horizontal'?'width':'height',ordered=selected.map((n,i)=>({n,b:boxes[i]})).sort((a,b)=>a.b[key]-b.b[key]);
        const gap=(ordered.at(-1).b[key]+ordered.at(-1).b[size]-ordered[0].b[key]-ordered.reduce((sum,a)=>sum+a.b[size],0))/(ordered.length-1);let position=ordered[0].b[key];
        for(const {n,b} of ordered){transformWorld(n,translation(key==='x'?position-b.x:0,key==='y'?position-b.y:0));position+=b[size]+gap;}
      }
    } else if(['transform','translate','scale','rotate','skew','flip-x','flip-y'].includes(action)) {
      const spec=options.spec?json(options.spec):{},box=union(selected.map(bounds));let delta=identity();
      const pivot=spec.pivot || [box.x+box.width/2,box.y+box.height/2];if(!Array.isArray(pivot)||pivot.length!==2)throw new Error('Pivot must be [x,y]');const [px,py]=pivot.map(number);
      if(spec.matrix) {if(!Array.isArray(spec.matrix)||spec.matrix.length!==6)throw new Error('Matrix requires six numbers');delta=spec.matrix.map(number);}
      else {
        const sx=number(spec.scaleX ?? (action==='scale'?values[1]:action==='flip-x'?-1:1)),sy=number(spec.scaleY ?? (action==='scale'?values[2] ?? values[1]:action==='flip-y'?-1:1));if(sx===0||sy===0)throw new Error('Scale cannot be zero');
        const r=number(spec.rotate ?? (action==='rotate'?values[1]:0))*Math.PI/180,kx=number(spec.skewX ?? (action==='skew'?values[1]:0))*Math.PI/180,ky=number(spec.skewY ?? (action==='skew'?values[2] ?? 0:0))*Math.PI/180;
        if(Math.abs(Math.cos(kx))<1e-9||Math.abs(Math.cos(ky))<1e-9)throw new Error('Singular skew angle');
        delta=multiply([Math.cos(r),Math.sin(r),-Math.sin(r),Math.cos(r),0,0],multiply([1,Math.tan(ky),Math.tan(kx),1,0,0],[sx,0,0,sy,0,0]));
        delta=multiply(multiply(translation(px,py),delta),translation(-px,-py));
        delta=multiply(translation(number(spec.dx ?? (action==='translate'?values[1]:options.dx ?? 0)),number(spec.dy ?? (action==='translate'?values[2]:options.dy ?? 0))),delta);
      }
      for(const n of selected)transformWorld(n,delta);
    } else if(action==='erase') {
      const eraser=brushPath(json(options.spec));const leaves=selected.flatMap(n=>n.name==='g'?walk(n.children).filter(c=>editable(c)&&c.name!=='g'):n);
      if(leaves.some(n=>['text','image','use'].includes(n.name)))throw new Error('Vector eraser supports geometric paths/shapes, not text/image/use');
      for(const n of leaves) {
        const world=worldMatrix(n),p=pathFor(n),localEraser=new Path2D(eraser).transform(asNative(inverse(world)));
        if(inherited(n,'stroke','none')!=='none')throw new Error('Vector eraser currently requires filled shapes without strokes');
        if(inherited(n,'fill','black')==='none')continue;
        if(inherited(n,'fill-rule','nonzero')==='evenodd')p.setFillType(FillType.EvenOdd);
        const cut=p.op(localEraser,PathOp.Difference);n.name='path';n.attribs.d=cut.toSVGString();setAttribute(n,'fill-rule',cut.getFillType()===FillType.EvenOdd?'evenodd':'nonzero');delete n.attribs['data-tw-segments'];
      }
    } else throw new Error(`Unknown vector action ${action}`);
  }
  save(session,target,doc);return info();
};

// Legacy API retains argument layout and default origin transforms.
const edit = (session,args,target) => {
  const [action,selector,id,...values]=args;
  if(action==='nodes') {const doc=open(target,selector);return walk(doc.nodes).filter(n=>n.type==='tag').map(n=>({tag:n.name,attributes:n.attribs}));}
  if(action==='add') {
    let spec;
    if(id==='rect')spec={x:values[0],y:values[1],width:values[2],height:values[3],fill:values[4]||'#000000'};
    else if(id==='circle')spec={cx:values[0],cy:values[1],r:values[2],fill:values[3]||'#000000'};
    else if(id==='line')spec={x1:values[0],y1:values[1],x2:values[2],y2:values[3],stroke:values[4]||'#000000',width:values[5]??1};
    else if(id==='path')spec={d:values[0],fill:values[1]||'#000000'};
    else if(id==='text')spec={x:values[0],y:values[1],text:values[2]||'',fill:values[3]||'#000000',fontSize:values[4]??16};
    else throw new Error('Shape must be rect/circle/line/path/text');
    return execute(session,target,['add',selector,id],{spec}).then(result=>({...result,id:result.ids[0]}));
  }
  if(action==='set') {
    const doc=open(target,selector),node=doc.byId(id),[attribute,value]=values;
    const attrs=new Set([...styleNames,'transform','x','y','x1','x2','y1','y2','width','height','cx','cy','r','rx','ry','d','points']);
    if(!attrs.has(attribute)||value===undefined||/url\(|javascript:|https?:|file:/i.test(value))throw new Error('Unsupported or unsafe SVG attribute');
    setAttribute(node,attribute,value);save(session,target,doc);return {costume:doc.costume.name,id,action};
  }
  if(['translate','scale','rotate'].includes(action)) {
    const doc=open(target,selector),node=doc.byId(id);
    const text=action==='translate'?`translate(${number(values[0])} ${number(values[1])})`:action==='scale'?`scale(${number(values[0])} ${number(values[1] ?? values[0])})`:`rotate(${number(values[0])})`;
    node.attribs.transform=`${node.attribs.transform||''} ${text}`.trim();save(session,target,doc);return {costume:doc.costume.name,id,action};
  }
  return execute(session,target,[action,selector,id]).then(result=>({...result,id}));
};
module.exports = {edit,execute,open,save,select,bounds,pathFor,pathModel,pathText,rgba,gradientSpec,number,alpha,trajectory,parseTransform,worldMatrix};
