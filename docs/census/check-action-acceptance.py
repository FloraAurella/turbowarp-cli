#!/usr/bin/env python3
"""Read-only action acceptance checks; --build writes only the two new mapping documents.

This file never imports/executes project modules or runs node:test. The Node helper parses
JavaScript with Acorn and interprets only data expressions used by command specs/test names.
Verified status requires external action-specific main-thread evidence; generation is pending.
"""
import argparse
import collections
import hashlib
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'tw-cli'
DOCS = CLI / 'docs/census'
JSON_PATH = DOCS / 'action-acceptance.json'
MD_PATH = DOCS / 'action-acceptance.md'
STATES = {'verified-command', 'verified-not-applicable', 'verified-limited', 'dom-only', 'pending'}
CANDIDATES = {'candidate', 'testing-pending', 'unmapped'}
CACHE = {}
READ_HASHES = {}
REGISTRY = {}
TESTS = {}
RECIPES = {}

JS_ANALYZER = r'''
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[1];
const babel=require(path.join(root,'desktop-master/node_modules/@babel/parser'));
const registry={},tests=[],files=[],missing=[];
const parse=file=>{const text=fs.readFileSync(file,'utf8');const ast=babel.parse(text,{sourceType:'script',plugins:['estree']}).program;return {text,ast};};
const id=n=>n.type==='Identifier'?n.name:n.value;
function interpreter(ast,extra={}) {
 const declarations=new Map();
 for(const n of ast.body)if(n.type==='VariableDeclaration')for(const d of n.declarations)if(d.id.type==='Identifier')declarations.set(d.id.name,d.init);
 const evaluating=new Set(),base={...extra};
 const get=(name,scope)=>{if(Object.hasOwn(scope,name))return scope[name];if(Object.hasOwn(base,name))return base[name];if(!declarations.has(name))throw Error('Not a static data identifier: '+name);if(evaluating.has(name))throw Error('cycle');evaluating.add(name);const value=ev(declarations.get(name),scope);evaluating.delete(name);base[name]=value;return value;};
 const ev=(n,scope={})=>{
  if(!n)return undefined;
  if(n.type==='Literal')return n.value;
  if(n.type==='Identifier')return n.name==='undefined'?undefined:get(n.name,scope);
  if(n.type==='TemplateLiteral')return n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?ev(n.expressions[i],scope):'')).join('');
  if(n.type==='ArrayExpression'){const a=[];for(const e of n.elements){if(e.type==='SpreadElement')a.push(...ev(e.argument,scope));else a.push(ev(e,scope));}return a;}
  if(n.type==='ObjectExpression'){const o={};for(const p of n.properties){if(p.type==='SpreadElement')Object.assign(o,ev(p.argument,scope));else o[p.computed?ev(p.key,scope):id(p.key)]=ev(p.value,scope);}return o;}
  if(n.type==='ArrowFunctionExpression')return (...args)=>{const s={...scope};n.params.forEach((p,i)=>{if(p.type==='Identifier')s[p.name]=args[i];else if(p.type==='AssignmentPattern')s[p.left.name]=args[i]===undefined?ev(p.right,s):args[i];else if(p.type==='ArrayPattern')p.elements.forEach((x,j)=>s[x.name]=args[i][j]);else throw Error('unsupported static param');});if(n.body.type==='BlockStatement')throw Error('static functions may not have statements');return ev(n.body,s);};
  if(n.type==='UnaryExpression'){const v=ev(n.argument,scope);if(n.operator==='!')return !v;if(n.operator==='-')return -v;if(n.operator==='+')return +v;if(n.operator==='typeof')return typeof v;}
  if(n.type==='BinaryExpression'){const a=ev(n.left,scope),b=ev(n.right,scope);if(n.operator==='+')return a+b;if(n.operator==='-')return a-b;if(n.operator==='*')return a*b;if(n.operator==='===')return a===b;if(n.operator==='!==')return a!==b;}
  if(n.type==='ConditionalExpression')return ev(n.test,scope)?ev(n.consequent,scope):ev(n.alternate,scope);
  if(n.type==='MemberExpression'){const obj=ev(n.object,scope),key=n.computed?ev(n.property,scope):id(n.property);return obj[key];}
  if(n.type==='CallExpression'){
   const args=n.arguments.map(x=>ev(x,scope));
   if(n.callee.type==='MemberExpression'){
    const method=id(n.callee.property);
    if(n.callee.object.type==='Identifier'&&n.callee.object.name==='Object') {if(method==='fromEntries')return Object.fromEntries(args[0]);if(method==='keys')return Object.keys(args[0]);if(method==='freeze')return args[0];if(method==='entries')return Object.entries(args[0]);}
    const object=ev(n.callee.object,scope);if(Array.isArray(object)&&method==='map')return object.map(args[0]);
   }
   const fn=ev(n.callee,scope);if(typeof fn!=='function')throw Error('static function only');return fn(...args);
  }
  throw Error('Unsupported static expression '+n.type);
 };
 return {ev,get,decl:declarations};
}
const core=path.join(root,'tw-cli/src/commands.js');const parsed=parse(core);const coreI=interpreter(parsed.ast);
const coreSpecs=coreI.get('COMMANDS',{});
function addSpecs(defs,file,text,declaration) {
 for(const [family,definition]of Object.entries(defs)){
  if(registry[family])throw Error('duplicate family '+family);
  const actions=definition.options?{'$direct':definition}:definition;
  registry[family]={file:path.relative(root,file),actions,evidence:{line:declaration.loc.start.line,endLine:declaration.loc.end.line,anchor:text.slice(declaration.start,Math.min(declaration.end,declaration.start+160))}};
 }
}
addSpecs(coreSpecs,core,parsed.text,coreI.decl.get('COMMANDS'));files.push(path.relative(root,core));
const modfile=path.join(root,'tw-cli/src/command-modules.js'),mod=parse(modfile),mi=interpreter(mod.ast);files.push(path.relative(root,modfile));
const moduleNames=mi.get('filenames',{});const booleans=new Set(['force','compile','turbo']);
for(const filename of moduleNames){const file=path.join(root,'tw-cli/src',filename);if(!fs.existsSync(file)){missing.push('tw-cli/src/'+filename);continue;}
 const p=parse(file),i=interpreter(p.ast);const s=i.get('specs',{});addSpecs(s,file,p.text,i.decl.get('specs'));files.push(path.relative(root,file));
 try{for(const option of i.get('booleanOptions',{}))booleans.add(option);}catch{}
 // Export-inline booleans are data, not module execution.
 for(const n of p.ast.body)if(n.type==='ExpressionStatement'&&n.expression.type==='AssignmentExpression'&&n.expression.left.type==='MemberExpression'&&n.expression.left.object.name==='module'&&n.expression.left.property.name==='exports'){
  const prop=n.expression.right.properties?.find(x=>id(x.key)==='booleanOptions');if(prop){try{for(const x of i.ev(prop.value))booleans.add(x);}catch{}}
 }
}
const effects=['reverse','louder','softer','faster','slower','echo','robot','fade-in','fade-out','mute'];
for(const filename of fs.readdirSync(path.join(root,'tw-cli/test')).filter(f=>f.endsWith('.js')).sort()){
 const file=path.join(root,'tw-cli/test',filename),p=parse(file),i=interpreter(p.ast,{audio:{effects:Object.fromEntries(effects.map(x=>[x,true]))}});files.push(path.relative(root,file));
 function walk(n,scope={}){
  if(!n||typeof n!=='object')return;
  if(n.type==='ForOfStatement'){
   try{const values=i.ev(n.right,scope);if(Array.isArray(values)){for(const value of values){const s={...scope};const d=n.left.declarations?.[0]?.id||n.left;if(d.type==='Identifier')s[d.name]=value;else if(d.type==='ArrayPattern')d.elements.forEach((x,j)=>s[x.name]=value[j]);else throw Error('forof binding');walk(n.body,s);}return;}}catch{}
  }
  if(n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.callee.name==='test'){
   let name;try{name=i.ev(n.arguments[0],scope);}catch{}
   if(typeof name==='string')tests.push({file:path.relative(root,file),exactTestName:name,line:n.loc.start.line,endLine:n.loc.end.line,declarationAnchor:p.text.slice(n.arguments[0].start,n.arguments[0].end),parameterBindings:scope});
   return;
  }
  for(const [key,value]of Object.entries(n))if(!['loc','start','end'].includes(key)){if(Array.isArray(value))for(const c of value)walk(c,scope);else if(value&&typeof value==='object')walk(value,scope);}
 }
 walk(p.ast);
}
process.stdout.write(JSON.stringify({registry,tests,readFiles:files,booleanOptions:[...booleans].sort(),moduleNames,missingModules:missing}));
'''


def read(relative):
    if relative not in CACHE:
        data = (ROOT / relative).read_bytes()
        CACHE[relative] = data.decode('utf8')
        READ_HASHES[relative] = hashlib.sha256(data).hexdigest()
    return CACHE[relative]


def sha(relative):
    read(relative)
    return READ_HASHES[relative]


def source(relative, needle, before=0, after=8, occurrence=0):
    lines = read(relative).splitlines()
    hits = [i for i, line in enumerate(lines, 1) if needle in line]
    if len(hits) <= occurrence:
        raise ValueError(f'No exact anchor {relative}: {needle!r}')
    line = hits[occurrence]
    return {'path': relative, 'line': max(1, line - before), 'endLine': min(len(lines), line + after),
            'anchor': needle, 'sha256': sha(relative)}


def analyze():
    result = subprocess.run(['node', '-e', JS_ANALYZER, str(ROOT)], text=True, capture_output=True, check=True)
    data = json.loads(result.stdout)
    for file in data['readFiles']:
        read(file)
    REGISTRY.update(data['registry'])
    for test in data['tests']:
        test['path'] = test.pop('file')
        test['sha256'] = sha(test['path'])
        TESTS[(test['path'], test['exactTestName'])] = test
    return data


def testref(filename, exact, assertions, semantic, parameter=None, partial=False):
    key = ('tw-cli/test/' + filename, exact)
    if key not in TESTS:
        return {'path': key[0], 'exactTestName': exact, 'unavailable': True,
                'semanticMatch': semantic, 'coverage': 'partial' if partial else 'specific',
                'requiredMissing': ['Exact test declaration not in current read snapshot; do not substitute test count.']}
    data = dict(TESTS[key])
    lines = read(data['path']).splitlines()
    refs = []
    for anchor in assertions:
        found = [i for i in range(data['line'], data['endLine'] + 1) if anchor in lines[i - 1]]
        if not found:
            raise ValueError(f'Assertion anchor outside exact test {exact}: {anchor!r}')
        refs.append({'line': found[0], 'anchor': anchor})
    data.update({'assertions': refs, 'semanticMatch': semantic,
                 'coverage': 'partial' if partial else 'specific',
                 'executionStatus': 'testing-pending', 'pendingUntilMain': True,
                 'mainRun': None})
    if parameter:
        data['parameterScope'] = parameter
    data['runArgv'] = ['node', '--test', '--test-name-pattern', '^' + re.escape(exact) + '$', str(ROOT / data['path'])]
    return data


def invocation(argv, context='open-project', bindings=None, purpose=None):
    argv = list(argv)
    family = argv[0]
    record = REGISTRY.get(family)
    if not record:
        return {'argv': argv, 'command': 'tw ' + shlex.join(argv), 'routed': False,
                'requiredMissing': [f'Command family {family} is not registered in current command-modules/commands specs.']}
    direct = '$direct' in record['actions']
    action = '$direct' if direct else argv[1]
    if action not in record['actions']:
        return {'argv': argv, 'command': 'tw ' + shlex.join(argv), 'routed': False,
                'requiredMissing': [f'Subcommand {family} {action} is absent from actual specs.']}
    rule = record['actions'][action]
    options, positionals = [], []
    booleans = ANALYSIS['booleanOptions']
    i = 1 if direct else 2
    while i < len(argv):
        if argv[i].startswith('--'):
            option = argv[i][2:]
            if option not in rule['options']:
                raise ValueError(f'Bad actual invocation {argv}: --{option} not allowed by specs')
            options.append(option)
            if option not in booleans:
                if i + 1 >= len(argv):
                    raise ValueError('Missing actual option value: ' + str(argv))
                i += 1
        else:
            positionals.append(argv[i])
        i += 1
    if not rule['min'] <= len(positionals) <= rule['max']:
        raise ValueError(f'Bad exact positional shape {argv}: {len(positionals)} not {rule["min"]}..{rule["max"]}')
    return {'argv': argv, 'command': 'tw ' + shlex.join(argv), 'routed': True,
            'executionContext': context, 'bindings': bindings or {}, 'purpose': purpose,
            'specEvidence': {'path': record['file'], **record['evidence'], 'sha256': sha(record['file'])},
            'spec': {'family': family, 'action': None if direct else action, **rule},
            'shapeChecked': 'static actual registry: positional bounds + accepted options; no project executed'}


def recipe(ids, commands, implementations, tests=None, missing=None, target='verified-command',
           reason=None, supported=None, boundary=None):
    if isinstance(ids, str):
        ids = [ids]
    for id in ids:
        if 'CURRENT_IDS' in globals() and id not in CURRENT_IDS:continue
        if id in RECIPES:
            raise ValueError('Recipe conflict: ' + id)
        RECIPES[id] = {'targetStatus': target, 'actualCli': [invocation(c) for c in commands],
                       'implementationEvidence': implementations, 'tests': tests or [],
                       'requiredMissing': missing or [], 'semanticReason': reason,
                       'supportedPart': supported, 'boundary': boundary,
                       'rootFamily': None}


