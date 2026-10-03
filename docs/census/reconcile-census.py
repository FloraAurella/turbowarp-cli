#!/usr/bin/env python3
"""M1 document reconciliation. --check is read-only; --write touches allowlisted docs only.

Do not use the older scripts/build-action-ledger.js or addon-inventory.js to regenerate
these documents: their exact-enum/quoted-string parsers lose rows and descriptions.
"""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'tw-cli/docs'
CENSUS = DOCS / 'census'
GUI = 'desktop-master/node_modules/scratch-gui/src/'
PAINT = 'desktop-master/node_modules/scratch-paint/src/'
BLOCKS = 'desktop-master/node_modules/scratch-blocks/'
VM = 'desktop-master/node_modules/scratch-vm/src/'
DESKTOP = 'desktop-master/'
ADDONS = GUI + 'addons/addons/'
AREAS = ['menu-bar', 'code-workspace', 'sprites', 'costumes', 'sounds',
         'stage-controls', 'monitors-prompts', 'extensions-addons', 'project-io', 'paint-tools']
DISPOSITIONS = ['commanded', 'limited', 'not-applicable', 'dom-only', 'pending']
TEXT_CACHE = {}
ACTIONS = {}
ALIASES = {}
ADDON_ROWS = []
DRAFT_INPUTS = {}
DRAFT_SOURCE_ACTIONS = []

def read(path):
    if path not in TEXT_CACHE:
        TEXT_CACHE[path] = (ROOT / path).read_text()
    return TEXT_CACHE[path]