def semantic_recipes(ledger, inventory):
    def impl(file,needle,after=12):return source('tw-cli/src/'+file,needle,after=after)
    def T(file,name,assertions,semantic,partial=False,parameter=None):return testref(file,name,assertions,semantic,parameter,partial)
    def r(ids,cmds,ev,ts=(),missing=(),**kwargs):recipe(ids,cmds,ev,list(ts),list(missing),**kwargs)
    def one(id,cmd,ev,ts=(),missing=(),**kwargs):r(id,[cmd],ev,ts,missing,**kwargs)
    # Core project and exact file outputs. Save-as uses save but export deliberately does not bind.
    save_test=T('commands.test.js','commands create/save/reopen, preserve layers/assets, undo/redo and rollback',
                ['session.execute([\'save\'])','session.execute([\'open\', file])','zip.file(costume.md5ext)'], '绑定保存路径，持久化实际project.json/asset字节后重开。')
    import_test=T('project-io.test.js','real binary SB, frozen SB2/nested-SB2 and SB3 import offline; bytes and converted state survive reload',
                  ['sbFixture()','_nestedFolder.sb2','assert.equal(prepared.sourceFormat, format)','saved.assets.get(name)'], '真实SB二进制、冻结SB2/嵌套SB2/SB3资产与转换状态重载；命令open由同readProject链加载。',partial=True)
    for id in ['mb.save-shortcut','mb.file.save-to-file','mb.save-status.save']:
        one(id,['save'],[impl('commands.js','async save(file')],[save_test],reason='smartSave有文件句柄时→当前session原路径save；无句柄须显式save <path>。')
    one('mb.file.save-as',['save','/tmp/tw-acceptance/save-as.sb3'],[impl('commands.js','async save(file')],[save_test],['另存之后绑定新路径与标题变更尚无此精确GUI断言。'])
    for id in ['mb.open-shortcut','mb.file.load','project-io.open-path']:
        one(id,['open','/tmp/tw-acceptance/input.sb3'],[impl('commands.js','async open(file'),impl('project.js','const normalizeProject =')],[import_test],['SB/SB2/SB3加载fixture存在，但UI文件名标题≤100/仅SB3句柄接线需独立命令断言。'])
    one('mb.file.new',['new'],[impl('commands.js',"if (command === 'new')")],[save_test],['GUI默认空白模板与blankProject默认角色资产/位置需要fixture逐字段对比。'])
    r(['project-io.close-dirty-stay','project-io.close-dirty-discard'],[['quit'],['quit','--force']],
      [source('tw-cli/bin/tw.js',"if (command === 'quit'",after=15)] if "if (command === 'quit'" in read('tw-cli/bin/tw.js') else [source('tw-cli/bin/tw.js','Unsaved',after=8)],
      [T('commands.test.js','JSONL rejects malformed envelopes and quit arguments without terminating or corrupting stdout',['request(\'quit\', \'typo\'','result.status, 0'], '退出协议拒错与forced quit；dirty拒绝还需精确stay断言。',partial=True)],
      ['分开stay(保留session)和discard(退出丢弃)具体dirty-state断言。'])
    one('project-io.alert-download',['project','export','/tmp/tw-acceptance/backup.sb3'],[impl('project-io-commands.js',"if (action === 'export')")],[],['错误告警下载项目未绑定原路径/未清dirty的具体fixture尚缺。'])
    # Exact asset IDs / index / name and CLI shape, never re-use draft costume paint argument strings.
    asset_id_test=T('asset-tools.test.js','asset ID survives rename/content edits/reorder/reload; duplicate resources have unique persistent UUIDs and independent players',
                    ["['asset','duplicate','costume'","['asset','rename','costume'","['asset','reorder','costume'","['asset','select','costume'"], 'uuid持久化、rename/reorder/currentCostume和声音独立player，测试逐kind断言。')
    sound_copy_test=T('asset-tools.test.js','sound copy/render/select/trim/delete/keep/paste/copy-to-new have sample-exact GUI slicing and mono channel-zero semantics',
                      ["['asset','copy','sound'",'copied WAV remains a snapshot after editing its source',"['asset','paste','sound'"], 'copy后源mute仍保留原WAV快照，再粘贴该快照；选区切样本/channel0。')
    paint_clip_test=T('paint-tools.test.js','explicit clipboard is a snapshot and eyedropper applies sampled RGBA to selected vector nodes',
                     ["snapshot.json", "paint(s,'copy'", "paint(s,'style'"], '显式copy图形快照后source变色；sample/apply选中节点有实际颜色断言。')
    asset_specs={'costumes.select':('select','costume'),'costumes.rename':('rename','costume'),
                 'backdrops.rename':('rename','costume'),'costumes.delete':('delete','costume'),
                 'costumes.duplicate':('duplicate','costume'),'costumes.reorder':('reorder','costume'),
                 'costumes.export':('export','costume'),'sounds.editor.rename':('rename','sound'),
                 'sounds.delete':('delete','sound'),'sounds.duplicate':('duplicate','sound'),
                 'sounds.list.reorder':('reorder','sound'),'sounds.export':('export','sound')}
    for id,(action,kind) in asset_specs.items():
        args=['asset',action,kind,'0']
        if action=='rename':args+=['new-name']
        if action=='reorder':args+=['0']
        if action=='export':args+=['/tmp/tw-acceptance/'+('costume.svg' if kind=='costume' else 'sound.wav')]
        if id.startswith('backdrops'):args+=['--target','stage']
        anchor={'rename':"if(action==='rename')",'delete':"if(action==='delete')",'duplicate':"if(action==='duplicate')",'select':"if(action==='select')",'reorder':"if(action==='reorder')",'export':"if(action==='export')"}[action]
        ts=[asset_id_test] if action in ['rename','duplicate','select','reorder'] else []
        missing=[]
        if action=='rename':missing+=['造型/声音rename必须同步引用积木；当前UUID/name测试未对GUI引用重写做具体断言。']
        if id=='backdrops.rename':missing+=['舞台背景改名更新全部target背景引用的具体fixture。']
        if action=='delete':missing+=['删除索引调整currentCostume/最后造型限制/精确声音恢复状态fixture。']
        one(id,args,[impl('asset-commands.js',anchor)],ts,missing)
    one('costumes.share-to-target',['asset','share','costume','0','Other'],[impl('asset-commands.js',"if(action==='share')")],[],['造型share:新targetcurrentCostume、source不变和editingTarget不切换完整fixture。'])
    for id in ['sprites.drop-sound','sounds.share-to-stage']:
        one(id,['asset','share','sound','0','stage' if id=='sounds.share-to-stage' else 'Other'],[impl('asset-commands.js',"if(action==='share')")],
            [T('asset-tools.test.js','asset ID survives rename/content edits/reorder/reload; duplicate resources have unique persistent UUIDs and independent players',
               ["['asset','share','sound'",'selected);','getSounds().some'], '声音share到stage新UUID与source选择未改变；Other分支不由stage测试自动验收。',partial=id=='sprites.drop-sound')])
    for id in ['costumes.add-blank','backdrops.add-blank']:
        one(id,['asset','blank','costume','costume1']+(['--target','stage'] if id.startswith('backdrops') else []),
            [impl('asset-commands.js',"if(action==='blank')")],[],['GUI emptyCostume空SVG/rotationCenter=0/尺寸与当前blank 60x60模板仍需对比。'])
    conversion_test=T('asset-tools.test.js','asset size/center and SVG/PNG conversion preserve stage dimensions and real colors, not vector tracing',
                      ["['asset','convert','costume',c.id,'bitmap']","['asset','convert','costume',c.id,'vector']",'data:image/png;base64,'], 'SVG→PNG→embeddedSVG→PNG尺寸/center/alpha颜色与重载，非矢量描摹。')
    for id,fmt in [('costumes.paint-convert-bitmap','bitmap'),('costumes.paint-convert-vector','vector')]:
        one(id,['asset','convert','costume','0',fmt],[impl('asset-commands.js','const convertCostume=')],[conversion_test],['GUI字体inline/trimmed raster边界与原Paper资产精确像素/center对拍未完成。'])
    # The four actual library fixtures are sufficient for byte-loading candidates, not surprise/favorite.
    library_test=T('project-io.test.js','installed frozen library loads sprite/costume/sound/backdrop with exact assets and reopen semantics',
                   ["['sprite', 'Abby']","['costume', 'Abby-a']","['sound', 'Meow']","['backdrop', 'Arctic']",'Buffer.from(loaded.asset.data)'],
                   '四类真实冻结清单资产bytes与重开；main须证明skip=0，assetavailability输入gate已解。')
    for id,kind,name in [('sprites.add.choose-item','sprite','Abby'),('costumes.library-select','costume','Abby-a'),('sounds.library.add','sound','Meow'),('backdrops.library-select','backdrop','Arctic')]:
        one(id,['library','load',kind,name],[impl('project-io-commands.js',"if (command === 'library')"),impl('project-io-commands.js','const attachAsset =')],[library_test],
            ['main统一真实库load测试需skip=0；spriteGUI随机初始位置/重名去重，资产选择后currentCostume/target更新须对应kind语义确认。'])
    # Local backpack supported part is D4 only: never read old IndexedDB; mapping uses explicit filesystem fixture.
    store_test=T('project-io.test.js','atomic backpack persists every type across sessions and restore points preserve selected ID/monitor/asset IDs',
                 ["['save', type", "['load', ids.costume]", "['load', ids.sound]", "['load', ids.block]", "['load', ids.sprite]", "['restore', point.id]"],
                 'project/sprite/block/costume/sound持久化到显式文件库，多session与selected/monitor/assetID恢复。')
    d4={'decision':'D4','reason':'旧IndexedDB用户数据迁移只由桌面版；CLI显式新文件库数据管道，不读取旧库。'}
    for id in ['sprites.drop-backpack-sprite','sprites.drop-backpack-costume','sprites.drop-backpack-sound','sprites.drop-backpack-code','costumes.backpack-drop','costumes.backpack-sound-drop','sounds.drop.backpackSound','sounds.drop.backpackCostume','code-ws.drop-backpack-code','project-io.backpack-code-to-stage']:
        one(id,['backpack','load','<backpack-item-uuid>','--dir','/tmp/tw-acceptance/backpack'],[impl('project-io-commands.js','const loadBlocks ='),impl('project-io-commands.js',"if (item.type === 'sprite')")],[store_test],
            ['独立审尚未批准此D4数据迁移limited判定；目标投放/保留作用域/ID冲突需按item.type精确核对。'],target='verified-limited',boundary=d4,supported='新显式本地库的load pipeline（真实文件fixture），不迁移旧GUI IndexedDB。')
    for id,kind,selector in [('sprites.drag-to-backpack','sprite',None),('code-ws.drag-block-to-backpack','block','<block-id>'),('project-io.backpack-store-costume','costume','0'),('project-io.backpack-store-sound','sound','0')]:
        cmd=['backpack','save',kind,'saved']+([selector] if selector else [])+['--dir','/tmp/tw-acceptance/backpack']
        one(id,cmd,[impl('project-io-commands.js',"if (action === 'save')")],[store_test],['D4独立审和GUIpayload/thumbnail元数据格式仍需核实。'],target='verified-limited',boundary=d4,supported='显式本地文件库save；不自动迁移旧存储。')
    one('project-io.restore-create',['project','restore-save','before-edit','--dir','/tmp/tw-acceptance/restore'],[impl('project-io-commands.js',"if (action === 'restore-save')")],[store_test],['D4独立审与快照assets/thumbnail/automaticType细节仍待对应。'],target='verified-limited',boundary=d4,supported='创建新文件库restore point。')
    one('project-io.restore-load',['project','restore','<restore-uuid>','--dir','/tmp/tw-acceptance/restore'],[impl('project-io-commands.js','await readProject(payload); await session.restore')],[store_test],['加载restore需断言GUI fileHandle清空、dirty确认及标题恢复。'],target='verified-limited',boundary=d4,supported='新本地快照加载与selectedID/monitor/assetID保持。')
    # Exact block semantics are in plural blocks family, not the proposed legacy blocks move flags.
    block_add_test=T('block-tools.test.js','complex SB3 procedure mutation, boolean arguments, obscured shadows and comments roundtrip in clipboard',
                     ['const f = await fixture(session, dir)','assert.notEqual(hidden.block, hidden.shadow)','pasted.idMap'], '真实构建含boolean procedure和obscured shadow块图，复制/粘贴fresh IDs及注释。')
    graph_test=T('block-tools.test.js','connect/disconnect healing, single delete, cleanup and cycle/shape failure are graph-safe and undoable',
                 ["['blocks', 'disconnect'","['blocks', 'delete'",'getBlock(hat.id).next, last.id'], 'Ctrl unplug healing/单块delete、连接shape/cycle与undo/reopen可执行。')
    copy_test=T('block-tools.test.js','complex SB3 procedure mutation, boolean arguments, obscured shadows and comments roundtrip in clipboard',
                ["['blocks', 'copy'","['blocks', 'paste'",'copied.bundle.comments.length, 1','pasted.roots.length, 1'], '复制standalone依赖/注释/obscured shadow后粘贴复用兼容procedure，fresh IDs。')
    field_test=T('block-tools.test.js','opcode switching remaps inputs, splits real branches, changes shadows, validates field/resource menus',
                 ["['blocks', 'set-field'",'fields.VARIABLE.id, value2.id',"['blocks', 'field-menu'"], '实际变量ID字段与资源menu校验；不是对任意FIELD类型全面代理。',partial=True)
    proc_test=T('block-tools.test.js','mutation changes are DOM-shaped, signatures synchronize calls and delete blocks used externally is refused',
                ["['blocks', 'procedure-edit'",'mutations.length >= 2',"['blocks', 'procedure-delete'"], 'procedure签名更名同步DOM-shaped mutation到call，外部调用存在拒删。')
    one('code-ws.block-create-from-flyout',['blocks','add','motion_movesteps','--inputs','{"STEPS":10}','--at','40,50'],[impl('block-commands.js',"if (action === 'add')")],[block_add_test],['Palette默认field/shadow和create事件簿记对GUI具体opcode仍需匹配。'])
    for id in ['code-ws.block-delete','code-ws.block-delete-key']:
        one(id,['blocks','delete','<block-id>','--single','--heal'],[impl('block-commands.js',"if (['connect', 'disconnect', 'heal', 'delete'].includes(action))")],[graph_test],reason='鼠标右键和Delete键进入同一heal删除回调；保留下接堆，不与stack clear混淆。')
    one('code-ws.block-duplicate',['blocks','duplicate','<block-id>','--at','100,200'],[impl('block-commands.js',"if (action === 'duplicate')")],
        [T('block-tools.test.js','real checked-in SB3 inspect/count/find, duplicate fresh IDs, reload and execute twice',["['blocks', 'duplicate'",'oldId, newId','getBlock(duplicated.id).x, 100'], 'checked-in SB3堆复制newID/current coords，解释和编译运行两遍。')])
    one('code-ws.block-copy',['blocks','copy','<block-id>','--output','/tmp/tw-acceptance/blocks.json'],[impl('block-commands.js',"if (['copy', 'export', 'cut', 'duplicate', 'share'].includes(action))")],[copy_test])
    one('code-ws.block-paste',['blocks','paste','/tmp/tw-acceptance/blocks.json','--at','300,200'],[impl('block-commands.js',"if (action === 'paste' || action === 'import')")],[copy_test],['workspace注释独立剪贴板paste（无块）是否覆盖当前bundle格式还需fixture。'])
    one('code-ws.block-cut',['blocks','cut','<block-id>'],[impl('block-commands.js',"if (action === 'cut')")],
        [T('block-tools.test.js','clipboard hostile imports and output overwrite failures leave project/history intact; cut heals only single', ["['blocks', 'cut', first.id]",'getBlock(last.id), undefined',"['blocks', 'paste']"], '正常Ctrl-X stack剪切不heal；single剪切heal独立，copy-buffer留存。')])
    r('code-ws.block-move',[['blocks','disconnect','<block-id>','--at','42,44'],['blocks','move','<block-id>','42','44'],['blocks','connect','<block-id>','--after','<parent-id>']],
      [impl('block-commands.js',"if (action === 'move')"),impl('block-commands.js',"if (['connect', 'disconnect', 'heal', 'delete'].includes(action))")],[graph_test],
      ['包含三种拖动语义，应按具体disconnect/connect/move事件组数与受影响坐标核对；固定位置helper不复现GUI自动bump。'])
    one('code-ws.field-variable-select',['blocks','set-field','<block-id>','VARIABLE','<variable-id>'],[impl('block-commands.js',"if (action === 'set-field')")],[field_test],['列表LIST/广播BROADCAST_OPTION及New message创建引用不能由VARIABLE断言代理。'])
    for id,field,value in [('code-ws.field-colour-edit','COLOUR','#123456'),('code-ws.field-note-edit','NOTE','60'),('code-ws.field-text-edit','NUM','25'),('code-ws.field-dropdown-select','COSTUME','costume1')]:
        one(id,['blocks','set-field','<block-id>',field,value],[impl('block-commands.js','const validateField =')],[],['精确'+field+'字段变更、bounds/menu联动与项目reload fixture缺失；变量menu测试不适用全部field。'])
    for id in ['sprites.drop-blocks']:
        one(id,['blocks','share','<script-root-id>','Other','--target','Sprite1'],[impl('block-commands.js',"if (action === 'share')")],
            [T('block-tools.test.js','share remaps local variables and process argument IDs, keeps broadcasts global; conflicts have explicit policies', ["['blocks', 'share'",'receiver.variableMap[f.score.id], score2.id','receiver.variableMap[f.ping.id], f.ping.id'], '跨target share重分配proc arg IDs、复用同名local、broadcast global，冲突policy明确。')])
    for id in ['code-ws.make-block','prompt.procedure.label','prompt.procedure.boolean','prompt.procedure.number-text','prompt.procedure.warp','prompt.procedure.field-text','prompt.procedure.field-remove','code-ws.procedure-edit','code-ws.procedure-change-type','code-ws.procedure-delete']:
        action='procedure-delete' if id.endswith('delete') else 'procedure-add' if id=='code-ws.make-block' else 'procedure-edit'
        cmd=['blocks',action,'walk']
        if action=='procedure-add':cmd+=['--params','[{"name":"distance","type":"number"},{"name":"flag","type":"boolean"}]','--warp','true']
        if id=='code-ws.procedure-change-type':cmd+=['--type','reporter']
        if id=='prompt.procedure.warp':cmd+=['--warp','true']
        ts=[proc_test] if id in ['code-ws.procedure-edit','code-ws.procedure-delete'] else [block_add_test] if id=='code-ws.make-block' else []
        missing=[] if ts else ['此过程编辑子语义需精确mutation arg顺序/标签/warp/return/参数删除fixture，rename测试不能代理。']
        if id=='prompt.procedure.label':missing+=['proccode中任意中间label拼接与删除—not just name prefix/args append。']
        one(id,cmd,[impl('block-commands.js',"if (action === '"+action+"')")],ts,missing)
    one('code-ws.argument-reporter-drag',['blocks','add','argument_reporter_string_number','--fields','{"VALUE":"distance"}'],[impl('block-commands.js',"if (action === 'add')")],[block_add_test])
    for id,cmd in [('code-ws.delete-all-blocks',['blocks','clear']),('code-ws.clean-up',['blocks','cleanup','--at','48,64','--gap','72'])]:
        one(id,cmd,[impl('block-commands.js',"if (action === 'clear')" if id.endswith('blocks') else "if (action === 'cleanup' || action === 'clean-up')")],[graph_test],
            ['GUI精确pixelmetrics布局/不可删块及≥2确认语义尚未覆盖；结构cleanup存在不是像素对拍。'])
    # Variables/comments/list/monitors: field-specific fixtures, explicit 1-based CLI indices.
    list_test=T('commands.test.js','lists, broadcasts, comments, monitors, procedures and bitmap edits survive save',
                ["['list', 'append'","['list', 'replace'",'value, [1, 8, 3]'], 'list append/replace(1-based)与SB3重开。')
    monitor_test=T('monitors.test.js','monitor ranges, modes, positions and list CSV survive project reload and undo',
                   ["['monitors', 'mode'","['monitors', 'move'","['monitors', 'size'","['monitors', 'range'"], 'mode slider/position/size/范围isDiscrete=false和reload；逆minmax拒绝与GUI归一化不同。')
    for id,cmd in [('code-ws.make-list',['list','add','items','[]']),('code-ws.make-variable',['var','add','score','0'])]:
        one(id,cmd,[impl('commands.js',"if (action === 'add')",after=12)],[list_test] if id.endswith('list') else [save_test],
            ['GUI默认自动showMonitor、global/local/cloud Prompt对应与作用域/云creation选项需组合fixture。'])
    for id,cmd in [('code-ws.variable-rename',['addon','rename-variable','<id>','renamed']),('code-ws.variable-delete',['var','delete','<id>'])]:
        one(id,cmd,[impl('addon-commands.js',"if (action === 'rename-variable')") if id.endswith('rename') else impl('commands.js',"else if (action === 'delete') target.deleteVariable")],[],
            ['删除GUI变量还删除全部引用块；CLI仅deleteVariable不等价。'] if id.endswith('delete') else ['变量/列表global/local/cloud name引用完整fixture需按owner核实。'])
    for id,act,args in [('monitor.list.edit','set-item',['items','1','text']),('monitor.list.insert-below','insert-item',['items','2','']),('monitor.list.insert-above','insert-item',['items','1','']),('monitor.list.remove','delete-item',['items','1'])]:
        one(id,['monitors',act]+args,[impl('monitor-commands.js',"if (action === 'set-item')")],
            [T('monitors.test.js','monitor ranges, modes, positions and list CSV survive project reload and undo',["['monitors', 'delete-item'",'value[0], \'name\''], '删除列表项及undo实际值。')] if act=='delete-item' else [],
            [] if act=='delete-item' else ['GUI字符串编辑/先提交当前值/插入空字符串位置精确fixture尚缺。'])
    one('monitor.list.append',['list','append','items','""'],[impl('editor-commands.js',"if (action === 'append')")],[list_test],['append空字符串而非数值3的精确fixture。'])
    monitor_map={'stage.monitor.drag':('move',['score','12','34']), 'stage.monitor.menu-hide':('hide',['score']),
                 'stage.monitor.menu-mode-default':('mode',['score','default']),'stage.monitor.menu-mode-large':('mode',['score','large']),
                 'stage.monitor.menu-mode-slider':('mode',['score','slider']),'stage.monitor.menu-slider-range':('range',['score','10.0','0']),
                 'monitor.list.resize':('size',['items','110','200'])}
    for id,(action,args) in monitor_map.items():
        anchor={'move':"else if (action === 'move')",'hide':"if (action === 'show' || action === 'hide')",'mode':"else if (action === 'mode')",'range':"else if (action === 'range')",'size':"else if (action === 'size')"}[action]
        misses=[]
        if action=='range':misses=['GUI将min/max排序归一、文本小数点推isDiscrete；当前monitors range逆范围拒绝，不可升级。']
        if id=='monitor.list.resize':misses=['GUI clamp宽[100,stageWidth]/高[60,stageHeight]，CLI 0..4096未同边界。']
        if id.endswith(('default','large')):misses+=['精确mode='+args[-1]+'保存/循环可用性fixture，slider测试不足。']
        one(id,['monitors',action]+args,[impl('monitor-commands.js',anchor)],[monitor_test],misses)
    one('stage.monitor.slider-drag',['monitors','value','score','7'],[impl('monitor-commands.js',"if (action === 'value')")],[],['slider归一/clamp/isDiscrete、global/local/cloud provider同步的精确fixture。'])
    one('stage.monitor.menu-import-list',['monitors','import-list','items','/tmp/tw-acceptance/list.csv','--column','1'],[impl('monitor-commands.js',"if (action === 'import-list')")],
        [T('monitors.test.js','monitor ranges, modes, positions and list CSV survive project reload and undo',["['monitors', 'import-list'", "['name', 'a,b', 'quote\"d']"], '带引号CSV第一列真实列表值。')],
        ['GUI单列/NaN列回退原text.split、超界filter undefined与当前parser行为不同，需要修语义而非CSV testcount升级。'])
    one('stage.monitor.menu-export-list',['monitors','export-list','items','/tmp/tw-acceptance/list.txt','--format','text'],[impl('monitor-commands.js',"if (action === 'export-list')")],[],['GUI值以CRLF连接且无额外末尾LF；当前text export用LF+末尾LF，JSONexport测试不能代替。'])
    one('code-ws.monitor-checkbox-toggle',['monitor','add','score'],[impl('editor-commands.js','monitor(session')],[monitor_test],['带params非变量opcode monitor、取消隐藏与先前monitor状态/isMonitored同步需精确fixture。'])
    comment_test=T('commands.test.js','lists, broadcasts, comments, monitors, procedures and bitmap edits survive save',
                   ["['comment', 'add'","['comment', 'set'",'text, \'更新说明\''], '工作区comment add/text set/reload真实值；块附着/尺寸/最小化不由此断言代理。',partial=True)
    commentids={'code-ws.workspace-comment-add':('add',['text']), 'code-ws.block-comment-add':('add',['text','--block','<id>']),
                'code-ws.comment-text-edit':('set',['<comment-id>','text']), 'code-ws.comment-move':('move',['<comment-id>','20','30']),
                'code-ws.comment-delete':('delete',['<comment-id>']), 'code-ws.block-comment-remove':('delete',['<comment-id>']),
                'code-ws.comment-resize':('resize',['<comment-id>','220','120']), 'code-ws.comment-minimize':('minimize',['<comment-id>','true']),
                'code-ws.comment-duplicate':('duplicate',['<comment-id>'])}
    for id,(act,args) in commentids.items():
        if act not in REGISTRY['comment']['actions']:
            RECIPES[id]={'targetStatus':'verified-command','actualCli':[],'implementationEvidence':[],'tests':[],'requiredMissing':['实际comment specs缺少'+act+'；不得用add/set/manual project patch冒充。'],'semanticReason':None,'supportedPart':None,'boundary':None,'rootFamily':None};continue
        one(id,['comment',act]+args,[impl('editor-commands.js','comment(session')],[comment_test] if act in ['add','set'] else [], ['此comment子动作具体blockId/尺寸/最小化/位置/duplicate-copy属性fixture需补。'])
    for id,act in [('code-ws.undo','undo'),('code-ws.redo','redo'),('sounds.editor.undo','asset'),('sounds.editor.redo','asset'),('costumes.paint-undo','paint'),('costumes.paint-redo','paint')]:
        cmd=[act] if act in ['undo','redo'] else [act,'redo' if id.endswith('redo') else 'undo']
        one(id,cmd,[impl('commands.js',"if (command === 'undo' || command === 'redo')")], [asset_id_test] if act=='asset' else [save_test] if act in ['undo','redo'] else [paint_clip_test],
            ['当前99/200MiB为shared-project历史，不是GUI按工作区/声音/造型切换清栈生命周期；此范围差异需精确fixture/独立边界批准。'])
    # Runtime and settings commands are separate from batch run; tests target exact fork state.
    rt_test=T('runtime-control.test.js','runtime contract routes through real CommandSession and block steps mutate only fork copy',
              ["call(session, 'start'",'first.steppedBlocks, 1',"call(session, 'stop')","score(await session.execute(['info']))"], 'persistent fork start/step/stop、真实VM线程和值/editor不变。')
    for id in ['stage.run.greenflag-click','stage.run.overlay-click','stage.run.embed-autoplay']:
        one(id,['runtime','start','--paused'],[impl('runtime-commands.js',"if (name === 'start')")],[rt_test],['GUI绿旗在当前runtime restart/reset timer/clone，而runtime start独立fork并拒已有；需重启语义及editor运行状态边界批准。'])
    one('stage.run.stop-click',['runtime','stop'],[impl('runtime-commands.js',"if (name === 'stop')")],[T('runtime-control.test.js','trace/watch bounded rings retain immutable samples, clones are reported and stop removes them',["call(session, 'stop')).cloneCount, 0",'clones.clones.length, 1'], '真实fork clone状态被stop清空。')],['GUI stopAll保留可重启runtime；当前controller stop关闭fork，内部native audio-stop语义还需对齐。'])
    pause_test=T('runtime-control.test.js','pause freezes virtual frames and waits, resume progresses without editing shared VM',
                 ['assert.deepEqual(await call(session, \'status\'), paused)','score(await call(session, \'step\', \'--frames\', \'2\')), 7'], '等待clock/frames暂停，step继续，sharedVM不变。')
    for id,cmd in [('addon.pause.pause',['runtime','pause']),('addon.pause.resume',['runtime','resume']),('addon.debugger.resume',['runtime','resume'])]:
        one(id,cmd,[impl('runtime-commands.js',"if (['pause', 'resume', 'status', 'clones'].includes(name))")],[pause_test],['GUI暂停还audioContext/timer/compiled thread补偿；fork frameclock测试不能自动代替音频暂停恢复。'])
    one('addon.debugger.step',['runtime','step'],[impl('runtime-commands.js',"if (name === 'step')")],[T('runtime-control.test.js','compiled runtime supports pause/frame step but explicitly rejects block stepping, breakpoints and primitive trace',["call(session, 'step'), /Compiled single-step/","call(session, 'start', '--paused', '--no-compile')",'score(await call(session, \'step\')), 1'], '解释线程block step、compiled拒block step，frame step与block分开。')],['GUIsingleStep sharedThread timer/audio advance相同语义需对拍；解释步进并非D7/D6豁免。'])
    one('addon.debugger.breakpoint',['runtime','breakpoint','add','<block-id>'],[impl('runtime-commands.js',"if (name === 'breakpoint')")],[T('runtime-control.test.js','block-ID breakpoints pause before execution, record hits and bypass once on stepping/resume',["call(session, 'breakpoint', 'add'",'status.breakpoint.blockId, script.second'], 'BlockID breakpoint真暂停执行前/hit；GUI breakpoint自定义积木不是同一种定义入口。')],['必须实现GUI addon自定义breakpoint积木注册/存储/调用；CLI blockID断点是相关候选不等价proccode块。'])
    one('stage.question.answer',['runtime','answer','Alice','--question','1'],[impl('runtime-commands.js',"if (name === 'answer')")],[T('runtime-control.test.js','ask blocks remain pending until immediate or frame-scheduled answer and trace shows reporter boundaries',["call(session, 'answer', 'Alice'",'score(await call(session, \'step\', \'--frames\', \'1\')), \'Alice\''], 'ANSWER事件解除ask阻塞，questionID校验；有效文本运行值。')])
    keys=[('stage.keyboard.down',['runtime','input','key','space','down']),('stage.keyboard.up',['runtime','input','key','space','up']),
          ('stage.pointer.down',['runtime','input','mouse','0','0','down','--button','0']),('stage.pointer.up',['runtime','input','mouse','0','0','up','--button','0']),
          ('stage.pointer.move',['runtime','input','mouse','12','34']),('stage.pointer.right-down',['runtime','input','mouse','0','0','down','--button','2']),
          ('stage.pointer.wheel',['runtime','input','wheel','1','2'])]
    inputtest=T('device-adapters.test.js','key/mouse/wheel/userData/cloud use real VM IO, and JSONL frame order changes script results',
                ['mouseWheel','keyboard','cloud'], '真实VM IO分设备及帧序；persistent输入路由测试另核对。')
    for id,cmd in keys:
        one(id,cmd,[impl('runtime-commands.js','const inputEvent =')],[inputtest],['persistent命令此具体up/down/right/wheel字段的精确路由与wasDragged/contextmenu影响fixture需逐项匹配。'])
    settings_fixture=T('settings.test.js','settings changes use VM project-options comment and survive SB3 reload',
                       ["['settings', 'set', 'fps', '60']","['settings', 'set', 'turbo', 'on']","['settings', 'size', '640', '480']",'result.maxClones, 500'], 'VM options写舞台配置comment后重载fps/turbo/fencing/maxClones/highQuality与stageSize。')
    settingsmap={'settings.fps60':('fps','60'),'settings.custom-fps':('fps','45'),'settings.turbo':('turbo','on'),
                 'settings.high-quality-pen':('highQualityPen','on'),'settings.interpolation':('interpolation','on'),
                 'settings.infinite-clones':('maxClones','100000'),'settings.fencing':('fencing','off'),'settings.misc-limits':('miscLimits','off'),
                 'settings.warp-timer':('warpTimer','true'),'settings.compiler':('compiler','true'),'settings.stage-width':('width','640'),
                 'settings.stage-height':('height','480'),'mb.edit.turbo':('turbo','on'),'stage.run.greenflag-shift-click':('turbo','on'),
                 'mb.edit.fps60':('fps','60'),'stage.run.greenflag-alt-click':('fps','60'),'stage.run.greenflag-right-click':('fps','60'),
                 'mb.edit.username':('username','Alice'),'prompt.username.reset':('username','player')}
    for id,(key,value) in settingsmap.items():
        if id not in {a['id'] for a in ledger['actions']}:continue
        misses=[]
        if key=='maxClones':misses=['GUIInfinity vs当前finite≤100000限制，不能称无限克隆已实现。']
        if key=='fps' and id.endswith('custom-fps'):misses=['GUI可解析有限浮点/0 screen refresh；settings fps1..240/run整数不是同输入域。']
        if key in ['compiler','warpTimer']:misses+=['设置存session与actual运行控制对应，但GUI即时setCompilerOptions与storeProjectOptions覆盖需验证。']
        if key in ['fps','fencing','highQualityPen','width','height','turbo','maxClones']:
            misses+=['GUI高级设置本次改变不自动持久化，CLI settings set多数立即storeProjectOptions；默认持久化行为差异需对齐。']
        if key not in ['fps','turbo','fencing','maxClones','highQualityPen','width','height']:misses+=['此key具体运行/值/sb3作用尚无精确fixture，不能复用已测其它settings键。']
        one(id,['settings','set',key,value],[impl('settings-commands.js','const set =')],[settings_fixture] if key in ['fps','turbo','fencing','maxClones','highQualityPen','width','height'] else [],misses)
    one('settings.store-options',['settings','store'],[impl('settings-commands.js',"if (action === 'store')")],[settings_fixture],['单独store按钮对改动前后runtime配置comment与未保存情况的精确fixture。'])
    # Exact builtin load or data-only permissions. Deny-path tests never verify allowed operation.
    extfixture=T('extension-policy.test.js','pen/music load real native builtin opcodes and serialize no-block load through undo/redo/save/open',
                 ["for (const id of ['pen', 'music'])",'result.loaded, true','loadedExtensions.includes'], '真正加载pen/music opcode及unused extensions metadata、undo/redo/SB3。')
    for id in ['extension.load.pen','extension.load.music']:
        one(id,['ext','load',id.split('.')[-1]],[impl('extension-commands.js','const APPROVED'),impl('extension-commands.js','await vm.extensionManager.loadExtensionURL')],[extfixture],['music预览instrument具体音色对拍不由加载opcode代理。'] if id.endswith('music') else [])
    for a in ledger['actions']:
        id=a['id']
        if id.startswith('extension.load.') and id not in RECIPES:
            RECIPES[id]={'targetStatus':'verified-command','actualCli':[invocation(['ext','load',id.split('.')[-1]])],
                         'implementationEvidence':[impl('extension-commands.js','if (!APPROVED.has(item.id)')],
                         'tests':[],'requiredMissing':['此extension加载仍拒绝或不在APPROVED；拒绝测试不能证明加载GUI语义，FaceSensing URL须独立JS sandbox。'],
                         'semanticReason':'仅失败路径存在','supportedPart':None,'boundary':None,'rootFamily':None}
    doctest=T('extension-policy.test.js','freeze gallery/offline metadata, enumerate every builtin and render docs only as safe plain text',
              ['ext(s, \'doc\', [\'box2d\', file])',"assert.match(text, /Box2D/)",'doesNotMatch(text, /<script|<iframe/i)'], '冻结Box2D文档读为纯文本/输出file无DOM；不是任意页面可视化。')
    one('extension.docs',['ext','doc','box2d','/tmp/tw-acceptance/box2d.txt'],[impl('extension-commands.js',"if (action === 'doc')")],[doctest],['外链/文档窗口与纯文本输出差异需独立OS-shell/D6理由批准。'])
    ptest=T('extension-policy.test.js','unified frozen permission enumeration includes all D5 categories and records unsupported/default-deny reasons',
            ['const decision = await permit','decision.allowed, item.supported','if (!item.supported)'], '每capability默认deny及grant实际supported Boolean，unsupported不可upgrade允许动作。')
    perm_tokens={'fetch':'net:example.org','download':'write:/tmp/tw-acceptance/output.bin','embed':'embed:https://example.org/','read-clipboard':'clipboard-read',
                 'notify':'notifications','geolocate':'location','open-window':'open-window:https://example.org/','redirect':'redirect:https://example.org/',
                 'record-audio':'audio-input','record-video':'video-input','load-extension':'extension-execute'}
    for a in ledger['actions']:
        id=a['id'];m=re.fullmatch(r'permission\.([\w-]+)\.(allow|deny)',id)
        if not m or m[1] not in perm_tokens:continue
        token=perm_tokens[m[1]];cmd=['permission','check',token]+(['--allow',token] if m[2]=='allow' else [])
        misses=[]
        if m[2]=='allow':misses=['D5 permission check仅Boolean policy；对应实际capability执行需fixture；unsupported grant仍deny不等GUIallow。']
        one(id,cmd,[impl('extension-commands.js',"if (command === 'permission')")],[ptest],misses)
    # Paint: exact command arity and test feature anchors, but Paper GUI gaps remain pending explicitly.
    shape_fixture=T('paint-tools.test.js','bitmap primitives, flood mask, gradients, brush, eraser, text and color alpha alter real pixels',
                    ["paint(s,'rect'","paint(s,'ellipse'","paint(s,'line'","paint(s,'brush'","paint(s,'erase'","paint(s,'flood'"], '数值raw Canvas fixture真实pixels，非Paper绘图editor坐标/trim对拍。',partial=True)
    geom_fixture=T('paint-tools.test.js','vector multi-selection group/order/ungroup, world transforms and clipboard survive reload and undo/redo',
                   ["paint(s,'group'","paint(s,'ungroup'","direction:'forward'","direction:'backward'"], 'SVG同parent group与order/ungroup实际world bounds、clipboard/reload。',partial=True)
    style_fixture=T('paint-tools.test.js','vector style/alpha/HSV/gradient and swap change actual pixels; eraser performs path subtraction',
                    ["paint(s,'style'","paint(s,'gradient-swap'","paint(s,'erase'"], '显式nodes变色/HSV/horizontal gradient/alpha和fill几何erase实际像素。',partial=True)
    point_fixture=T('paint-tools.test.js','vector segment insertion preserves cubic curve geometry; IDs, handles and deletion are persistent',
                    ["paint(s,'point-add'","paint(s,'pointed'","paint(s,'curved'","paint(s,'point-set'","paint(s,'point-delete'"], 'Cubic split实际curve bounds、IDs、显式handles/删除重载。',partial=True)
    svg_gap='原Paper坐标placement/裁切/字体/栅格边缘与数值SVG fixture不自动等价，须对应GUI轨迹/oracle。'
    bitmap_gap='raw Canvas像素坐标/fixed clip/crop未实现GUI Paper2x workspace/trim导出与rotationCenter；必须对拍，不能limited精度豁免。'
    spec_shape={'brush':{'points':[[2,2],[10,10]],'size':4,'color':'#ff0000'},'erase':{'points':[[2,2],[10,10]],'size':4},
                'fill':{'x':3,'y':3,'color':'#00ff00'},'text':{'x':2,'y':18,'text':'A','fontSize':16,'color':'#123456'},
                'line':{'x1':2,'y1':2,'x2':20,'y2':20,'width':2,'color':'#123456'},
                'ellipse':{'x':2,'y':2,'width':10,'height':8,'color':'#123456'},'rectangle':{'x':2,'y':2,'width':10,'height':8,'color':'#123456'}}
    for fmt in ['vector','bitmap']:
        for action,specvalue in spec_shape.items():
            id='paint.'+fmt+'.'+action
            if id not in {a['id'] for a in ledger['actions']}:continue
            cmd=['paint','flood' if action=='fill' and fmt=='bitmap' else action,'0','--mode',fmt,'--spec',json.dumps(specvalue,separators=(',',':'))]
            if action=='fill' and fmt=='vector':cmd=['paint','style','0','--nodes','<node-id>','--fill','#00ff00']
            gap=bitmap_gap if fmt=='bitmap' else svg_gap
            if fmt=='vector' and action=='fill':gap='GUI fill按coordinate hit选择填充/描边及开闭path；当前--nodes style无Paper hitTest fill，未实现该具体能力。'
            if fmt=='vector' and action=='erase':gap='当前erase只filled geometry，无stroke/text/image/use subtraction；非GUI全工具erase。'
            if fmt=='vector' and action=='brush':gap='native outline生成刷path非Paper blob smoothing/union；同轨迹差分fixture缺失。'
            if action=='text':gap+=' font family metrics不是project fontManager添加/内联/重载。'
            one(id,cmd,[impl('paint-commands.js',"if(mode==='vector')") if "if(mode==='vector')" in read('tw-cli/src/paint-commands.js') else impl('paint-commands.js',"if(mode === 'vector')")], [shape_fixture] if fmt=='bitmap' else [style_fixture] if action in ['fill','erase'] else [], [gap])
    paint_actions={'costumes.paint-group':('group',[]),'costumes.paint-ungroup':('ungroup',[]),
                   'costumes.paint-bring-forward':('order',['--direction','forward']),'costumes.paint-send-backward':('order',['--direction','backward']),
                   'costumes.paint-bring-to-front':('order',['--direction','front']),'costumes.paint-send-to-back':('order',['--direction','back']),
                   'costumes.paint-flip-horizontal':('flip-x',[]),'costumes.paint-flip-vertical':('flip-y',[]),
                   'costumes.paint-paste':('paste',['--from','/tmp/tw-acceptance/clip.json','--dx','10','--dy','10']),
                   'costumes.paint-copy':('copy',['--nodes','<node-id>','--output','/tmp/tw-acceptance/clip.json']),
                   'costumes.paint-cut':('cut',['--nodes','<node-id>','--output','/tmp/tw-acceptance/clip.json'])}
    for id,(action,args) in paint_actions.items():
        gap=[]
        if action=='group':gap=['group同parent限制；GUI可跨parent选区group语义未实现，不是D6DOM豁免。']
        if action=='ungroup':gap=['composited opacity/clip group ungroup当前拒绝，不能拿简单group测试代理完整GUI。']
        if action in ['flip-x','flip-y']:gap=[svg_gap,bitmap_gap]
        if action=='paste':gap=['GUI clipboard类型/rasterization及pasteOffset自动累计状态与跨造型format差异待fixture。']
        ts=[paint_clip_test] if action in ['copy','cut','paste'] else [geom_fixture]
        one(id,['paint',action,'0']+args,[impl('paint-commands.js','const execute=')],ts,gap)
    colorids={'costumes.paint-fill-color':['--fill','#123456'],'costumes.paint-stroke-color':['--stroke','#123456'],
              'costumes.paint-stroke-width':['--stroke-width','3'],'paint.color.hue':['--hue','33.333333333'],
              'paint.color.saturation':['--saturation','50'],'paint.color.brightness':['--brightness','75'],
              'paint.color.alpha':['--alpha','0.5'],'paint.color.transparent':['--fill','none'],
              'paint.color.solid':['--fill','#ff0000'],'paint.color.swap':[]}
    for id,args in colorids.items():
        action='gradient-swap' if id.endswith('swap') else 'style'
        one(id,['paint',action,'0','--nodes','<node-id>']+args,[impl('vector-editor.js','const applyStyle =') if 'const applyStyle =' in read('tw-cli/src/vector-editor.js') else impl('vector-editor.js','applyStyle =')],[style_fixture],['选中图形style存在，但GUI从none到描边自动补width/color、HSV百分比/alpha0/null与color-panelclose单undo的精确fixture需对应。'])
    for typ in ['horizontal','vertical','radial']:
        one('paint.color.gradient-'+typ,['paint','style','0','--nodes','<node-id>','--gradient',json.dumps({'type':typ,'stops':[{'offset':0,'color':'#ff0000'},{'offset':1,'color':'#0000ff'}]},separators=(',',':'))],
            [impl('vector-editor.js','gradientSpec')],[style_fixture],['此'+typ+'渐变PaperobjectBounds/继承stroke/null-color/关闭面板资产oracle未全部验证。'])
    for id,action in [('costumes.paint-curve-points','curved'),('costumes.paint-point-points','pointed'),('paint.reshape.insert-point','point-add'),('paint.selection.reshape-point','point-set'),('paint.selection.reshape-handle','point-set'),('paint.reshape.delete-segments','point-delete'),('paint.reshape.doubleclick-remove-point','point-delete')]:
        cmd=['paint',action,'0','--path','<path-id>','--segments','<segment-id>']
        if action=='point-add':cmd+=['--after','<segment-id>','--t','0.5']
        if action=='point-set':cmd+=['--spec','{"x":10,"y":20,"handleIn":[-5,-2],"handleOut":[5,2]}']
        if id.endswith('doubleclick-remove-point') and 'double-click' in REGISTRY['paint']['actions']['point-delete']['options']:cmd+=['--double-click']
        one(id,cmd,[impl('vector-editor.js','const editPoints =')],[point_fixture],['Paper路径句柄移动时共线/Alt split/前后curve调整的此子语义需要更精确fixture，不用统一point test全覆盖。'])
    one('costumes.paint-eye-dropper',['paint','sample','0','10','10','--apply','fill','--to-costume','1','--nodes','<node-id>'] if 'apply' in REGISTRY['paint']['actions']['sample']['options'] else ['paint','sample','0','10','10'],
        [impl('paint-commands.js',"sample")],[paint_clip_test],['vector采样/native颜色平均与paint采样→onChangeColor选择图形、alpha/null值完整GUIfixture还需精确对拍。'])
    for id in ['costumes.paint-brush-size','costumes.paint-eraser-size','costumes.paint-shape-thickness','paint.bitmap.shape-filled','paint.bitmap.shape-outlined']:
        one(id,['paint','defaults','--spec','{"brush":4,"eraser":6,"thickness":2,"filled":false}','--output','/tmp/tw-acceptance/paint-defaults.json'],
            [impl('paint-commands.js',"if(action==='defaults')")],[],['defaults仅保存显式文件，后续绘制必须传值；GUI立即参数变化与已有shape实时style需对应fixture。'])
    # Exact ten selected sound effects have parameterized frozen graph test names, not generic test count.
    for suffix,effect in [('faster','faster'),('slower','slower'),('louder','louder'),('softer','softer'),('mute','mute'),('fadeIn','fade-in'),('fadeOut','fade-out'),('reverse','reverse'),('robot','robot'),('echo','echo')]:
        name=f'selected {effect}: numeric PCM differential against frozen GUI graph and undo/redo/SB3'
        one('sounds.effect.'+suffix,['asset','effect','sound','0',effect,'--range','0.2,0.7','--units','fraction'],
            [impl('asset-commands.js',"if(action==='effect')"),impl('audio-editor.js','const effects =')],
            [T('asset-tools.test.js',name,['const expected=await frozenEffect','closeSamples(current.buffer.getChannelData(0)','await s.execute([\'asset\',\'undo\'])'], '具体'+effect+'真实PCM与冻结GUI graph相同nativecontext差分/reload/mono，并非Chromium DSP oracle。',parameter={'effect':effect})],
            ['同native OfflineAudioContext graph是适配差分不是真实Chromium音频对拍；'+('GUI tooLoud RMS禁用和边缘指数ramp需按实际选择检查。' if effect=='louder' else '自动试听输出另动作，不自动算设备播放。')])
    soundcmds={'sounds.editor.copy':['asset','copy','sound','0','--range','5,12','--units','samples','--output','/tmp/tw-acceptance/clip.wav'],
               'sounds.editor.paste':['asset','paste','sound','0','--from','/tmp/tw-acceptance/clip.wav','--range','3,8','--units','samples'],
               'sounds.editor.copyToNew':['asset','copy-to-new','sound','0','--range','5,12','--units','samples'],
               'sounds.editor.deleteSelection':['asset','delete-range','sound','0','--range','5,12','--units','samples'],
               'sounds.editor.keepSelection':['asset','keep-range','sound','0','--range','5,12','--units','samples']}
    for id,cmd in soundcmds.items():
        one(id,cmd,[impl('audio-editor.js','const edit =')],[sound_copy_test])
    for id in ['sounds.editor.play','sounds.record.playback.play','sounds.library.preview']:
        one(id,['asset','render','sound','0','/tmp/tw-acceptance/preview.wav','--range','0.2,0.7','--units','fraction'],
            [impl('audio-editor.js',"render")],[sound_copy_test],['设备扬声器试听未实现；D1是输出授权，不是自动允许verified-limited，需用户此动作输出降级审结。'],
            target='verified-command',supported='仅样本/范围WAV离线输出，不是实时播放。')
    # Addon settings persistence only proves stored configuration. For semantic addons activation is missing.
    configtest=T('addon-config.test.js','all81 enabled state and148 settings persist across processes in an explicit config; reset/presets validated',
                 ['for (const frozen of inventory.addons)',"['addon', 'enabled'","['addon', 'setting'","['addon', 'reset-setting'","['addon', 'presets'"],
                 '按全部81 manifest/148 setting/13 preset真实值跨进程持久化、每字段reset断言；仅configuration不执行userscript。')
    inventory_by={a['id']:a for a in inventory['addons']}
    for a in ledger['actions']:
        id=a['id'];m=re.fullmatch(r'addon\.([^.]+)\.(enabled|reset|reset-settings|setting\.([^\.]+)|reset-setting\.([^\.]+)|preset\.([^\.]+))',id)
        if not m or id in RECIPES:continue
        aid,kind=m[1],m[2];entry=inventory_by[aid];config='/tmp/tw-acceptance/addons.json'
        if kind=='enabled':cmd=['addon','enabled',aid,'true','--config',config]
        elif kind in ['reset','reset-settings']:cmd=['addon','reset',aid,'--config',config]
        elif kind.startswith('setting.'):
            st=next(s for s in entry['settings'] if s['id']==m[3]);v=st['default'];text=str(v).lower() if isinstance(v,bool) else str(v);cmd=['addon','setting',aid,m[3],text,'--config',config]
        elif kind.startswith('reset-setting.'):cmd=['addon','reset-setting',aid,m[4],'--config',config]
        else:cmd=['addon','preset',aid,m[5],'--config',config]
        target='verified-not-applicable' if entry['disposition']=='not-applicable' else 'dom-only' if entry['disposition']=='dom-only' else 'verified-command'
        misses=['独立逐动作结论尚未批准此setting pure-visual/OSshell排除。'] if target=='verified-not-applicable' else ['配置值保存不会自动启用userscript或后续运行/绘制行为；需此setting实际应用语义实现及fixture。'] if target=='verified-command' else []
        one(id,cmd,[impl('addon-commands.js','const configuration ='),impl('addon-commands.js','const configResult =')],[{**configtest,'parameterScope':{'addonId':aid,'operation':kind}}],misses,
            target=target,reason=entry['reason'],supported='显式JSON配置持久化，不改变GUI/runtime直到显式语义命令。')
    # Explicit semantic addon operations use their actual plural/asset settings, not aliases by rootfamily.
    addon_test=T('addon-config.test.js','pending devtools replaces references, cleans unused locals/orphans only with flags, copy/cut/paste and undo',
                 ["['addon', 'replace-variable'","['addon', 'cleanup-plus'","['addon', 'copy-single'","['addon', 'cut-single'","['addon', 'paste-at'"], 'devtools replace refs、显式clean delete flags、copy/cut/paste后的实际块/值与undo。')
    addonmap={'addon.editor-devtools.replace-variable':['addon','replace-variable','<old-id>','<new-id>'],
              'addon.editor-devtools.copy-single':['addon','copy-single','<block-id>','--output','/tmp/tw-acceptance/block.json'],
              'addon.editor-devtools.cut-single':['addon','cut-single','<block-id>'],
              'addon.editor-devtools.paste-at-mouse':['addon','paste-at','/tmp/tw-acceptance/block.json','--at','100,200'],
              'addon.editor-devtools.clean-up-plus':['addon','cleanup-plus','--delete-orphans','--delete-unused'],
              'addon.editor-devtools.make-space':['addon','cleanup-plus','--make-space','<block-root-id>'],
              'addon.editor-devtools.copy-all':['addon','copy-all','--output','/tmp/tw-acceptance/all-blocks.json'],
              'addon.block-switching.switch':['addon','switch','<id>','motion_changeyby'],
              'addon.block-duplicate.duplicate-stack':['blocks','duplicate','<id>','--mode','stack'],
              'addon.block-duplicate.duplicate-single':['blocks','duplicate','<id>','--mode','single'],
              'addon.block-cherry-picking.detach-single':['blocks','disconnect','<id>','--single','--heal'],
              'addon.reorder-custom-inputs.move-left':['blocks','procedure-edit','walk','--params','[{"name":"b","type":"number"},{"name":"a","type":"number"}]'],
              'addon.reorder-custom-inputs.move-right':['blocks','procedure-edit','walk','--params','[{"name":"b","type":"number"},{"name":"a","type":"number"}]'],
              'addon.variable-manager.set-variable':['addon','set-variable','<variable-id>','hello'],
              'addon.variable-manager.set-list':['addon','set-list','<list-id>','a\nb\n'],
              'addon.variable-manager.rename':['addon','rename-variable','<variable-id>','renamed'],
              'addon.variable-manager.search':['addon','variables','query'],
              'addon.swap-local-global.scope':['addon','swap-scope','<variable-id>','global'],
              'addon.swap-local-global.cloud':['addon','swap-scope','<variable-id>','global','--cloud','true'],
              'addon.rename-broadcasts.rename':['addon','rename-broadcast','<broadcast-id>','NEW'],
              'addon.find-bar.find':['addon','find','query','--kind','all'],
              'addon.initialise-sprite-position.new-position':['addon','initial-sprite','--x','12','--y','-15'],
              'addon.move-to-top-layer.front':['addon','move-layer','front'],
              'addon.block-count.read':['blocks','count'],
              'addon.mouse-pos.read':['runtime','status'],
              'addon.clones.read':['runtime','clones'],
              'addon.color-picker.hex-field':['blocks','set-field','<id>','COLOUR','#123456'],
              'addon.paint-skew.shear':['paint','skew','0','45','0','--nodes','<id>']}
    for id,cmd in addonmap.items():
        if id not in {a['id'] for a in ledger['actions']}:continue
        ev=[impl('addon-commands.js','const execute =')] if cmd[0]=='addon' else [impl('block-commands.js','const execute =')] if cmd[0]=='blocks' else [impl('runtime-commands.js','const execute =')] if cmd[0]=='runtime' else [impl('paint-commands.js','const execute=')]
        ts=[addon_test] if '.editor-devtools.' in id and id.split('.')[-1] in ['replace-variable','copy-single','cut-single','paste-at-mouse','clean-up-plus'] else [graph_test] if 'detach-single' in id else [copy_test] if 'block-duplicate' in id else [field_test] if id.endswith('hex-field') else []
        misses=[]
        if id.endswith(('clean-up-plus','make-space')):misses=['height估计/column x48 y64与GUI Blockly实际bbox/pixel layout不同，deleteflags之外仍需精确布局。']
        elif id.endswith('new-position'):misses=['实际只作用当前sprite，不自动patch之后新增/复制位置、randomization/truthiness默认分支。']
        elif id.endswith('cloud'):misses=['swap cloud转换值/☁名字/monitor/provider与invalid冲突的精确fixture，不可用scalar scope测试代替。']
        elif not ts:misses=['此具体语义无精确fixture/断言，不能拿addon.commands equivalenceindex当验收。']
        one(id,cmd,ev,ts,misses)
    # Packager config leaves have per-leaf roundtrip tests; output behavior is a separate required proof.
    packtest=T('package-options.test.js','every default leaf supports strict set/get, nested config, export/import and reset',
               ['for (const key of pack.OPTION_KEYS)',"run(s, 'set', [key, JSON.stringify(value)]",'value, value, key'], '每真实默认leaf类型和值set/get/reset/config export/import；仅configroundtrip。')
    imagepacktest=T('package-options.test.js','icon/cursor/loadingScreen use safe Packager.Image files, never URL/prototype/data payloads',
                    ["['app.icon', 'cursor.custom', 'loadingScreen.image']",'result.images.length, 3','pngSHA256'], '三个图片选项真实PNG解码/包内dataURI/hash，没有GUI/桌面启动。')
    val_for={'framerate':'60','stageWidth':'640','stageHeight':'480','maxClones':'500','maxTextureDimension':'4096',
             'username':'player','projectId':'12345','target':'html','resizeMode':'stretch','cursor.type':'custom','cursor.center.x':'4','cursor.center.y':'4',
             'app.windowTitle':'example','app.packageName':'example','app.version':'1.2.3','app.windowMode':'window','app.windowControls':'frameless','app.escapeBehavior':'nothing',
             'steamworks.appId':'480','steamworks.onError':'warning','cloudVariables.mode':'local','cloudVariables.cloudHost':'',
             'cloudVariables.custom':'{"score":"local"}','custom.css':'body {opacity:0.9}','custom.js':'globalThis.marker=1;',
             'appearance.background':'#123456','appearance.foreground':'#123456','appearance.accent':'#123456','monitors.listColor':'#123456','monitors.variableColor':'#123456',
             'loadingScreen.text':'Loading','loadingScreen.imageMode':'normal','extensions':'[]'}
    for a in ledger['actions']:
        id=a['id']
        if not id.startswith('package.option.'):continue
        key=id[len('package.option.'):];v=val_for.get(key,'true')
        if key in ['app.icon','cursor.custom','loadingScreen.image']:v='/tmp/tw-acceptance/icon.png'
        cmd=['pack','set',key,v]
        grants={'custom.css':'custom-css','custom.js':'custom-js','chunks.gamepad':'gamepad','chunks.pointerlock':'pointerlock','cloudVariables.unsafeCloudBehaviors':'unsafe-cloud'}
        if key in grants:cmd+=['--allow',grants[key]]
        ts=[imagepacktest] if key in ['app.icon','cursor.custom','loadingScreen.image'] else [{**packtest,'parameterScope':{'optionPath':key,'defaultOnly':True}}]
        one(id,cmd,[impl('package-commands.js','const validateLeaf ='),impl('package-commands.js',"action === 'set'")],ts,
            ['本leaf变更而非default roundtrip产生的输出副作用fixture必须明确；不可按58路径/optioncount整体升级。'+('全desktop target真实官方bytes/平台运行未验收。' if key=='target' or key.startswith(('app.','steamworks.')) else '')])
    for id,action,args in [('package.export-options','export',['/tmp/tw-acceptance/pack.json']),('package.import-options','import',['/tmp/tw-acceptance/pack.json']),('package.reset-options','reset',[])]:
        one(id,['pack',action]+args,[impl('package-commands.js',"if (action === '"+action+"')") if action in ['reset','export'] else impl('package-commands.js',"action === 'import'")],[packtest],['GUIdanger confirm/blob独立state与安全默认local cloud差异需对应审结。'])
    for a in ledger['actions']:
        if a['id'].startswith('package.reset.'):
            one(a['id'],['pack','reset',a['resetKeys'][0]],[impl('package-commands.js',"if (action === 'reset')")],[packtest],
                ['GUI此局部Reset必须一次重置'+','.join(a['resetKeys'])+'并清对应BlobState；单leaf reset不等完整分组动作。'])
    buildtest=T('package-options.test.js','real html: offline output, parsing, asset bytes+MD5+SHA256, local cloud and safe titles',
                ["run(s, 'build'",'result.launched, false','setFramerate\\(60\\)','warpTimer: true'], 'HTML真实assets/checksum/title/localcloud/fps60/warpTimer输出，不执行runtime。')
    for id in ['package.build','mb.file.package']:
        one(id,['pack','build','/tmp/tw-acceptance/output.html'],[impl('package-commands.js','const build =')],[buildtest],['HTML/ZIP子集fixture不能证明全部官方桌面targets/JS行为/平台播放，无headless green代理。'])
    one('package.preview',['pack','preview','/tmp/tw-acceptance/preview.html'],[impl('package-commands.js',"if (args[0] === 'preview')")],[],['GUI实际打开PackagerPreview窗口并执行runtime；CLI只生成HTML launched=false，OSshell展示差异须独立审，不直接limited。'])


def final_candidates(ledger, inventory):
    by_id={a['id']:a for a in ledger['actions']}
    def impl(file,needle,after=12):return source('tw-cli/src/'+file,needle,after=after)
    def tt(file,name,anchors,semantic,partial=False):return testref(file,name,anchors,semantic,partial=partial)
    def addrecipe(id,cmd,ev,tests=(),missing=(),**kwargs):
        if id not in RECIPES and id in by_id:recipe(id,[cmd],ev,list(tests),list(missing),**kwargs)
    # Latest dedicated addon tests prove exact operations, not the equivalence index itself.
    addon_t={'scope':tt('addon-config.test.js','pending swap-local-global keeps values, IDs, references and monitor state; refuses unsafe cross-target/local/cloud conversion',
                        ["['addon', 'swap-scope'",'getMonitorState().get(monitor.id).targetId, null','/other targets/'], 'scalar global/local保留ID/value/monitor与cross-target拒绝；cloud允许转换尚无本fixture。'),
             'var':tt('addon-config.test.js','variable manager newline list/scalar edits and rename preserve all references and are rollback-safe',
                      ["['addon', 'set-variable'","['addon', 'set-list'","['addon', 'rename-variable'", "['a', 'b', '']"], 'newline列表保留尾空项、scalar/string值和rename引用、reload实际数据。'),
             'broadcast':tt('addon-config.test.js','broadcast rename/merge updates ID+name on every target and survives real SB3 reload execution and undo',
                            ["['addon', 'rename-broadcast'",'BROADCAST_OPTION.id, destination.id','result.variables' if 'result.variables' in read('tw-cli/test/addon-config.test.js') else 'merge.merged, true'], 'broadcast rename与同名merge跨target引用和值与reload运行。'),
             'snap':tt('addon-config.test.js','pending paint-snap delegates reviewed move/scale with config threshold and persists SVG through SB3 reload',
                       ["['addon', 'snap-move'","['addon', 'snap-scale'",'asset.decodeText(), finalSVG'], '显式config派发后SVG变形/reload，非Paper2x placement精度oracle。',True),
             'count':tt('addon-config.test.js','equivalence index records concrete commands for counts/find/rename/position/layer/variables and all pending4',
                        ["['addon', 'block-count']","['addon', 'find'","['addon', 'initial-sprite'","['addon', 'move-layer'"], '具体count/find/selectedsprite位置/layer断言，index.commands长度本身不作证。')}
    for id,key in [('addon.swap-local-global.scope','scope'),('addon.variable-manager.set-variable','var'),('addon.variable-manager.set-list','var'),('addon.variable-manager.rename','var'),('addon.variable-manager.search','var'),('addon.rename-broadcasts.rename','broadcast'),('addon.block-count.read','count'),('addon.find-bar.find','count'),('addon.initialise-sprite-position.new-position','count'),('addon.move-to-top-layer.front','count')]:
        if id in RECIPES:
            RECIPES[id]['tests'].append(addon_t[key])
            RECIPES[id]['requiredMissing']=[x for x in RECIPES[id]['requiredMissing'] if '无精确fixture' not in x]
    for id,action,args in [('addon.paint-snap.snap-move','snap-move',['0','moving','41','0']),('addon.paint-snap.snap-scale','snap-scale',['0','moving','1.9','1'])]:
        addrecipe(id,['addon',action]+args+['--config','/tmp/tw-acceptance/addons.json'],[impl('addon-commands.js',"if (action === 'snap-move' || action === 'snap-scale')")],[addon_t['snap']],
                  ['assetviewBox几何/threshold不是Paper2x canvas placement坐标；unsupported geometry refuse、guide/popover旧bug兼容未验收。'])
    target_test=tt('targets.test.js','sprite-pane order, folders, draggable property and layer order remain distinct',
                   ["['targets', 'reorder'","['targets', 'folder-add'","['targets', 'folder-rename'","['targets', 'folder-remove-all'",'originalLayers'], 'sprite-pane order与layer区分、prefix folder改名/引用、reload稳定ID。')
    for id,cmd in [('sprites.drag-reorder',['targets','reorder','Other','0']),('sprites.folder.create',['targets','folder-create','Friends','--target','Sprite1']),
                   ('sprites.folder.add-to',['targets','folder-add','Friends','--target','Sprite1']),('sprites.folder.remove-from',['targets','folder-remove','--target','Sprite1']),
                   ('sprites.folder.rename',['targets','folder-rename','Friends','Team']),('sprites.folder.remove',['targets','folder-remove-all','Team'])]:
        addrecipe(id,cmd,[impl('target-commands.js','const execute =')],[target_test],
                  ['frozen folders ensureNotReserved、fixTargetOrder/全分组排序与rename引用需要精确fixture，基础prefix操作不代理全部folder。'] if '.folder.' in id else [])
    prop_tests=tt('commands.test.js','commands create/save/reopen, preserve layers/assets, undo/redo and rollback',
                  ["['sprite', 'set', 'x', '42']","['sprite', 'rename'","['sprite', 'front'",'targets[1].x, 42'], 'x/rename/layer/持久化；其它可见属性尚无fixture代理。',True)
    for id,key,value in [('sprites.info.name','rename','renamed'),('sprites.info.x','x','42'),('sprites.info.y','y','23'),
                         ('sprites.info.size','size','120'),('sprites.info.direction','direction','45'),('sprites.info.dial','direction','45'),
                         ('sprites.info.show','visible','true'),('sprites.info.hide','visible','false'),('sprites.info.rotation.all-around','rotationStyle','all around'),
                         ('sprites.info.rotation.left-right','rotationStyle','left-right'),('sprites.info.rotation.dont-rotate','rotationStyle',"don't rotate")]:
        cmd=['sprite','rename',value] if key=='rename' else ['sprite','set',key,value]
        addrecipe(id,cmd,[impl('commands.js','async sprite(args')],[prop_tests] if key in ['rename','x'] else [],
                  [] if key=='x' else ['此可见属性bounds/fencing/name引用或旋转样式具体fixture缺失。'])
    select_test=tt('commands.test.js','stable target IDs disambiguate names and selection survives rollback and undo/redo',
                   ["request('sprite', 'select', 'stage')",'result.selected, \'Stage\'','result.selected, \'Renamed\''], '指定target UUID/stage选择，执行与rollback/undo选择保持。')
    for id,name in [('sprites.select','Sprite1'),('sprites.stage-select','stage'),('stage.dblclick.select-target','Sprite1')]:
        addrecipe(id,['sprite','select',name],[impl('commands.js',"if (action === 'select')")],[select_test],reason='选择下一编辑命令目标；舞台双击pick需要先显式提供target，不把视觉命中作为已实现。')
    for id in ['sprites.contextmenu.delete','sprites.delete.button']:
        addrecipe(id,['sprite','delete','--target','Sprite1'],[impl('commands.js',"else if (action === 'delete') vm.deleteSprite")],[],['deleteSprite实际API存在，但GUI删除快照Restore登记、clone/monitor清理及后续editingTarget fixture需补。'])
    addrecipe('sprites.contextmenu.duplicate',['sprite','duplicate','--target','Sprite1'],[impl('commands.js',"else if (action === 'duplicate')")],[],['当前export/addSprite克隆，GUIduplicateSprite goBehindOther/克隆角色名与层位置需fixture核对。'])
    addrecipe('sprites.contextmenu.export',['project','export-sprite','/tmp/tw-acceptance/sprite.sprite3','--target','Sprite1'],[impl('project-io-commands.js',"if (action === 'export-sprite')")],
              [tt('project-io.test.js','sprite3 export/import writes positional/output paths, exact assets and graph; main transaction provides undo', ["['export-sprite']",'sprite.name, target.getName()','asset.md5'], '真实sprite3 sprite.json/资产/图连接字节导出，maintarget明确。')])
    # Runtime info reads are not log exporters, reporter clipboard or performance graph implementations.
    for id,cmd,needle in [('addon.debugger.threads',['runtime','status'],"if (['pause', 'resume', 'status', 'clones'].includes(name))"),
                         ('addon.mouse-pos.read',['runtime','status'],"if (['pause', 'resume', 'status', 'clones'].includes(name))"),
                         ('addon.clones.read',['runtime','clones'],"if (['pause', 'resume', 'status', 'clones'].includes(name))")]:
        if id not in RECIPES:addrecipe(id,cmd,[impl('runtime-commands.js',needle)],[],['必须测试此specific字段信息而非runtime status对象存在；clone测试可按主fixture补充。'])
    # D7 pre-recorded video/loudness/frame fixtures, no scope creep to BLE,JS,geometry or project recorder audio.
    mediatest=tt('device-adapters.test.js','video frames reach frozen optical flow and real reporter, mirror/resize and no polling',
                 ['ioDevices.video.getFrame','motion, reference.motionAmount','mirror: true'], '预录帧实际触发frozen video sensing光流与reporter，非摄像头。')
    loudtest=tt('device-adapters.test.js','fixed/PCM/WAV loudness reaches actual sensing reporter and hat, not live microphone',
                ['loudness','sensing_loudness'], '固定/PCM/WAV注入真实sensing loudness与hat，非录音声音资产create。')
    for id in ['extension.load.videoSensing']:
        if id in RECIPES:
            RECIPES[id]['tests']=[mediatest]
            RECIPES[id]['requiredMissing']=['视频builtin安全工厂实际支持与ext load当前白名单必须对应；预录帧加载source/setup/精确CLI集成需要mainfixture，不能用camera拒绝代理。']
            RECIPES[id]['boundary']={'decision':'D7','reason':'实时摄像头不支持；仅预录帧管道。'}
            RECIPES[id]['supportedPart']='device video-frame/replay达真实videoSensing光流；不是FaceSensing JS执行。'
            RECIPES[id]['targetStatus']='verified-limited'
    for id in ['sounds.add.record','sounds.record.start','sounds.record.stop','sounds.record.save']:
        addrecipe(id,['sound','add','/tmp/tw-acceptance/recorded.wav'],[impl('commands.js','async sound(args')],[loudtest],
                  ['预录wav进入project声音与GUIrecording自动RMS trim/name/channel/rate保存pipeline需要精确fixture；loudness sensing不代理record asset save。'],
                  target='verified-limited',boundary={'decision':'D7','reason':'只实时麦克风采集不承诺；预录素材允许。'},supported='WAV导入pipeline；尚未验证recording auto-trim等支持部分。')
    # Fill specialized command references for clear concrete gaps (not implementation claims).
    concrete={
        'mb.title-input':'项目标题编辑影响另存文件名/100字符;目前无title命令及session project-title字段。',
        'mb.edit.restore':'最近一次删除sprite/costume/sound的restoreFun槽位与特定对象恢复；global undo不是同槽位。',
        'settings.infinite-clones':'设置maxClones Infinity；finite100000上限不可代理。',
        'code-ws.extension-button':'任意加载扩展registerButtonCallback payload/callback执行；ext目录/列表命令不能代理。',
        'code-ws.execute-stack':'点击特定script/reporterruntime toggleScript并reportValue，runtime greenflag start不指定script。',
        'extension.custom-load-file':'从本地JS加载并安全执行：当前ext load-file明确failclosed拒绝，即使allow仍拒。',
        'extension.custom-load-text':'文本JS在sandbox/unsandboxed模式安全执行，不可用data-only JSON导入代替。',
        'extension.custom-load-url':'下载并执行URL JS /sequential loader；permission net批准或offline目录不等执行。',
        'extension.enable-returns':'过程return积木启用及完整return opcode/editor/runtime持久化，--type只改变mutation不启用return集合。',
        'stage.drag.sprite':'startDrag/goToFront→脚本XY抑制→stage内落点commit→stopDrag/editor target；set x/y不代理drag lifecycle。',
        'stage.drag.sprite-editor-canvas':'拖影瞬间visible=false可被脚本观察，再恢复/越界不commit位置；仅最终sprite set不等价。',
        'paint.font.add-file':'自定义字体文件作为project fontManager资产加入/导出内联/SB3重载，不是text --font family。',
        'paint.font.add-system':'fontManager system-font name/fallback登记与缺字跨机行为，不是现有Canvas font string。',
        'paint.font.delete':'删除project字体清单并影响renderer fontinline，非删除text node。',
        'paint.font.export':'导出project custom fontManager原始字节format，asset export costume不代理字体。',
        'project-io.restore-interval':'GUI自动timer/PROJECT_CHANGED/interval<0关闭/重新安排/TYPE_AUTOMATIC快照，不是manual restore-save。',
        'project-io.restore-delete':'删除具体快照和孤立资产库、不可撤销确认；FileStore list/read无delete spec。',
        'project-io.restore-delete-all':'删除全部restore数据库及项目/资产/thumbnail集合，不能仅操作一个snapshot。',
        'addon.mediarecorder.option.project-audio':'audioEngine主输出混入视频轨道及完整音画同步；device loudness/WAV单音轨不是project mix recorder。',
        'addon.mediarecorder.option.delay':'录制delay整数每975ms/小数补偿后Recorder.start时序，离线frame单独输出不含此分支。',
        'addon.tw-disable-vibration.navigator-vibrate':'navigator.vibrate返回false与原API恢复，尚缺vibration拒绝返回值fixture。',
        'addon.tw-disable-vibration.gamepad-pulse':'haptic pulse Promise(false)具体observable返回而非genericpermissiondeny。',
        'addon.tw-disable-vibration.gamepad-play-effect':'haptic playEffect Promise(preempted)具体observable返回而非camera拒绝。',
        'addon.gamepad.open':'进入mappingeditor updateAllContent时store=true条件写stage magic comment；show只readonly，缺open副作用fixture。',
        'package.project-id':'SelectProject Scratch metadata/token→加载到packinput；pack build --project本地字节不实现远程id。',
        'package.project-url':'SelectProject URL请求/取消/import进度；当前pack build读取open project，本地input不同。',
        'package.cursor-auto-center':'读取实际cursor image尺寸Math.round(width/2,height/2)而非用户手写x/y；需精确命令及fixture。'
    }
    for id,need in concrete.items():
        if id in RECIPES:RECIPES[id]['requiredMissing'].append(need)
        elif id in by_id:RECIPES[id]={'targetStatus':'verified-command','actualCli':[],'implementationEvidence':[],'tests':[],
                                    'requiredMissing':[need],'semanticReason':'具体动作缺口，不能rootfamily代替。','supportedPart':None,'boundary':None,'rootFamily':None}
    # Focused read of newly landed modules: candidate only, never retroactive green.
    def replace(id,cmd,ev,ts,misses=(),**kwargs):
        if id not in by_id:return
        RECIPES.pop(id,None);recipe(id,[cmd],ev,ts,list(misses),**kwargs)
    if 'font' in REGISTRY:
        fontfixture=tt('fonts.test.js','custom font command serializes exact real SB3 assets/ID and reload registers before SVG hydration',
                       ["['font', 'from-file'",'json.customFonts',"['font', 'export'", "['font', 'delete'"], '真实WOFF2字体资产md5/customFonts/frame像素、reload前注册、export exactbytes、delete+undo字体恢复。')
        replace('paint.font.add-file',['font','from-file','My Pixel','/tmp/tw-acceptance/font.woff2','--fallback','sans-serif'],[impl('font-commands.js','manager.addCustomFont')],[fontfixture],
                ['当前WOFF2真实fixture；GUI文件输入ttf/otf/woff/woff2 allformat、fallback/name字段UI提交和资产inline链仍需逐format验证。'])
        replace('paint.font.export',['font','export','My Pixel','--output','/tmp/tw-acceptance/export.woff2'],[impl('font-commands.js',"if (action === 'export')")],[fontfixture])
        replace('paint.font.delete',['font','delete','My Pixel'],[impl('font-commands.js',"if (action === 'delete')")],[fontfixture])
        replace('paint.font.add-system',['font','system','Portable Unknown','--fallback','serif'],[impl('font-commands.js',"if (action === 'system')")],
                [tt('fonts.test.js','system font metadata, load/reset and explicit PNG output follow module transaction/option semantics',["['font', 'system'",'portableSystemAccess, false','fontManager.fonts.length, 2'], '系统fontManager元数据实际保存/reload；native fallback不同于发现host system字体。')],
                ['GUIsystemfont可调用实际host family;当前metadataonly/fallback渲染，不能用跨机精度limited豁免，需独立OS字体边界。'])
    if 'record' in REGISTRY:
        recordfixture=tt('recording.test.js','waitflag/delay/stopOnStop/endstop semantics use clock frames, not wall sleeps or exhausted threads',
                         ['d.timing.durationIncludesDelay, true','stopped.stopReason, \'PROJECT_STOP_ALL\'','i.options.stopOnStop, false'], 'duration含delay、waitflag/stop event禁用/连续空脚本不stop，实际离屏帧manifest。')
        for suffix,key,value in [('duration','duration','0.6'),('delay','delay','0.2'),('wait-flag','waitflag','true'),('end-stop','stopOnStop','true')]:
            args=['record','start','/tmp/tw-acceptance/record-'+suffix,'--duration','0.6','--fps','10']
            if key=='duration':args=['record','start','/tmp/tw-acceptance/record-duration','--duration',value,'--fps','10']
            else:args+=['--'+key,value]
            replace('addon.mediarecorder.option.'+suffix,args,[impl('record-commands.js','const configFor ='),impl('record-commands.js','const execute =')],[recordfixture],
                    ['真实native clockframe候选非GUI MediaRecorder wall975ms延迟/录制开始事件精确对拍；第二轮独审仍pending，不将编码/wholeproject音轨当已覆盖。'])
        replace('addon.mediarecorder.option.project-audio',['record','start','/tmp/tw-acceptance/projectaudio','--projectaudio','true'],[impl('record-commands.js','supported: false')],
                [tt('recording.test.js','projectaudio gaps/unsupported formats/no overlap fail closed, never produce success silent fallback or capture OS mic',["['--projectaudio', 'true']",'/NOT_YET_SUPPORTED|requires|900-frame/'], 'projectaudio明确拒绝，无成功silentfallback；只能证明失败安全而非项目音轨混合。',True)],
                ['整个VM sound调度、pitch/pan/loops/clock与framecapture同步仍NOT_YET_SUPPORTED；这是实现缺失非D7/D6limited。'])
        replace('addon.mediarecorder.option.mic-mix',['record','start','/tmp/tw-acceptance/mixed','--duration','0.8','--delay','0.2','--fps','10','--microphonemix','true','--mic-track','/tmp/tw-acceptance/mic.wav'],
                [impl('record-commands.js','if (config.microphonemix')],[tt('recording.test.js','actual native preRecorded decoding/sample-clock WAV mix including delay crop, source offset and microphone replacement',
                    ['manifest.options.microphonemix, true','mixed.samples, Math.round(0.6 * 44100)','Math.abs(actual - expected)'], '真实预录mic WAV sampleclock mix与delay crop/offset/PCM值，只miccapture D7。')],
                ['真实录音实时capture不承诺；预录supported部分需要mainfixturefiles/allow精确路径齐全及独立D7判定，不代理GUI mic拒绝后降级分支。'],target='verified-limited',
                boundary={'decision':'D7','reason':'实时麦克风采集仅预录WAV替代，不扩到projectaudio。'},supported='实际预录WAV microphone mix/sampleclock PCM数字fixture。')
        replace('addon.mediarecorder.start',['record','start','/tmp/tw-acceptance/recording','--duration','0.4','--fps','10','--format','frames'],
                [impl('record-commands.js','const execute =')],[tt('recording.test.js','actual offscreen PNG frame sequence/header/pixels manifest clock advances an independent non-dirty copy',
                    ['result.frames, 5','frame.pixelsSha256','runtimeCopy.targets[1].x, 50'], '真实offscreen逐帧像素/headers/hashes/nativeVM clock，无项目dirty。')],
                ['GUIcaptureStream→MediaRecorder视频可D1输出但projectaudio默认true当前不支持、导出编码/停止按钮/realGUI对拍未覆盖；不得标D7limited整个start。'])
    if 'gamepad' in REGISTRY:
        gpfixture=tt('gamepad-mapping.test.js','session-only create/set/controller switch never dirty; store writes stage magic comment and real parser/save/reload preserves it',
                     ["['gamepad', 'select-controller'",'parseOptionsComment().buttons[0].high','session.dirty, true','parser(reload.vm).parseOptionsComment()'], '真实stage magic comment与frozenGUI parser一致，store条件controller选择写入/undo/reload。')
        replace('addon.gamepad.select-controller',['gamepad','select-controller','pad-b'],[impl('gamepad-mapping-commands.js',"action === 'select-controller'")],[gpfixture],['依赖已有recorded controller实例，真实deviceenumeration不承诺；二轮R04事件链复审未确认。'])
        for id,cmd in [('addon.gamepad.store-mapping',['gamepad','store','true']),('addon.gamepad.remove-mapping',['gamepad','store','false'])]:
            replace(id,cmd,[impl('gamepad-mapping-commands.js',"action === 'store'")],[gpfixture],['magicfirstcomment删除/refuseinvalid/cloneproject state具体分支main fixture齐全与独立D6/D7设备边界。'])
        for id,empty in [('addon.gamepad.reset','false'),('addon.gamepad.clear','true')]:
            replace(id,['gamepad','reset','--empty',empty],[impl('gamepad-mapping-commands.js',"action === 'reset'")],
                    [tt('gamepad-mapping.test.js','reset unchecks auto-store but leaves frozen comment; disabling store removes only first magic comment', ["['gamepad', 'reset', '--empty', 'true']",'text, saved','storeInProject, false'], 'clear映射autoStorefalse保旧comment；reset default false还需default生成fixture匹配。')],
                    ['clear(empty=true)fixture不能代理reset生成默认按projectusedkeys mapping；真实GUI stored/newcontroller选择默认语义需匹配。'] if id.endswith('reset') else [])
    # Final source-freeze: registry shape and actual recording execution scopes.
    def append_evidence(id,*evidence):
        if id in RECIPES:
            entries=RECIPES[id]['implementationEvidence']
            for ev in evidence:
                if not any((e['path'],e['line'],e['endLine'],e['anchor'])==(ev['path'],ev['line'],ev['endLine'],ev['anchor']) for e in entries):entries.append(ev)
    for suffix in ['duration','delay','wait-flag','end-stop']:
        append_evidence('addon.mediarecorder.option.'+suffix,impl('record-worker.js','const checkConfig =',after=19),
                        impl('record-worker.js',"runtime.on('PROJECT_STOP_ALL', onStop);",after=51),
                        impl('record-commands.js','const execute =',after=59))
    append_evidence('addon.mediarecorder.start',impl('record-commands.js','const execute =',after=59),
                    impl('record-worker.js','const recording =',after=52),
                    impl('record-worker.js',"runtime.on('PROJECT_STOP_ALL', onStop);",after=51))
    append_evidence('addon.mediarecorder.option.project-audio',impl('record-worker.js','if (value.projectaudio)',after=1))
    append_evidence('addon.mediarecorder.option.mic-mix',impl('record-commands.js','const readTracks =',after=40),
                    impl('record-worker.js','const mixTracks =',after=62))
    native_scope='仅hash-pinned或显式导入字体binary；hostfont discovery disabled不证明缺字/中日韩/复杂脚本全覆盖。固定压力fixture不证明whole-project audio已支持。'
    for id in ['paint.font.add-file','paint.font.add-system','paint.font.export','paint.font.delete','addon.mediarecorder.start']:
        append_evidence(id,impl('native-environment.js','DISABLE_SYSTEM_FONTS_LOAD',after=0))
        if id in RECIPES:RECIPES[id]['requiredMissing'].append(native_scope)
    # Show optional one-shot project persistence in actual IO command examples;
    # export resource output remains --output, not --out.
    for id,record in RECIPES.items():
        for cmd in list(record['actualCli']):
            argv=cmd['argv'];rule=cmd.get('spec',{})
            if argv[0] in ['library','backpack','project'] and rule.get('action') in ['load','import','import-sprite','restore'] and 'out' in rule.get('options',[]) and '--out' not in argv:
                extra=invocation(argv+['--out','/tmp/tw-acceptance/edited.sb3','--force'],
                                 context=cmd.get('executionContext','open-project'),purpose='Optional one-shot mutation + explicit SB3 persistence; resource exports use --output instead.')
                record['actualCli'].append(extra)
    # Final no-proxy pass: parameter family tests do not automatically verify every
    # dropdown type, gesture, cloud branch, history scope, or allowed modal behavior.
    strict_missing={
        'code-ws.procedure-delete':'现有精确测试仅断言external-call拒绝，成功删除definition/root-body/recursivecalls与刷新语义fixture未证明。',
        'code-ws.argument-reporter-drag':'创建reporter的具体fixture在procedure内部使用，GUI从shadow拖出会复制shadow/newID/非定义参数连接；需要复制源parameter实测。',
        'code-ws.make-block':'fixture建立两个参数warp=true，但Label任意位置/空声明/OKCancel与default mutation覆盖不全。',
        'code-ws.block-delete':'右键N块删除含nested descendants/heal后续，现有single删除中间块无nested C-block具体fixture。',
        'code-ws.block-delete-key':'Delete快捷键同heal处理，但Blocklysafe selection/comment/copy guard及nested删除fixture仍需审。',
        'sprites.drag-reorder':'默认folders patch vm.reorderTarget会改folderprefix/组连续性；target pane reorder测试无folder-active拖拽整体语义。',
        'stage.dblclick.select-target':'explicitsprite select证明选择ID，但GUIrenderer.pick/双击禁用fullscreen/player条件未实现，不能将pick行为等价直接升级。',
        'stage.monitor.menu-mode-slider':'此slider只data_variable可用，当前mode允许任何非list reporter；需opcode可用性和default/large cyclefixture。',
        'addon.editor-devtools.paste-at-mouse':'GUICtrlV/paste有变量/procedure/near-mouse落点/bump计时细节；单pastefile x断言不能allclips语义完验。',
        'addon.editor-devtools.copy-single':'需要copy后source mutate再paste保持同快照/单块nestedchildren/不带next具体链fixture。',
        'addon.editor-devtools.cut-single':'需exactheal/bundledependencies/native UndoGroup与删除guard逐分支，负overwrite+copiedflag不代理。',
        'addon.find-bar.find':'find-bar可过程/广播/变量使用查找及carousel跨脚本导航；addon find query只opcode/name JSONsearch，未实现其完整查询排序及语义。',
        'addon.swap-local-global.scope':'现测试scalar global/local；列表scope、sensing_of name引用、cloud/undo保monitor/clones错误条件未完整覆盖，不以单fixture提升所有scope动作。',
        'addon.rename-broadcasts.rename':'source同时更新runtime targets包括clone blocks；当前helper仅isOriginal且测试未含clone/GUI事件队列/广播cleanup一致性。',
        'addon.variable-manager.rename':'云变量☁修正/重复名case/invalid保input原名GUI边界测试尚缺。',
        'addon.variable-manager.search':'GUI是按本角色/global可见行过滤；CLI输出names与未知local target切换仅subset，需独立UIparameterization排除结论。',
        'costumes.paint-cut':'vector快照删除支持；bitmap切除rect及内部跨formatclipboard/state与GUIallselectedRoot lifecycle不能由vectorcopy测试代理。',
    }
    for id,need in strict_missing.items():
        if id in RECIPES:RECIPES[id]['requiredMissing'].append(need)
    for id,r in RECIPES.items():
        if id.startswith('permission.') and id.endswith('.deny'):
            r['requiredMissing'].append('CLIpermissioncheck(false)政策只读声明不会回传到运行中GUIsecurityManager请求/callback/hostcache；需真实request→deny integration，不以policy枚举测试代理。')
        for cmd in r['actualCli']:
            if cmd.get('executionContext')=='open-project':
                if cmd['argv'][0]=='runtime' and cmd['argv'][1]!='start':cmd['executionContext']='session with open project and existing runtime start (paused when step/answer); example placeholders bind fixture IDs'
                if cmd['argv'][0] in ['permission','pack','addon'] and cmd.get('spec',{}).get('action') in ['check','set','reset','import','export','setting','enabled','preset','reset-setting']:
                    cmd['executionContext']='CLI session; explicit configuration path as needed; no project for configuration-only operations'
    return concrete