def sha(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()

def source(path, start, end=None, anchor=None):
    lines = read(path).splitlines()
    end = end or start
    if not (1 <= start <= end <= len(lines)):
        raise ValueError(f'Invalid source range: {path}:{start}-{end} ({len(lines)} lines)')
    quote = '\n'.join(lines[start - 1:end])
    if anchor and anchor not in quote:
        raise ValueError(f'Anchor missing at {path}:{start}-{end}: {anchor}')
    return {'path': path, 'line': start, 'endLine': end,
            'anchor': anchor or quote.strip()[:220], 'sha256': sha(path)}

def refstr(sources):
    return '; '.join(f"{s['path']}:{s['line']}" +
                     (f"-{s['endLine']}" if s['endLine'] != s['line'] else '') for s in sources)

def at(path, needle, before=0, after=0):
    lines = read(path).splitlines()
    hits = [i for i, line in enumerate(lines, 1) if needle in line]
    if not hits:
        raise ValueError(f'No source anchor: {path}: {needle}')
    line = hits[0]
    return source(path, max(1, line - before), min(len(lines), line + after), needle)

def S(relative, start, end=None, prefix=GUI, anchor=None):
    return source(prefix + relative, start, end, anchor)

def add(id, area, name, trigger, sources, effect, command=None, disposition='commanded',
        note=None, visibility='conditional', kind='action', origin='supplement'):
    assert area in AREAS and disposition in DISPOSITIONS
    if id in ALIASES:
        return
    ACTIONS[id] = {'id': id, 'area': area, 'name': name, 'trigger': trigger,
                   'ref': refstr(sources), 'sources': sources, 'effect': effect,
                   'proposedCommand': command, 'proposedDisposition': disposition,
                   'implementationStatus': 'pending', 'acceptanceStatus': 'pending',
                   'reviewStatus': 'unconfirmed' if note else 'source-reviewed',
                   'reviewNotes': [note] if note else [], 'visibility': visibility,
                   'kind': kind, 'origin': origin, 'aliases': []}

def alias(old, new, reason):
    ALIASES[old] = {'id': old, 'canonicalIds': new if isinstance(new, list) else [new], 'reason': reason}
    ACTIONS.pop(old, None)

def splitrow(line):
    # Pipes inside inline code (including old unescaped <name|id>) are not table delimiters.
    cells, value, code, escaped = [], '', False, False
    for char in line[1:]:
        if escaped:
            value += char
            escaped = False
        elif char == '\\':
            value += char
            escaped = True
        elif char == '`':
            code = not code
            value += char
        elif char == '|' and not code:
            cells.append(value.strip())
            value = ''
        else:
            value += char
    return cells

SOURCE_FILES = []
for directory in [GUI, PAINT, BLOCKS + 'core/', BLOCKS + 'blocks_vertical/', VM,
                  DESKTOP + 'src-main/', DESKTOP + 'src-preload/',
                  DESKTOP + 'src-renderer-webpack/', DESKTOP + 'src-renderer/']:
    SOURCE_FILES += [str(p.relative_to(ROOT)) for p in (ROOT / directory).rglob('*')
                     if p.is_file() and p.suffix in ['.js', '.jsx', '.html', '.css']]
BY_NAME = collections.defaultdict(list)
for p in sorted(set(SOURCE_FILES)):
    BY_NAME[Path(p).name].append(p)

def resolve_path(token, area):
    token = token.replace('VM/src/', VM).replace('VM/', VM).replace('GUI/', GUI).replace('DT/', DESKTOP)
    if token.startswith(('scratch-gui/', 'scratch-paint/', 'scratch-vm/', 'scratch-blocks/')):
        token = DESKTOP + 'node_modules/' + token
    if token.startswith('src-main/') or token.startswith('src-preload/') or token.startswith('src-renderer'):
        token = DESKTOP + token
    if token.startswith('addons/') and not token.startswith('addons/addons/'):
        token = ADDONS + token[len('addons/'):]
    if (ROOT / token).is_file():
        return token
    gui_basenames = {
        'target-pane.jsx':'containers/target-pane.jsx', 'stage-selector.jsx':'containers/stage-selector.jsx',
        'sprite-selector.jsx':'components/sprite-selector/sprite-selector.jsx',
        'sprite-selector-item.jsx':'components/sprite-selector-item/sprite-selector-item.jsx',
        'sprite-info.jsx':'components/sprite-info/sprite-info.jsx', 'direction-picker.jsx':'components/direction-picker/direction-picker.jsx',
        'library.jsx':'components/library/library.jsx', 'menu-bar.jsx':'components/menu-bar/menu-bar.jsx',
        'settings-menu.jsx':'components/menu-bar/settings-menu.jsx', 'language-menu.jsx':'components/menu-bar/language-menu.jsx',
        'project-title-input.jsx':'components/menu-bar/project-title-input.jsx', 'author-info.jsx':'components/menu-bar/author-info.jsx',
        'share-button.jsx':'components/menu-bar/share-button.jsx', 'community-button.jsx':'components/menu-bar/community-button.jsx',
        'sb-file-uploader-hoc.jsx':'lib/sb-file-uploader-hoc.jsx', 'sb3-downloader.jsx':'containers/sb3-downloader.jsx',
        'menu-bar-hoc.jsx':'containers/menu-bar-hoc.jsx', 'blocks.jsx':'containers/blocks.jsx',
        'sound-editor.jsx':'components/sound-editor/sound-editor.jsx', 'sound-tab.jsx':'containers/sound-tab.jsx',
        'sound-library.jsx':'containers/sound-library.jsx', 'recording-step.jsx':'components/record-modal/recording-step.jsx',
        'playback-step.jsx':'components/record-modal/playback-step.jsx',
        'audio-selector.jsx':'containers/audio-selector.jsx',
        'audio-effects.js':'lib/audio/audio-effects.js', 'fade-effect.js':'lib/audio/effects/fade-effect.js',
        'audio-recorder.js':'lib/audio/audio-recorder.js', 'audio-buffer-player.js':'lib/audio/audio-buffer-player.js',
        'audio-util.js':'lib/audio/audio-util.js', 'monitor.jsx':'containers/monitor.jsx',
    }
    core_names={'contextmenu.js','procedures.js','blockly.js','block_svg.js','workspace.js','workspace_svg.js','gesture.js','block_dragger.js','flyout_base.js','flyout_vertical.js','field_variable.js','field_dropdown.js','field_textinput.js','field_note.js','data_category.js','scratch_blocks_utils.js','zoom_controls.js','icon.js','variables.js','scratch_block_comment.js','workspace_comment_render_svg.js','workspace_comment_svg.js','toolbox.js'}
    if '/' not in token and token in core_names:
        return BLOCKS + 'core/' + token
    if '/' not in token and token in gui_basenames:
        return GUI + gui_basenames[token]
    if token == 'userscript.js' and area in ['sprites','costumes']:
        return ADDONS + 'folders/userscript.js'
    if token == '_manifest_entry.js' and area == 'sprites':
        return ADDONS + 'drag-drop/_manifest_entry.js'
    if area == 'costumes' and token in ['paint-editor.jsx','fixed-tools.jsx','fixed-tools/fixed-tools.jsx','mode-tools.jsx']:
        return PAINT + 'components/' + {'paint-editor.jsx':'paint-editor/paint-editor.jsx','fixed-tools.jsx':'fixed-tools/fixed-tools.jsx','fixed-tools/fixed-tools.jsx':'fixed-tools/fixed-tools.jsx','mode-tools.jsx':'mode-tools/mode-tools.jsx'}[token]
    candidates = [p for p in BY_NAME[Path(token).name] if p.endswith('/' + token)]
    if not candidates:
        candidates = BY_NAME[Path(token).name]
    if not candidates:
        raise ValueError(f'Unresolvable draft source {area}: {token}')
    def score(p):
        n = 0
        if p.startswith(GUI) and not '/addons/' in p: n += 5
        if p.startswith(BLOCKS): n += 4 if area == 'code-workspace' else 0
        if p.startswith(PAINT): n += 7 if area == 'costumes' and token.startswith(('fixed-tools', 'mode-tools', 'paint-editor', 'keyboard-', 'undo-', 'copy-paste-', 'stroke-width')) else 0
        if p.startswith(VM): n += 8 if token.startswith(('engine/', 'sprites/', 'serialization/')) or Path(token).name in ['virtual-machine.js', 'rendered-target.js', 'runtime.js', 'sb3.js'] else 0
        if p == GUI + 'components/menu-bar/menu-bar.jsx': n += 20
        if p == GUI + 'lib/blocks.js' and token == 'lib/blocks.js': n += 20
        if p == GUI + 'containers/blocks.jsx' and token == 'containers/blocks.jsx': n += 20
        if p == DESKTOP + 'src-renderer-webpack/editor/gui/desktop-hoc.jsx': n += 20
        return n
    return max(candidates, key=score)

LEGACY_ALIASES = {
    'code-ws.drag-block-to-sprite': ('sprites.drop-blocks', '同一 BLOCK_DRAG_END→target-pane.shareBlocksToTarget；起点/接收端重复登记。'),
    'sprites.drop-costume': ('costumes.share-to-target', '同一 COSTUME drop→shareCostumeToTarget；角色卡接收端与造型起点合并，舞台投放见单独条目。'),
    'sprites.undo-restore': ('mb.edit.restore', '同一 Edit→Restore 入口；按最后删除对象恢复，角色草稿重复登记。'),
    'backdrops.add-via-stage-card': (['backdrops.open-library', 'backdrops.upload-file', 'backdrops.add-surprise', 'backdrops.add-blank'], '此行是四个已登记入口的汇总，不是第五个独立用户动作。'),
    'costumes.share-to-stage-sound': (['sounds.share-to-stage', 'project-io.backpack-code-to-stage'], '原行是跨区域提示，拆成声音/背包代码两个真实投放动作。'),
    'costumes.paint-draw': (['paint.vector.brush', 'paint.vector.erase', 'paint.vector.fill', 'paint.vector.text', 'paint.vector.line', 'paint.vector.ellipse', 'paint.vector.rectangle', 'paint.bitmap.brush', 'paint.bitmap.erase', 'paint.bitmap.fill', 'paint.bitmap.text', 'paint.bitmap.line', 'paint.bitmap.ellipse', 'paint.bitmap.rectangle'], '原粗粒度绘制汇总拆成逐工具动作，保留兼容引用而不重复计数。'),
    'costumes.paint-tool-vector': ([f'paint.vector.choose-{x}' for x in ['select','reshape','brush','eraser','fill','text','line','ellipse','rectangle']], '九个工具按钮/快捷键逐个登记。'),
    'costumes.paint-tool-bitmap': ([f'paint.bitmap.choose-{x}' for x in ['brush','line','ellipse','rectangle','text','fill','eraser','select']], '八个工具按钮/快捷键逐个登记。'),
    'costumes.paint-zoom': (['paint.view.zoom-in', 'paint.view.zoom-out', 'paint.view.zoom-reset'], '三个缩放按钮逐个登记。'),
    'code-ws.zoom-buttons': (['code-ws.zoom-in', 'code-ws.zoom-out', 'code-ws.zoom-reset'], '三个工作区缩放按钮逐个登记。')
}

def load_drafts():
    for old, (new, reason) in LEGACY_ALIASES.items(): alias(old, new, reason)
    previous = {}
    if (CENSUS / 'm1-census.json').exists():
        ledger = json.loads((CENSUS / 'm1-census.json').read_text())
        if ledger.get('schemaVersion') == 2:
            # Save the source rows before cross-area splitting so rerunning is deterministic.
            previous = {a['id']: a for a in ledger.get('draftSourceActions', [])}
            DRAFT_SOURCE_ACTIONS.extend(json.loads(json.dumps(list(previous.values()))))
            DRAFT_INPUTS.update(ledger.get('draftAudit',{}))
    if previous:
        ACTIONS.update(previous)
        return
    last_effect, last_command = '', ''
    for area in AREAS[:6]:
        path = CENSUS / f'{area}.md'
        DRAFT_INPUTS[area]={'path':str(path.relative_to(ROOT)),'sha256':sha(str(path.relative_to(ROOT))),'rows':[]}
        for line_no, line in enumerate(path.read_text().splitlines(), 1):
            if not re.match(r'^\| (?:code-ws|mb|stage|sprites|costumes|backdrops|sounds)\.', line): continue
            cells = splitrow(line)
            if len(cells) > 7:
                # Historical tables have raw JS || in the source column. The two trailing
                # command/disposition cells are unambiguous; rejoin evidence until effect.
                cells = cells[:3] + [' | '.join(cells[3:-3])] + cells[-3:]
            if len(cells) != 7: raise ValueError(f'Bad draft row {path.name}:{line_no}: {len(cells)}')
            id, name, trigger, raw_ref, effect, cmd, disp = cells
            DRAFT_INPUTS[area]['rows'].append({'id':id,'line':line_no,'originalRef':raw_ref})
            ids = [id]
            if id == 'backdrops.library-search / -tag-filter': ids = ['backdrops.library-search','backdrops.library-tag-filter']
            if id == 'costumes.paint-fill-color / -stroke-color': ids = ['costumes.paint-fill-color','costumes.paint-stroke-color']
            matches = list(re.finditer(r'([\w/.-]+\.(?:js|jsx)):(\d+)(?:-(\d+))?', raw_ref))
            sources = []
            for m in matches:
                p = resolve_path(m[1], area)
                start, end = int(m[2]), int(m[3] or m[2])
                if p.endswith('/sound-tags.js') and end == 13: end = 12
                sources.append(source(p, start, end))
            if not sources:
                if raw_ref.startswith('同上'): sources = last_sources
                elif id == 'code-ws.category-select': sources = [S('core/toolbox.js', 557, 565, BLOCKS)]
                elif id == 'costumes.paint-draw': sources = [S('containers/paint-editor-wrapper.jsx', 48, 63)]
                else: raise ValueError(f'Draft has no line evidence: {id}')
            last_sources = sources
            # Resolve cross-row shorthand; explicit corrections below replace ambiguous cases.
            if effect.startswith('同上') or effect.startswith('同 '): effect = last_effect + '；' + effect
            else: last_effect = effect
            if cmd.startswith(('同上', '同 sprites.', '同 `')): cmd = last_command
            elif '`tw' in cmd: last_command = cmd
            match = re.match(r'(commanded|limited|not-applicable|dom-only)', disp)
            if not match: raise ValueError(f'Unknown disposition: {id}: {disp}')
            disposition = match[1]
            cmd = cmd.replace('\\|', '|')
            command_matches = re.findall(r'`(tw[^`]+)`', cmd)
            command = ' ; '.join(command_matches) if command_matches and disposition in ['commanded','limited'] else None
            if disposition == 'commanded' and not command:
                command = 'tw ' + ('sound' if id.startswith('sounds.') else 'costume' if id.startswith('costumes.') else 'project') + ' operation --id <id>'
            actual_area = 'paint-tools' if id.startswith('costumes.paint-') else 'monitors-prompts' if id.startswith('stage.monitor.') or id == 'stage.question.answer' else area
            for actual_id in ids:
                if actual_id in ACTIONS: continue  # repeated costumes.rename row, not a new action
                if actual_id in ALIASES: continue
                add(actual_id, actual_area, name, trigger, sources, effect, command, disposition,
                    visibility='not-rendered-in-desktop' if any(x in effect for x in ['不渲染','不可达','未接线死代码']) else 'conditional', origin='draft')

    DRAFT_SOURCE_ACTIONS.extend(json.loads(json.dumps(list(ACTIONS.values()))))


def supplement_areas():
    # Corrections to the six historical drafts. Stable IDs survive; source paths no longer use aliases.
    def patch(id, **fields):
        ACTIONS[id].update(fields)
        if 'sources' in fields: ACTIONS[id]['ref'] = refstr(fields['sources'])
    patch('code-ws.procedure-delete', effect='存在非递归调用块时拒绝删除并显示 PROCEDURE_USED；否则只 dispose 定义堆并刷新工具箱，不自动删除调用者。',
          sources=[S('core/procedures.js',641,660,BLOCKS), S('blocks_vertical/vertical_extensions.js',165,185,BLOCKS)],
          proposedCommand='tw proc delete <proccode> # 提案：有调用时拒绝')
    patch('stage.monitor.menu-slider-range', trigger='右键滑块→更改范围，输入 min/max 后 OK 或 Enter；无独立离散性复选框',
          effect='min/max 归一排序；isDiscrete 由两输入均不含小数点推导（不是数值是否整数）；写 monitors 并随 sb3 保存。',
          sources=[S('containers/monitor.jsx',157,173), S('containers/slider-prompt.jsx',30,55)],
          proposedCommand='tw monitor range <id> --min-text <value> --max-text <value>')
    patch('code-ws.block-comment-icon-toggle', effect='只创建/销毁注释气泡，保留文本/尺寸；不调用 setMinimized，不序列化 visible。首次自动定位是派生布局，见单独移动动作。',
          sources=[S('core/icon.js',124,131,BLOCKS), S('core/scratch_block_comment.js',329,382,BLOCKS)])
    for id in ['sprites.drop-backpack-sprite','sprites.drop-backpack-costume','sprites.drop-backpack-sound','sprites.drop-backpack-code','sprites.drag-to-backpack','sprites.folder.backpack-dump','sounds.drop.backpackSound']:
        if id in ACTIONS:
            patch(id, proposedDisposition='limited', reviewNotes=['桌面 gui.jsx 固定 backpackHost="_local_"；backpack-api 分派到 IndexedDB。D4 不读取/迁移旧浏览器存储，仅提议显式导出文件/本地库管道。不是必需网络/凭据。'],
                  sources=ACTIONS[id]['sources']+[S('lib/backpack-api.js',8,28),S('lib/tw-local-backpack-api.js',58,88),S('src-renderer-webpack/editor/gui/gui.jsx',19,36,DESKTOP)])
    for id in ['costumes.backpack-drop','costumes.backpack-sound-drop','sounds.drop.backpackCostume','code-ws.drop-backpack-code','code-ws.drag-block-to-backpack']:
        patch(id, proposedDisposition='limited', reviewNotes=['接收/导出语义可命令化，但桌面旧背包 IndexedDB 的读取迁移属于 D4；仅显式文件输入/本地新库提案，不承诺自动迁移。'])
    for id in ['costumes.library-favorite','backdrops.library-favorite','sounds.library.favorite']:
        patch(id, proposedDisposition='limited', proposedCommand='tw library favorite --library <id> --item <name> --config <path>',
              effect='写 localStorage 收藏状态并改变库排序；不是无状态纯视觉。D4 旧存储迁移不由 CLI 读取，新配置文件为提案。')
    patch('stage.fullscreen.launch-flag', proposedDisposition='not-applicable', proposedCommand=None,
          effect='现成 turbowarp --fullscreen 是 Electron GUI 启动选项，不能作为 tw CLI 无界面实现证据；无项目语义。')
    patch('stage.drag.sprite-editor-canvas', proposedDisposition='limited',
          proposedCommand='tw sprite drag <target> --path <trace.json>',
          effect='编辑器拖影期间确实 postSpriteInfo({visible:false})，结束时恢复可见并提交坐标；该瞬时 VM 状态可被脚本观察，不能称为纯视觉无状态。',
          reviewNotes=['拖动中 VM 可见性/图层/坐标抑制与 GUI 事件顺序仍需对拍；不保证任意时刻保存的中间状态。'])
    for id in ['stage.indicator.active-color','stage.indicator.turbo-badge','stage.indicator.fps-badge','stage.indicator.mic','stage.indicator.target-highlight','stage.indicator.loading']:
        patch(id, kind='passive-display')
    patch('mb.errors.list', kind='passive-display', proposedCommand='tw errors list')
    patch('mb.file.restore-points', proposedDisposition='not-applicable', proposedCommand=None,
          effect='只打开还原点管理 modal；创建/导出/加载/删除/自动间隔逐项见 project-io.restore-*，入口不冒充整个快照能力。')
    patch('code-ws.extension-status-button', proposedDisposition='not-applicable', proposedCommand=None,
          effect='只打开扩展连接 modal；扫描/连接/断开/更新各有独立登记，D7 不适用于所有 Bluetooth 外设。')
    patch('code-ws.extension-button', proposedDisposition='pending', proposedCommand=None, reviewStatus='unconfirmed',
          reviewNotes=['runtime 注册任意扩展按钮回调：builtin 与第三方回调集合不是封闭的统一命令。已登记 dispatcher；具体加载的动态扩展按钮还需逐扩展确认，不能一概 limited/D7。'])
    patch('code-ws.field-note-edit', effect='写 NOTE 字段入项目；点击琴键另发 PLAY_NOTE 音频预览，单独登记 code-ws.note-preview。',
          proposedCommand='tw block field <block> NOTE <number>')
    alias('code-ws.record-sound-option','sounds.add.record','声音菜单 record... 与声音页录音按钮均打开同一SoundRecorder管线；D7采集/保存另有动作。')
    ACTIONS['sounds.add.record']['trigger']+='；声音类积木下拉 record... 选项'
    ACTIONS['sounds.add.record']['sources'] += [S('lib/blocks.js',79,89),S('containers/blocks.jsx',611,613)]
    patch('costumes.paint-cut', proposedDisposition='commanded', proposedCommand='tw vector cut <costume> --nodes <ids> --clipboard <file>',
          effect='内部 copy + deleteSelection，删除会重写 SVG/PNG；不能归为纯剪贴板 UI。')
    for id in ['costumes.paint-fill-color','costumes.paint-stroke-color','costumes.paint-color-readout']:
        patch(id, proposedDisposition='commanded', proposedCommand='tw vector style <costume> --nodes <ids> --fill/--stroke <color>',
              sources=[S('containers/color-indicator.jsx',33,104,PAINT),S('containers/color-picker.jsx',103,159,PAINT)],
              effect='有已选图形/文本时 applyColorToSelection 修改图形，关闭颜色面板时 onUpdateImage 重写资产；无选区时只设后续绘制参数。')
    patch('costumes.paint-stroke-width', proposedDisposition='commanded', proposedCommand='tw vector style <costume> --stroke-width <n> --nodes <ids>',
          sources=[S('containers/stroke-width-indicator.jsx',24,54,PAINT)],
          effect='applyStrokeWidthToSelection 修改已选矢量并 onUpdateImage；从无色到非零宽度会补黑色描边。无选区时只设后续参数。')
    patch('costumes.paint-font-select', proposedDisposition='limited', proposedCommand='tw vector text-style <costume> --nodes <ids> --font <family>',
          sources=[S('containers/font-dropdown.jsx',58,144,PAINT)],
          effect='下拉悬停预览字体，选择后 onUpdateImage 将选中文本字体写入资产；点外部恢复原字体。系统字体/字体内联需对拍。')
    patch('sprites.add.choose-item', reviewNotes=['sprites.json 清单本地存在，不等于所有库资产字节离线可用；冻结资产缺口见未验收清单。'])
    # Split previously bundled actions and preserve old aggregate IDs as non-counting aliases.
    for old,new,needle in [('code-ws.zoom-in','放大','Blockly.ZoomControls.prototype.createZoomInSvg_'),('code-ws.zoom-out','缩小','Blockly.ZoomControls.prototype.createZoomOutSvg_'),('code-ws.zoom-reset','重置','Blockly.ZoomControls.prototype.createZoomResetSvg_')]:
        add(old,'code-workspace',f'工作区{new}','点击右下对应缩放按钮',[at(BLOCKS+'core/zoom_controls.js',needle,after=65)],'只改 workspace.scale/scroll 与编辑器 metrics，不入 sb3。',disposition='not-applicable')
    add('code-ws.execute-stack','code-workspace','点击脚本/报告器运行或查看值','点击可执行积木堆或报告器',[at(BLOCKS+'core/gesture.js','doBlockClick_ =',after=35),at(VM+'virtual-machine.js','blockListener (',after=12)],'触发 Blockly stackclick→VM toggleScript；报告器值气泡由执行结果显示，不是单纯选中。','tw run stack <target> <block>')
    add('code-ws.note-preview','code-workspace','音符字段琴键试听','点击音符弹窗琴键',[S('core/field_note.js',682,692,BLOCKS),S('lib/blocks.js',336,338)],'发 PLAY_NOTE 供音频层播放；D1 输出文件替代设备播放，没有采集。','tw audio note <midi> --out <wav>','limited',note='音符包络/时序/音频设备预览对拍未验收。')
    add('code-ws.help','code-workspace','积木 Help 项','积木右键→Help（有 helpUrl 才启用）',[S('core/contextmenu.js',260,270,BLOCKS)],'打开 block.helpUrl；核心块多为禁用，动态扩展可启用。',disposition='not-applicable',visibility='extension-dependent')
    add('stage.keyboard.down','stage-controls','项目键盘按下输入','非文本输入时键盘 keydown',[S('lib/vm-listener-hoc.jsx',159,171)],'向 VM keyboard IO 注入 key/isDown；影响 when key pressed 与 key pressed?。','tw input key <key> down')
    add('stage.keyboard.up','stage-controls','项目键盘释放输入','键盘 keyup',[S('lib/vm-listener-hoc.jsx',202,212)],'向 VM keyboard IO 注入 isDown:false。','tw input key <key> up')
    add('sprites.stage-select','sprites','选中舞台编辑目标','单击舞台缩略图',[S('containers/stage-selector.jsx',81,83),S('containers/target-pane.jsx',103,108)],'setEditingTarget(stage.id)，使后续命令作用于舞台。','tw sprite select Stage')
    add('sounds.share-to-stage','sounds','拖声音到舞台卡','声音条目拖到舞台卡释放',[S('containers/stage-selector.jsx',134,139)],'shareSoundToTarget(index, stageId)，舞台获得声音克隆。','tw sound share <sound> --to Stage')
    add('project-io.backpack-code-to-stage','project-io','背包代码投放舞台','BACKPACK_CODE 拖到舞台卡释放',[S('containers/stage-selector.jsx',140,158)],'取出 standalone blocks 并 shareBlocksToTarget(stageId)；旧本地背包迁移受 D4 限制。','tw block import <json> --target Stage','limited')
    # Monitor list inline edits and prompts (the stage.monitor.* IDs are moved without duplication).
    mp='monitors-prompts'
    add('monitor.list.activate',mp,'激活列表项编辑','单击可编辑列表行',[S('containers/list-monitor.jsx',34,45)],'设置 activeIndex/activeValue，仅 UI；后续提交见 monitor.list.edit。',disposition='not-applicable')
    add('monitor.list.edit',mp,'提交列表项文本','编辑列表输入框后失焦；Tab/方向键/Enter 先提交',[S('containers/list-monitor.jsx',47,63),S('containers/list-monitor.jsx',109,114)],'将 activeValue 字符串写入变量数组指定索引。','tw list set-item <list> <index> <text>')
    for direction,shift,offset in [('below',False,1),('above',True,0)]:
        add(f'monitor.list.insert-{direction}',mp,'插入空列表项（'+('下方' if offset else '上方')+'）',('Shift+' if shift else '')+'Enter',[S('containers/list-monitor.jsx',91,106)],'先提交当前项，再 slice/concat 在指定位置插入空字符串并激活新项。',f'tw list insert <list> <index{ "+1" if offset else "" }> ""')
    add('monitor.list.navigate',mp,'列表编辑上下导航','Tab/Shift+Tab/ArrowUp/ArrowDown',[S('containers/list-monitor.jsx',70,90)],'提交未完成编辑后 wrap 索引移动焦点；焦点本身不需 CLI。',disposition='not-applicable')
    add('monitor.list.remove',mp,'删除列表项','激活行内删除按钮',[S('containers/list-monitor.jsx',116,130)],'slice/concat 删除索引并 setVariableValue。','tw list delete-item <list> <index>')
    add('monitor.list.append',mp,'追加空列表项','列表底部 + 按钮',[S('components/monitor/list-monitor.jsx',28,34),S('containers/list-monitor.jsx',132,142)],'数组末尾追加空字符串并激活新行。','tw list append <list> ""')
    add('monitor.list.resize',mp,'调整列表监视器宽高','拖动列表底部 = 手柄',[S('containers/list-monitor.jsx',144,171)],'宽钳至[100,stageWidth]，高钳至[60,stageHeight]；松手 requestUpdateMonitor 写 width/height。','tw monitor set <list> width/height <n>')
    add('monitor.list.scroll',mp,'列表滚动','列表内容滚轮/滚动条',[at(GUI+'components/monitor/list-monitor-scroller.jsx','scroll',before=3,after=10)],'只改变虚拟列表滚动/显示行，无变量数据变化。',disposition='not-applicable')
    add('monitor.menu.open',mp,'打开监视器右键菜单','右键或符合条件时长按',[S('components/monitor/monitor.jsx',44,48)],'只弹 react-contextmenu；模式/导入/导出/隐藏见 stage.monitor.*。',disposition='not-applicable')
    for suffix,name,needle,effect in [('name','输入变量/列表名称','handleChange (','缓冲 inputValue，确认后作为变量创建/改名参数。'),('scope','选择全局/本角色作用域','handleScopeOptionSelection (','缓冲 globalSelected，舞台或云变量要求全局。'),('cloud','选择云变量','handleCloudVariableOptionChange (','缓冲 cloudSelected；勾选强制 globalSelected=true；实际创建见 code-ws.make-variable。')]:
        add('prompt.variable.'+suffix,mp,name,'变量/列表 Prompt 中输入或选择',[at(GUI+'containers/prompt.jsx',needle,after=8)],effect,disposition='not-applicable')
    add('prompt.variable.cancel',mp,'取消变量/列表 Prompt','Cancel/关闭按钮',[S('containers/prompt.jsx',42,44)],'关闭弹窗，不创建变量/列表。',disposition='not-applicable')
    alias('prompt.variable.ok',['code-ws.make-variable','code-ws.make-list','code-ws.variable-rename'],'同一创建/改名提交入口；避免把弹窗 OK 再计为额外变更。')
    add('prompt.slider.cancel',mp,'取消滑块范围设置','Cancel/无效输入后 OK',[S('containers/slider-prompt.jsx',30,55)],'无效范围回调 onCancel；有效确认归 stage.monitor.menu-slider-range。',disposition='not-applicable')
    add('prompt.username.reset',mp,'重置用户名','用户名 modal Reset 按钮',[S('containers/tw-username-modal.jsx',48,52)],'桌面版将 VM userData 用户名设为 player 并清 invalid。','tw username player')
    add('prompt.username.cancel',mp,'取消用户名设置','Cancel/关闭 modal',[S('containers/tw-username-modal.jsx',39,41)],'关闭，不提交缓冲值。',disposition='not-applicable')
    for typ,needle,effect in [('text','const input = document.createElement','缓存字符串；不改调用方直到确认。'),('ok',"if (e.key === 'Enter')",'resolve(input.value) 交给调用方，如任意帧率/CSV 列/文件夹名；具体变更在调用方动作。'),('cancel',"if (e.key === 'Escape')",'resolve(null)，Esc/Cancel/点击背景都取消。')]:
        add('prompt.desktop.'+typ,mp,'桌面异步 prompt '+typ,'输入；Enter/OK；Esc/Cancel/背景（按类型）',[at(DESKTOP+'src-renderer-webpack/editor/prompt/prompt.js',needle,after=8)],effect,disposition='not-applicable')
    for typ,start,end,effect in [('alert-ok',12,21,'关闭原生 alert，只阅读错误/通知，无项目写入。'),('confirm',28,40,'OK→true，Cancel→false；调用方据此继续/拒绝，CLI 显式参数避免交互。')]:
        add('prompt.native.'+typ,mp,'原生 '+typ,'Electron 信息框 OK/Cancel',[S('src-main/prompts.js',start,end,DESKTOP)],effect,disposition='not-applicable')
    for suffix,name,needle in [('label','添加过程标签','handleAddLabel ('),('boolean','添加布尔参数','handleAddBoolean ('),('number-text','添加文本/数字参数','handleAddTextNumber ('),('warp','切换不刷新屏幕','handleToggleWarp (')]:
        add('prompt.procedure.'+suffix,mp,name,'Make/Edit Block 弹窗对应按钮/复选框',[at(GUI+'containers/custom-procedures.jsx',needle,after=8)],'修改弹窗 mutationRoot，OK 后作为过程 mutation 写回；取消不提交。','tw proc edit <name> --params/--warp <spec>')
    add('prompt.procedure.cancel',mp,'取消过程编辑','Cancel/关闭',[S('containers/custom-procedures.jsx',113,119)],'不回传 mutation，原过程不变。',disposition='not-applicable')
    for suffix,needle,name in [('text','addLabelExternal','过程标签/参数名编辑'),('remove','removeField','删除过程标签/参数')]:
        candidates=[p for p in BY_NAME['procedures.js'] if '/scratch-blocks/core/' in p]
        if needle in read(candidates[0]):
            add('prompt.procedure.'+suffix+'-field',mp,name,'弹窗声明块字段编辑/×按钮',[at(candidates[0],needle,after=8)],'只修改临时声明 mutation；确认后同步调用者，命令为提案。','tw proc edit <name> --params <spec>')
    # All advanced/runtime options inside settings modal.
    settings=[('fps60','60 FPS','handleFramerateChange','vm.setFramerate(checked?60:30)','tw run --fps <30|60>'),('custom-fps','自定义帧率','handleCustomizeFramerate','解析有限浮点再 setFramerate','tw run --fps <n>'),('high-quality-pen','高质量画笔','handleHighQualityPenChange','renderer.setUseHighQualityRender','tw runtime set highQualityPen <bool>'),('interpolation','插值','handleInterpolationChange','vm.setInterpolation','tw runtime set interpolation <bool>'),('infinite-clones','无限克隆','handleInfiniteClonesChange','maxClones=Infinity 或 300','tw runtime set maxClones <n>'),('fencing','移除围栏','handleRemoveFencingChange','runtimeOptions.fencing=!checked','tw runtime set fencing <bool>'),('misc-limits','移除其他限制','handleRemoveLimitsChange','runtimeOptions.miscLimits=!checked','tw runtime set miscLimits <bool>'),('warp-timer','Warp Timer','handleWarpTimerChange','compilerOptions.warpTimer=checked','tw runtime set warpTimer <bool>'),('compiler','禁用编译器','handleDisableCompilerChange','compilerOptions.enabled=!checked','tw run [--compile]'),('stage-width','舞台宽','handleStageWidthChange','setStageSize(value,currentHeight)','tw stage size <width> <height>'),('stage-height','舞台高','handleStageHeightChange','setStageSize(currentWidth,value)','tw stage size <width> <height>'),('store-options','保存项目选项','handleStoreProjectOptions','storeProjectOptions 将配置写入舞台配置注释，影响重新加载后的设置','tw runtime store-options')]
    for suffix,name,needle,effect,cmd in settings:
        add('settings.'+suffix,mp,name,'高级设置对应复选框/数字输入/自定义 prompt/保存按钮',[at(GUI+'containers/tw-settings-modal.jsx',needle+' (',after=8)],effect+'；非所有选项自动持久化，保存项目选项是独立操作。',cmd)
    add('settings.close',mp,'关闭高级设置','×/关闭 modal',[S('containers/tw-settings-modal.jsx',166,168)],'关闭 UI，已立即执行的 runtime 改动不回滚。',disposition='not-applicable')
    add('settings.help',mp,'展开设置帮助','各选项 ? 按钮',[S('components/tw-settings-modal/settings-modal.jsx',49,83)],'切换内联帮助/文档，不改变 VM。',disposition='not-applicable')
    # Project IO, restore points and desktop shell are kept inside the four requested supplemental areas.
    io='project-io'
    for suffix,name,start,end,cmd,effect in [('open-path','桌面命令行/文件关联打开本地项目',40,45,'tw open <file>','读取本地文件，gui loadProject；sb/sb2/sb3 类型由解析器判定，CLI 当前不能冒称老格式支持。'),('open-url','打开直接 HTTP(S) 项目',48,54,'tw open-url <url> --allow net:<host>','privilegedFetch 整体项目；网络权限提案未实现。'),('open-scratch','打开 Scratch 项目 URL',56,65,'tw open-scratch <id> --allow net:scratch.mit.edu','先 API metadata/project_token，再 projects.scratch 下载并取标题。'),('open-sample','打开离线扩展示例',68,94,'tw open-sample <name>','只允许 dist-extensions/samples 内路径并 Brotli 解压。')]:
        add('project-io.'+suffix,io,name,'桌面启动参数/第二实例/文件关联或扩展样例链接',[S('src-main/windows/editor.js',start,end,DESKTOP),S('src-renderer-webpack/editor/gui/desktop-hoc.jsx',117,151,DESKTOP)],effect,cmd)
    add('project-io.close-dirty-stay',io,'关闭时保留未保存项目','关闭窗口脏项目提示→Stay',[S('src-main/windows/editor.js',251,284,DESKTOP)],'取消退出，保留当前项目；零交互 CLI 默认拒绝丢弃。','tw session close # 提案：dirty 时拒绝')
    add('project-io.close-dirty-discard',io,'关闭时丢弃未保存项目','同提示→Leave',[S('src-main/windows/editor.js',267,282,DESKTOP)],'destroy 窗口，放弃未保存变更；CLI --force 为提案等价。','tw session close --force')
    add('project-io.drop-project-file',io,'项目文件拖放打开（未确认）','OS 项目文件拖入编辑器',[S('src-main/windows/editor.js',561,565,DESKTOP),S('lib/sb-file-uploader-hoc.jsx',126,167)],'存在拖放路径权限 IPC 与文件上传管线，但未找到 GUI 项目 .sb3 drop 接线；asset drag-drop addon 不等于 project drop。',disposition='pending',note='源码未确认真实项目 drop 入口；保留候选，不计为已确认动作或已实现能力。',kind='unconfirmed-candidate')
    for suffix,name,needle,effect,cmd in [('restore-create','手动创建还原点','handleClickCreate (','生成 VM 项目/资产/缩略图快照，写 IndexedDB；CLI 新快照文件提案。','tw restore-point create --out <file>'),('restore-delete','删除单个还原点','handleClickDelete (','confirm 后删除快照，不可撤销；D4 旧库迁移不由 CLI 解析。','tw restore-point delete <id> --force'),('restore-delete-all','删除全部还原点','handleClickDeleteAll (','confirm 后清理全部还原点/资产库。','tw restore-point clear --force'),('restore-export','导出还原点 sb3','handleClickExport (','exportRestorePoint 还原资产 zip 后下载 .sb3，不加载 VM。','tw restore-point export <id> --out <sb3>'),('restore-load','加载还原点','handleClickLoad (','脏项目 confirm 后整体替换 VM，setFileHandle(null)，重新渲染。','tw restore-point load <id> [--force]'),('restore-interval','自动还原间隔','handleChangeInterval (','持久化间隔，重新安排自动快照计时器；不是 cron/外部任务。','tw restore-point interval <ms>')]:
        add('project-io.'+suffix,io,name,'还原点 modal 对应按钮/选择框',[at(GUI+'containers/tw-restore-point-manager.jsx',needle,after=25)],effect,cmd,'limited',note='D4：只映射新文件库；旧 IndexedDB 数据导出/迁移由桌面版负责；缩略图及自动计时仍待验收。')
    add('project-io.restore-list',io,'查看还原点列表','打开还原点 modal 后列表',[at(GUI+'containers/tw-restore-point-manager.jsx','refreshState ()',after=18)],'读取快照 metadata/thumbnail；CLI 文件库 list 提案。','tw restore-point list','limited')
    add('project-io.restore-close',io,'关闭还原点管理','×/关闭',[S('containers/tw-restore-point-manager.jsx',380)],'关闭 modal，不删除快照。',disposition='not-applicable')
    for suffix,name,needle,effect,cmd,disp in [('toggle','展开/收起背包','handleToggle (','只改 expanded 并通知 resize。',None,'not-applicable'),('more','加载更多背包条目','handleMore (','读取下一页本地 IndexedDB 内容；D4 迁移有限。','tw backpack list --offset <n>','limited'),('delete','删除背包条目','handleDelete (','删除本地库条目。','tw backpack delete <id>','limited'),('rename','重命名背包条目','handleRename (','prompt 后 updateBackpackObject 改名。','tw backpack rename <id> <name>','limited')]:
        add('project-io.backpack-'+suffix,io,name,'背包标题/更多按钮/条目右键菜单',[at(GUI+'containers/backpack.jsx',needle,after=20),S('lib/backpack-api.js',8,28)],effect,cmd,disp)
    for typ,needle,cmd in [('costume','costumePayload','tw backpack add-costume <target> <costume>'),('sound','soundPayload','tw backpack add-sound <target> <sound>')]:
        add('project-io.backpack-store-'+typ,io,'拖'+typ+'保存到背包','从资产列表拖条目至背包释放',[at(GUI+'containers/backpack.jsx',needle,after=8),S('containers/backpack.jsx',104,155)],'构造资产 payload/缩略图并 saveBackpackObject 到 _local_；D4。',cmd,'limited')
    for suffix,name,line in [('code','代码',337),('costumes','造型/背景',353),('sounds','声音',375)]:
        add('project-io.tab-'+suffix,io,'切换'+name+'标签页','点击编辑器对应 Tab',[S('components/gui/gui.jsx',line,min(line+10,read(GUI+'components/gui/gui.jsx').count('\n')))],'只改 GUI activeTab，CLI 操作由显式 command/target 参数替代。',disposition='not-applicable')
    for suffix,needle,name,effect in [('invalid-close','onClose:','关闭无效项目提示','关闭 modal，不加载文件。'),('invalid-restore','onClickRestorePoints:','从无效项目提示打开还原点','关闭错误 modal、打开还原点列表。')]:
        add('project-io.'+suffix,io,name,'无效项目错误 modal 对应按钮',[at(GUI+'containers/tw-invalid-project-modal.jsx',needle,after=4)],effect,disposition='not-applicable')
    for suffix,needle,name in [('alert-close','handleOnCloseAlert (','关闭顶部告警'),('alert-reconnect','handleOnReconnect (','告警重连入口')]:
        add('project-io.'+suffix,io,name,'顶部告警 X/重新连接',[at(GUI+'containers/alert.jsx',needle,after=5)],'只关闭告警/打开连接 modal，真正连接另见 extension.device-connect。',disposition='not-applicable')
    add('project-io.alert-download',io,'错误告警下载项目','顶部告警 Download',[S('containers/alert.jsx',42,57),S('containers/sb3-downloader.jsx',84,93)],'调用 saveProjectSb3/downloadProject 保留项目数据。','tw export-sb3 <path>')
    # Mac native menu roles do not promise all version-dependent Electron submenus.
    native=[('about',19,23,'关于'),('settings',28,33,'桌面设置 Cmd+,'),('addons',35,39,'插件设置'),('services',44,44,'系统服务'),('hide',50,50,'隐藏应用'),('hide-others',53,53,'隐藏其他应用'),('unhide',56,56,'显示全部'),('quit',62,62,'退出应用'),('new-window',70,75,'新建窗口 Cmd+N'),('close-window',86,91,'关闭窗口 Cmd+W'),('reload',104,112,'重新加载 Cmd+R'),('devtools',114,114,'开发者工具'),('reset-zoom',120,120,'重置窗口缩放'),('zoom-in',123,123,'窗口放大'),('zoom-out',126,126,'窗口缩小'),('fullscreen',132,132,'OS 全屏'),('window-menu',137,137,'系统窗口菜单'),('learn-more',143,147,'桌面站点')]
    for suffix,start,end,name in native:
        add('desktop.menu.'+suffix,io,name,'macOS 原生应用菜单对应项',[S('src-main/menu-bar.js',start,end,DESKTOP)],'Electron 窗口/系统 role 或外链；不改变项目。关闭/退出的脏数据确认单独登记。',disposition='not-applicable',visibility='macOS-only')
    alias('desktop.menu.package','mb.file.package','原生菜单与 GUI 打包均调用 PackagerWindow.forEditor；同能力合并并保留原生触发证据。')
    ACTIONS['mb.file.package']['sources'].append(S('src-main/menu-bar.js',77,84,DESKTOP))
    ACTIONS['mb.file.package']['ref']=refstr(ACTIONS['mb.file.package']['sources'])
    for suffix,name,needle,effect in [('edit-role','系统 Edit 菜单','role: \'editMenu\'','Electron 默认文本剪切/复制/粘贴/全选角色；版本依赖，无项目级独立操作。'),('context-spelling','替换拼写建议','webContents.replaceMisspelling','替换编辑输入文本；是否写项目由各输入框提交决定。'),('context-dictionary','加入拼写字典','addWordToSpellCheckerDictionary','写 Electron spellchecker 字典，不是项目数据。'),('context-open-link','右键打开链接','openExternal(url)','打开系统浏览器外链。'),('context-cut','文本剪切','webContents.cut()','写 OS clipboard 并剪切当前文本，后续提交语义归字段。'),('context-copy','文本复制','clipboard.writeText(text)','只写 OS clipboard。'),('context-paste','文本粘贴','webContents.paste()','粘贴至当前文本，后续提交语义归字段。')]:
        path=DESKTOP+('src-main/menu-bar.js' if suffix=='edit-role' else 'src-main/context-menu.js')
        add('desktop.'+suffix,io,name,'原生菜单/文本右键对应项',[at(path,needle,before=3,after=3)],effect,disposition='not-applicable')
    # User-visible desktop preferences: ten UI fields, not sixteen internal config metadata keys.
    prefs=[('updateChecker','更新通道',39,42,'commanded'),('crashDumps','崩溃转储级别',44,47,'limited'),('microphone','麦克风设备',60,63,'limited'),('camera','摄像头设备',65,68,'limited'),('hardwareAcceleration','硬件加速',70,73,'not-applicable'),('backgroundThrottling','后台节流',75,79,'not-applicable'),('bypassCORS','绕过 CORS',81,84,'commanded'),('spellchecker','拼写检查',86,90,'not-applicable'),('exitFullscreenOnEscape','Esc 退出全屏',92,95,'not-applicable'),('richPresence','Discord Rich Presence',97,105,'limited')]
    for key,name,start,end,disp in prefs:
        add('desktop.pref.'+key,io,name,'桌面设置对应选择框/复选框',[S('src-main/windows/desktop-settings.js',start,end,DESKTOP)],'写 tw_config.json v2.'+key+'；CLI 写配置不代表对应 Electron/Discord/媒体副作用已实现。',f'tw pref set {key} <value> --config <path>' if disp!='not-applicable' else None,disp)
    for suffix,start,end,name in [('open-user-data',107,109,'打开用户数据目录'),('open-crash-dumps',111,118,'打开崩溃目录')]:
        add('desktop.'+suffix,io,name,'桌面设置底部按钮',[S('src-main/windows/desktop-settings.js',start,end,DESKTOP)],'shell.showItemInFolder；崩溃目录可先 mkdir。无项目操作。',disposition='not-applicable')
    add('desktop.rich-presence-docs',io,'Rich Presence 文档','点击设置页说明链接',[S('src-renderer/desktop-settings/desktop-settings.html',316,316,DESKTOP)],'只打开外链。',disposition='not-applicable')
    for suffix,start,end,name,cmd,disp in [('update-download',28,35,'下载新桌面版',None,'not-applicable'),('update-ignore',37,62,'忽略当前更新','tw pref set ignoredUpdate/ignoredUpdateUntil <value> --config <path>','limited'),('update-close',64,66,'关闭更新提示（临时忽略）','tw pref set ignoredUpdateUntil <time> --config <path>','limited')]:
        add('desktop.'+suffix,io,name,'更新窗口 Download/Ignore/关闭；Ignore 可带永久复选框',[S('src-main/windows/update.js',start,end,DESKTOP)],'打开更新站点或记录忽略版本/截止时间（安全更新不能永久忽略）；CLI 不负责桌面安装。',cmd,disp)
    add('desktop.advanced-customizations',io,'加载用户脚本/样式文件','用户把 userscript.js/userstyle.css 放在桌面数据目录后重开编辑器',[S('src-main/windows/editor.js',546,559,DESKTOP)],'读用户 JS/CSS 并在 GUI 注入；任意 DOM 插件无 headless 等价（D6）。',disposition='dom-only',visibility='user-file-dependent')
    # Paint tools: separate mode selection, real asset edits, and non-persisting view controls.
    pa='paint-tools'
    vector=['select','reshape','brush','eraser','fill','text','line','ellipse','rectangle']
    bitmap=['brush','line','ellipse','rectangle','text','fill','eraser','select']
    for fmt,names in [('vector',vector),('bitmap',bitmap)]:
        for idx,tool in enumerate(names):
            base=141+idx*3 if fmt=='vector' else 174+idx*3
            add(f'paint.{fmt}.choose-{tool}',pa,f'{fmt} 选择 {tool} 工具','点击对应工具图标或无修饰键快捷键',[S('components/paint-editor/paint-editor.jsx',139,169,PAINT) if fmt=='vector' else S('components/paint-editor/paint-editor.jsx',172,200,PAINT),S('hocs/keyboard-shortcuts-hoc.jsx',19,40,PAINT)],'只改当前 mode，不改资产；后续绘制结果有独立动作。',disposition='not-applicable')
    tools=[('vector','brush','helper/blob-tools/blob.js','this.tool.onMouseDown','沿轨迹构造 Paper blob 路径，松手 onUpdateImage 导出 SVG。'),('vector','erase','containers/eraser-mode.jsx','this.blob.activateTool','isEraser=true 通过 blob 布尔路径擦除，重写 SVG。'),('vector','fill','helper/tools/fill-tool.js','handleMouseDown (','命中填充/描边区域，修改纯色/渐变并 onUpdateImage。'),('vector','text','helper/tools/text-tool.js','handleTextInput (','textarea 更新 PointText 内容，提交 SVG；空文本会删除。'),('vector','line','containers/line-mode.jsx','onMouseDown (','创建/续接矢量线，Shift 约束角度；更新 SVG。'),('vector','ellipse','helper/tools/oval-tool.js','handleMouseDown (','拖起终点生成椭圆，Shift/Alt 约束；更新 SVG。'),('vector','rectangle','helper/tools/rect-tool.js','handleMouseDown (','拖起终点生成矩形，Shift/Alt 约束；更新 SVG。'),('bitmap','brush','helper/bit-tools/brush-tool.js','handleMouseDown (','离散印章沿轨迹画位图，更新 PNG。'),('bitmap','erase','containers/bit-eraser-mode.jsx','isEraser','通过 isEraser 位图刷擦除 alpha，更新 PNG。'),('bitmap','fill','helper/bit-tools/fill-tool.js','handleMouseDown (','连通区域 flood fill，可遮罩渐变；更新 PNG。'),('bitmap','text','helper/tools/text-tool.js','handleTextInput (','PointText 最终栅格合成入 PNG，不保留可编辑矢量文字。'),('bitmap','line','helper/bit-tools/line-tool.js','handleMouseDown (','按线段轨迹位图绘制，更新 PNG。'),('bitmap','ellipse','helper/bit-tools/oval-tool.js','handleMouseDown (','实心/空心椭圆栅格化合成，更新 PNG。'),('bitmap','rectangle','helper/bit-tools/rect-tool.js','handleMouseDown (','实心/空心矩形栅格化合成，更新 PNG。')]
    for fmt,tool,rel,needle,effect in tools:
        disp='limited' if tool in ['brush','erase','fill','text'] or fmt=='bitmap' else 'commanded'
        add(f'paint.{fmt}.{tool}',pa,fmt+' '+tool+' 编辑','选择工具后按下/拖动/松手；文本输入后提交',[at(PAINT+rel,needle,after=30),S('containers/paint-editor-wrapper.jsx',48,63)],effect+' rotationCenter/assetId/md5 随持久化管线更新。',f'tw {fmt} {tool} <costume> --spec <json> --out <sb3>',disp,note='数值轨迹/抗锯齿/字体/像素对拍仍未验收；replace-image 不是完整工具等价。' if disp=='limited' else None)
    for suffix,name,rel,needle,effect in [('move','移动选区','helper/selection-tools/move-tool.js','onMouseDrag (','平移选中 Paper items；位图提交选区 raster。'),('scale','缩放选区','helper/selection-tools/scale-tool.js','onMouseDrag (','拖包围盒角/边，Alt 从中心、Shift 改比例约束。'),('rotate','旋转选区','helper/selection-tools/rotate-tool.js','onMouseDrag (','拖旋转柄，按角度旋转并 onUpdateImage。'),('clone','Alt 拖动复制选区','helper/selection-tools/move-tool.js','if (hitProperties.clone)','cloneSelection 再移动；新图形进入 SVG/PNG。'),('nudge','方向键微移选区','helper/selection-tools/nudge-tool.js','onKeyDown (','按 1/view.zoom，Shift 乘倍数；keyup onUpdateImage。'),('reshape-point','拖控制点','helper/selection-tools/point-tool.js','onMouseDrag (','改路径 segment.point 及相邻手柄，写 SVG。'),('reshape-handle','拖贝塞尔手柄','helper/selection-tools/handle-tool.js','onMouseDrag (','改 handleIn/Out；Alt 可解除共线耦合，写 SVG。')]:
        add('paint.selection.'+suffix,pa,name,'选择/变形模式对应鼠标/键盘动作',[at(PAINT+rel,needle,after=25)],effect,'tw vector transform <costume> --nodes <ids> --op '+suffix+' --spec <json>')
    add('paint.reshape.insert-point',pa,'路径中插入控制点','变形工具点击路径边',[S('helper/selection-tools/reshape-tool.js',250,264,PAINT)],'在命中曲线上插入 segment，onUpdateImage 更新 SVG。','tw vector point-add <costume> --path <id> --at <offset>')
    for suffix,name,needle in [('pan','平移画布','handleDragMove ('),('wheel','滚轮移动/缩放','handleWheel ('),('horizontal-scroll','横滚动条','handleHorizontalScrollbarMouseMove ('),('vertical-scroll','竖滚动条','handleVerticalScrollbarMouseMove (')]:
        add('paint.view.'+suffix,pa,name,'空格/中键拖拽；滚轮；拖对应滚动条',[at(PAINT+'containers/scrollable-canvas.jsx',needle,after=18)],'只改 paper.view/viewBounds；不写资产。',disposition='not-applicable')
    for suffix,start,end in [('zoom-out',272,282),('zoom-reset',283,293),('zoom-in',294,304)]:
        add('paint.view.'+suffix,pa,suffix,'点击右下缩放按钮',[S('components/paint-editor/paint-editor.jsx',start,end,PAINT)],'改 paper.view 缩放，不写图像。',disposition='not-applicable')
    for suffix,name,needle,effect in [('alpha','颜色透明度','handleAlphaChange (','alpha=0 走透明色；否则更新 rgba/hex，选中图形在颜色面板关闭时持久化。'),('transparent','设为透明/无色','handleTransparent (','onChangeColor(null)；有选区时删除填充/描边，无选区时为后续参数。'),('gradient-horizontal','水平渐变','handleChangeGradientTypeHorizontal (','applyGradientTypeToSelection(HORIZONTAL)，保存 SVG。'),('gradient-vertical','垂直渐变','handleChangeGradientTypeVertical (','同 VERTICAL。'),('gradient-radial','径向渐变','handleChangeGradientTypeRadial (','同 RADIAL。'),('solid','纯色填充','handleChangeGradientTypeSolid (','同 SOLID。')]:
        add('paint.color.'+suffix,pa,name,'颜色面板对应滑条/按钮',[at(PAINT+'containers/color-picker.jsx',needle,after=7),S('containers/color-indicator.jsx',33,104,PAINT)],effect,'tw vector style <costume> --'+suffix+' <value> --nodes <ids>')
    add('paint.color.swap',pa,'交换渐变两色','颜色面板交换按钮',[S('containers/color-indicator.jsx',116,131,PAINT)],'有选区 swapColorsInSelection 后持久化；无选区只交换绘制参数。','tw vector gradient-swap <costume> --nodes <ids>')
    for suffix,name,needle in [('primary','选择渐变第一色','onSelectColor: ('),('secondary','选择渐变第二色','onSelectColor2: (')]:
        add('paint.color.'+suffix,pa,name,'点击对应颜色 swatch',[at(PAINT+'containers/color-picker.jsx',needle,after=4)],'只改 colorIndex；具体颜色写入由颜色动作处理。',disposition='not-applicable')
    add('paint.text.cancel-font',pa,'取消字体悬停预览','字体菜单点外部',[S('containers/font-dropdown.jsx',127,144,PAINT)],'恢复 savedFont/选中文本，取消预览，不提交新资产。',disposition='not-applicable')
    add('paint.bitmap.selection-box',pa,'位图框选区域','位图选择工具拖矩形框',[S('helper/bit-tools/select-tool.js',93,140,PAINT)],'抽出区域为浮动选区；移动/离开时 commitSelectionToBitmap 写回；CLI 用显式 rect 参数。','tw bitmap select <costume> --rect <x,y,w,h>','limited')
    add('paint.vector.selection-box',pa,'矢量框选/Shift 多选','选择工具框选/Shift 点击',[at(PAINT+'helper/selection-tools/selection-box-tool.js','onMouseDown',after=15)],'只改选区，CLI 以 nodes 参数替代。',disposition='not-applicable')
    for suffix,name,rel,needle,effect,cmd,disp in [('add-system','添加系统字体','components/tw-fonts-modal/add-system-font.jsx','handleFinish (','fontManager.addSystemFont(name,fallback)；字体字节不嵌入，跨机不保证。','tw font add-system <family> --fallback <family>','limited'),('add-file','添加字体文件','components/tw-fonts-modal/add-custom-font.jsx','handleFinish (','读取 .ttf/.otf/.woff/.woff2，createAsset 后 addCustomFont，项目保存时带自定义字体资产。','tw font add <file> --name <name> --fallback <family>','commanded'),('delete','删除项目字体','components/tw-fonts-modal/manage-font.jsx','handleDelete (','确认后 fontManager.deleteFont(index)，影响项目字体清单。','tw font delete <index> --force','commanded'),('export','导出自定义字体','components/tw-fonts-modal/manage-font.jsx','handleExport (','downloadBlob(font.data) 原始字体字节。','tw font export <index> --out <file>','commanded')]:
        add('paint.font.'+suffix,pa,name,'字体管理 modal 相应按钮',[at(GUI+rel,needle,after=22)],effect,cmd,disp)
    add('paint.font.preview',pa,'字体预览文字','管理字体页预览输入',[S('components/tw-fonts-modal/font-playground.jsx',20,33)],'只改变预览文字，不改项目字体。',disposition='not-applicable')
    add('paint.font.close',pa,'返回/关闭字体管理','modal X/取消添加',[S('containers/tw-fonts-modal.jsx',33,52)],'有子页则退回清单，否则关闭 modal；不删除字体。',disposition='not-applicable')


def supplement_extensions_and_packager():
    ea='extensions-addons'
    add('extension.library-open',ea,'打开扩展库','编辑器底部 Add Extension 按钮',[S('components/gui/gui.jsx',404,415)],'打开 extensionLibrary modal；加载扩展为独立动作。',disposition='not-applicable')
    # Concrete builtins are finite; remote gallery and arbitrary extension callbacks are explicitly not finite.
    builtin=read(GUI+'lib/libraries/extensions/index.jsx')
    for m in re.finditer(r"extensionId: '([^']+)'",builtin):
        id=m[1]
        if id in ['custom_extension','procedures_enable_return','gallery']: continue
        line=builtin.count('\n',0,m.start())+1
        disp='limited' if id in ['videoSensing','faceSensing','text2speech','translate','microbit','ev3','boost','wedo2','gdxfor'] else 'commanded'
        reason=None
        if id in ['videoSensing','faceSensing']: reason='D7 实时相机采集仅限预录帧管道；模型/识别结果未对拍。'
        elif id in ['text2speech','translate']: reason='服务网络/语音输出依赖；冻结离线字节与 D5 host 授权仍待核验。'
        elif id in ['microbit','ev3','boost','wedo2','gdxfor']: reason='真实 Scratch Link/BLE/硬件连接未交付；不是把 D7 摄像头决定错误泛化到全部硬件。'
        add('extension.load.'+id,ea,'加载内置 '+id,'扩展库点击对应条目',[S('lib/libraries/extensions/index.jsx',line,line+9),S('containers/extension-library.jsx',142,158)],'未加载时 loadExtensionURL(id)，已加载时只选分类；blocks 可随项目引用扩展。','tw ext load '+id,disp,note=reason)
    add('extension.enable-returns',ea,'启用 TurboWarp 自制积木返回值','扩展库 Enable return 条目',[S('containers/extension-library.jsx',136,139)],'启用过程返回值并选 My Blocks 分类。','tw proc enable-returns')
    add('extension.gallery-load',ea,'加载远程扩展库条目','扩展库点击画廊扩展',[S('containers/extension-library.jsx',44,85),S('containers/extension-library.jsx',142,158)],'远程 metadata→URL→extensionManager；动态目录不是冻结 builtin 清单。','tw ext load-url <url> --allow net:<host>','pending',note='远程画廊动态版本/回调/可执行权限未逐扩展确认；不把 manifest 本身当完整行为证据。')
    add('extension.gallery-refresh',ea,'扩展库读取画廊 metadata','打开库触发自动请求',[S('containers/extension-library.jsx',99,122)],'请求 extensions-v0.json，缓存成功结果/超时/错误展示。','tw ext gallery list --allow net:extensions.turbowarp.org','limited',kind='automatic-after-action')
    for suffix,needle,effect in [('search','handleFilterChange (','过滤 name/tags。'),('tag','handleTagClick (','选择扩展标签。'),('close','handleClose (','关闭扩展库。')]:
        add('extension.library-'+suffix,ea,'扩展库 '+suffix,'库搜索框/标签/×',[at(GUI+'components/library/library.jsx',needle,after=8)],effect+' 仅 UI 状态。',disposition='not-applicable')
    add('extension.library-favorite',ea,'收藏扩展库条目','条目星标',[S('components/library/library.jsx',100,113),S('containers/extension-library.jsx',180,190)],'写 tw:library-favorites:extensionLibrary，以 extensionId 持久化；D4 迁移有限。','tw library favorite --library extensionLibrary --item <id> --config <file>','limited')
    add('extension.docs',ea,'打开扩展文档','库条目 More info/扩展文档按钮',[S('containers/extension-library.jsx',77,81),S('containers/blocks.jsx',187,193),S('src-main/windows/editor.js',632,641,DESKTOP)],'主进程可将 extensions.turbowarp.org 文档打开为离线文档窗口，其余为外链。','tw ext doc <id>','limited')
    add('extension.sample-open',ea,'打开扩展示例项目','扩展库详情 sample 链接',[S('containers/extension-library.jsx',78,81),S('src-main/windows/editor.js',616,629,DESKTOP)],'新窗口载入离线示例；CLI 只加载项目并忽略开窗。','tw open-sample <name>')
    add('extension.gallery-home',ea,'查看更多扩展','扩展库 More/失败条目链接',[S('lib/libraries/extensions/index.jsx',443,496)],'打开扩展画廊网站，无项目操作。',disposition='not-applicable')
    for suffix,needle,name in [('url','handleSwitchToURL (','切换 URL 输入'),('file','handleSwitchToFile (','切换文件输入'),('text','handleSwitchToText (','切换源码文本输入')]:
        add('extension.custom-mode-'+suffix,ea,name,'自定义扩展 modal 对应 Tab',[at(GUI+'containers/tw-custom-extension-modal.jsx',needle,after=6)],'只改 type 与输入展示，不执行代码。',disposition='not-applicable')
    for suffix,name,start,end,cmd in [('url','从 URL 加载 JS',54,59,'tw ext load-url <url> --allow net:<host>'),('file','从本地文件加载 JS',61,64,'tw ext load-file <file> --allow extension:<id>'),('text','从文本加载 JS',66,70,'tw ext load-text --file <js> --allow extension:<id>')]:
        add('extension.custom-load-'+suffix,ea,name,'对应模式输入后 Enter/Load Extension',[S('containers/tw-custom-extension-modal.jsx',start,end),S('containers/tw-custom-extension-modal.jsx',123,145)],'转换为 URL/data URI 后顺序 loadExtensionURL；文件/文本可手动信任 unsandboxed，D5 零交互。',cmd,'pending',note='当前 CLI 默认拒绝任意可执行扩展；URL/file/text 沙箱差别及 fail-closed 授权未实现验收。')
    add('extension.custom-drop-files',ea,'拖扩展 JS 文件','自定义扩展 modal 拖入多个文件',[S('containers/tw-custom-extension-modal.jsx',182,191)],'只暂存 files 并切 file 模式；实际执行由 custom-load-file。',disposition='not-applicable')
    add('extension.custom-unsandboxed',ea,'选择非沙箱执行','文件/源码模式 unsandboxed 复选框',[S('containers/tw-custom-extension-modal.jsx',193,207),S('containers/tw-custom-extension-modal.jsx',128,139)],'暂存并持久化信任选项，加载时 manuallyTrustExtension；涉及执行权限，不是纯主题。','tw ext load-file <js> --unsandboxed --allow extension:<id>','pending',note='必须 fail-closed；无可验证 headless 沙箱/权限 CLI 实现，保留 unconfirmed。')
    add('extension.custom-cancel',ea,'取消自定义扩展输入','关闭 modal',[S('containers/tw-custom-extension-modal.jsx',112,114)],'关闭，不执行扩展。',disposition='not-applicable')
    device=[('scan','扫描外设','containers/scanning-step.jsx','componentDidMount (','scanForPeripheral，收集发现列表。'),('rescan','重新扫描','containers/scanning-step.jsx','handleRefresh (','清列表/重发 scanForPeripheral。'),('auto-scan','自动扫描并配对','containers/auto-scanning-step.jsx','handleStartScan (','scan 后列表非空时 onConnecting 第一个外设。'),('connect','连接选中外设','containers/connection-modal.jsx','handleConnecting (','connectPeripheral(extensionId, peripheralId)。'),('disconnect','断开外设','containers/connection-modal.jsx','handleDisconnect (','disconnectPeripheral 并关闭 modal。'),('cancel','取消连接流程','containers/connection-modal.jsx','handleCancel (','未连上时 disconnectPeripheral 停止扫描并关闭 modal。'),('update','更新 micro:bit 固件','containers/connection-modal.jsx','handleSendUpdate (','selectAndUpdateMicroBit，实际写设备固件；范围不应藏入 dom-only。')]
    for suffix,name,rel,needle,effect in device:
        add('extension.device-'+suffix,ea,name,'连接 modal 对应 Scan/Refresh/外设条目/Disconnect/Cancel/Update',[at(GUI+rel,needle,after=20)],effect,'tw device '+suffix+' --extension <id> --peripheral <id>','limited',note='静态接线已核实；真实设备/权限/失败恢复、固件文件与三平台验收未覆盖。')
    add('extension.device-update-open',ea,'进入固件更新说明','连接 modal Update peripheral',[S('containers/connection-modal.jsx',111,119)],'只改 phase=updatePeripheral；发送固件另见 device-update。',disposition='not-applicable')
    add('extension.device-help',ea,'外设帮助','连接 modal Help',[S('containers/connection-modal.jsx',103,110)],'打开 extension.helpLink 外链。',disposition='not-applicable')
    # Each permission request has an explicit allow and deny ID, not one umbrella "permissions done" claim.
    perms=[('load-extension','canLoadExtensionFromProject','extension:<id>','commanded'),('fetch','canFetch','net:<host>','commanded'),('open-window','canOpenWindow','open-window:<url>','limited'),('redirect','canRedirect','redirect:<url>','limited'),('record-audio','canRecordAudio','audio-input','limited'),('record-video','canRecordVideo','video-input','limited'),('read-clipboard','canReadClipboard','clipboard-read','limited'),('notify','canNotify','notify','limited'),('geolocate','canGeolocate','location','limited'),('embed','canEmbed','embed:<url>','dom-only'),('download','canDownload','fs:<path>','commanded')]
    for typ,needle,permission,disp in perms:
        for choice in ['allow','deny']:
            add('permission.'+typ+'.'+choice,ea,typ+' '+choice,'扩展安全弹窗 '+choice+'（750ms 后按钮可用；关闭=deny）',[at(GUI+'containers/tw-security-manager.jsx','async '+needle+' (',after=18),S('containers/tw-security-manager.jsx',223,229),S('components/tw-security-manager-modal/security-manager-modal.jsx',64,86)],'resolve '+str(choice=='allow').lower()+' 给 VM securityManager；部分 allowed 值/host 仅会话缓存；D5 CLI 默认全 deny。',('tw run --allow '+permission if choice=='allow' and disp!='dom-only' else 'tw run # 默认 deny') if disp!='dom-only' else None,disp,note='授权决定不代表相机/剪贴板/通知/定位/开窗能力已交付；默认拒绝无需互动。')
    add('permission.load-extension.unsandboxed',ea,'项目扩展安全提示非沙箱选项','安全 modal 非沙箱复选框',[S('containers/tw-security-manager.jsx',243,250),S('containers/tw-security-manager.jsx',257,280)],'allow 且 unsandboxed 时信任此 URL；拒绝不能留下授权。','tw run --unsandboxed --allow extension:<id>','pending',note='任意 JS 权限边界尚未实现。')
    for typ,start,end in [('read-clipboard',133,141),('notifications',143,151)]:
        for choice in ['allow','deny']:
            add('permission.desktop-'+typ+'.'+choice,ea,'桌面 '+typ+' '+choice,'桌面原生安全窗口 Allow/Deny/关闭',[S('src-main/windows/security-prompt.js',99,108,DESKTOP),S('src-main/windows/security-prompt.js',start,end,DESKTOP)],'SecurityState 按窗口缓存允许；关闭返回 false。','tw run --allow '+typ if choice=='allow' else 'tw run # 默认 deny','limited')
    # Packager is compiled Svelte in the frozen desktop bundle. Real line 230 + exact field anchor,
    # not guessed line numbers or a claim that HTML/ZIP wrapper exposes every option.
    path=DESKTOP+'src-renderer/packager/standalone.html'
    line=read(path).splitlines()[229]
    fields=sorted(set(re.findall(r'\bl\.([\w.]+)(?:\[[^\]]+\])?=',line)) - {'__value','checked','value','reset'})
    for field in fields:
        add('package.option.'+field,'project-io','打包选项 '+field,'打包器相应 input/checkbox/select/文件按钮，[value] 更改',[source(path,230,anchor='l.'+field+'=') if 'l.'+field+'=' in line else source(path,230,anchor='l.'+field)],'更新 PackagerOptions.'+field+'（可影响输出页面、运行时或桌面封装）；这是真实 GUI 选项绑定，不是 tw package 已暴露接口。','tw package --opt '+field+'=<value>','commanded',note='提案；现有 CLI HTML/ZIP 固定配置并未覆盖此选项。输出/安全/默认值对拍未验收。')
    for suffix,name,term,effect,cmd,disp in [('export-options','导出打包配置','options.export','下载 PackagerOptions JSON。','tw package options export --out <json>','commanded'),('import-options','导入打包配置','options.import','解析配置、迁移字段，危险选项 confirm 后应用。','tw package options import <json> [--allow unsafe-options]','commanded'),('reset-options','重置打包配置','options.resetAll','还原全部配置为默认值。','tw package options reset','commanded'),('preview','预览打包项目','options.preview','生成预览窗口并执行打包运行时；文件输出可替代展示但窗口副作用有限。','tw package preview --out <html>','limited'),('build','生成打包输出','options.package','按 target/options 打包并下载结果，包括 HTML/ZIP/桌面多架构。','tw package <output> --target <target>','commanded')]:
        add('package.'+suffix,'project-io',name,'打包器对应按钮',[source(path,230,anchor=term),S('src-main/windows/packager.js',19,28,DESKTOP)],effect,cmd,disp,note='bundle 静态行为已登记；配置管线/全部 target 和跨平台产物尚未验收。')
    for suffix,name,needle in [('project-file','选择打包本地项目','input-for-remembering-project-file'),('project-editor','导入当前编辑器项目','import-project-with-port')]:
        add('package.'+suffix,'project-io',name,'打包器选择项目/从编辑器导入按钮',[source(path,7,anchor=needle) if suffix=='project-file' else S('src-main/windows/packager.js',19,28,DESKTOP)],'把项目字节作为打包输入；不更改源项目。','tw package --project <sb3> --out <output>')

# The target disposition is deliberately separate from implementation/acceptance.
# Four complex semantic patches keep disposition=pending and a concrete proposed category/reason.
ADDON_DEFINITIONS = {
'2d-color-picker': ('commanded','二维 SV 取色是确定数值输入，不能因 DOM 控件把最终颜色编辑排除；映射为显式颜色参数。','paint-editor.js','const setColor ='),
'better-img-uploads': ('limited','Canvas 解码/重绘/尺寸 full-fill-fit 后包 SVG；文件管道可做，浏览器转码/色彩/fit 对拍未确认。','userscript.js','async function onchange'),
'bitmap-copy': ('limited','只支持一个 Raster；复制 PNG 到系统剪贴板可用显式文件输出替代，不承诺 OS clipboard/D5 权限。','userscript.js','const dataURL ='),
'block-cherry-picking': ('commanded','Ctrl 单块 unplug(true) 会 healing 原堆连接；命令应区分单块与整堆。','../block-duplicate/module.js','if (isCherryPicking)'),
'block-count': ('commanded','统计 VM 独立 sprite blocks，不是纯文字装饰；只读 JSON/count 可移植。','blockcount.js','let sprites ='),
'block-duplicate': ('commanded','Alt 复制 XML/重分配 ID/发 BlockCreate；Ctrl+Alt 单块不复制后续堆。','module.js','if (isDuplicating)'),
'block-palette-icons': ('not-applicable','只改积木分类图标 CSS，不更改项目/运行数据。','userstyle.css','.scratchCategoryItemBubble'),
'block-switching': ('pending','相关 opcode 切换含参数 remap、shadow、mutation/过程参数；有项目语义不能 dom-only，逐 opcode 转换与合法连接还未确认。','userscript.js','const menuCallbackFactory'),
'blocks2image': ('dom-only','输出取自实际 Blockly SVG、样式、字体/foreignObject；这是编辑器图像而非舞台渲染，D1 舞台 PNG 不等价。','userscript.js','Blockly'),
'cat-blocks': ('not-applicable','猫帽/眼睛/跟随鼠标只改变 block SVG 外观。','userscript.js','renderCatFace_'),
'clones': ('commanded','读取 runtime._cloneCounter 与 maxClones 的运行信息，可 JSON 统计；徽标布局排除。','userscript.js','const v ='),
'color-picker': ('commanded','实际 userscript 只调用 code-editorHandler；HEX 经过颜色字段回调写项目。paint-editor.js 在目录但未被 runtime 导入。','code-editor.js','const setColor ='),
'columns': ('not-applicable','只改变 Toolbox/Flyout 两列布局、尺寸与滚动展示。','userscript.js','Toolbox.prototype.position'),
'copy-reporter': ('limited','复制 monitor/reporter 的运行值到系统 clipboard；值输出可等价，OS clipboard 与 arbitrary reporter 求值待验收。','userscript.js','navigator.clipboard.writeText'),
'custom-block-shape': ('not-applicable','padding/notch/corner 仅 Blockly 渲染几何，无块图语义。','userscript.js','const BlockSvg'),
'custom-block-text': ('not-applicable','字号/粗体/阴影只改 block 文本样式。','userscript.js','const updateBlockly'),
'custom-menu-bar': ('not-applicable','菜单标签显隐 CSS，不移除 underlying project actions。','menu-icons.css','settings-menu_dropdown-label'),
'custom-zoom': ('not-applicable','只配置 workspace view zoom 与自动隐藏控制条，不入 sb3。','userscript.js','zoomOptions.maxScale'),
'data-category-tweaks-v2': ('not-applicable','Variables/List 分类布局与排序改 toolbox XML，不改项目变量/引用。','userscript.js','const DataCategory'),
'debugger': ('limited','日志/断点/线程/帧指标可命令化；源码明确 compiled thread 不可单步，暂停还涉及 clock/audio，GUI 图表与链接不复现。','module.js','if (thread.isCompiled)'),
'default-costume-editor-color': ('commanded','默认 fill/stroke/strokeSize 影响之后资产输出，应参数化绘制默认值；旧 redux/localStorage persistence 不迁移 D4。','userscript.js','addon.settings.addEventListener'),
'disable-paste-offset': ('commanded','pasteOffset=0 影响新图形的位置（SVG 内容），不是纯视觉。','userscript.js','CLEAR_PASTE_OFFSET'),
'disable-stage-drag-select': ('not-applicable','只限制 GUI 拖拽/编辑目标选择手势，CLI 显式 target/坐标操作不模拟手势 guard。','userscript.js','vm.getTargetIdForDrawableId'),
'drag-drop': ('commanded','文件拖放转发现有 asset/list/question 真实输入；等价显式文件路径，不依赖 OS DnD。','userscript.js','handleDrop'),
'editor-buttons-reverse-order': ('not-applicable','只改控件排列。','userstyle.css','stage-header_stage-menu-wrapper'),
'editor-colored-context-menus': ('not-applicable','contextmenu 色彩/边框只视觉。','userscript.js','sa-contextmenu-colored'),
'editor-comment-previews': ('not-applicable','悬停展示已有 comment text，不改注释/项目。','userscript.js','const getComment'),
'editor-compact': ('not-applicable','CSS 尺寸及 tooltip，纯布局。','userstyle.css','gui_body-wrapper'),
'editor-devtools': ('pending','Clean Up+ 可删除孤儿/未用变量、复制/剪切/引用替换都有项目语义；仅建清单尚未逐条确认 undo/连接/坐标，不能 dom-only。','DevTools.js','doCleanUp(block)'),
'editor-extra-keys': ('commanded','增加可保存键字段值，项目在未启用 addon 时也可读；命令 field/input 参数即可。','userscript.js','const block = ScratchBlocks.Blocks'),
'editor-number-arrow-keys': ('commanded','数值增量经 input 事件提交字段/属性，需复刻 modifier 步长、十进制精度与最大最小值。','userscript.js','document.body.addEventListener'),
'editor-searchable-dropdowns': ('commanded','不只过滤：源码能从搜索文本创建全局/局部变量/列表/广播并设字段引用；这些语义必须保留。','userscript.js','const variable = addonItem.createVariable'),
'editor-sounds': ('not-applicable','连接/删除块的 UI 音效，不是项目 sound 资产或 runtime 输出。','userscript.js','loadSounds_'),
'editor-square-inputs': ('not-applicable','只改变 input outputShape 渲染；不改变块 input 类型/项目语义。','userscript.js','OUTPUT_SHAPE_SQUARE'),
'editor-stage-left': ('not-applicable','Stage 左右布局及 flyout client rect，无项目变化。','stageleft.css','stage-header_stage-size-toggle-group'),
'editor-stepping': ('not-applicable','高亮当前执行块而非单步；noCompiler 为展示限制，不应冒称 debugger step 实现。','userscript.js','const threads ='),
'editor-theme3': ('not-applicable','积木配色/字体对比度，GUI 外观配置。','theme3.js','const Blockly ='),
'expanded-backpack': ('not-applicable','仅背包 grid 行数/缩略图及 resize；不存取背包内容。','backpack.css','backpack_backpack-list'),
'find-bar': ('limited','脚本/造型/声音查找可结构化；工作区滚动历史、Ctrl 跳转、DOM 定位不承诺。','userscript.js','getScratchBlocks'),
'folders': ('commanded','name 的 folder// 前缀及 target/costume/sound 重排实际入项目，不能以 DOM-only 删除；折叠 UI 排除。','userscript.js','const renameItems'),
'fullscreen': ('not-applicable','浏览器 FullscreenAPI/工具栏隐藏，窗口布局不改变项目。','userscript.js','requestFullscreen'),
'gamepad': ('limited','控制器映射和 magic comment 持久化可命令化，postIOData 回放可做；实时 Gamepad API/设备采集无头环境不承诺。','userscript.js','const storeMappings'),
'hide-delete-button': ('not-applicable','只隐藏删除图标，右键删除仍存在。','sprites.css','display: none'),
'hide-flyout': ('not-applicable','调 flyout 可见/锁定/动画，不更改块图。','userscript.js','flyoutLock'),
'hide-new-variables': ('commanded','新变量/列表不自动显示 monitor，会改变保存的 monitors.visible；应作为创建 --no-monitor。','userscript.js','originalCreateVariable'),
'hide-stage': ('not-applicable','CSS 隐藏舞台/精灵 pane 释放空间，无 runtime 停止。','userscript.js','function hideStage'),
'initialise-sprite-position': ('commanded','改新角色/复制角色 x/y、是否随机；这些是项目状态。','userscript.js','vm.constructor.prototype.addSprite'),
'jump-to-def': ('limited','过程定义 ID 查找可只读输出；滚屏/高亮/中键跳转 GUI 不等价。','userscript.js','doBlockClick_'),
'load-extensions': ('commanded','按设置同步加载 music/pen/text2speech/translate；不能仅称 category 外观。','userscript.js','loadExtensionIdSync'),
'mediarecorder': ('limited','captureStream+MediaRecorder 写视频；D1 离屏帧/音频管道可提案替代，编码/实时长度/音画同步未验收。','userscript.js','const videoStream ='),
'middle-click-popup': ('limited','按名字/表达式搜索后生成 XML 新块有项目语义；DOM 预览/拖动/自动补全不复现，查询解析器覆盖未验收。','userscript.js','function selectBlock'),
'mouse-pos': ('commanded','读取 mouse._scratchX/Y 可输出为运行 telemetry；图标布局排除。','userscript.js','Object.defineProperty'),
'move-to-top-bottom': ('commanded','costumes/sounds splice 排序并 emitProjectChanged，映射 asset reorder。','userscript.js','const target ='),
'move-to-top-layer': ('commanded','goToFront 改 sprite layerOrder，明确项目/渲染语义。','userscript.js','goToFront'),
'mute-project': ('commanded','共享 vol-slider outputNode.gain 静音，不是停止脚本/逐 target volume；映射主输出音量。','../vol-slider/module.js','export const setMuted'),
'no-script-bumping': ('commanded','禁用自动 bump 会影响保存的 top-level x/y；显式 move --no-bump，而非纯视觉排除。','userscript.js','bumpNeighbours_'),
'number-pad': ('not-applicable','总显示数字键盘，仅输入方式；字段提交已在 code-ws.field-text-edit。','userscript.js','showEditor_'),
'onion-skinning': ('not-applicable','guide layer 的参考叠影不进入资产导出；编辑器参考层纯视觉。','userscript.js','const createOnionLayer'),
'paint-by-default': ('not-applicable','只改 ActionMenu 默认入口；新建/录音/上传本体已独立登记。','userscript.js','document.body.addEventListener'),
'paint-skew': ('commanded','Paper itemGroup.shear 修改 SVG，Ctrl/Alt 手势可转数值 affine 参数。','userscript.js','this.itemGroup.shear'),
'paint-snap': ('pending','Move/Scale snap 改资产坐标，DOM guides 不是全部语义；阈值/优先级/坐标/导出安全尚未逐分支确认。','updateSelectTool.js','function onMouseDrag'),
'pause': ('commanded','共享 debugger.setPaused 补偿 clock/thread/timer/audio；暂停支持 compiled，但单步不支持 compiled，必须分开。','../debugger/module.js','export const setPaused'),
'pick-colors-from-stage': ('limited','stage renderer 像素传递到 paint eye dropper；D1 同样采样数值可做，像素/半径/坐标对拍待验收。','userscript.js','scratch-paint/eye-dropper/'),
'remove-curved-stage-border': ('not-applicable','只取消 CSS border-radius。','remove-borders.css','border-radius'),
'remove-sprite-confirm': ('commanded','deleteSprite 前确认决定是否删除；零交互 CLI --force/默认拒绝，不能仅删掉安全 guard。','userscript.js','const oldDeleteSprite'),
'rename-broadcasts': ('commanded','修改 stage broadcast variable 和所有 targets/clones 的 field name/ref；不是仅输入框改名。','userscript.js','const renameBroadcastInVM'),
'reorder-custom-inputs': ('commanded','调整 procedure declaration 输入顺序后 mutation 与调用参数同步，需 ID/value 一致。','userscript.js','polluteProcedureDeclaration'),
'script-snap': ('commanded','grid snap 调整保存的顶层块坐标；应显式 numeric grid。','userscript.js','setGrid'),
'search-sprites': ('limited','name 查找结果可命令化；DOM 筛选/folder 显隐不复现。','userscript.js','searchBox.addEventListener'),
'sprite-properties': ('not-applicable','只显隐 SpriteInfo 面板，属性本体已命令化提案。','userscript.js','togglePropertiesPanel'),
'swap-local-global': ('pending','变量作用域/云标志转换保留值、引用、monitor/undo 且有跨目标使用冲突；未逐条件确认，不能当纯 DOM 丢弃。','userscript.js','const convertVariable'),
'transparent-orphans': ('not-applicable','只改 orphan/dragged block opacity。','userstyle.css','opacity:'),
 'tw-disable-cloud-variables': ('commanded','redux setCloud(false) 使本地 provider 不连接；D3 非外网云。','userscript.js','SET_CLOUD'),
 'tw-disable-compiler': ('commanded','vm.setCompilerOptions({enabled:false}) 真正影响执行引擎。','userscript.js','setCompilerOptions'),
 'tw-disable-vibration': ('limited','navigator.vibrate/GamepadHapticActuator 返回拒绝；CLI 默认设备 deny 仅等价无振动，不支持开启真实设备反馈。','userscript.js','navigator.vibrate'),
 'tw-remove-backpack': ('not-applicable','CSS 隐藏面板但未删除 IndexedDB 数据。','remove-backpack.css','display: none'),
 'tw-remove-feedback': ('not-applicable','只隐藏菜单外链。','remove-feedback.css','display: none'),
 'tw-straighten-comments': ('commanded','endBubbleDrag 改 currentDragDeltaXY.y，注释 y 持久化；不能仅认作线条视觉。','userscript.js','currentDragDeltaXY.y'),
 'variable-manager': ('commanded','更改 scalar/list 值和 renameVariableById，真实项目编辑；列表按 newline 分割。','userscript.js','vm.setVariableValue'),
 'vol-slider': ('commanded','统一项目主输出增益（audioEngine.inputNode.gain），并记忆 unmuteVolume；与 sprite volume 不同。','module.js','export const setVolume'),
 'zebra-striping': ('not-applicable','嵌套积木 CSS 交替色，不改 opcode/input/项目。','userscript.js','sa-zebra-stripe')
}


def collect_addons():
    actual={p.parent.name for p in (ROOT/ADDONS).glob('*/_manifest_entry.js')}
    assert set(ADDON_DEFINITIONS)==actual, ('Addon set mismatch',actual-set(ADDON_DEFINITIONS),set(ADDON_DEFINITIONS)-actual)
    settings_path=GUI+'addons/settings/settings.jsx'
    store_path=GUI+'addons/settings-store-singleton.js'
    for aid,(disp,reason,behavior_file,needle) in sorted(ADDON_DEFINITIONS.items()):
        manifest_path=ADDONS+aid+'/_manifest_entry.js'
        text=read(manifest_path)
        manifest,_=json.JSONDecoder().raw_decode(text.split('const manifest = ',1)[1])
        behavior_path=str((ROOT/ADDONS/aid/behavior_file).resolve().relative_to(ROOT))
        behavioral=at(behavior_path,needle,before=2,after=12)
        manifest_source=at(manifest_path,'const manifest = ',after=8)
        target='commanded' if disp=='pending' else disp
        unconfirmed=disp=='pending'
        row={'id':aid,'name':manifest['name'],'description':manifest['description'],
             'enabledByDefault':manifest.get('enabledByDefault',False),'noCompiler':manifest.get('noCompiler',False),
             'source':manifest_path,'sha256':sha(manifest_path), 'disposition':disp,
             'proposedDisposition':target, 'implementationStatus':'pending','acceptanceStatus':'pending',
             'reviewStatus':'unconfirmed' if unconfirmed else 'source-reviewed', 'reason':reason,
             'evidence':[manifest_source,behavioral], 'settings':manifest.get('settings',[]),
             'presets':manifest.get('presets',[]), 'actionIds':[],
             'runtimeFiles':[{'path':str(p.relative_to(ROOT)),'sha256':sha(str(p.relative_to(ROOT)))}
                             for p in sorted((ROOT/ADDONS/aid).glob('*.js')) if not p.name.startswith('_')]}
        ADDON_ROWS.append(row)
        add('addon.'+aid+'.enabled','extensions-addons',aid+' 启用/禁用','插件设置开关；danger 插件先 confirm',
            [S('addons/settings/settings.jsx',554,575),manifest_source,behavioral],
            'SettingsStore.setAddonEnabled；热更新或标 dirty 需 reload。运行/编辑效果：'+reason,
            'tw addon set '+aid+' enabled <bool> --config <path>' if target not in ['not-applicable','dom-only'] else None,
            disp,note=reason if unconfirmed else None,visibility='addon-settings')
        row['actionIds'].append('addon.'+aid+'.enabled')
        for setting in manifest.get('settings',[]):
            sid=setting['id']; typ=setting['type']
            mneedle='"id": '+json.dumps(sid)
            ev=at(manifest_path,mneedle,before=2,after=10)
            action_id='addon.'+aid+'.setting.'+sid
            add(action_id,'extensions-addons',aid+' 设置 '+sid,{'boolean':'勾选框','select':'点击枚举按钮','color':'颜色输入','integer':'数字输入失焦/Enter','positive_integer':'数字输入失焦/Enter','string':'文本失焦/Enter','untranslated':'文本失焦/Enter'}[typ],
                [ev,S('addons/settings/settings.jsx',374,468)],
                'setAddonSetting('+aid+','+sid+')；type='+typ+'，默认值='+json.dumps(setting.get('default'),ensure_ascii=False)+'；if 条件='+json.dumps(setting.get('if'),ensure_ascii=False)+'；语义边界：'+reason,
                'tw addon set '+aid+' '+sid+' <value> --config <path>' if target not in ['not-applicable','dom-only'] else None,
                disp,note=reason if unconfirmed else None,visibility='addon-enabled-and-setting-condition')
            row['actionIds'].append(action_id)
            if typ in ['integer','positive_integer','string','untranslated','color']:
                reset_id='addon.'+aid+'.reset-setting.'+sid
                add(reset_id,'extensions-addons',aid+' 重置 '+sid,'该字段回转箭头按钮',[ev,S('addons/settings/settings.jsx',350,366)],
                    'setAddonSetting('+aid+','+sid+',null) 恢复 manifest 默认值；条件显示同字段。',
                    'tw addon reset-setting '+aid+' '+sid+' --config <path>' if target not in ['not-applicable','dom-only'] else None,
                    disp,note=reason if unconfirmed else None,visibility='addon-enabled-and-setting-condition')
                row['actionIds'].append(reset_id)
        if manifest.get('settings'):
            action_id='addon.'+aid+'.reset'
            add(action_id,'extensions-addons',aid+' 重置全部设置','已启用插件标题旁 Reset',[S('addons/settings/settings.jsx',607,621),manifest_source],
                'SettingsStore.resetAddon(id)，恢复该插件默认设置，保留显式可解释处置边界。',
                'tw addon reset '+aid+' --config <path>' if target not in ['not-applicable','dom-only'] else None,
                disp,note=reason if unconfirmed else None,visibility='addon-enabled')
            row['actionIds'].append(action_id)
        for preset in manifest.get('presets',[]):
            pid=preset['id']; action_id='addon.'+aid+'.preset.'+pid
            add(action_id,'extensions-addons',aid+' 预设 '+pid,'插件设置内预设按钮',[at(manifest_path,'"id": '+json.dumps(pid),before=2,after=12),S('addons/settings/settings.jsx',519,541)],
                'applyAddonPreset，将此预设 values 应用于插件，具体 values 保留 inventory。',
                'tw addon preset '+aid+' '+pid+' --config <path>' if target not in ['not-applicable','dom-only'] else None,
                disp,note=reason if unconfirmed else None,visibility='addon-enabled')
            row['actionIds'].append(action_id)
    # Global addon settings editor actions.
    for suffix,name,needle,effect,cmd,disp in [('search','搜索插件','handleSearch (','仅过滤插件列表/最多20条结果。',None,'not-applicable'),('search-clear','清空搜索','handleClickSearchButton (','清搜索并聚焦。',None,'not-applicable'),('extended','显示插件 ID/版本详情','handleClickVersion (','切 extended，仅显示额外调试 ID。',None,'not-applicable'),('reload','立即应用并重新加载编辑器','handleReloadNow (','reloadChannel 通知所有编辑器 location.reload；脏项目退出语义另登记。',None,'not-applicable'),('reset-all','恢复全部插件默认设置','handleResetAll (','confirm 后 resetAllAddons，D4 原存储不由 CLI 迁移。','tw addon reset-all --config <file> --force','limited'),('export','导出插件设置 JSON','handleExport (','SettingsStore.export 含版本/theme，主进程原子写 JSON。','tw addon export --config <file> --out <json>','limited'),('import','导入插件设置 JSON','handleImport (','读 JSON→SettingsStore.import 版本检查，可能触发 reload。','tw addon import <json> --config <file>','limited')]:
        add('addons.settings.'+suffix,'extensions-addons',name,'插件设置对应搜索框/版本文字/Reload/Reset/Export/Import',[at(settings_path,needle,after=20),S('src-renderer-webpack/editor/gui/addons.js',5,11,DESKTOP)],effect,cmd,disp)
    add('addons.settings.group-toggle','extensions-addons','展开/收起插件组','New/Others/Danger 组标题',[S('addons/settings/settings.jsx',755,793)],'只改组 open state，不禁用任何插件。',disposition='not-applicable')
    add('addons.settings.feedback','extensions-addons','插件反馈链接','插件设置右上 Feedback',[S('addons/settings/settings.jsx',1106,1115)],'只打开外部用户评论页。',disposition='not-applicable')
    addon_runtime_actions()

# Extra runtime actions introduced by addons. Style-only addons have no extra action beyond
# their per-addon settings toggles; do not invent one "visual operation" row for them.
def addon_runtime_actions():
    rows={r['id']:r for r in ADDON_ROWS}
    def runtime(aid,suffix,name,trigger,file,needle,effect,command=None,disp=None,note=None):
        row=rows[aid]; d=disp or row['disposition']
        path=str((ROOT/ADDONS/aid/file).resolve().relative_to(ROOT))
        id='addon.'+aid+'.'+suffix
        add(id,'extensions-addons',name,trigger,[at(path,needle,before=3,after=18)],effect,
            command or ('tw addon '+aid+' '+suffix+' --spec <json>' if d not in ['not-applicable','dom-only'] else None),d,
            note=note or (row['reason'] if d=='pending' else None),visibility='addon-enabled')
        row['actionIds'].append(id)
    def existing(aid,ids):
        rows[aid]['actionIds'] += [id for id in ids if id in ACTIONS]
    runtime('2d-color-picker','set-color','二维 SV 选色','拖颜色面板，Shift 限定轴','paint-editor.js','function updateHandle','HSV 数值进入 eye-dropper 回调并应用 fill/stroke；选择颜色本身有资产语义。','tw vector style <costume> --fill/--stroke <hex>')
    runtime('better-img-uploads','upload','HD 上传位图/角色/背景','ActionMenu HD Upload→文件，Ctrl/right 可选择 fitting','userscript.js','async function onchange','解码 canvas→dataURL→嵌 PNG 的 SVG，然后触发对应已有文件上传。','tw costume add <bitmap> --hd --fit <full|fill|fit>')
    runtime('bitmap-copy','copy-raster','复制位图选区到剪贴板','位图选区 Ctrl+C','userscript.js','const dataURL =','导出单 Raster source 给 copyImage；只读文件输出为 D5 降级。','tw bitmap export-selection <costume> --rect <rect> --out <png>')
    runtime('block-cherry-picking','detach-single','Ctrl 拖单块','工作区 Ctrl/Cmd 拖单块（可反转默认）','../block-duplicate/module.js','if (isCherryPicking)','unplug(true) healing 原堆，不带后续堆；最终 move 事件持久化。','tw block move <id> --single --heal --at <x,y>')
    runtime('block-duplicate','duplicate-stack','Alt 拖复制堆','Alt+拖工作区堆','module.js','if (isDuplicating)','XML copy→新 ID、保留坐标并发 BlockCreate；定义块排除。','tw block duplicate <id>')
    runtime('block-duplicate','duplicate-single','Ctrl+Alt 拖复制单块','Ctrl/Cmd+Alt 拖块','module.js','const nextBlock =','复制后删 next 再 unplug，生成单块而非整堆。','tw block duplicate <id> --single')
    runtime('block-switching','switch','切换相关积木 opcode','积木右键选择替换项','userscript.js','const menuCallbackFactory','按源码映射重建 XML、shadow/字段/输入/连接/变更组；不是可直接裸 patch opcode。','tw block switch <id> <opcode>',disp='pending')
    runtime('blocks2image','export-svg','导出积木 SVG','工作区/堆右键→SVG','userscript.js','const Blockly =','克隆 Blockly DOM/SVG，内联 CSS/字体等；D6 编辑器布局依赖。',disp='dom-only')
    runtime('blocks2image','export-png','导出积木 PNG','工作区/堆右键→PNG','userscript.js','let canvas =','由 SVG 图像栅格化，尺寸依赖真实 Blockly 视图。',disp='dom-only')
    for aid,needle,cmd,effect in [('block-count','let sprites =','tw block count','按 sprite.blocks 去重统计全项目块数。'),('clones','const v =','tw runtime clones','输出 runtime._cloneCounter/maxClones。'),('mouse-pos','Object.defineProperty','tw input mouse get','输出 VM mouse scratchX/Y。')]:
        file='blockcount.js' if aid=='block-count' else 'userscript.js'
        runtime(aid,'read','读取 '+aid,'启用后自动展示，项目/帧更新刷新',file,needle,effect,cmd)
        ACTIONS['addon.'+aid+'.read']['kind']='passive-display'
    runtime('color-picker','hex-field','HEX 修改积木颜色字段','积木颜色面板 HEX 输入','code-editor.js','saColorPickerText.addEventListener','normalizeHex 后模拟 eye dropper 回传并 setValue，字段入项目。','tw block field <id> COLOUR <hex>')
    for suffix,name,needle,cmd in [('copy-monitor','复制监视器值','createEditorContextMenu','tw monitor value <id> --out <txt>'),('copy-bubble','复制报告器值','copyButton.onclick','tw runtime reporter <block> --out <txt>')]:
        runtime('copy-reporter',suffix,name,'监视器右键 Copy/报告器值气泡复制按钮','userscript.js',needle,'读取当前值并写 OS clipboard；显式文本输出是 limited 替代。',cmd)
    # Default paint colors and pasted positioning remain effects of concrete paint operations, not duplicates.
    existing('default-costume-editor-color',['costumes.paint-fill-color','costumes.paint-stroke-color','costumes.paint-stroke-width'])
    existing('disable-paste-offset',['costumes.paint-paste'])
    existing('disable-stage-drag-select',['stage.drag.sprite','stage.dblclick.select-target'])
    existing('drag-drop',['sprites.drop-file'])
    for suffix,name,needle,cmd,effect in [('drop-costume','拖图片到造型/背景列表','selector_wrapper','tw costume add <file>','同造型上传，包含 HD 选项。'),('drop-sound','拖音频到声音列表','selector_wrapper','tw sound add <file>','同声音上传解码/转 WAV。'),('drop-list','拖文本到列表监视器','monitor_list-monitor','tw list import <list> <file>','以文件选择器触发 importCSV；多列选择归 stage.monitor.menu-import-list。'),('drop-answer','拖文本到提问框','question_question','tw run --answer-file <txt>','FileReader 文本写输入框并等待正常提交 ANSWER。')]:
        runtime('drag-drop',suffix,name,'OS 文件拖到对应 DOM 区域','userscript.js',needle,effect,cmd)
    runtime('editor-extra-keys','key-field','选择额外按键字段','key dropdown 选择 Enter/标点/附加键','userscript.js','const block = ScratchBlocks.Blocks','写保存的 KEY_OPTION 字段，支持按原始字符串注入。','tw block field <id> KEY_OPTION <key>')
    runtime('editor-number-arrow-keys','increment','方向键增量数值','数字输入框 Up/Down，Shift/Alt 改步长','userscript.js','document.body.addEventListener','按自定义十进制步长加减并 dispatch input/change；字段/属性可持久化。','tw field increment <id> --step <decimal>')
    runtime('editor-searchable-dropdowns','search','搜索积木下拉','下拉搜索框输入/方向键/Enter','userscript.js','function performSearch','排名/过滤可结构化，菜单/键盘焦点不需复现。','tw block options <id> --search <query>','limited')
    for suffix,needle,typ,scope in [('create-global-variable','createGlobalVariable','variable','global'),('create-local-variable','createLocalVariable','variable','local'),('create-global-list','createGlobalList','list','global'),('create-local-list','createLocalList','list','local'),('create-broadcast','createBroadcast','broadcast_msg','global')]:
        runtime('editor-searchable-dropdowns',suffix,suffix,'搜索输入非空时点击 Create 对应项','userscript.js',needle,'以搜索文本 workspace.createVariable，再 setValue 到新 variable.id；创建后还会绑定当前字段引用。','tw var add <name> --type '+typ+' --scope '+scope+' --bind-field <block>')
    runtime('find-bar','find','查找脚本/资产','Find 输入/下拉条目','userscript.js','getScratchBlocks','查找定义/脚本/广播/变量或选中造型/声音；CLI 输出 ID/资源并可另 select。','tw find <query> --kind <script|costume|sound>')
    runtime('find-bar','history','查找跳转历史','Ctrl+Left/Right','userscript.js','eventKeyDown','只回放工作区滚动历史，不改变项目。',disp='not-applicable')
    # Folders use the same injected context menu for three kinds; source/receiver duplicates share IDs.
    existing('folders',[a['id'] for a in ACTIONS.values() if a['id'].startswith(('sprites.folder.','costumes.folder-'))])
    for typ in ['sound']:
        for suffix,needle,effect in [('create','const createFolder','为选中资源增加 folder// 名称前缀并修复排序。'),('add-to','addToFolder','移入已存在文件夹，改名前缀。'),('remove-from','removeFromFolder','移出文件夹，去前缀。'),('rename','const renameItems','批量 renameSound 更名，同步引用块。'),('remove','const removeFolder','批量去前缀，不删除声音。'),('toggle','setFolderOpen','仅 SortableHOC 内存 folders.open，不入项目。'),('reorder','vm.reorderSound','按文件夹边界重排、必要时改前缀。')]:
            # Exact labels vary, use the dispatcher/semantic branch as a stable implementation anchor.
            fallback={'add-to':'setFolderOfName','remove-from':'setFolder(null)','remove':'renameItems(null)','reorder':'reorderSound'}
            file=ADDONS+'folders/userscript.js'
            n=needle if needle in read(file) else fallback.get(suffix,needle)
            runtime('folders',typ+'-'+suffix,'声音文件夹 '+suffix,'声音项/文件夹右键，点击或拖动','userscript.js',n,effect,
                    'tw sound folder '+suffix+' <sound|folder> --spec <json>',disp='not-applicable' if suffix=='toggle' else 'commanded')
    for typ in ['costume','sound']:
        runtime('folders',typ+'-drag-into',typ+' 拖入/移出文件夹','列表拖放落到文件夹/外部','userscript.js','abstractReorder','重排资源并更新 folder// 前缀；原基础 reorder 不包含此改名。','tw '+typ+' reorder <from> <to> --folder <name>')
        runtime('folders',typ+'-backpack-dump',typ+' 文件夹批量存背包','文件夹卡拖到背包并确认','userscript.js','sa_loadNextItem','按队列逐个构造 payload 存本地背包；D4 迁移 limited。','tw backpack add-folder <name> --type '+typ,disp='limited')
    for suffix,name,needle,effect,cmd in [('mapping','编辑 Gamepad 映射','handleGamepadMappingChanged','editor mapping 更新，按需保存；真实 Gamepad 信号由 postIOData 转鼠标/键盘。','tw gamepad map --spec <json>'),('store-mapping','存映射于项目注释','const storeMappings','魔术末尾标记 JSON 写 stage.comments 并 emitProjectChanged。','tw gamepad map --store-project'),('remove-mapping','删除保存映射','const removeStoredMappings','删除匹配 magic stage comment 并标脏。','tw gamepad map --remove-project'),('reset','重置映射','resetButton.addEventListener','恢复默认映射，可同步保存 magic comment。','tw gamepad map --reset'),('clear','清空映射','clearButton.addEventListener','清除 mappings，可同步保存。','tw gamepad map --clear'),('input','注入控制器项目输入','vm.postIOData("keyboard"','按 mappings 回放键/鼠标输入；实时硬件采集不承诺。','tw input replay <events.json>')]:
        runtime('gamepad',suffix,name,'Gamepad 配置页/控制器相应操作','userscript.js',needle,effect,cmd)
    existing('hide-new-variables',['code-ws.make-variable','code-ws.make-list','code-ws.monitor-checkbox-toggle'])
    runtime('initialise-sprite-position','new-position','新角色默认坐标','新增/复制角色时自动采用配置','userscript.js','vm.constructor.prototype.addSprite','修改初始化 x/y 与 duplicate 随机/固定规则；持久化项目坐标。','tw sprite add <name> --x <n> --y <n>')
    runtime('jump-to-def','find-definition','定位过程定义','中键/Shift 点击过程调用','userscript.js','doBlockClick_','返回定义块 ID 可移植；工作区滚动/高亮排除。','tw proc locate <proccode>')
    runtime('load-extensions','auto-load','自动加载选定扩展','项目加载后读取 addon 设置','userscript.js','loadExtensionIdSync','加载 music/pen/text2speech/translate；服务依赖仍按对应扩展的 limited 处置。','tw ext load <id>')
    runtime('mediarecorder','start','开始录项目视频','menu Start recording→配置确认；可等绿旗','userscript.js','const videoStream =','stage canvas.captureStream + audio media destination + MediaRecorder，时间/绿旗/停止联动。','tw record --frames <n> --video-out <file>')
    runtime('mediarecorder','stop','停止并导出录制视频','录制按钮/停止条件触发','userscript.js','stopSignFunc','合并 recorder Blob 下载视频文件；编码/音画精度 limited。','tw record stop --out <file>')
    runtime('mediarecorder','cancel','取消录制配置/等待','配置取消/等待绿旗 Abort','userscript.js','cancelButton.addEventListener','取消缓冲/待开始流程，不写项目。',disp='not-applicable')
    runtime('middle-click-popup','open-search','打开插块搜索','中键/Shift 点击工作区或 Ctrl+Space','userscript.js','function openPopup','只开搜索 UI；解析/生成块另登记。',disp='not-applicable')
    runtime('middle-click-popup','insert','按名字/表达式插入积木','搜索结果拖出或 Enter','userscript.js','function selectBlock','根据查询生成 scratch-blocks XML 并发创建/拖动事件；解析器覆盖未验收。','tw block insert-query <query> --at <x,y>')
    for typ in ['costume','sound']:
        for where,needle in [('top','createEditorContextMenu'),('bottom','createEditorContextMenu')]:
            runtime('move-to-top-bottom',typ+'-'+where,typ+' 移到'+where,'资源右键→Move to '+where,'userscript.js',needle,'移除并 unshift/push 对应数组；emitTargetsUpdate/emitProjectChanged，保持当前 costume。','tw '+typ+' reorder <index> '+('0' if where=='top' else 'last'))
    runtime('move-to-top-layer','front','精灵移到最前层','Shift 点击精灵卡','userscript.js','goToFront','改变 layerOrder/renderer 顺序。','tw sprite front')
    runtime('mute-project','mute','项目主输出静音/取消','Ctrl 点击/右键绿旗（非 Shift）','userscript.js','const clickMuteButton','共享 vol-slider.setMuted，保存原输出 gain，脚本继续。','tw runtime mute <on|off>')
    existing('no-script-bumping',['code-ws.block-move'])
    runtime('onion-skinning','toggle','开关洋葱皮参考层','paint 下方 Onion 按钮','userscript.js','const createOnionLayer','只添加 isGuide 参考图层，不进入 onUpdateImage SVG/PNG；配置另登记。',disp='not-applicable')
    existing('paint-by-default',['sprites.add.paint','costumes.add-blank','backdrops.add-blank','sounds.add.record'])
    runtime('paint-skew','shear','斜切选中图形','Ctrl 拖缩放边；Alt 从中心','userscript.js','this.itemGroup.shear','数值 shearX/Y 按 bbox 尺寸计算，图形坐标持久化。','tw vector shear <costume> --x <n> --y <n> --origin <x,y>')
    runtime('paint-snap','toggle','启用/禁用 paint snapping','paint Snap 按钮','ui.js','toggleButton.addEventListener','只开关吸附规则；真正改变几何见 snap-move/scale。',disp='not-applicable')
    for suffix,file,needle,effect in [('snap-move','updateSelectTool.js','function onMouseDrag','移动选区时按距离/优先级找参考点并改 delta，最终资产坐标变化。'),('snap-scale','updateScaleTool.js','addons.paintSnap =','缩放时按节点/边框点吸附并保持中心/比例约束；导出几何变化。')]:
        runtime('paint-snap',suffix,suffix,'选择工具移动/缩放时启用吸附',file,needle,effect,'tw vector '+suffix+' <costume> --spec <json>',disp='pending')
    for suffix,name,needle,effect in [('pause','暂停项目','export const setPaused','冻结 thread 状态/clock，暂停 audioContext，保留等待计时器并补偿；不是 stopAll。'),('resume','恢复项目','if (!paused && didChange)','恢复 thread/clock/audio 并补偿已过暂停时间；compiled 线程可恢复。')]:
        runtime('pause',suffix,name,'舞台 Pause/Resume 按钮或 Alt+X','../debugger/module.js',needle,effect,'tw run '+suffix)
    existing('pick-colors-from-stage',['stage.colorpick.pick-from-stage'])
    runtime('pick-colors-from-stage','apply-color','舞台采样回填绘图颜色','paint 吸管时点击舞台','userscript.js','scratch-paint/eye-dropper/','回调填 paint fill/stroke，选区颜色写回图像；同 stage 采样 primitive，UI glue 另保留。','tw pick-color --x <n> --y <n> --apply <fill|stroke>')
    existing('remove-sprite-confirm',['sprites.delete.button','sprites.contextmenu.delete'])
    runtime('rename-broadcasts','rename','改名广播消息','广播 dropdown Rename→prompt','userscript.js','const renameBroadcastInVM','更新舞台 broadcast variable.name、所有块引用名/缓存，并保留同 ID。','tw broadcast rename <id> <name>')
    for suffix in ['left','right']:
        runtime('reorder-custom-inputs','move-'+suffix,'过程参数移'+suffix,'Make/Edit Block 中参数左右箭头','userscript.js','polluteProcedureDeclaration','临时声明块交换参数/标签顺序，确认后 signature 与调用 mutation 同步。','tw proc reorder-param <proccode> <argId> --'+suffix)
    runtime('script-snap','snap','工作区坐标网格吸附','拖脚本松手','userscript.js','setGrid','使用 Blockly grid snap 更新保存的 top-level x/y。','tw block snap --target <id> --grid <n>')
    runtime('search-sprites','find','按角色名称搜索','sprite pane 搜索框','userscript.js','searchBox.addEventListener','过滤显示卡片；CLI 输出匹配 target ID，GUI folder 展示不复现。','tw sprite list --filter <query>')
    for suffix,name,needle,effect in [('scope','切换变量/列表作用域','const convertVariable','保留 ID/值/引用/monitor/undo，拒绝跨 target 已使用或冲突名称条件。'),('cloud','切换云变量标志','const canUserUseCloudVariables','受 canUseCloud/数量/列表限制；会改变变量所有权和 isCloud，不能裸 patch。')]:
        runtime('swap-local-global',suffix,name,'变量 Rename modal/右键 Scope 切换','userscript.js',needle,effect,'tw var convert <id> --scope/--cloud <spec>',disp='pending')
    existing('tw-disable-cloud-variables',['mb.edit.cloud'])
    existing('tw-disable-compiler',['settings.compiler'])
    existing('tw-disable-vibration',['permission.record-video.deny'])
    runtime('tw-straighten-comments','align','块注释对齐 source y','块注释拖动松手','userscript.js','currentDragDeltaXY.y','override endBubbleDrag 最终 y=iconY-TOP_BAR_HEIGHT/2；真实 comment 坐标序列化。','tw comment align <id> --source-y')
    for suffix,name,needle,effect,cmd in [('rename','变量管理器改名','workspace.renameVariableById','通过 Blockly rename 事件更新 VM/引用，云变量补 ☁ 名字。','tw var rename <id> <name>'),('set-variable','编辑变量值','vm.setVariableValue(this.target.id, this.scratchVariable.id, input.value);','失焦/Enter 直接 VM scalar 字符串赋值。','tw var set <id> <value>'),('set-list','编辑列表全文','input.value.split("\\n")','newline 拆列表，失焦提交全部项目列表值。','tw var set <id> --type list <json>')]:
        runtime('variable-manager',suffix,name,'Variables 新标签对应名字/值输入框','userscript.js',needle,effect,cmd)
    runtime('variable-manager','search','过滤变量/列表','变量管理搜索输入','userscript.js','searchBox.addEventListener','只过滤行，查到的值还可 JSON 查询。','tw var list --filter <query>','limited')
    runtime('vol-slider','volume','主项目音量','舞台音量滑块 input/change','userscript.js','slider.addEventListener("input"','setVolume(+value) 改 audioEngine 主输出 gain；change 才提交 unmuteVolume。','tw runtime volume <0..100>')
    runtime('vol-slider','mute','主输出静音按钮','舞台滑块旁喇叭按钮','userscript.js','icon.addEventListener','共享 setMuted；原音量记忆与 mute-project 一致。','tw runtime mute <on|off>')
    # Debugger is a compound tool with separate logging, pause/step and view-only operations.
    for suffix,name,file,needle,effect,cmd,disp in [('open','打开调试器','userscript.js','debuggerButton.addEventListener','只展示 debugger 窗口。',None,'not-applicable'),('close','关闭调试器','userscript.js','closeButton.element.addEventListener','只隐藏 debugger，不清 logs 或自动 resume。',None,'not-applicable'),('tabs','切换 Logs/Threads/Performance','userscript.js','const setActiveTab','只改 debugger 视图。',None,'not-applicable'),('resume','恢复暂停项目','userscript.js','unpauseButton.element.addEventListener','setPaused(false)，共享暂停模块。','tw run resume','commanded'),('step','解释线程单步','threads.js','singleStep();','singleStep 不能 step compiled/monitor thread，需解释模式。','tw run step --no-compile','limited'),('log','输出 log/warn/error','userscript.js','addon.tab.addBlock','自定义调试块注册 log/warn/error（运行中输出文本/类型/位置）。','tw debug log <text> --type <log|warn|error>','limited'),('breakpoint','运行到 breakpoint 暂停','userscript.js','setPaused(true);','debug breakpoint 自定义块暂停线程/clock/audio。','tw debug breakpoint <block>','limited'),('logs-export','导出日志','logs.js','exportButton.element.addEventListener','可 Shift 自定义 {sprite}/{content}/{type} 格式，重复 count 次下载。','tw debug logs export --out <txt> [--format <template>]','commanded'),('logs-clear','清除日志','logs.js','trashButton.element.addEventListener','清 LogView rows，会话日志不入 sb3。','tw debug logs clear','commanded'),('threads','读取运行线程','threads.js','Compiled threads','返回线程/当前块；compiled 无 stack 信息。','tw debug threads','limited'),('performance','读取帧/克隆性能','performance.js','const tab =','按帧采样 FPS/clone/列表指标；HTML 图表不复现。','tw debug performance','limited')]:
        runtime('debugger',suffix,name,'调试器对应按钮/Tab/自定义积木执行',file,needle,effect,cmd,disp)
    for suffix,name,needle,effect,cmd in [('clean-up-plus','Clean Up+','doCleanUp(block)','按空间列整理；确认时可删除孤儿脚本、未用局部变量/列表；真实破坏性项目操作。','tw block clean-up-plus --target <id> --policy <json>'),('make-space','插入空间','this.m("make-space")','为指定块位置让出空间，改 top-level 坐标。','tw block make-space <id>'),('copy-all','复制全部脚本','this.m("copy-all")','导出全部当前工作区脚本至 Blockly 内部 clipboard。','tw block export --target <id> --out <json>'),('copy-single','复制单个块','this.m("copy-block")','eventCopyClick 单块模式，可不带 next。','tw block copy <id> --single'),('cut-single','剪切单个块','this.m("cut-block")','复制后 unplug/heal/delete，真实块图编辑。','tw block cut <id> --single'),('paste-at-mouse','在鼠标位置粘贴','this.m("paste")','粘贴 clipboard 后 beginDragOfNewBlocks，落点持久化。','tw block paste --at <x,y>'),('replace-variable','替换变量/列表引用','doReplaceVariable','对 workspace.getVariableUses 修改字段到另一个存在的变量，不是改变量值。','tw block replace-var <oldId> <newId>')]:
        runtime('editor-devtools',suffix,name,'工作区/块右键增补项或快捷键','DevTools.js',needle,effect,cmd,disp='pending')
    # All addon actionRefs resolve, including settings-only visual addons; no deleted inventory entries.
    for row in ADDON_ROWS:
        row['actionIds']=sorted(set(row['actionIds']))


def add_remaining_surfaces():
    add('prompt.procedure.field-text','monitors-prompts','编辑过程标签/参数名称','过程声明块临时字段输入',[S('core/field_textinput_removable.js',60,71,BLOCKS),S('blocks_vertical/procedures.js',334,340,BLOCKS)],'修改临时过程 mutation 的 proccode/argumentnames；OK 后才同步定义/所有调用。','tw proc edit <name> --params <json>')
    add('prompt.procedure.field-remove','monitors-prompts','删除过程标签/参数','临时参数输入框浮动 ×',[S('core/field_textinput_removable.js',75,85,BLOCKS),S('blocks_vertical/procedures.js',730,758,BLOCKS)],'只在有多个 input 时删除对应声明 input，刷新 mutation；取消不改项目，OK 后更新调用。','tw proc remove-param <name> <argId>')
    for suffix,needle,name in [('open-system','handleOpenSystemFonts (','进入添加系统字体页'),('open-file','handleOpenCustomFonts (','进入添加字体文件页')]:
        add('paint.font.'+suffix,'paint-tools',name,'Fonts modal 对应添加按钮',[at(GUI+'containers/tw-fonts-modal.jsx',needle,after=6)],'只改变子页 screen；实际添加/文件输入独立登记。',disposition='not-applicable')
    for suffix,needle,effect in [('choose-file','handleChangeFile (','选文件/createObjectURL 用于预览，确认 addCustomFont 才加入项目。'),('name','handleChangeName (','缓冲字体 name；确认后校验并用该名字。'),('fallback','handleChangeFallback (','缓冲 fallback；确认后加入系统/自定义字体清单。')]:
        add('paint.font.'+suffix,'paint-tools','字体 '+suffix,'字体添加页文件/名称/回退字段',[at(GUI+'components/tw-fonts-modal/add-custom-font.jsx',needle,after=12)],effect,disposition='not-applicable')
    for suffix,needle,effect in [('close','handleClose (','关闭非本平台项目提示；本 platform 说明 modal。'),('report','https://','打开不兼容平台说明/问题外链。')]:
        path=GUI+('containers/tw-unknown-platform-modal.jsx' if suffix=='close' else 'components/tw-unknown-platform-modal/unknown-platform-modal.jsx')
        if needle in read(path):
            add('project-io.unknown-platform-'+suffix,'project-io','不兼容项目平台 '+suffix,'平台警告对应按钮/链接',[at(path,needle,after=14)],effect,disposition='not-applicable')
    for suffix,needle,effect in [('back','handleBack (','history.back'),('reload','handleReload (','location.replace 去掉 query；重新加载当前编辑器页')]:
        add('project-io.crash-'+suffix,'project-io','GUI 崩溃页 '+suffix,'GUI crash 对应按钮',[at(GUI+'containers/error-boundary.jsx',needle,after=5)],effect+'，窗口导航不模拟；脏项目丢失风险不被称已修复。',disposition='not-applicable')
    for suffix,needle,name in [('next','onNextStep:','教程下一步'),('prev','onPrevStep:','教程上一步'),('all','onShowAll:','打开全部教程'),('close','onCloseCards:','关闭教程卡'),('expand','onShrinkExpandCards:','收起/展开教程卡'),('drag','onDrag:','移动教程卡')]:
        add('project-io.tutorial-'+suffix,'project-io',name,'教程卡对应按钮/拖动',[at(GUI+'containers/cards.jsx',needle,after=4)],'仅 Redux cards/deck/位置状态，不修改 VM 项目。',disposition='not-applicable',visibility='tutorial-enabled')
    add('project-io.tutorial-select','project-io','选择教程','Tips Library 条目',[S('containers/tips-library.jsx',39,63)],'内部 deck 激活或打开新教程页；纯教学 UI，桌面默认无菜单入口。',disposition='not-applicable',visibility='tutorial-enabled')
    add('desktop.migration-continue','project-io','迁移失败后继续','桌面迁移错误/超时页 Continue anyways',[S('src-main/windows/migrate.js',35,44,DESKTOP),S('src-renderer/migrate/migrate.html',168,175,DESKTOP)],'D4 主进程迁移用户浏览器数据的流程；继续可放弃尚未迁移存储。CLI 不读旧 IndexedDB。','tw migrate # 仅桌面版负责，CLI 不实现','limited')
    add('desktop.migration-contact','project-io','迁移问题邮件','迁移页 contact 邮件链接',[S('src-renderer/migrate/migrate.html',117,117,DESKTOP)],'mailto 外链，无项目操作。',disposition='not-applicable')
    for page in ['about','privacy']:
        path=DESKTOP+f'src-renderer/{page}/{page}.html'
        seen=set()
        for m in re.finditer(r'<a\s[^>]*href="([^"]+)"',read(path)):
            href=m[1]
            if href in seen:continue
            seen.add(href)
            line=read(path).count('\n',0,m.start())+1
            suffix='settings' if href=='#' else hashlib.sha256(href.encode()).hexdigest()[:10]
            add('desktop.'+page+'.link-'+suffix,'project-io',page+' 链接 '+href,'About/Privacy 页点击链接',[source(path,line,anchor=href)],'打开桌面设置窗口' if href=='#' else '打开系统外链/邮件，无项目改变。',disposition='not-applicable')
    for aid,suffix,file,needle,effect in [('hide-stage','hide','userscript.js','function hideStage','隐藏舞台及目标 pane；只 CSS/resize，不停止项目。'),('hide-stage','show','userscript.js','function unhideStage','点 small/large/full 取消隐藏；只布局。'),('sprite-properties','toggle','userscript.js','togglePropertiesPanel','info/双击角色卡切属性栏显隐，不改变属性值。'),('hide-flyout','lock','userscript.js','flyoutLock','锁定/解锁 flyout，只可见性。'),('hide-flyout','category','userscript.js','Blockly.getMainWorkspace','category click 只展开/隐藏 flyout，块不改变。'),('fullscreen','toggle','userscript.js','requestFullscreen','浏览器 OS fullscreen 与 toolbar 显隐，无项目状态。'),('onion-skinning','settings-open','userscript.js','const createOnionLayer','显示洋葱皮设置面板/参考层，无资产输出。')]:
        add('addon.'+aid+'.'+suffix,'extensions-addons',aid+' '+suffix,'addon 启用时对应按钮/手势',[at(ADDONS+aid+'/'+file,needle,before=3,after=15)],effect,disposition='not-applicable',visibility='addon-enabled')
        next(r for r in ADDON_ROWS if r['id']==aid)['actionIds'].append('addon.'+aid+'.'+suffix)


def add_fixed_addon_controls():
    rows={r['id']:r for r in ADDON_ROWS}
    def control(aid,suffix,name,trigger,file,start,end,effect,disp='not-applicable',cmd=None,note=None):
        id='addon.'+aid+'.'+suffix
        add(id,'extensions-addons',name,trigger,[source(ADDONS+aid+'/'+file,start,end)],effect,cmd,disp,note=note,visibility='addon-enabled')
        rows[aid]['actionIds'].append(id)
    # All fixed paint popover controls, independently of their similar persisted settings.
    control('onion-skinning','toggle','开关洋葱皮','Onion 按钮','userscript.js',518,537,'toggle enabled；prev/next均0时默认prev=1、opacity=0时补25，参考层guide=true不导出。')
    control('onion-skinning','settings-open','展开洋葱皮设置','Onion settings齿轮','userscript.js',590,615,'只切 settingsPage visible。')
    control('onion-skinning','settings-close','关闭洋葱皮设置','点设置层外部','userscript.js',596,615,'关闭设置层，不清参考图层或改项目资产。')
    for field in ['previous','next','opacity','opacityStep']:
        for op,start,end,effect in [('input',618,665,'输入转Number，0..100并更新参考层；空暂记0/blur修正显示。'),('decrement',667,674,'若>0则减1，刷新参考层。'),('increment',677,684,'若<100则加1，刷新参考层。')]:
            control('onion-skinning','popover.'+field+'.'+op,field+' '+op,'Onion popover '+field+' 输入/－/＋','userscript.js',start,end,effect+' 此popover值是内存配置，不写addon manifest设置或项目。')
    for mode,start,end in [('merge',699,708),('tint',709,718)]:
        control('onion-skinning','popover.mode.'+mode,'参考层模式 '+mode,'Onion popover对应按钮','userscript.js',start,end,'settings.mode='+mode+'，只改参考guide层显示。')
    for mode,start,end in [('front',728,738),('behind',739,748)]:
        control('onion-skinning','popover.layering.'+mode,'参考层 '+mode,'Onion popover对应按钮','userscript.js',start,end,'relayerOnionLayers，参考layer.guide=true，不调整项目实际元素图层。')
    control('paint-snap','popover-open','展开Snap设置','Snap设置按钮','ui.js',72,100,'仅settingsPage.dataset.visible。')
    control('paint-snap','popover-close','关闭Snap设置','点外部','ui.js',80,100,'仅关闭浮层；几何吸附状态保持。')
    fields={'to':['pageCenter','pageAxes','pageEdges','pageCorners','objectCenters','objectMidlines','objectEdges','objectCorners'],
            'from':['boxCenter','boxCorners','boxEdgeMids']}
    for typ,names in fields.items():
        for name in names:
            for value in ['on','off']:
                src=[source(ADDONS+'paint-snap/ui.js',102,132),source(ADDONS+'paint-snap/ui.js',233,279)]
                id='addon.paint-snap.popover.'+typ+'.'+name+'.'+value
                add(id,'extensions-addons','Snap '+typ+' '+name+' '+value,'Snap popover对应On/Off按钮',src,
                    'setSnap'+typ.title()+'('+name+','+str(value=='on').lower()+')；snapTo还toggle(true)，会影响后续资产几何。持久化manifest设置与popover内存值是不同触发。',
                    'tw paint-snap set '+typ+'.'+name+' '+str(value=='on').lower(),'pending',
                    note='设置字段与按钮接线确认；实际几何/吸附优先级/阈值坐标未完全验证，不升级addon处置。',visibility='addon-enabled')
                rows['paint-snap']['actionIds'].append(id)
    for op,start,end,effect in [('input',134,155,'change：按min=4/max=50裁剪valueInput.value，然后onChange(valueInput.value)。'),('decrement',158,165,'源码先valueInput.value -= 1，却onChange(Number(valueInput.value)+1)，回调仍为旧值；显示与实际阈值不一致。'),('increment',167,174,'源码先valueInput.value += 1，却onChange(Number(valueInput.value)+1)，回调比旧值大2；可能越过UI max50。')]:
        control('paint-snap','popover.threshold.'+op,'Snap阈值 '+op,'Snap阈值输入/－/＋','ui.js',start,end,effect+' 回调在ui.js:220-230调用setThreshold；CLI应记录真实行为，修复源码不属本线。',disp='pending',cmd='tw paint-snap threshold --op '+op+' --value <n>',note='已确认上游显示/回调不一致，是否设计为bugcompat需实现线决定；本线不改源码。')
    # Dynamic counts are represented by stable action type + controller/button/axis indices, not omitted.
    control('gamepad','open','打开Gamepad映射设置','舞台控制器按钮','userscript.js',204,217,'生成editor和modal，无项目写入。')
    control('gamepad','close','关闭Gamepad映射设置','X、Enter/Space在X、Esc（非监听输入）、背景','userscript.js',219,238,'移除modal，已选择映射保留；不伪称回滚。')
    control('gamepad','select-controller','选择要编辑的控制器','控制器下拉select','gamepadlib.js',714,738,'改变selected controller索引及显示内容；多个设备以index参数，不新增无限ID。')
    for suffix,start,end,effect,cmd in [('bind-key',835,885,'监听key（单字符及列出的特殊键），Alt被忽略；Shift/Control在keyup提交，设置mapping.high/low。','tw gamepad bind-key --controller <id> --button/--axis <index> --property <high|low> --key <key>'),('bind-mouse',817,833,'mapping input进入acceptingInput后再click，设置type=mousedown、button=e.button；轴子控件allowClick=false。','tw gamepad bind-mouse --controller <id> --button <index> --mouse-button <n>'),('clear-binding',864,871,'监听不支持且非Escape的键将mapping.property=null并changed；Escape保留旧映射退出监听。','tw gamepad clear-binding --controller <id> --button/--axis <index> --property <high|low>')]:
        control('gamepad',suffix,suffix,'映射输入激活后按键/点击','gamepadlib.js',start,end,effect+' changed→mapping-changed；若shouldStore则更新项目magic comment。',disp='limited',cmd=cmd)
    control('gamepad','cancel-bind','取消控制器绑定监听','Escape或blur','gamepadlib.js',864,892,'退出监听并恢复display，未采集新映射；部分key会清空映射，不能把所有键当cancel。')
    for mode in ['none','cursor','wasd','arrows','custom']:
        control('gamepad','axis-mode.'+mode,'双轴映射 '+mode,'Axis下拉选择 '+mode,'gamepadlib.js',908,1020,'按选项设置相邻index/index+1映射；custom保留已有key或初始化arrows；none用emptyMapping；按项目store选项保存。',disp='limited',cmd='tw gamepad axis --controller <id> --index <n> --mode '+mode)
    for id,effect in [('addon.gamepad.reset','gamepad.resetControls后shouldStoreSettingsInProject=false、checkbox=false；映射恢复默认，不自动声称删除旧magic comment。'),('addon.gamepad.clear','gamepad.clearControls后shouldStoreSettingsInProject=false、checkbox=false；清活动映射，不自动声称删除旧magic comment。')]:
        ACTIONS[id]['effect']=effect
    # Debugger visible tabs/navigation and block types are finite and should not remain a broad gap.
    alias('addon.debugger.tabs',['addon.debugger.tab.logs','addon.debugger.tab.threads','addon.debugger.tab.performance'],'三种可见tab各自登记，汇总行不计。')
    for typ in ['logs','threads','performance']:
        control('debugger','tab.'+typ,'调试器 '+typ+' tab','点击'+typ+'标签','userscript.js',531,560,'切activeTab并调整header按钮，仅视图；数据查询/导出另有动作。')
    control('debugger','drag','移动调试器窗口','拖调试器顶部','userscript.js',133,168,'clampedX/Y改变interface style，不改项目。')
    control('debugger','locate-log-block','日志/线程定位积木','日志/线程目标链接mousedown','userscript.js',273,309,'先setEditingTarget(originalId)、切Code tab、goToBlock；CLI输出原target/block，工作区滚屏不复现。',disp='limited',cmd='tw debug locate --target <id> --block <id>')
    control('debugger','compiler-warning','点击编译器限制警告','调试器警告条','userscript.js',108,121,'打开高级设置，不自动禁用compiler。')
    alias('addon.debugger.log',['addon.debugger.emit.log','addon.debugger.emit.warn','addon.debugger.emit.error'],'三个调试自定义块分别登记；编译兼容/持久化待验收。')
    for typ,start,end in [('log',44,50),('warn',51,57),('error',58,64)]:
        control('debugger','emit.'+typ,'调试 '+typ+' 积木','执行对应自定义 '+typ+' %s 积木','userscript.js',start,end,'debugger.addLog(text,thread,"'+typ+'")；记录类别/位置/count，未注册addon时的项目兼容仍limited。',disp='limited',cmd='tw debug log <text> --type '+typ)
    for side,start,end in [('previous',710,714),('next',718,722)]:
        control('find-bar','result-'+side,'查找结果 '+side,'Find carousel按钮/左右键','userscript.js',start,end,'选择下/上个匹配script并定位；CLI输出结果索引/ID，滚屏不复现。',disp='limited',cmd='tw find <query> --result '+side)
    for side,idx in [('previous','index-1'),('next','index+1')]:
        control('editor-devtools','costume-'+side,'快捷切造型 '+side,'costume editor Ctrl/Cmd+'+('Left' if side=='previous' else 'Right'),'DevTools.js',614,662,'DOM点击相邻造型卡→setCostume，currentCostume是项目状态；无前/后项则无操作。',disp='commanded',cmd='tw costume use <'+idx+'>')
    # Remaining UI controls for variable manager oversized values and per-tab entry.
    control('variable-manager','open','打开变量管理Tab','Variables Tab按钮','userscript.js',328,354,'仅编辑器tab切换；变量读写/改名独立登记。')
    control('variable-manager','large-value-show','显示超大变量/列表','值超出限制时点击显示按钮','userscript.js',219,241,'解除该行只读/tooBig遮挡显示值，不修改变量。')
    for row in ADDON_ROWS:
        row['actionIds']=[i for i in row['actionIds'] if i not in ALIASES]
        for old,entry in ALIASES.items():
            if old.startswith('addon.'+row['id']+'.'):row['actionIds']+=entry['canonicalIds']
        row['actionIds']=sorted(set(row['actionIds']))


def apply_independent_review_repairs():
    """Fifteen action-specific static findings supplied by the independent reviewer.
    Only source classification is confirmed; implementation/GUI execution remains pending.
    """
    def patch(id, issue, **fields):
        ACTIONS[id].update(fields)
        ACTIONS[id]['independentReview']={'status':'unconfirmed-disposition-pass' if issue=='R13' else 'static-pass' if issue in ['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R14','R15'] else 'pending-independent-rereview','issue':issue,'report':'tw-cli/docs/census/independent-review-notes.md','runtimeExecuted':False,'source':'independent reviewer final R09 verdict (non-user peer review)','approvedBy':'independent-peer-static-review-only'}
        ACTIONS[id]['reviewNotes'].append('独立复核 '+issue+'：'+('static-pass' if issue in ['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R14','R15'] else 'partial已改、待独立复审')+'；未运行GUI/CLI验收。')
        if 'sources' in fields:ACTIONS[id]['ref']=refstr(fields['sources'])
    def register(id, issue, area, name, trigger, evidence, effect, command=None, disposition='commanded', **extra):
        add(id,area,name,trigger,evidence,effect,command,disposition,**extra)
        patch(id,issue)
    # R01/R02: onChangeColor reaches selected items; copying is a snapshot, not source re-read.
    patch('costumes.paint-eye-dropper','R01',proposedDisposition='commanded',proposedCommand='tw paint sample <costume> <x> <y> # 输出颜色，再paint style应用',
          sources=[S('containers/color-picker.jsx',161,165,PAINT),S('containers/paint-editor.jsx',273,285,PAINT),S('containers/color-indicator.jsx',33,79,PAINT)],
          effect='吸管保存onChangeColor回调，画布内松手callback(colorString)；有选区时applyColorToSelection，关闭颜色面板onUpdateImage写资产。不能归纯UI。')
    patch('sounds.editor.copy','R02',proposedDisposition='commanded',proposedCommand='tw asset copy sound <id> --range <a,b> --output <clipboard.wav>',
          sources=[S('containers/sound-editor.jsx',317,332),S('containers/sound-editor.jsx',375,425)],
          effect='复制当时选区/全曲Float32Array到copyBuffer快照，跨声音保留；粘贴读取该快照而非重新读取源声音。')
    patch('costumes.paint-copy','R02',proposedDisposition='commanded',proposedCommand='tw paint copy <costume> --nodes <ids> --output <clipboard.json>',
          sources=[S('hocs/copy-paste-hoc.jsx',30,89,PAINT)],
          effect='选区Paper exportJSON生成clipboard快照；无选区取整图/修剪Raster。paste importJSON并加10*pasteOffset；不得用后续重新读取原资产替代copy。')
    # R03: real scheduling effect, explicitly OS-specific, never a pure-visual claim.
    patch('desktop.pref.backgroundThrottling','R03',proposedDisposition='not-applicable',proposedCommand=None,
          sources=[S('src-main/windows/desktop-settings.js',75,79,DESKTOP),S('src-main/windows/editor.js',594,596,DESKTOP)],
          effect='写settings并立即webContents.setBackgroundThrottling，影响后台renderer定时器/运行调度，非纯视觉。CLI无Electron后台窗口，仅OSshell专属调度边界；headless frameclock不是自动等价。',
          boundary={'decision':'OS-shell','pureVisual':False,'reason':'Electron renderer visibility/background scheduling does not exist in CLI; do not downgrade project semantics as UI.'})
    # R04/R05: controller navigation can save mappings; distinguish addon reset from runtime reset.
    game_sources=[S('addons/addons/gamepad/userscript.js',149,212),S('addons/addons/gamepad/gamepadlib.js',730,737),S('addons/addons/gamepad/gamepadlib.js',1143,1155)]
    for id in ['addon.gamepad.open','addon.gamepad.select-controller']:
        patch(id,'R04',proposedDisposition='commanded',proposedCommand='tw gamepad config --controller <id> --store-project <bool>',sources=game_sources,
              effect='打开/选择controller会updateAllContent→mapping-changed；若shouldStoreSettingsInProject=true，storeMappings将当前控制器映射写stage magic comment并标项目改变。否则只改UI；条件项目写入不能排除。')
    register('addon.gamepad.reset-settings','R05','extensions-addons','Gamepad插件恢复manifest默认设置','已启用插件标题Reset',
             [S('addons/settings/settings.jsx',607,621),S('addons/settings-store.js',356,366),S('addons/addons/gamepad/_manifest_entry.js',1,35)],
             'SettingsStore.resetAddon(gamepad)恢复hide设置默认值，区别于映射面板Reset controls；配置重置不自动改项目映射。','tw addon reset gamepad --config <path>')
    patch('addon.gamepad.reset','R05',name='Gamepad运行映射Reset controls',effect='只gamepad.resetControls，shouldStore=false；不是SettingsStore.resetAddon，不覆盖hide设置。保留旧runtime ID。')
    next(row for row in ADDON_ROWS if row['id']=='gamepad')['actionIds'].append('addon.gamepad.reset-settings')
    # R06: replace accidental sound component/PropTypes references by executing containers.
    sounds={
        'sounds.editor.copy':[(317,332),(375,425)],'sounds.editor.deleteSelection':[(193,215)],
        'sounds.editor.keepSelection':[(216,234)],'sounds.editor.paste':[(375,427)],
        'sounds.editor.play':[(172,179)],'sounds.editor.redo':[(306,316)],
        'sounds.editor.stop':[(180,183)],'sounds.editor.trim.clear':[(109,112),(431,436)],
        'sounds.editor.undo':[(295,305)]}
    for id,ranges in sounds.items():
        patch(id,'R06',sources=[S('containers/sound-editor.jsx',a,b) for a,b in ranges]+([S('lib/audio/audio-buffer-player.js',16,32)] if id=='sounds.editor.play' else []))
    # R07: real PlayButton event branching, not a dead indicator or whole-item hover.
    patch('sounds.library.preview','R07',trigger='Play圆钮mousedown或mouseenter开始；touchstart切换；mouseleave非touch开始则停止。普通item hover在showPlayButton=true时skip。',
          sources=[S('containers/library-item.jsx',85,113),S('containers/library-item.jsx',165,174),S('containers/play-button.jsx',43,82),S('containers/sound-library.jsx',128,168)],
          effect='PlayButton onPlay/onStop→LibraryItem.handlePlay/Stop→SoundLibrary decode/play/stop；设备试听有输出，不是死代码。')
    register('sounds.library.preview-stop','R07','sounds','停止声音库试听','播放圆钮mousedown/touchstart；非touch鼠标移出',
             [S('containers/play-button.jsx',43,82),S('containers/library-item.jsx',108,113),S('containers/sound-library.jsx',166,168)],
             '停止对应库SoundPlayer；不追加项目声音。零交互离线输出不能冒称实时Stop已实现。',disposition='not-applicable')
    # R08: toolbar no-selection selectAll is different from direct keyboard delete and reshape point deletion.
    patch('costumes.paint-delete-selection','R08',name='绘图工具栏Delete选区/无选区全选删除',trigger='工具栏Delete；键盘删除另登记',
          sources=[S('containers/mode-tools.jsx',198,211,PAINT),S('helper/selection.js',253,263,PAINT)],
          effect='toolbar handleDelete无选区会selectAll；RESHAPE先删除选中segments，没有segments才删item，非整图clear统一语义。',proposedCommand='tw paint delete <costume> --nodes <ids> # reshape用point-delete')
    register('paint.selection.keyboard-delete','R08','paint-tools','键盘删除所选item/segments','Delete/Backspace（无选区不自动全选）',
             [S('hocs/keyboard-shortcuts-hoc.jsx',64,68,PAINT),S('helper/selection.js',253,263,PAINT)],
             '直接deleteSelection，RESHAPE删selected segments或item；无选区无删除。必须区别toolbar先selectAll。','tw paint delete <costume> --nodes <ids>')
    register('paint.reshape.delete-segments','R08','paint-tools','删除变形模式选中控制点','RESHAPE选中segments后Delete或toolbarDelete',
             [S('helper/selection.js',214,249,PAINT),S('helper/selection.js',253,263,PAINT)],
             '_removeSelectedSegments保留/修正相邻路径；不等同删除整个Path，也不等同clear。','tw paint point-delete <costume> --path <id> --segments <ids>')
    register('paint.reshape.doubleclick-remove-point','R08','paint-tools','双击控制点删除','双击segment后未拖动松手',
             [S('helper/selection-tools/point-tool.js',41,45,PAINT),S('helper/selection-tools/point-tool.js',81,104,PAINT),S('helper/selection-tools/point-tool.js',162,169,PAINT)],
             'removePoint删除segment并按新的curveLength调整前handleOut/后handleIn，onUpdateImage保存；不是简单删item。','tw paint point-delete <costume> --path <id> --segments <id>')
    # R09: six recorder choices; only live microphone is D7, all other output scheduling/audio choices commanded.
    for suffix,start,end,effect,cmd,disp in [
        ('duration',47,63,'secs钳1..600并setTimeout停止；会影响导出视频长度。','tw record --duration <seconds>','commanded'),
        ('delay',65,81,'delay整数段每秒等待975ms、余数*1000；开始延迟影响输出内容。','tw record --delay <seconds>','commanded'),
        ('project-audio',83,99,'audioEnabled时audioEngine.inputNode接入MediaStreamDestination并混入输出。','tw record --project-audio <bool>','commanded'),
        ('mic-mix',101,116,'micEnabled时getUserMedia音轨混入；实时D7 limited，预录音频替代需实际实现与fixture。','tw record --mic-file <wav>','limited'),
        ('wait-flag',118,134,'waitUntilFlag监听PROJECT_START；启动信号对齐真实录制内容。','tw record --wait-flag <bool>','commanded'),
        ('end-stop',135,158,'只waitUntilFlag开时可用；PROJECT_STOP_ALL触发结束导出。','tw record --end-on-stop <bool>','commanded')]:
        register('addon.mediarecorder.option.'+suffix,'R09','extensions-addons','录项目视频 '+suffix,'录制配置对应数字框/复选框',
                 [S('addons/addons/mediarecorder/userscript.js',start,end),S('addons/addons/mediarecorder/userscript.js',186,196),S('addons/addons/mediarecorder/userscript.js',239,328)],
                 effect,cmd,disp)
        next(row for row in ADDON_ROWS if row['id']=='mediarecorder')['actionIds'].append('addon.mediarecorder.option.'+suffix)
    # R10/R11: compiled frozen line 230, exact anchors and function context preserve long-line semantic proof.
    packpath=DESKTOP+'src-renderer/packager/standalone.html'
    for suffix,name,anchor,effect,cmd in [
        ('project-id','打包器按Scratch ID输入','if("id"===l)','SelectProject.type=id：读取metadata/token再项目数据；不是editor打开项目UI。','tw pack project-id <id>'),
        ('project-url','打包器按URL输入','if("url"!==l)','SelectProject.type=url：校验http/https并fetch project；与桌面editor OpenedFile动作分开。','tw pack project-url <url>')]:
        register('package.'+suffix,'R10','project-io',name,'SelectProject ID/URL模式输入后Load/Enter',
                 [source(packpath,230,anchor=anchor),source(packpath,230,anchor='SelectProject.type')],effect,cmd)
    line=read(packpath).splitlines()[229]
    resets=list(re.finditer(r'E\(\[([^\]]*)\]\)',line))
    assert len(resets)==8
    names=['runtime','player','cursor','cloud','advanced','target','application','steamworks']
    for name,match in zip(names,resets):
        keys=json.loads('['+match[1]+']')
        extra=''
        if name=='player':extra=' 同时将app icon blob与loadingScreen image blob置null。'
        if name=='cursor':extra=' 同时将customCursor blob置null。'
        register('package.reset.'+name,'R11','project-io','打包器局部Reset '+name,'对应分组Reset按钮→确认',
                 [source(packpath,30,anchor='reset.confirm'),source(packpath,230,anchor=match.group(0))],
                 '确认后E逐key拷贝上游默认并g.set；只重置 '+','.join(keys)+'。'+extra,
                 'tw pack reset <group> # 提案，按真实keys逐项重置')
        ACTIONS['package.reset.'+name]['resetKeys']=keys
    register('package.cursor-auto-center','R11','project-io','自定义光标自动居中','cursor Automatically center按钮',
             [source(packpath,230,anchor='l.cursor.center.x=Math.round(n.width/2)'),source(packpath,230,anchor='l.cursor.center.y=Math.round(n.height/2)')],
             '解码自定义cursor图像width/height，centerX/Y各取Math.round(尺寸/2)，不改stageSize。','tw pack cursor-center-auto')
    # R12: generic WebGUI prompts unreachable in desktop; native prompts remain separately counted.
    for typ in ['geolocate','notify','read-clipboard']:
        for choice in ['allow','deny']:
            id='permission.'+typ+'.'+choice
            patch(id,'R12',kind='excluded-control',visibility='web-gui-only-not-rendered-in-desktop',
                  sources=ACTIONS[id]['sources']+[S('src-renderer-webpack/editor/gui/desktop-hoc.jsx',65,74,DESKTOP),S('containers/tw-security-manager.jsx',164,169),S('src-main/windows/project-running-window.js',71,78,DESKTOP)],
                  effect='通用WebGUI '+typ+'安全modal决定仍保留，但desktop propsSecurityManager覆盖：clipboard/notify返回true交Electron native权限，geolocate返回false不弹此modal。不计desktop动作分母。')
    # R13: canEmbed policy is data, only native embedding execution is DOM dependent.
    for choice in ['allow','deny']:
        patch('permission.embed.'+choice,'R13',proposedDisposition='commanded',proposedCommand='tw permission check embed:<url> '+('--allow embed:<url>' if choice=='allow' else ''),
              sources=[S('containers/tw-security-manager.jsx',404,419),S('extension-support/tw-unsandboxed-extension-runner.js',91,96,VM),S('components/tw-security-manager-modal/security-manager-modal.jsx',64,86)],
              effect='canEmbed返回Boolean并会话缓存允许host；权限policy本身可无DOM，不等于创建iframe或渲染网页。')
    register('extension.embed-dom-execution','R13','extensions-addons','扩展嵌入网页DOM执行','扩展获canEmbed允许后创建/嵌入webDOM',
             [S('extension-support/tw-unsandboxed-extension-runner.js',91,96,VM),S('components/tw-security-manager-modal/embed.jsx',1,35)],
             'canEmbed只返回授权；真实HTML/iframe/DOM展示属D6，不承诺headless等价。',disposition='dom-only',visibility='extension-dependent')
    # R14: three haptics denial outcomes, never video-input authorization.
    vibration=next(row for row in ADDON_ROWS if row['id']=='tw-disable-vibration')
    vibration['actionIds']=[id for id in vibration['actionIds'] if id!='permission.record-video.deny']
    for suffix,start,end,effect in [('navigator-vibrate',1,9,'navigator.vibrate返回false'),('gamepad-pulse',12,19,'GamepadHapticActuator.pulse返回Promise(false)'),('gamepad-play-effect',22,29,'GamepadHapticActuator.playEffect返回Promise("preempted")')]:
        id='addon.tw-disable-vibration.'+suffix
        register(id,'R14','extensions-addons','禁止振动 '+suffix,'启用addon时项目请求对应振动API',
                 [S('addons/addons/tw-disable-vibration/userscript.js',start,end)],
                 effect+'；禁用addon恢复原API。设备输出可观察，不与camera/麦克风混淆；CLI默认deny等价边界待验证。','tw device permission vibration deny','limited')
        vibration['actionIds'].append(id)
    # R15: faceSensing URL precedence; capture boundary is separate from unapproved executable JS.
    patch('extension.load.faceSensing','R15',name='加载画廊URL Face Sensing（非VM内置）',proposedDisposition='pending',proposedCommand='tw ext load-url https://extensions.turbowarp.org/lab/face-sensing.js',
          sources=[S('lib/libraries/extensions/index.jsx',130,142),S('containers/extension-library.jsx',142,147),S('extension-support/extension-manager.js',12,29,VM)],
          effect='item.extensionURL优先于extensionId：加载lab/face-sensing.js。VM defaultBuiltinExtensions没有faceSensing；目录可离线读取不代表安全执行。D7只限制相机采集，不能将URL加载失败当D7豁免。',reviewStatus='unconfirmed',reviewNotes=['独立审确认非builtin；可执行第三方JS加载/安全sandbox及识别帧fixture仍pending。'])
    # Second independent pass: seven static-pass, eight partial require rereview.
    # Copy/paste is a closed file protocol, not re-reading a selected source asset later.
    patch('sounds.editor.paste','R02',sources=[S('containers/sound-editor.jsx',375,427)],
          proposedCommand='tw asset paste sound <destination-id> --from clipboard.wav [--range <a,b> --units fraction]',
          effect='读取copy时样本快照copyBuffer；CLI协议asset copy sound <source> --range→clipboard.wav，再asset paste sound <destination> --from同文件：无选区append，有选区replace；跨采样率先OfflineAudioContext resample。assetcopy WAV为mono channel0快照，不能source重新读取。',
          clipboardProtocol={'kind':'sound-snapshot','producer':'asset copy sound <source-id> --range <a,b> --units fraction --output clipboard.wav','consumer':'asset paste sound <destination-id> --from clipboard.wav [--range <a,b> --units fraction]','scope':'source selection snapshot; append or replace destination selection; rate conversion','format':'PCM WAV snapshot','guiSourceFormat':'Float32Array samples+sampleRate memory; persisted WAV quantization remains acceptance pending'})
    patch('sounds.editor.copy','R02',clipboardProtocol=ACTIONS['sounds.editor.paste']['clipboardProtocol'])
    patch('costumes.paint-paste','R02',sources=[S('hocs/copy-paste-hoc.jsx',30,89,PAINT)],
          proposedCommand='tw paint paste <destination-costume> --from clipboard.json --dx <10*pasteOffset> --dy <10*pasteOffset>',
          effect='copy当时Paper exportJSON快照→paste Base.importJSON；bitmap目标非单Raster须group.rasterize；10*pasteOffset每次偏移并递增。CLIvector JSONsnapshot producer/consumer必须同协议；bitmap PNGsnapshot另协议，跨format必须显式处理，非重新读取源造型。',
          clipboardProtocol={'vector':{'producer':'paint copy <source-costume> --nodes <ids> --output clipboard.json','consumer':'paint paste <destination-costume> --from clipboard.json --dx <offset> --dy <offset>','format':'tw-vector-clipboard JSON nodes+defs snapshot; GUI Paper exportJSON mapping pending'},'bitmap':{'producer':'paint copy <source-costume> --rect x,y,w,h --output clipboard.png','consumer':'paint paste <destination-costume> --from clipboard.png --spec {x,y}','format':'PNG snapshot; GUI Raster exportJSON mapping pending'},'scope':'all/selected root or reshape CompoundPath; trim bitmap no-selection; cross-format rasterization; auto10offset lifecycle pending'})
    patch('costumes.paint-copy','R02',clipboardProtocol=ACTIONS['costumes.paint-paste']['clipboardProtocol'])
    for id in ['addon.gamepad.open','addon.gamepad.select-controller']:
        patch(id,'R04',sources=[S('addons/addons/gamepad/userscript.js',187,212),S('addons/addons/gamepad/gamepadlib.js',730,744),S('addons/addons/gamepad/gamepadlib.js',1143,1155)],
              effect='open在generateEditor后直接handleEditorControllerChanged；select controller执行updateContent然后发gamepad-changed→handleEditorControllerChanged→handleGamepadMappingChanged；仅shouldStore=true时storeMappings写magic comment。updateAllContent本身不发mapping-changed，不能错引。')
    patch('sounds.library.preview','R07',sources=[S('containers/library-item.jsx',85,113),S('containers/library-item.jsx',165,174),S('containers/play-button.jsx',18,20),S('containers/play-button.jsx',43,82),S('containers/sound-library.jsx',128,168)],
          effect='PlayButton onPlay→LibraryItem.handlePlay→sound decode/play。源码state声明/写入touchStarted，但mousedown及mouseleave读取touchstarted（小写s）拼写不一致；不能承诺touch正常免mouseleave stop。',
          trigger='Play圆钮mousedown/mouseenter开始，touchstart切换；普通item hover showPlayButton=true skip；mouseleave读取错误touchstarted字段可能停掉touch开始的播放。')
    patch('sounds.library.preview-stop','R07',effect='mousedown/touchstart在isPlaying时onStop；mouseleave用state.touchstarted而写入touchStarted，拼写异常意味着不能记录正常touch免stop；stop函数真实执行。')
    # Segment keyboard deletion is a sub-branch, not a third separately triggered action.
    seg=ACTIONS.pop('paint.reshape.delete-segments')
    alias('paint.reshape.delete-segments',['costumes.paint-delete-selection','paint.selection.keyboard-delete'],'RESHAPE删选中segment是toolbar/keyboard delete的子分支，不额外增加第三个动作分母。')
    for id in ['costumes.paint-delete-selection','paint.selection.keyboard-delete']:
        ACTIONS[id]['sources']+=seg['sources']
        ACTIONS[id]['effect']+=' RESHAPE _removeSelectedSegments直接seg.remove，不执行PointTool.removePoint的双击邻接句柄补偿；命令应普通point-delete模式。'
        ACTIONS[id]['subbranches']=[{'name':'reshape selected segments','commandProposal':'tw paint point-delete <costume> --path <path-id> --segments <ids>','evidence':S('helper/selection.js',226,249,PAINT)},{'name':'item/root selection','commandProposal':'tw paint delete <costume> --nodes <ids>','evidence':S('helper/selection.js',253,263,PAINT)}]
    patch('paint.reshape.doubleclick-remove-point','R08',proposedCommand='tw paint point-delete <costume> --path <path-id> --segments <id> --double-click',
          effect='独立doubleclick随后无drag的PointTool.removePoint；删除后按新curveLength调整前handleOut/后handleIn，非keyboard seg.remove；CLI必须独立double-click补偿模式并fixture验证。')
    for suffix in ['duration','delay','project-audio','mic-mix','wait-flag','end-stop']:
        id='addon.mediarecorder.option.'+suffix
        ACTIONS[id]['effect']+=' 时序：secs clamp后timeout在userscript:308设置，随后314-328执行delay，325 recorder.start；计时包含开始前delay，不能当录制开始后duration。mic NotAllowedError/NotFoundError在248-255将micEnabled=false继续，其它error抛出。'
        patch(id,'R09')
    # No decoded Brotli iframe source with reviewed line/anchor is yet pinned; retain a candidate, not DOM counted action.
    patch('extension.embed-dom-execution','R13',kind='unconfirmed-candidate',visibility='dynamic-extension-execution-unconfirmed',proposedDisposition='pending',
          proposedCommand=None,effect='待规范化冻结iframe.js.br解压source：createFrame97-115与display327-341→canEmbed的执行证据；当前policy/权限提示不能证明实际iframe执行，保留未确认候选不计desktop动作。',
          sources=[S('containers/tw-security-manager.jsx',404,419),S('extension-support/tw-unsandboxed-extension-runner.js',91,96,VM)],
          reviewStatus='unconfirmed',reviewNotes=['R13政策命令化与真实iframe执行必须分开；尚未固化decodedBrotli path/line/sha规范证据，不自授DOM审结。'])
    patch('extension.load.faceSensing','R15',sources=ACTIONS['extension.load.faceSensing']['sources']+[S('containers/tw-security-manager.jsx',26,34),S('containers/tw-security-manager.jsx',235,240),S('containers/tw-security-manager.jsx',257,260),S('src-main/windows/project-running-window.js',124,128,DESKTOP)],
          effect=ACTIONS['extension.load.faceSensing']['effect']+' 官网上URL被isTrustedExtension自动信任；getSandboxMode返回unsandboxed且canLoadExtensionFromProject返回true，无通用加载授权modal；desktop主进程将HTTPS extensions.turbowarp.org资源redirect至tw-extensions本地冻结字节。不代表CLI已有允许执行或识别fixture。')
    # Third pass: twelve dispositions concluded (R13 candidate only), three residuals.
    for id in ['addon.gamepad.open','addon.gamepad.select-controller']:
        patch(id,'R04',sources=ACTIONS[id]['sources']+[S('addons/addons/gamepad/userscript.js',149,177)],
              effect=ACTIONS[id]['effect']+' store=true只是必要非充分：storeMappings调用editor.export()，export为null则立即return不写；有效export才创建/改magic comment并didChangeProject。必须保留export-null无写入分支。')
    patch('sounds.library.preview-stop','R07',trigger='isPlaying时Play圆钮mousedown/touchstart调用onStop；mouseleave且state.touchstarted假也stop。冻结camelcase拼写异常使touchStarted=true仍可mouseleave停止。')
    for suffix in ['duration','delay','project-audio','mic-mix','wait-flag','end-stop']:
        id='addon.mediarecorder.option.'+suffix
        patch(id,'R09',sources=ACTIONS[id]['sources']+[S('addons/addons/mediarecorder/userscript.js',217,237)],
              effect=ACTIONS[id]['effect']+' 异常：若duration timeout实际早于recorder.start触发，stopRecording227发现recorder.state=inactive便return，timeout被忽略；后续start没有同一duration timer再次停止。整秒delay每秒等待975ms，余数等待fraction*1000ms，因此名义delay>=duration不是timeout先到的充分条件：duration=10/delay=10时名义start约9.75s，timer未必在inactive时触发；调度开销另影响实际先后。CLI拒绝delay>=duration为保守intentional difference，保持pending；不能冒充上游分支条件或GUI全等价。')
    # Normalize alias references and inventory after branch removal.
    for old,entry in ALIASES.items():
        for target in entry['canonicalIds']:
            if target in ACTIONS:ACTIONS[target]['aliases']=sorted(set(ACTIONS[target]['aliases']+[old]))
    # Store exact independent finding memberships without promoting implementation status.
    for row in ADDON_ROWS:row['actionIds']=sorted(set(row['actionIds']))
    for a in ACTIONS.values():
        if a.get('independentReview'):
            a['sources']=list({(s['path'],s['line'],s['endLine'],s['anchor']):s for s in a['sources']}.values())
            a['ref']=refstr(a['sources'])


def final_review():
    def patch(id, **fields):
        ACTIONS[id].update(fields)
        if 'sources' in fields: ACTIONS[id]['ref']=refstr(fields['sources'])
    # The parser must not copy X / visible:true / default-mode into the Y / hide / large rows.
    fixes={
        'sprites.info.y':('vm.postSpriteInfo({y})→setXY；fencing 对坐标做限制；更新项目 y。','tw sprite set y <n> --target <id>'),
        'sprites.info.hide':('vm.postSpriteInfo({visible:false})→setVisible；更新项目 visible=false。','tw sprite set visible false --target <id>'),
        'stage.monitor.menu-mode-large':("requestUpdateMonitor({id,mode:'large'})；随 sb3 保存。",'tw monitor set <id> mode large'),
        'stage.monitor.menu-mode-slider':("仅 data_variable 可 requestUpdateMonitor({id,mode:'slider'})；随 sb3 保存。",'tw monitor set <id> mode slider'),
        'costumes.paint-curve-points':('按邻近 segment 生成/对齐 handleIn/Out，再 onUpdateImage 重写 SVG。','tw vector points curved <costume> --segments <ids>'),
        'costumes.paint-point-points':('将已选 segment 的 handleIn/Out 置 null，onUpdateImage 重写 SVG。','tw vector points pointed <costume> --segments <ids>'),
        'costumes.paint-ungroup':('ungroupSelection 将选中 Group 子元素提至父级，onUpdateImage 重写 SVG；与 group 相反。','tw vector ungroup <costume> --nodes <ids>'),
        'costumes.paint-send-backward':('sendBackward 将所选 SVG 元素后移一层，保持组层级后写资产。','tw vector order <costume> --backward --nodes <ids>'),
        'costumes.paint-send-to-back':('sendToBack 将选中元素移到同级底部，写 SVG。','tw vector order <costume> --back --nodes <ids>'),
        'costumes.paint-flip-vertical':('scale(1,-1) 垂直镜像选区/整图；矢量修复 path orientation，位图 flipBitmapVertical，重写资产。','tw costume transform <costume> --flip-vertical'),
        'code-ws.make-list':('创建 type=list 的全局/当前角色列表；创建时默认显示 monitor，hide-new-variables 可改写。','tw list add <name> <json> --scope <global|local> --target <id>'),
    }
    for id,(effect,cmd) in fixes.items(): patch(id,effect=effect,proposedCommand=cmd)
    patch('mb.file.save-separate',visibility='not-rendered-in-desktop',proposedDisposition='not-applicable',proposedCommand=None,
          effect='notScratchDesktop() 为显式守卫；桌面不渲染此项。网页端 downloadProject 一次性导出不绑定句柄；不是桌面可见导出入口。',
          sources=[S('components/menu-bar/menu-bar.jsx',670,689),S('containers/sb3-downloader.jsx',84,93)])
    patch('mb.see-inside',sources=[S('components/menu-bar/menu-bar.jsx',1007,1012),S('components/menu-bar/tw-see-inside.jsx',10,31)])
    patch('backdrops.add-blank',sources=[S('containers/stage-selector.jsx',101,105),S('containers/costume-tab.jsx',165,170)])
    patch('backdrops.upload-file',sources=[S('containers/stage-selector.jsx',106,119),S('containers/costume-tab.jsx',197,213)])
    patch('backdrops.library-search',sources=[S('components/library/library.jsx',156,173)],name='背景库搜索')
    patch('backdrops.library-tag-filter',sources=[S('components/library/library.jsx',117,131)],name='背景库标签过滤')
    patch('sprites.library.favorite',sources=[S('components/library-item/library-item.jsx',34,47),S('components/library/library.jsx',100,113)])
    patch('stage.indicator.active-color',sources=[S('components/controls/controls.jsx',38,53),S('components/green-flag/green-flag.jsx',20,24),S('components/stop-all/stop-all.jsx',20,24)])
    patch('stage.pointer.right-down',effect='button=2 发 mouse IO；项目调用右键感知后 usesRightClickDown 使 contextmenu 被抑制，右键与普通 down 合并 primitive 但保留用户触发。')
    patch('stage.run.greenflag-right-click',effect='contextmenu 事件调用 onGreenFlagClick；非 Shift 时切 30↔60 fps；Shift+右键同时切 turbo 与 fps。')
    patch('stage.run.greenflag-shift-click',effect='Shift click 切 turbo；若同时 Alt/右键还切 fps。组合修饰键分支已在同 handler 登记。')
    for id in ['stage.dblclick.select-target','stage.fullscreen.os-f11-altenter','stage.fullscreen.os-escape']:
        patch(id,reviewStatus='source-reviewed',reviewNotes=['静态接线已复核；不宣称实机三平台验证。'])
    # Active note/audio previews are observable output. D1 includes audio-to-file, not user speakers.
    for id in ['sounds.editor.play','sounds.record.playback.play','sounds.library.preview']:
        patch(id,proposedDisposition='limited',proposedCommand='tw sound render <sound> <out.wav> --range <start,end>',
              effect=ACTIONS[id]['effect']+'；试听是用户可闻输出，D1 文件输出替代播放器；不能只因不改 sb3 就删掉能力。',
              reviewNotes=['实时扬声器播放/选区采样率/包络对拍未验收；文件输出不是设备播放。'])
    for id in ['sounds.editor.stop','sounds.record.playback.stop']:
        patch(id,proposedDisposition='not-applicable',proposedCommand=None,effect='停止当前扬声器试听；CLI 一次性 WAV 输出没有实时播放状态，输出取消需明确，不冒称已实现 stop。')
    for id in ['costumes.paint-brush-size','costumes.paint-eraser-size','costumes.paint-shape-thickness']:
        patch(id,proposedDisposition='commanded',proposedCommand='tw paint defaults --brush/--eraser/--thickness <n> --config <path>',
              effect='设置后续绘制数值参数；无选区时本身不改资产，但不是 CLI 应删除的能力，参数随对应绘制命令显式提供。')
    alias('costumes.paint-shape-fill-toggle',['paint.bitmap.shape-filled','paint.bitmap.shape-outlined'],'Filled/Outlined 是两个按钮，分别登记稳定 ID。')
    for suffix,needle in [('filled','onClick={props.onFillShapes}'),('outlined','onClick={props.onOutlineShapes}')]:
        add('paint.bitmap.shape-'+suffix,'paint-tools','位图形状 '+suffix,'位图矩形/圆工具对应按钮',[at(PAINT+'components/mode-tools/mode-tools.jsx',needle,before=4,after=3)],'setShapesFilled '+str(suffix=='filled').lower()+'；后续位图形状按此填充/描边，参数化而非弃置。','tw bitmap shape <costume> --filled <bool>')
    # Precise color channels are separate user controls. The former shorthand stays as a non-counting alias.
    alias('costumes.paint-color-readout',['paint.color.hue','paint.color.saturation','paint.color.brightness'],'三个数字/滑块控件拆分；作用于选中图形与后续绘制颜色。')
    for suffix,needle in [('hue','handleHueChange ('),('saturation','handleSaturationChange ('),('brightness','handleBrightnessChange (')]:
        add('paint.color.'+suffix,'paint-tools','颜色 '+suffix+' 数值输入','颜色面板对应 slider/百分比输入',[at(PAINT+'containers/color-picker.jsx',needle,after=7),S('containers/color-indicator.jsx',33,104,PAINT)],'按 HSV→hex/alpha 回填 fill/stroke；有选区时资产写回，无选区时只改变后续颜色参数。','tw vector style <costume> --'+suffix+' <0..100> --nodes <ids>')
    # Split combined add/remove comment context-menu row while preserving its original public ID.
    alias('code-ws.block-comment-add-remove',['code-ws.block-comment-add','code-ws.block-comment-remove'],'右键 Add/Remove comment 为两个状态下不同操作，避免复合 ID。')
    for suffix,cmd,effect in [('add','tw comment add <text> --block <id>','创建附着块注释，经 CommentCreate 写 target.comments。'),('remove','tw comment delete <id>','删除块注释，经 CommentDelete 移除 target.comments。')]:
        add('code-ws.block-comment-'+suffix,'code-workspace','块注释 '+suffix,'积木右键对应 Add/Remove comment',[S('core/contextmenu.js',296,315,BLOCKS)],effect,cmd)
    # Add missing close/help shell/modal surfaces with a checked source handler, not guesswork.
    add('project-io.webgl-back','project-io','WebGL 不支持提示返回','WebGL modal Back',[S('containers/webgl-modal.jsx',6,15)],'window.history.back，网页导航；无项目写入。',disposition='not-applicable')
    for suffix,needle in [('sb3fix','https://turbowarp.github.io/sb3fix/'),('report-validation','https://github.com/TurboWarp/sb3fix/issues')]:
        add('project-io.invalid-'+suffix,'project-io','无效项目提示 '+suffix,'错误 modal 对应链接',[at(GUI+'components/tw-invalid-project-modal/invalid-project-modal.jsx',needle,before=2,after=5)],'只打开修复站/issue，不自动修复项目。',disposition='not-applicable')
    # Per-handler command strings must not contain "same as", bare ellipses, or invented implemented status.
    for a in ACTIONS.values():
        cmd=a.get('proposedCommand')
        if cmd:
            cmd=cmd.replace('tw-cli ', 'tw ').replace('…','<args>').replace('--scope ...','--scope <global|local>')
            a['proposedCommand']=cmd
        a['effect']=re.sub(r'；同上[^；]*$', '', a['effect'])
    # Alias exactly repeated receiver/runtime UI actions rather than double-counting them.
    # Keep source/receiver evidence when merging a duplicate; the alias itself is not counted.
    for old,new in [('addon.drag-drop.drop-list','stage.monitor.menu-import-list'),('addon.drag-drop.drop-answer','stage.question.answer'),('addon.pick-colors-from-stage.apply-color','stage.colorpick.pick-from-stage')]:
        ACTIONS[new]['sources']+=ACTIONS[old]['sources']
        ACTIONS[new]['trigger']+='；'+ACTIONS[old]['trigger']
        if old=='addon.pick-colors-from-stage.apply-color':
            ACTIONS[new]['effect']+='；paint吸管发起时此addon接入相同stage callback，颜色回填paint fill/stroke，已选图形颜色可在关闭色板时持久化。'
        if old=='addon.drag-drop.drop-answer':
            ACTIONS[new]['effect']+='；文件填问答缓冲时 trim 尾换行并将内部换行转空格、替换当前选区，提交仍由 Enter/箭头执行。'
    alias('addon.drag-drop.drop-list','stage.monitor.menu-import-list','同一个被程序触发的 importCSV；新增文件 drag 触发记录合入源动作。')
    alias('addon.drag-drop.drop-answer','stage.question.answer','文件 drop 只填 question 缓冲文本；最终 ANSWER 与已登记提交同一能力，文本规范化记录在 source。')
    alias('addon.pick-colors-from-stage.apply-color','stage.colorpick.pick-from-stage','同一次 stage renderer 取色经 Redux glue 回填；不是第二次取色动作。')
    for row in ADDON_ROWS:
        for old in list(row['actionIds']):
            if old in ALIASES:
                row['actionIds'].remove(old)
                row['actionIds']+=ALIASES[old]['canonicalIds']
        row['actionIds']=sorted(set(row['actionIds']))
    # Count different UI triggers separately; identical enumeration in two drafts is represented by aliases.
    for old,entry in ALIASES.items():
        for id in entry['canonicalIds']:
            if id not in ACTIONS: raise ValueError(f'Alias target absent: {old} -> {id}')
            ACTIONS[id]['aliases'].append(old)
    for a in ACTIONS.values():
        a['aliases']=sorted(set(a['aliases']))
        a['implementationStatus']='pending'
        a['acceptanceStatus']='pending'
        a['sources']=list({(s['path'],s['line'],s['endLine'],s['anchor']):s for s in a['sources']}.values())
        a['ref']=refstr(a['sources'])
        a['implementationEvidence']=[]
        a['implementationNote']='M1 源码普查/命令提案，不等于 CLI 已实现；当前仅普查静态源码，不因同名 CLI 命令升级 implementationStatus；acceptanceStatus 独立待 GUI 对拍。'
        if a['origin']=='draft' and a['area'] in ['menu-bar','sprites','costumes'] and a['visibility']=='conditional':
            a['visibility']='desktop-editor'
        if a['kind']=='action' and (a['visibility']=='not-rendered-in-desktop' or a['id'].startswith(('mb.mode.','mb.file.save-now','mb.file.save-as-copy','mb.file.remix','mb.share-button','mb.remix-button','mb.community-button','mb.see-inside','mb.news.close','sprites.contextmenu.rename'))):
            a['visibility']='not-rendered-in-desktop'
            a['kind']='excluded-control'
        if a['origin']=='draft':
            a['reviewNotes'].append('历史行号已按当前冻结源码解析为完整 path:line，并读取引用片段；未把草稿摘要的 commanded 当已验收。')
            a['reviewNotes']=sorted(set(a['reviewNotes']))


OPEN_ISSUES = [
    {'id':'m1.dynamic-extension-buttons','status':'pending/unconfirmed','reason':'code-ws.extension-button 是任意 runtime callback dispatcher；远程画廊和自定义 JS 的按钮集合不封闭，不能宣称逐第三方扩展全量覆盖。'},
    {'id':'m1.project-file-drop','status':'pending/unconfirmed','reason':'确认了 asset drop 与拖放路径权限 IPC，未找到 desktop GUI .sb3 项目 drop 的执行接线；候选 project-io.drop-project-file 保留。'},
    {'id':'m1.addon-semantic-confirmation','status':'pending/unconfirmed','addonIds':['block-switching','editor-devtools','paint-snap','swap-local-global'],'reason':'opcode/shadow/连接、清理删除/undo、吸附优先级/几何、作用域/云/monitor 保真仍需逐分支复核；清单条目完整不等于此四项已确认。'},
    {'id':'m1.runtime-addon-microcontrols','status':'pending/unconfirmed','reason':'固定paint-snap/onion-skinning微控件、Gamepad每设备/按钮/轴的参数化动作类型、debugger各tab/导航已补齐。实际设备数量/运行中线程/动态第三方扩展数据项仍是开放集合；仅静态类型普查，未实机验收。'},
    {'id':'m1.desktop-roles-version','status':'not-applicable/unconfirmed','reason':'macOS services/editMenu/windowMenu 为 Electron 内置动态 roles；已登记 role，OS/Electron 按版本扩出的每个菜单项无法仅凭仓库冻结完全枚举。'},
    {'id':'m1.gui-parity-acceptance','status':'pending','reason':'无 GUI 操作对拍、音频/画图精度/字体/权限设备/packager全部target/三平台验收；本线不运行会写项目或启动 GUI 的命令。'},
    {'id':'m1.offline-library-assets','status':'resolved-input-gate-reported-by-main','reason':'主线程已独立check-baseline：1304/1304官方desktopv1.16 Linux tar/asar回收资产，missing0/errors0，301extensions/81addons hash通过；MIT直接下载0，来源不混淆。资产输入gate解决不自动验收四类library load。'}
]


def escaped(value):
    if value is None: return '—'
    return str(value).replace('\\n','<br>').replace('\n','<br>').replace('|','\\|')


def summarize(actions):
    byarea=dict(collections.Counter(a['area'] for a in actions))
    kinds=dict(collections.Counter(a['kind'] for a in actions))
    return {'ledgerRecordCount':len(actions),
            'actualActionCount':sum(a['kind'] in ['action','automatic-after-action'] for a in actions),
            'passiveDisplayCount':kinds.get('passive-display',0),
            'excludedControlCount':kinds.get('excluded-control',0),
            'unconfirmedCandidateCount':kinds.get('unconfirmed-candidate',0),
            'duplicateIdCount':0, 'missingAreaCount':0,'missingRequiredFieldCount':0,
            'byArea':byarea,'byKind':kinds,
            'byProposedDisposition':dict(sorted(collections.Counter(a['proposedDisposition'] for a in actions).items())),
            'byImplementationStatus':dict(collections.Counter(a['implementationStatus'] for a in actions)),
            'byAcceptanceStatus':dict(collections.Counter(a['acceptanceStatus'] for a in actions))}


def area_header(area, stats):
    extras={
        'menu-bar':'复核后 59 条记录；save-separate 受 notScratchDesktop() 排除。入口与操作效果不混记。',
        'code-workspace':'scratch-blocks core 与 blocks_vertical 使用完整路径；同名 procedures.js 已分开。UI zoom/工具等复合行拆为稳定子 ID。',
        'sprites':'原草稿实际49行，不是标题的50；脚本共享/造型共享/Restore接收端去重，补舞台选择。背包 _local_ 判定已更正。',
        'costumes':'不重复计 costumes.rename；paint操作移入paint-tools；背景库搜索/标签与颜色双控件已拆分，原ID留aliases。',
        'sounds':'10音效、文件解码/编辑/录音/预览均保留；实时采集D7、输出D1，立体声编辑单声道/10MB降采样需验收。',
        'stage-controls':'monitor和question归monitors-prompts但保留stage.*稳定ID；键盘输入补齐；瞬时visible:false拖影不再当纯视觉。',
        'monitors-prompts':'监视器模式/滑块/列表逐项编辑、范围、Prompt、过程声明、高级设置各选项；离散性取输入文本是否含小数点。',
        'extensions-addons':'内置扩展逐ID、custom URL/file/text、安全allow/deny、扫描连接、81插件的148设置/13预设/重置和运行主动作。复杂/动态情况保留pending/unconfirmed。',
        'project-io':'本地/URL/Scratch/离线样例、脏项目关闭、还原点、本地背包、native菜单/文本、桌面设置、packager真实选项绑定、错误/迁移/信息页。',
        'paint-tools':'矢量9/位图8工具选择逐项，真实绘制/变形/颜色渐变/透明度/文本/字体、conversion、undo/group/order/剪贴板。替换整图不充当工具全等价。'}
    counts=collections.Counter(a['proposedDisposition'] for a in ACTIONS.values() if a['area']==area)
    return [f'# M1 能力普查：{area}', '',
            '- 本文件已从历史草稿复核/去重，唯一权威总账本为 [m1-census.json](m1-census.json) 和 [m1-census.md](m1-census.md)。',
            '- `commanded` 仅是 `proposedDisposition`（命令化设计），不是已实现/已验收；所有 `implementationStatus=pending`，所有 `acceptanceStatus=pending`。',
            '- 源码路径相对仓库根；`path:line` 指冻结源码实际行，JSON `sources` 还保存 range/anchor/SHA-256；不使用不明确的 basename/同上。',
            '- '+extras[area],
            '- 记录统计：'+str(stats['byArea'][area])+'；处置提案 '+', '.join(k+'='+str(counts.get(k,0)) for k in DISPOSITIONS)+ '。',
            '- ID不因改区域改名；重复入口按alias记录，拆分的旧汇总ID不计动作；未确认候选/不可见控件/passive另分kind。', '',
            '| ID | 动作 | 触发方式 | path:line 证据 | 语义效果 | CLI 提案或边界 | 提案处置 | implementationStatus |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |']


def row_text(a):
    cmd=a.get('proposedCommand')
    if cmd: command='提案：`'+cmd+'`'
    else: command=a['proposedDisposition']+'；'+(a['reviewNotes'][0] if a['reviewNotes'] else 'UI/DOM/动态能力边界见语义效果')
    return '| '+' | '.join(escaped(x) for x in [a['id'],a['name'],a['trigger'],a['ref'],a['effect'],command,a['proposedDisposition'],'pending'])+' |'


def assert_safe_write(path):
    path=path.resolve()
    if path.parent==CENSUS.resolve() or path in {DOCS/'parity-matrix.md', DOCS/'addons-inventory.json', DOCS/'addons-disposition.md'}:
        return
    raise RuntimeError('Write outside user allowlist: '+str(path))


def write_file(path,text):
    assert_safe_write(path)
    path.write_text(text)


def publish():
    actions=sorted(ACTIONS.values(), key=lambda a:(AREAS.index(a['area']),a['id']))
    stats=summarize(actions)
    files={}
    for area in AREAS:
        lines=area_header(area,stats)
        for a in actions:
            if a['area']!=area:continue
            a['evidence']=f'tw-cli/docs/census/{area}.md:{len(lines)+1}'
            lines.append(row_text(a))
        lines += ['', '## 未验收/未确认', '',
                  '源码普查不运行项目或做GUI对拍；本区域的所有命令化提案都尚待逐动作CLI实现验证和验收。',
                  '未确认项详见总账本 openIssues；不能以零重复/零缺失区域推断full-parity完成。', '']
        files[CENSUS/(area+'.md')]='\n'.join(lines)
    # Original row audit gives a permanent transparent answer to historical ID/line questions.
    legacy_rows=[r for v in DRAFT_INPUTS.values() for r in v['rows']]
    id_counts=collections.Counter(r['id'] for r in legacy_rows)
    audit={'originalDraftRowCount':len(legacy_rows),'exactDuplicateRowsRemoved':sum(v-1 for v in id_counts.values()),
           'originalExactDuplicateIds':[id for id,n in id_counts.items() if n>1],
           'crossDraftDuplicateIdsMerged':['code-ws.drag-block-to-sprite','sprites.drop-costume','sprites.undo-restore'],
           'independentReviewRepairs':{'findingCount':15,'staticPass':['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R14','R15'],'unconfirmedDispositionPass':['R13'],'concludedDispositionCount':15,'pendingIndependentRereview':[],'source':'independent reviewer final R09 verdict (non-user peer review)','report':'independent-review-notes.md','runtimeExecuted':False,'repairedActionIds':[a['id'] for a in actions if a.get('independentReview')]},
           'preIndependentReviewLedgerCount':1177,'preIndependentReviewActualCount':1152,
           'oldAggregateIdsSplit':sorted(id for id in ALIASES if len(ALIASES[id]['canonicalIds'])>1),
           'semanticDuplicateTriggersMerged':['code-ws.record-sound-option'],
           'fixedAddonMicrocontrolsReviewed':True,
           'paintSnapThresholdFinding':'ui.js:160-173：decrement显示-1而callback旧值；increment显示+1而callback旧值+2，保持pending需bugcompat决定。',
           'originalJsonRecordCount':250,'originalJsonDuplicateIdCount':1,
           'note':'历史合并器只接受裸enum，漏掉带解释的处置行。原六稿322行，sprites实49行；已重读所有引用片段并保存原hash/ref。'}
    ledger={'schemaVersion':2,'scope':'冻结 TurboWarp desktop GUI 主线 + 81 addons 源码能力账本（不是full-parity验收）',
            'coverageComplete':False,'requiredAreas':AREAS,'sourceAreas':[a+'.md' for a in AREAS],
            'missingAreas':[],'duplicateIds':[], 'stats':stats,
            'warning':'proposedCommand/proposedDisposition 仅设计；implementationStatus 与 acceptanceStatus 全 pending。未确认动作不删除，coverageComplete=false。',
            'countingPolicy':{'actualActionCount':'desktop适用的kind=action/automatic-after-action；通用WebGUI六权限弹窗为excluded-control不混入desktop分母。不同入口保留，跨稿接收端去重。',
                              'ledgerRecordCount':'包括不可见控件、被动指示及unconfirmed候选；不含aliases和已拆分汇总行。'},
            'reconciliation':audit,'draftAudit':DRAFT_INPUTS,'draftSourceActions':DRAFT_SOURCE_ACTIONS,
            'aliases':sorted(ALIASES.values(),key=lambda a:a['id']), 'openIssues':OPEN_ISSUES,
            'sourceInventory':{'scratchGui':GUI,'scratchPaint':PAINT,'scratchBlocks':BLOCKS,'scratchVM':VM,
                               'desktopMain':DESKTOP+'src-main/','desktopRendererWebpack':DESKTOP+'src-renderer-webpack/'},
            'actions':actions}
    # Partial CLI counterparts are documented as pointers only, never a status promotion.
    counterparts=[]
    for path,needle,reason in [('tw-cli/src/project.js','const safeExtensions','项目加载已含SB/SB2/SB3转换，但安全可执行扩展仍仅pen/music；不支持任意画廊JS。'),('tw-cli/src/package-commands.js','const specs =','pack提供实际选项spec与config/build路径；代码存在不代表每字段输出/全target已验收。'),('tw-cli/src/commands.js','async run(options','批量frames/fps/answer/input不能代理pause/step/线程/真实device全部语义。'),('tw-cli/src/editor-commands.js','monitor(session','单字段monitor子集；新monitors模块需逐range/CSV/尺寸clamp语义和fixture匹配。')]:
        counterparts.append({'source':at(path,needle,after=12),'note':reason,'doesNotUpgradeImplementationStatus':True})
    ledger['partialCliCounterparts']=counterparts
    files[CENSUS/'m1-census.json']=json.dumps(ledger,ensure_ascii=False,indent=2)+'\n'
    addonstats=dict(sorted(collections.Counter(a['disposition'] for a in ADDON_ROWS).items()))
    inventory={'schemaVersion':2,'count':81,'inventoryComplete':True,'fullyDispositioned':False,
               'implementationComplete':False,'implementationStatus':'pending','acceptanceStatus':'pending',
               'countsByDisposition':addonstats,'settingCount':sum(len(a['settings']) for a in ADDON_ROWS),
               'presetCount':sum(len(a['presets']) for a in ADDON_ROWS),
               'pendingUnconfirmed':[a['id'] for a in ADDON_ROWS if a['disposition']=='pending'],
               'policy':'commanded是命令化目标，不是已实现；pending保留proposedDisposition与不确定原因；不删除任何冻结addon。D4旧设置迁移桌面负责。',
               'addons':ADDON_ROWS}
    files[DOCS/'addons-inventory.json']=json.dumps(inventory,ensure_ascii=False,indent=2)+'\n'
    md=['# M1 GUI 全量能力账本（源码复核版）','',
        '唯一机器账本：[m1-census.json](m1-census.json)。10个区域表与本表来自同一规范化记录；不是CLI实现完成清单。','',
        f"- 账本记录：**{stats['ledgerRecordCount']}**；实际已确认用户/自动触发动作：**{stats['actualActionCount']}**。",
        f"- 不混算：passive展示 {stats['passiveDisplayCount']}；桌面不渲染/未接线控件 {stats['excludedControlCount']}；未确认项目drop候选 {stats['unconfirmedCandidateCount']}。",
        '- 重复ID **0**；缺失必需区域 **0**；每条记录都含稳定ID/触发/path:line/语义/命令提案或明确边界。',
        f"- 全部 {len(actions)} 条 implementationStatus=pending、acceptanceStatus=pending；不存在因 proposedCommand 推导的“已实现”。",
        '- `coverageComplete=false`：下面有明确未覆盖/未确认项，区域齐全不等于GUI无限动态扩展/设备生态已穷尽。','',
        '## 统计','', '| 区域 | 记录数 |','| --- | --- |']
    md += [f'| [{area}]({area}.md) | {stats["byArea"][area]} |' for area in AREAS]
    md += ['', '提案处置：'+', '.join(k+'='+str(v) for k,v in stats['byProposedDisposition'].items())+'。','',
           '81 addons：'+', '.join(k+'='+str(v) for k,v in addonstats.items())+'；148设置与13预设完整保留，四项pending/unconfirmed不删。','',
           '## 六稿复核与去重','',
           '- 六稿原始动作表共322行：menu-bar59/code-workspace53/sprites49/costumes69/sounds48/stage-controls44。原JSON仅250条且含1重复。',
           '- 1个相同ID重复行 costumes.rename 已合并；3个跨稿同动作接收端记录合并为alias；工具/缩放/色值/复合提示拆分为稳定子ID。',
           '- 注释visible、procedure删除、桌面save-separate守卫、滑块小数点规则、本地背包、绘图颜色/字体/剪切持久化均已更正。',
           '- 独立原15项处置静态结案（14源码/账本static-pass，R13仅unconfirmed候选降级处置pass，非执行批准）；来源为independent reviewer final R09 verdict（non-user peer review）。R08segment-delete分支去重、R13iframe执行仅未确认候选不计desktop动作；见[independent-review-notes.md](independent-review-notes.md)。',
           '- JSON draftAudit 保留六稿原hash/原line/ref，aliases保留改区域/拆分/合并兼容引用；新表使用完整源码路径且引用sha/anchor可重复核对。','',
           '## 未覆盖/未确认及未验收','']
    md += ['- `'+i['id']+'`（'+i['status']+'）：'+i['reason'] for i in OPEN_ISSUES]
    md += ['', '## 去重后逐动作表','',
           '| ID | 动作 | 触发方式 | path:line 证据 | 语义效果 | CLI 提案或边界 | 提案处置 | implementationStatus |',
           '| --- | --- | --- | --- | --- | --- | --- | --- |']
    md += [row_text(a) for a in actions]
    md += ['', '## 兼容ID（不计数）','', '| 旧ID | 规范ID | 原因 |','| --- | --- | --- |']
    md += ['| '+escaped(a['id'])+' | '+escaped(', '.join(a['canonicalIds']))+' | '+escaped(a['reason'])+' |' for a in ledger['aliases']]
    md += ['', '## 只读校验','',
           '运行 `python3 tw-cli/docs/census/coverage-check.py`：解析JSON、ID唯一、10区域、必填字段、源码路径/range/anchor/SHA、Markdown一致、81manifest集合和设置/预设引用。',
           '此脚本无写入/无项目执行；输出零结构缺失不代表CLI或GUI对拍已验收。','',
           '现有 tw-cli/scripts/build-action-ledger.js 与 addon-inventory.js 仍是旧解析器（本线无权改 scripts）；不要运行它们覆盖本账本。重建仅用本目录 reconcile-census.py --write。','']
    files[CENSUS/'m1-census.md']='\n'.join(md)
    addons_md=['# 81 addons 逐项处置（M1源码普查）','',
               '来源是冻结 scratch-gui/addons/addons 的全部81 manifest及执行源码；未删任何条目。manifest描述用JSON解码，包含引号的描述不再被截断。',
               '规范动作/设置/重置/预设见 [census/m1-census.json](census/m1-census.json)；148 settings、13 presets，每项有稳定ID和path:line。','',
               '## 状态口径','',
               '- `commanded`：命令化提案目标，不是实现/验收。',
               '- `limited`：有具体运行/存储/精度边界；不因为用了DOM就掩盖真实项目语义。',
               '- `not-applicable`：纯编辑器视图/操作方式，逐项保留理由。',
               '- `dom-only`：Blockly编辑器SVG图像导出依赖真实DOM/CSS布局（blocks2image）；不以此概括变量/几何操作。',
               '- `pending/unconfirmed`：复杂项目操作尚未确认完整映射，保留目标类别和原因；四项不得算已处置完成。',
               '- 所有81项 `implementationStatus=pending` / `acceptanceStatus=pending`；`fullyDispositioned=false`。','',
               '## 统计','', ', '.join(k+'='+str(v) for k,v in addonstats.items())+'。','',
               '## 逐项表','', '| ID | 名称 / 完整功能描述 | 默认启用 | 处置 | 命令化目标 / 原因 | path:line 执行证据 | 动作引用 | 实现 / 验收 |',
               '| --- | --- | --- | --- | --- | --- | --- | --- |']
    for a in ADDON_ROWS:
        addons_md.append('| '+' | '.join(escaped(v) for v in [a['id'],a['name']+' — '+a['description'],str(a['enabledByDefault']).lower(),a['disposition'],a['reason'],refstr(a['evidence']),', '.join(a['actionIds']), 'pending / pending'])+' |')
    addons_md += ['', '## 明确未确认','']
    addons_md += ['- `'+a['id']+'` → 目标 '+a['proposedDisposition']+'；'+a['reason'] for a in ADDON_ROWS if a['disposition']=='pending']
    addons_md += ['', '其它已源码分类条目仍需实现及GUI对拍；外观条目对源码分类不需实现，但不把全表pending静默移成commanded。','',
                  'D4：settings-store读取 `tw:addons` localStorage 并有版本迁移；CLI不自动读取用户旧浏览器存储。显式导出的设置JSON及新CLI配置文件是拟议接口。',
                  'D6：此清单仅冻结81 addons，不承诺任意未来JS/CSS/HTML插件；真实项目/运行语义（clipboard/file、monitor、几何、广播、作用域）不以纯DOM为理由删除。','']
    files[DOCS/'addons-disposition.md']='\n'.join(addons_md)
    files[DOCS/'parity-matrix.md']=make_parity(stats,addonstats)
    # Guard and validate everything in memory before writing only the user-approved document set.
    assert len({a['id'] for a in actions})==len(actions)
    assert all(a['sources'] and a['trigger'] and a['effect'] for a in actions)
    assert all(a['implementationStatus']=='pending' for a in actions)
    assert all(stats['byArea'].get(a,0)>0 for a in AREAS)
    assert len(ADDON_ROWS)==81
    for path,text in files.items():
        assert_safe_write(path)
        if path.suffix=='.json':json.loads(text)
    for path,text in files.items():write_file(path,text)
    return stats


def make_parity(stats,addonstats):
    lines=['# tw-cli 功能对等矩阵（M1源码账本复核）','',
           '基线：当前仓库冻结 desktop-master/node_modules/scratch-gui、scratch-blocks、scratch-paint、scratch-vm 与 desktop src-main/src-renderer-webpack；具体路径/行号/anchor/SHA 在总账本。',
           '权威账本：[census/m1-census.json](census/m1-census.json)；可读总表：[census/m1-census.md](census/m1-census.md)；81插件：[addons-inventory.json](addons-inventory.json) / [addons-disposition.md](addons-disposition.md)。','',
           '## 最终账本统计（不是发布验收）','',
           f"- 账本记录：**{stats['ledgerRecordCount']}**；实际已确认动作：**{stats['actualActionCount']}**；被动指示{stats['passiveDisplayCount']}；不渲染控件{stats['excludedControlCount']}；未确认候选{stats['unconfirmedCandidateCount']}。",
           '- 重复ID：**0**；缺失必需区域：**0**；必填字段缺失：**0**（以 coverage-check.py 只读校验为准）。',
           '- 六稿322原始行全部复核：同ID重复1行移除，跨稿重复动作3组去重；四个缺失区域已补齐。旧总JSON250记录不能继续当分母。',
           '- 提案处置：'+', '.join(k+'='+str(v) for k,v in stats['byProposedDisposition'].items())+'。',
           '- 全部账本记录 `implementationStatus=pending`、`acceptanceStatus=pending`。同名命令代码存在仅说明子集实现；未逐动作验证CLI参数/语义/fixture时不升级。',
           '- `coverageComplete=false`；full-parity **未验收、不可发布为全对等**。静态缺失数0不等于动态扩展/真实设备或行为对拍缺口0。','',
           '## 决策记录','', '| 决策 | 边界 |','| --- | --- |',
           '| D1 | 原生离屏渲染/音频输出文件获准；GUI图像/音频差分对拍未验收，不承诺实时扬声器。 |',
           '| D3 | 云变量为本地文件/进程通道；desktop使用BroadcastChannel，不连接真实云服务。 |',
           '| D4 | 旧IndexedDB/localStorage数据迁移由桌面版负责；背包/收藏/插件设置/还原点新文件库为提案，不自动解析旧用户库。 |',
           '| D5 | 默认deny、显式授权、零交互；安全弹窗allow/deny登记不意味着对应设备/网络能力已实现。 |',
           '| D6 | 冻结81 addons逐项处置；不承诺任意未来JS/CSS/HTML DOM插件。 |',
           '| D7 | 实时摄像头/麦克风limited，预录文件/帧/音频管道；不泛化为全部BLE硬件禁止。 |','',
           '## 按区域汇总与验收要求','', '| 区域 | 记录数 | 能力与CLI提案（未验收） | 验收前必须补齐 |','| --- | --- | --- | --- |']
    detail={
        'menu-bar':('open/save/new/title、FPS/Turbo/cloud/username；菜单/主题/UI/不渲染项逐项not-applicable','本地SB3/SB2/SB打开、原子写原路径/另存、脏标记；桌面save-separate确实不渲染。'),
        'code-workspace':('block/field/var/list/proc/comment/monitor/undo/clipboard、脚本点击运行；缩放/Help单独列','Blockly事件与VM图连接/ID/shadow、调用signature、注释坐标/恢复栈、扩展任意按钮。'),
        'sprites':('增删改/duplicate/export/selected/property/reorder/共享/folder前缀','fencing/名字引用/layerOrder/共享ID/变量冲突/文件夹排序/背包D4。'),
        'costumes':('costume/backdrop/library/upload/GIF/asset rename/export/duplicate/reorder','SVG sanitize/字体/库字节/格式转换、rename引用、背景作用于全部targets。'),
        'sounds':('录制D7，文件上传/库/编辑10音效/WAV预览D1','立体声降单声道、>10MB降采样、效果参数/选区/undo99层、音频差分。'),
        'stage-controls':('run/stop、key/mouse/wheel/drag/colorpick；全屏窗口not-applicable','事件时序、wasDragged、可见性中间态/图层、renderer碰撞取色像素、帧率和modifier组合。'),
        'monitors-prompts':('列表逐项编辑/insert/delete/resize/CSV、范围/modes/ask-answer、过程Prompt、12高级选项','monitor序列化/范围minmax小数点/isDiscrete、runtime选项保存注释、默认隐显/ANSWER线程。'),
        'extensions-addons':('内置扩展、gallery/custom、安全逐权限、外设；81插件148设置13预设','四项unconfirmed复杂addon、沙箱/权限/defaultdeny、动态按钮、真实设备固件及微控件穷尽。'),
        'project-io':('文件/URL/Scratch/sample、还原点/本地背包、native菜单/设置/packager全部绑定','SB2/SB字节、URLtoken/D5、快照D4、10用户UI偏好与内部metadata区分、全部packager target/安全。'),
        'paint-tools':('每工具选择与绘制、变形/颜色/透明/渐变/font/convert/group/order/clipboard','Paper/位图真实几何及像素/字体/预览对拍；replace整图不能当完整绘图工具验收。')}
    for area in AREAS:
        lines.append('| ['+area+'](census/'+area+'.md) | '+str(stats['byArea'][area])+' | '+detail[area][0]+' | '+detail[area][1]+' |')
    lines += ['', '## 81 addons 处置与冻结边界','',
              ', '.join(k+'='+str(v) for k,v in addonstats.items())+'；implementation/acceptance均pending，fullyDispositioned=false。',
              '必须继续确认 block-switching、editor-devtools、paint-snap、swap-local-global；pending项保留命令化目标和原因，不能删掉或混成dom-only。',
              '纯布局外观32项not-applicable仍在inventory；blocks2image单独dom-only，因为输出实际Blockly SVG/CSS而非舞台截图。','',
              '## 独立静态复核','',
              '原15项可静态修复处置已结案：14源码/账本static-pass，R13仅unconfirmed候选降级处置pass、不批准iframe执行；来源为independent reviewer final R09 verdict（non-user peer review）。具体执行证据见 [independent-review-notes.md](census/independent-review-notes.md)。旧1177/1152分母只保留历史；R08分支去重及R13未确认iframe不计desktop分母。源码range/anchor/SHA检查不是语义正确性的代理，不称全部审结。','',
              '## 现有CLI代码只证明子集（未升级账本状态）','',
              '- `src/project.js` 已有SB/SB2/SB3转换与真实fixture，但批准可执行扩展仍仅pen/music、拒绝任意extensionURLs；不能把 ext load URL/file/text拒绝路径当实现。',
              '- 新 `src/package-commands.js` 的pack有选项/config/build实际spec；旧package固定HTML/ZIP接口仍独立。所有GUI字段输出及多平台target需精确fixture与主线程测试，不按optioncount升级。',
              '- run批量frames/fps/answer/input、monitor等子集可见源码，但stop/pause/step/任意动态扩展/实时gamepad/真实硬件不是同名能力自动已实现。',
              '- 这些源码行会被其他代码线更新；总账本 partialCliCounterparts 记录读取时path:line，审阅本线未执行/修改CLI代码。','',
              '## 明确仍未覆盖/未确认/未验收','']
    lines += ['- `'+i['id']+'`：'+i['reason'] for i in OPEN_ISSUES]
    lines += ['', '## 发布门禁与只读检查','',
              '任何implementation/acceptance pending、unconfirmed、缺少fixture或差分判据的命令化项目都阻止full-parity。limited必须附边界并验收允许损失；not-applicable/dom-only必须保留源码理由。',
              '运行 `python3 tw-cli/docs/census/coverage-check.py`（只读）：JSON解析、重复ID、必需区域、必填、源码range/anchor/SHA、Markdown与JSON、81manifest及148设置/13预设引用一致。',
              '检查通过只表示账本结构及源码引用一致，不表示M2/M6/M7、平台安全/设备/packager/音频画图对拍完成。','']
    return '\n'.join(lines)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--write',action='store_true',help='Regenerate only allowlisted census/addon/parity documents')
    mode.add_argument('--check',action='store_true',help='Read-only checker; does not regenerate')
    args=parser.parse_args()
    if args.check:
        import runpy
        checker=runpy.run_path(str(CENSUS/'coverage-check.py'))
        result=checker['check']()
        print(json.dumps(result,ensure_ascii=False,indent=2))
        raise SystemExit(1 if result['errors'] else 0)
    load_drafts()
    supplement_areas()
    supplement_extensions_and_packager()
    collect_addons()
    add_remaining_surfaces()
    add_fixed_addon_controls()
    final_review()
    apply_independent_review_repairs()
    stats=publish()
    print(json.dumps(stats,ensure_ascii=False,indent=2))


if __name__=='__main__':main()