def escape(value):return str(value if value is not None else '—').replace('|','\\|').replace('\n','<br>')


def build_mapping(write=True):
    global ANALYSIS, CURRENT_IDS
    ANALYSIS=analyze()
    ledger_path='tw-cli/docs/census/m1-census.json'; inv_path='tw-cli/docs/addons-inventory.json'
    ledger=json.loads(read(ledger_path)); inventory=json.loads(read(inv_path))
    CURRENT_IDS={a['id'] for a in ledger['actions']}
    read('tw-cli/docs/census/independent-review-notes.md')
    # Hash every source and test read on this line, including dependencies of delegated implementations.
    for p in sorted((CLI/'src').glob('*.js')):read(str(p.relative_to(ROOT)))
    for p in sorted((CLI/'test').glob('*.js')):read(str(p.relative_to(ROOT)))
    for p in ['tw-cli/baseline.json','tw-cli/src/command-modules.js','tw-cli/bin/tw.js','tw-cli/package.json','tw-cli/package-lock.json','tw-cli/src/native-environment.js','tw-cli/src/file-boundaries.js']:read(p)
    semantic_recipes(ledger,inventory)
    concrete=final_candidates(ledger,inventory)
    previous={}
    if JSON_PATH.is_file():
        previous={a['id']:a for a in json.loads(JSON_PATH.read_text())['actions']}
    retained_missing_count=0
    rows=[]
    for a in ledger['actions']:
        id=a['id'];r=RECIPES.get(id)
        upstream={**a,'sources':[dict(s) for s in a['sources']]}
        for s in upstream['sources']:read(s['path'])
        if not r:
            excluded=a['proposedDisposition']=='not-applicable' or a['kind'] in ['excluded-control','passive-display']
            dom=a['proposedDisposition']=='dom-only'
            target='verified-not-applicable' if excluded else 'dom-only' if dom else 'verified-command'
            r={'targetStatus':target,'actualCli':[],'implementationEvidence':[],'tests':[],
               'requiredMissing':['独立逐动作排除审结未提供；仅census提案不能升级verified-not-applicable。'] if excluded else ['D6原生DOM执行边界须明确独立逐动作批准，不按dom-only字符串整体升级。'] if dom else ['此动作尚无精确实际CLI argv、执行anchor和匹配semantic fixture；相关rootfamily不代理。'],
               'semanticReason':a['effect'],'supportedPart':None,'boundary':None,'rootFamily':None}
        r=json.loads(json.dumps(r))
        for missing in previous.get(id,{}).get('requiredMissing',[]):
            # A completed static finding can replace only its rereview blocker;
            # main-run bookkeeping is regenerated then bound to exact evidence.
            if missing.startswith('主线程Node24统一测试') or missing.startswith('主线程统一测试已通过'):continue
            if re.search(r'独审R\d+.*仍partial',missing) and a.get('independentReview',{}).get('status')!='pending-independent-rereview':continue
            if missing not in r['requiredMissing']:
                r['requiredMissing'].append(missing);retained_missing_count+=1
        routed=bool(r['actualCli']) and all(c.get('routed') for c in r['actualCli'])
        exact_tests=[t for t in r['tests'] if not t.get('unavailable') and t.get('coverage')=='specific' and t.get('assertions')]
        for t in r['tests']:
            if t.get('unavailable'):r['requiredMissing'].append('精确测试当前缺失：'+t['path']+' :: '+t['exactTestName'])
        if r['targetStatus'] in ['verified-command','verified-limited']:
            if not routed:r['requiredMissing'].append('实际可路由命令/完整参数形状缺失。')
            if not r['implementationEvidence']:r['requiredMissing'].append('执行实现path+anchor缺失。')
            if not exact_tests:r['requiredMissing'].append('与具体动作语义匹配的精确testfile+exactTestName+assertion fixture缺失；通用测试/负向拒绝不够。')
            r['requiredMissing'].append('主线程Node24统一测试运行结果待提供（此线未跑；必须skip=0、失败0且inputReadHash一致）。')
        review=a.get('independentReview')
        if review:
            if review.get('status')=='pending-independent-rereview':
                r['requiredMissing'].append('第三轮独审'+review['issue']+'仍partial：执行证据/协议/计数已精确修订，独立final复审未确认；不可自授source-approved。')
            if r['targetStatus']=='verified-not-applicable' and review.get('status')=='static-pass' and review['issue'] in ['R03','R12']:
                r['requiredMissing']=[m for m in r['requiredMissing'] if '独立逐动作' not in m]
                r['requiredMissing'].append('主线程确认此OS-shell/WebGUI排除范围后才可升级；本候选文件不自签verified。')
            r['independentConclusion']={**review,'reportSha256':sha('tw-cli/docs/census/independent-review-notes.md')}
        else:r['independentConclusion']=None
        if r['targetStatus']=='verified-limited':
            if not r['boundary'] or r['boundary'].get('decision') not in ['D7','D6']:
                r['targetStatus']='verified-command'
                r['requiredMissing'].append('不符合用户D7/明确D6 limited条件；D4仅旧存储迁移排除，新文件库supportedPart仍须命令完整验证。')
        if r['targetStatus']=='dom-only':
            r['requiredMissing'].append('D6原生DOM插件执行范围需独立逐动作审结；配置enabled储存不证明blocks SVG/PNG导出行为，仍仅candidate。')
        r['requiredMissing']=list(dict.fromkeys(r['requiredMissing']))
        # CandidateReady means evidence pointers exist and no semantic/fixture gap except main run.
        semantic_gaps=[m for m in r['requiredMissing'] if not m.startswith('主线程Node24统一测试')]
        ready=r['targetStatus'] in ['verified-command','verified-limited'] and routed and bool(r['implementationEvidence']) and bool(exact_tests) and not semantic_gaps
        rows.append({'id':id,'area':a['area'],'name':a['name'],'guiKind':a['kind'],'guiTrigger':a['trigger'],
                     'guiSource':a['sources'],'guiEffect':a['effect'],'guiProposedDisposition':a['proposedDisposition'],
                     'status':'pending','candidateStage':'testing-pending' if routed and r['implementationEvidence'] and exact_tests else 'candidate' if r['actualCli'] or r['targetStatus'] in ['verified-not-applicable','dom-only'] else 'unmapped',
                     'candidateReadyForMain':ready,'pendingUntilMain':True, 'inputReadHash':{'ledger':sha(ledger_path),'implementation':[e['sha256'] for e in r['implementationEvidence']],'tests':[t.get('sha256') for t in r['tests'] if t.get('sha256')]},
                     **r,'testExecution':{'status':'testing-pending','runner':'main-thread','suiteRunByThisAgent':False,'results':[]}})
    ids={a['id'] for a in ledger['actions']}
    if set(RECIPES)-ids:raise ValueError('Unknown recipe IDs '+str(sorted(set(RECIPES)-ids)))
    stats={'ledgerRecordCount':len(rows),'desktopActualActionCount':ledger['stats']['actualActionCount'],
           'countsByStatus':dict(collections.Counter(a['status'] for a in rows)),
           'countsByTargetStatus':dict(collections.Counter(a['targetStatus'] for a in rows)),
           'countsByCandidateStage':dict(collections.Counter(a['candidateStage'] for a in rows)),
           'candidateReadyForMainCount':sum(a['candidateReadyForMain'] for a in rows),
           'concreteCliCandidateCount':sum(bool(a['actualCli']) for a in rows),
           'implementationAndExactTestCandidateCount':sum(a['candidateStage']=='testing-pending' for a in rows),
           'independentConclusionCount':sum(bool(a['independentConclusion']) for a in rows),
           'independentStaticPassActionCount':sum(bool(a['independentConclusion']) and a['independentConclusion'].get('status')=='static-pass' for a in rows),
           'independentRereviewPendingActionCount':sum(bool(a['independentConclusion']) and a['independentConclusion'].get('status')=='pending-independent-rereview' for a in rows),
           'remaining':sum(a['status']=='pending' for a in rows),
           'remainingDesktopActual':sum(a['status']=='pending' and a['guiKind'] in ['action','automatic-after-action'] for a in rows),
           'duplicateCount':len(rows)-len({a['id'] for a in rows}),'missingActionCount':len(ids-{a['id'] for a in rows}),
           'mainTestsRunByThisAgent':0,'retainedPreviousRequiredMissingCount':retained_missing_count}
    report={'schemaVersion':1,'purpose':'draft GUI逐动作验收候选；原15静态处置结案（14源码/账本pass＋R13仅候选降级），精确main测试结果不自动验收动作scope。',
            'independentReviewGate':{'staticPassFindings':['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R14','R15'],'unconfirmedDispositionPassFindings':['R13'],'pendingRereviewFindings':[],'status':'static-remediation-only-not-action-implementation-approved','source':'independent reviewer final R09 verdict (non-user peer review)','runtimeExecuted':False},
            'releaseReady':False,'fullParityAccepted':False,
            'ledger':{'path':ledger_path,'sha256':sha(ledger_path),'records':len(rows),'actualActions':ledger['stats']['actualActionCount'],'formerRecords':1177,'formerActualActions':1152},
            'statusContract':{'allowedFinalStates':sorted(STATES),'currentStatus':'pending for every row',
                              'candidateStage':'candidate/testing-pending/unmapped不是verified状态',
                              'verified-command':'实施执行path+anchor、实际routed argv、精确testname且specific assertions证明GUI语义；main run0failed/0skip+currenthash。',
                              'verified-not-applicable':'仅纯视觉无语义或明确OS-shell/D4迁移范围；必须独立逐动作排除审结。',
                              'verified-limited':'仅用户D7实时媒体或明确D6边界；supportedPart必须实际fixture与reason。精度/实现欠缺不可豁免。',
                              'dom-only':'D6原生DOM addon执行；permission policy本身不可归DOM。',
                              'pending':'任一requiredMissing，或未获main run/独立审；不得按命令存在、testcount、optioncount升级。'},
            'inputReadHashes':{p:h for p,h in sorted(READ_HASHES.items())},'actualRegistry':REGISTRY,'actualTestDeclarations':list(TESTS.values()),
            'missingModuleFiles':ANALYSIS['missingModules'],
            'libraryInputGate':{'status':'resolved-input-gate-reported-by-main','source':'official TurboWarp Desktop v1.16 Linux tar/asar recovery','available':1304,'expected':1304,'missing':0,'errors':0,'MITDirectDownloadCount':0,
                                'reportedBy':'coordinator/main-thread','mainBaseline':{'frozenBaselineVerified':True,'complete':True,'extensions':301,'addons':81},
                                'libraryLoadAcceptance':'testing-pending; four-kind exact tests must run skip=0; never inferred from bytes availability'},
            'stats':stats,'mostImportantConcreteGaps':[{'id':id,'requiredMissing':[next((m for m in next(a for a in rows if a['id']==id)['requiredMissing'] if not m.startswith('主线程Node24统一测试')),msg)]} for id,msg in concrete.items() if id in {a['id'] for a in rows} and not next(a for a in rows if a['id']==id)['candidateReadyForMain']][:20],
            'actions':rows}
    bind_main_evidence(report)
    report['inputReadHashes']={p:h for p,h in sorted(READ_HASHES.items())}
    md=['# GUI逐动作验收候选映射','',
        '本文件对应 [action-acceptance.json](action-acceptance.json)。所有正式status仍pending；候选/test源码存在不是验收通过。只按主线程实际TAP exactName与file/sourceHash绑定测试执行，动作语义scope仍未全独立审结。','',
        f"账本 **{len(rows)}** 条；desktop实际动作 **{stats['desktopActualActionCount']}**。独立15项修复前1177/1152只作历史，不再当当前分母。",
        f"实际CLI候选 {stats['concreteCliCandidateCount']}；实现+specific测试指针候选 {stats['implementationAndExactTestCandidateCount']}；仅缺main运行的ready候选 {stats['candidateReadyForMainCount']}；remaining **{stats['remaining']}**（desktop actual {stats['remainingDesktopActual']}）。",
        '所有动作均含requiredMissing；未分配命令者也保留，不用rootfamily抹去差异。',
        f"主线程精确绑定：{stats.get('mainMatchedUniqueTests',0)}个唯一path+exactName/fileSHA测试，{stats.get('mainMatchedTestReferences',0)}条引用通过；未匹配{stats.get('mainUnmatchedTestReferences',0)}。全部动作status仍pending；ready仅证据指针候选，必须具体scope审，不按275通过或37教程授verified。",'',
        '## 字段与门禁','',
        '- `status`：verified-command / verified-not-applicable / verified-limited / dom-only / pending；当前全部pending。',
        '- `targetStatus`、`candidateStage`、`candidateReadyForMain`只是候选。`pendingUntilMain=true`。',
        '- `actualCli[].argv`来自真实spec，不是census proposedCommand；`executionContext`区分新建/打开项目/persistentruntime前置。实际选择器或fixture路径按bindings解析，不接受猜参数。',
        '- `implementationEvidence`：实际执行文件/行/anchor/hash，不取spec列表存在作为行为证明。',
        '- `tests`：精确testfile/name、assertion行、semanticMatch与parameterScope；每个实际参数化测试展开成exactname；partial测试不能单独让候选ready。',
        '- `inputReadHashes`：本次实际读取代码/测试/账本hash。修改任一输入必须重新审映射，不默默套最新代码原地验证旧候选。',
        '- `requiredMissing`：明确每动作行为差异/fixture/独立审/main运行缺口。D7仅实时camera/mic、明确D6；Paper精度、customsandbox、projectaudio录制不是limited豁免。',
        '- 主线程run要求Node24、精确testname存在、0failed、0skip、输入hash一致；mainresults先附每动作/测试结果再改status，不以fullsuite testcount代替。','',
        '## 资产输入gate','',
        '主线程报告官方desktop v1.16 Linux tar/asar回收1304/1304、missing0/errors0；301extensions/81addons hashpass。MITdirectdownload=0，来源不混。这里只解决输入gate；四类libraryload仍testing-pending，不重复跑suite。','',
        '## 最重要的具体缺口（最多20）','']
    md+=['- `'+x['id']+'`：'+x['requiredMissing'][0] for x in report['mostImportantConcreteGaps']]
    md+=['','## 全动作映射','', '| ID | 正式status | 候选/目标 | 实际CLI | 实现anchor | 精确测试与semanticMatch | requiredMissing |',
         '| --- | --- | --- | --- | --- | --- | --- |']
    for a in rows:
        command=' ; '.join(c['command'] for c in a['actualCli'])
        evidence=' ; '.join(e['path']+':'+str(e['line'])+' `'+e['anchor']+'`' for e in a['implementationEvidence'])
        tests=' ; '.join(t['path']+' :: '+t['exactTestName']+' ['+t.get('coverage','unavailable')+'] — '+t['semanticMatch'] for t in a['tests'])
        md.append('| '+' | '.join(escape(x) for x in [a['id'],a['status'],a['candidateStage']+' / '+a['targetStatus'],command,evidence,tests,' ; '.join(a['requiredMissing'])])+' |')
    md+=['','## 只读检查','',
         '运行 `python3 tw-cli/docs/census/check-action-acceptance.py`：JSON/ID集合一一对应、实际spec参数、精确测试声明/断言、输入hash、pending与运行证据门禁、Markdown一致。',
         '`--build`仅重建这两个新mapping文件；不写src/bin/package/test/census原账本。当前freeze原docs写域，后续main只按mapping测试。','']
    if write:
        for path,text in [(JSON_PATH,json.dumps(report,ensure_ascii=False,indent=2)+'\n'),(MD_PATH,'\n'.join(md))]:
            if path not in [JSON_PATH,MD_PATH]:raise RuntimeError('Write target outside mapping allowlist')
            path.write_text(text)
    return report


def bind_main_evidence(report):
    """Bind run results only by exact declaration+TAP name and matching frozen files.
    This is read-only evidence consumption, not suite execution or action verification.
    """
    result_path='tw-cli/docs/verification/full-tests.json';tap_path='tw-cli/docs/verification/full-tests.tap'
    if not (ROOT/result_path).is_file() or not (ROOT/tap_path).is_file():
        report['mainRunEvidence']={'status':'unavailable','testsExecutedByThisAgent':0};return
    result=json.loads(read(result_path));tap=read(tap_path)
    summary={}
    for line in result.get('summary',[]):
        m=re.fullmatch(r'# (tests|pass|fail|skipped) (\d+)',line)
        if m:summary[m[1]]=int(m[2])
    source_hashes=result.get('sourceHashes',{})
    mismatched=[]
    for rel,digest in source_hashes.items():
        path='tw-cli/'+rel
        if not (ROOT/path).is_file() or sha(path)!=digest:mismatched.append(path)
    results=collections.defaultdict(list)
    for line_number,line in enumerate(tap.splitlines(),1):
        match=re.fullmatch(r'(ok|not ok) (\d+) - (.*)',line)
        if match:results[match[3]].append({'tapLine':line_number,'testNumber':int(match[2]),'result':match[1]})
    gate=result.get('exitCode')==0 and result.get('sourceUnchanged') is True and not result.get('changedInputs') and not mismatched and \
        sha(tap_path)==result.get('tapSha256') and summary.get('fail')==0 and summary.get('skipped')==0 and summary.get('tests')==summary.get('pass') and \
        len([item for values in results.values() for item in values])==summary.get('tests') and all(item['result']=='ok' for values in results.values() for item in values)
    run_files={str(Path(arg).relative_to(ROOT)) for arg in result.get('argv',[]) if isinstance(arg,str) and arg.startswith(str(ROOT)) and arg.endswith('.js')}
    declarations={(t['path'],t['exactTestName']):t for t in report['actualTestDeclarations']}
    names=collections.Counter(t['exactTestName'] for t in report['actualTestDeclarations'])
    matched_keys=set();unmatched=[];references=0;matched_actions=0
    for action in report['actions']:
        bound=[]
        for test in action['tests']:
            key=(test['path'],test['exactTestName']);reason=None
            if test.get('unavailable'):reason='exact test declaration unavailable in frozen input'
            elif not gate:reason='main run exit/skip/hash/unchanged gate not satisfied'
            elif key not in declarations or names[test['exactTestName']]!=1:reason='exact name missing/ambiguous across included test files'
            elif test['path'] not in run_files:reason='test filepath not in main argv'
            elif source_hashes.get(test['path'].removeprefix('tw-cli/'))!=test.get('sha256'):reason='testfile SHA does not match main run'
            elif len(results[test['exactTestName']])!=1 or results[test['exactTestName']][0]['result']!='ok':reason='exact TAP result is absent/not passed/duplicate'
            elif any(source_hashes.get(ev['path'].removeprefix('tw-cli/'))!=ev['sha256'] for ev in action['implementationEvidence'] if ev['path'].startswith('tw-cli/src/')):reason='implementation SHA does not match run frozen source'
            if reason:
                unmatched.append({'actionId':action['id'],'path':test['path'],'exactTestName':test['exactTestName'],'reason':reason});continue
            row=results[test['exactTestName']][0]
            test['executionStatus']='passed';test['pendingUntilMain']=False
            test['mainRun']={'runner':'main-thread','report':result_path,'reportSha256':sha(result_path),'tap':tap_path,'tapSha256':sha(tap_path),
                             **row,'path':test['path'],'exactTestName':test['exactTestName'],'testFileSha256':test['sha256'],
                             'node':result['node'],'platform':result.get('platform'),'sourceUnchanged':True,'allImplementationHashesMatched':True,
                             'semanticScopeApproved':False,'coverage':test.get('coverage','partial'),'source':'main-thread-run-evidence-not-human-authorization'}
            bound.append(test['mainRun']);references+=1;matched_keys.add(key)
        action['testExecution']['results']=bound
        if action['tests'] and len(bound)==len(action['tests']):
            action['testExecution']['status']='passed';action['testExecution']['scopeApproved']=False;matched_actions+=1
            action['requiredMissing']=['主线程统一测试已通过（精确名称/文件及实现hash匹配），但此动作GUI语义范围与独立scope审批仍pending。' if missing.startswith('主线程Node24统一测试') else missing for missing in action['requiredMissing']]
        else:action['testExecution']['status']='testing-pending'
        action['status']='pending';action['pendingUntilMain']=True
    all_declared_bound=0
    for key,test in declarations.items():
        name=key[1]
        if gate and names[name]==1 and key[0] in run_files and source_hashes.get(key[0].removeprefix('tw-cli/'))==test['sha256'] and len(results[name])==1 and results[name][0]['result']=='ok':all_declared_bound+=1
    report['mainRunEvidence']={'status':'matched-frozen-main-run' if gate else 'gate-not-satisfied','report':result_path,'reportSha256':sha(result_path),
                             'tap':tap_path,'tapSha256':sha(tap_path),'summary':summary,'sourceUnchanged':result.get('sourceUnchanged'),
                             'sourceHashMismatchCount':len(mismatched),'sourceHashMismatches':mismatched,'node':result.get('node'),
                             'exactMappedUniqueTests':len(matched_keys),'mappedTestReferencesPassed':references,'mappedTestReferencesUnmatched':unmatched,
                             'allStaticDeclarationsWithMatchingMainResult':all_declared_bound,'testsExecutedByThisAgent':0,
                             'doesNotVerifyActionScope':True,'releaseReady':False}
    report['stats'].update(mainMatchedUniqueTests=len(matched_keys),mainMatchedTestReferences=references,mainUnmatchedTestReferences=len(unmatched),
                           actionsWithAllMappedTestsRunPassed=matched_actions,mainDeclaredExactMatches=all_declared_bound)


def validate_mapping():
    result={'errors':[],'staleInputs':[]};errors=result['errors']
    try:data=json.loads(JSON_PATH.read_text());ledger=json.loads((DOCS/'m1-census.json').read_text())
    except (OSError,json.JSONDecodeError) as exc:errors.append(str(exc));return result
    ids=[a['id'] for a in data['actions']];expected={a['id'] for a in ledger['actions']}
    if len(set(ids))!=len(ids):errors.append('Duplicate GUI action IDs')
    if set(ids)!=expected:errors.append('Missing or additional GUI action IDs: '+str(sorted(set(ids)^expected)))
    for path,digest in data['inputReadHashes'].items():
        file=ROOT/path
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest()!=digest:result['staleInputs'].append(path)
    if result['staleInputs']:errors.append('Inputs changed after read; mapping review must be refreshed: '+str(result['staleInputs']))
    registry=data['actualRegistry'];testindex={(t['path'],t['exactTestName']):t for t in data['actualTestDeclarations']}
    for a in data['actions']:
        if a['status'] not in STATES:errors.append('Invalid status: '+a['id'])
        if a['candidateStage'] not in CANDIDATES:errors.append('Invalid candidate: '+a['id'])
        if a['status']=='pending' and not a['requiredMissing']:errors.append('Pending lacks requiredMissing: '+a['id'])
        if a['status'].startswith('verified') or a['status']=='dom-only':
            if a['status']=='verified-not-applicable':
                if not a.get('independentConclusion'):errors.append('N/A unapproved independently: '+a['id'])
            elif a['status']=='dom-only':
                if not a.get('independentConclusion'):errors.append('DOM boundary unapproved independently: '+a['id'])
            else:
                if a['pendingUntilMain'] or a['testExecution']['status']!='passed' or not a['testExecution'].get('results'):errors.append('Premature verified/testgreen: '+a['id'])
                if a['requiredMissing']:errors.append('Verified with missing items: '+a['id'])
        if a['targetStatus']=='verified-limited' and (not a.get('boundary') or a['boundary']['decision'] not in ['D7','D6']):errors.append('Unauthorized limited scope: '+a['id'])
        for ev in a['implementationEvidence']+a['guiSource']:
            f=ROOT/ev['path']
            if not f.is_file():errors.append('Missing source: '+a['id']+' '+ev['path']);continue
            lines=f.read_text().splitlines()
            if not 1<=ev['line']<=ev['endLine']<=len(lines) or ev['anchor'] not in '\n'.join(lines[ev['line']-1:ev['endLine']]):errors.append('Source anchor invalid: '+a['id']+' '+ev['path'])
        for t in a['tests']:
            if t.get('unavailable'):continue
            key=(t['path'],t['exactTestName'])
            if key not in testindex:errors.append('Exact test not declared: '+a['id']+' '+str(key));continue
            lines=(ROOT/t['path']).read_text().splitlines()
            if t['declarationAnchor'] not in '\n'.join(lines[t['line']-1:t['endLine']]):errors.append('Exact test source mismatch: '+a['id'])
            for anchor in t['assertions']:
                if not t['line']<=anchor['line']<=t['endLine'] or anchor['anchor'] not in lines[anchor['line']-1]:errors.append('Assertion mismatch: '+a['id'])
            if t['executionStatus']=='passed':
                run=t.get('mainRun')
                if not run:errors.append('Unproven green test: '+a['id'])
                else:
                    if run.get('exactTestName')!=t['exactTestName'] or run.get('path')!=t['path'] or run.get('testFileSha256')!=t['sha256'] or not run.get('allImplementationHashesMatched'):errors.append('Main binding exact file/name/source mismatch: '+a['id'])
                    taplines=(ROOT/run['tap']).read_text().splitlines()
                    expected_tap_result=f"ok {run['testNumber']} - {t['exactTestName']}"
                    if not 1<=run['tapLine']<=len(taplines) or taplines[run['tapLine']-1]!=expected_tap_result:errors.append('Main TAP exact result mismatch: '+a['id'])
                    evidence=json.loads((ROOT/run['report']).read_text())
                    if evidence.get('exitCode')!=0 or evidence.get('sourceUnchanged') is not True or evidence.get('sourceHashes',{}).get(t['path'].removeprefix('tw-cli/'))!=t['sha256']:errors.append('Main run gate/filehash mismatch: '+a['id'])
        for c in a['actualCli']:
            if not c.get('routed'):continue
            rule=c['spec'];reg=registry[rule['family']]['actions'].get(rule['action'] or '$direct')
            if not reg or any(rule[k]!=reg[k] for k in ['min','max','options']):errors.append('Actual spec shape mismatch: '+a['id'])
    mdids=re.findall(r'^\| ([a-z][\w.-]+) \|',MD_PATH.read_text(),re.M)
    if collections.Counter(mdids)!=collections.Counter(ids):errors.append('Markdown/JSON exact action set mismatch')
    stats=data['stats']
    if stats['ledgerRecordCount']!=len(ids) or stats['countsByStatus']!=dict(collections.Counter(a['status'] for a in data['actions'])):errors.append('Stale mapping stats')
    result.update(stats)
    result['coveredRecords']=len(ids);result['missingCount']=len(expected-set(ids));result['duplicateCount']=len(ids)-len(set(ids));result['testsExecutedByThisAgent']=0
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build',action='store_true',help='Write only action-acceptance.json and .md; never run tests')
    parser.add_argument('--strict',action='store_true',help='Also fail while any action remains pending')
    args=parser.parse_args()
    if args.build:
        report=build_mapping();print(json.dumps(report['stats'],ensure_ascii=False,indent=2));return
    result=validate_mapping();print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(1 if result['errors'] or args.strict and result.get('remaining',0)>0 else 0)


if __name__=='__main__':main()
