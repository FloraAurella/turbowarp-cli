#!/usr/bin/env python3
"""Read-only M1 census checker. No VM/project/GUI execution and no filesystem writes."""
import collections
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'tw-cli/docs'
CENSUS = DOCS / 'census'
EXPECTED = ['menu-bar', 'code-workspace', 'sprites', 'costumes', 'sounds', 'stage-controls',
            'monitors-prompts', 'extensions-addons', 'project-io', 'paint-tools']
DISPOSITIONS = {'commanded', 'limited', 'not-applicable', 'dom-only', 'pending'}


def check():
    errors = []
    parsed = []
    for file in sorted(CENSUS.glob('*.json')) + [DOCS / 'addons-inventory.json']:
        try:
            json.loads(file.read_text())
            parsed.append(str(file.relative_to(ROOT)))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f'JSON parse: {file}: {exc}')
    if errors:
        return {'errors': errors, 'jsonParsed': parsed}
    ledger = json.loads((CENSUS / 'm1-census.json').read_text())
    inventory = json.loads((DOCS / 'addons-inventory.json').read_text())
    actions = ledger['actions']
    counts = collections.Counter(a['id'] for a in actions)
    duplicate_ids = [id for id, count in counts.items() if count > 1]
    areas = collections.Counter(a['area'] for a in actions)
    missing_areas = [area for area in EXPECTED if not areas[area]]
    missing_fields = []
    invalid_sources = []
    cache = {}
    def validate_source(source, owner):
        path = source.get('path', '')
        if path not in cache:
            file = ROOT / path
            if not file.is_file():
                cache[path] = None
            else:
                cache[path] = (file.read_text().splitlines(), hashlib.sha256(file.read_bytes()).hexdigest())
        value = cache[path]
        if not value:
            invalid_sources.append(owner + ': missing ' + path)
            return
        lines, digest = value
        start, end = source.get('line', 0), source.get('endLine', 0)
        if not isinstance(start, int) or not isinstance(end, int) or not 1 <= start <= end <= len(lines):
            invalid_sources.append(owner + f': bad range {path}:{start}-{end}')
            return
        if source.get('sha256') != digest:
            invalid_sources.append(owner + ': stale sha256 ' + path)
        if not source.get('anchor') or source['anchor'] not in '\n'.join(lines[start - 1:end]):
            invalid_sources.append(owner + f': missing anchor {path}:{start}-{end}')
    required = ['id', 'area', 'name', 'trigger', 'ref', 'effect', 'sources', 'proposedDisposition',
                'implementationStatus', 'acceptanceStatus', 'reviewStatus']
    ids = set(counts)
    for a in actions:
        for field in required:
            if not a.get(field):
                missing_fields.append(a.get('id', '<unknown>') + '.' + field)
        if not re.fullmatch(r'[a-z][\w-]*(?:\.[\w-]+)+', a['id']):
            errors.append('Unstable ID: ' + a['id'])
        if a['proposedDisposition'] not in DISPOSITIONS:
            errors.append('Invalid disposition: ' + a['id'])
        if a['proposedDisposition'] == 'commanded' and not a.get('proposedCommand'):
            missing_fields.append(a['id'] + '.proposedCommand')
        if a['proposedDisposition'] == 'pending' and not a.get('reviewNotes'):
            missing_fields.append(a['id'] + '.pendingReason')
        if a['implementationStatus'] != 'pending' and not a.get('implementationEvidence'):
            errors.append('Status upgraded without CLI implementation evidence: ' + a['id'])
        if a['acceptanceStatus'] != 'pending':
            errors.append('M1 must not claim GUI parity acceptance: ' + a['id'])
        for s in a.get('sources', []):
            validate_source(s, a['id'])
        # Markdown tables refer to exact canonical IDs and evidence rows.
        evidence = a.get('evidence', '')
        match = re.fullmatch(r'(tw-cli/docs/census/[\w-]+\.md):(\d+)', evidence)
        if not match:
            missing_fields.append(a['id'] + '.evidence')
        else:
            lines = (ROOT / match[1]).read_text().splitlines()
            line = int(match[2])
            if not 1 <= line <= len(lines) or not lines[line - 1].startswith('| ' + a['id'] + ' |'):
                errors.append('Stale document row evidence: ' + a['id'])
    for entry in ledger.get('aliases', []):
        if entry['id'] in ids:
            errors.append('Alias is also counted: ' + entry['id'])
        for target in entry['canonicalIds']:
            if target not in ids:
                errors.append('Missing alias target: ' + entry['id'] + ' -> ' + target)
    addon_ids = [a['id'] for a in inventory['addons']]
    actual_addons = {p.parent.name for p in (ROOT / 'desktop-master/node_modules/scratch-gui/src/addons/addons').glob('*/_manifest_entry.js')}
    missing_addons = sorted(actual_addons - set(addon_ids))
    if len(addon_ids) != 81 or len(set(addon_ids)) != 81 or set(addon_ids) != actual_addons:
        errors.append('Frozen addon ID set must match all 81 manifests exactly')
    for a in inventory['addons']:
        if a['disposition'] not in DISPOSITIONS or not a.get('reason'):
            missing_fields.append('addon.' + a['id'] + '.disposition/reason')
        if a['implementationStatus'] != 'pending' or a['acceptanceStatus'] != 'pending':
            errors.append('Addon wrongly claims implementation/acceptance: ' + a['id'])
        if a['disposition'] == 'pending' and a.get('reviewStatus') != 'unconfirmed':
            errors.append('Unconfirmed addon must stay pending: ' + a['id'])
        for source in a.get('evidence', []):
            validate_source(source, 'addon.' + a['id'])
        for id in a.get('actionIds', []):
            if id not in ids:
                errors.append('Addon actionRef missing: ' + a['id'] + ' -> ' + id)
        if not a.get('actionIds'):
            missing_fields.append('addon.' + a['id'] + '.actionIds')
        path = ROOT / a['source']
        manifest, _ = json.JSONDecoder().raw_decode(path.read_text().split('const manifest = ', 1)[1])
        if manifest['description'] != a['description'] or manifest['name'] != a['name']:
            errors.append('Truncated addon manifest string: ' + a['id'])
        for setting in manifest.get('settings', []):
            id = 'addon.' + a['id'] + '.setting.' + setting['id']
            if id not in ids:
                missing_fields.append(id)
        for preset in manifest.get('presets', []):
            id = 'addon.' + a['id'] + '.preset.' + preset['id']
            if id not in ids:
                missing_fields.append(id)
    actual_dispositions = dict(sorted(collections.Counter(a['proposedDisposition'] for a in actions).items()))
    if ledger.get('stats', {}).get('ledgerRecordCount') != len(actions):
        errors.append('Stale ledger stats: record count')
    if ledger.get('stats', {}).get('byArea') != dict(areas):
        errors.append('Stale ledger stats: by area')
    if ledger.get('stats', {}).get('byProposedDisposition') != actual_dispositions:
        errors.append('Stale ledger stats: dispositions')
    global_md = (CENSUS / 'm1-census.md').read_text()
    global_action_table = global_md.split('## 去重后逐动作表', 1)[1].split('## 兼容ID（不计数）', 1)[0]
    global_ids = re.findall(r'^\| ([a-z][\w.-]+) \|', global_action_table, re.M)
    if collections.Counter(global_ids) != counts:
        errors.append('Global Markdown action table differs from JSON canonical ID set')
    for area in EXPECTED:
        table = (CENSUS / (area + '.md')).read_text()
        table_ids = re.findall(r'^\| ([a-z][\w.-]+) \|', table, re.M)
        if set(table_ids) != {a['id'] for a in actions if a['area'] == area}:
            errors.append('Area Markdown differs from JSON: ' + area)
    matrix = (DOCS / 'parity-matrix.md').read_text()
    if f"账本记录：**{len(actions)}**" not in matrix:
        errors.append('Parity matrix does not reference final record count')
    if 'm1-census.json' not in matrix or '未验收' not in matrix:
        errors.append('Parity matrix missing ledger reference or acceptance boundary')
    # Independent review semantic guards. Existing path/range/hash alone cannot prove
    # the user-visible effect; these pin the fifteen concluded execution distinctions.
    by_id = {a['id']: a for a in actions}
    semantic_errors = []
    def expect(id, disposition=None, source_suffix=None, effect_words=(), kind=None):
        a=by_id.get(id)
        if not a:
            semantic_errors.append('Independent review missing action: '+id); return
        if disposition and a['proposedDisposition']!=disposition: semantic_errors.append('Independent review wrong disposition: '+id)
        if kind and a['kind']!=kind: semantic_errors.append('Independent review wrong counted kind: '+id)
        if source_suffix and not any(s['path'].endswith(source_suffix) for s in a['sources']): semantic_errors.append('Independent review executing source absent: '+id)
        for word in effect_words:
            if word not in a['effect']: semantic_errors.append('Independent review semantic distinction absent: '+id+' '+word)
        if not a.get('independentReview'): semantic_errors.append('Independent conclusion reference absent: '+id)
    expect('costumes.paint-eye-dropper','commanded','scratch-paint/src/containers/color-indicator.jsx',('applyColorToSelection','onUpdateImage'))
    expect('sounds.editor.copy','commanded','scratch-gui/src/containers/sound-editor.jsx',('copyBuffer','快照'))
    expect('costumes.paint-copy','commanded','scratch-paint/src/hocs/copy-paste-hoc.jsx',('快照','importJSON'))
    expect('desktop.pref.backgroundThrottling',source_suffix='src-main/windows/editor.js',effect_words=('调度','非纯视觉'))
    for id in ['addon.gamepad.open','addon.gamepad.select-controller']: expect(id,'commanded',effect_words=('storeMappings','comment'))
    expect('addon.gamepad.reset-settings','commanded','addons/settings/settings.jsx',('resetAddon','hide'))
    expect('addon.gamepad.reset',effect_words=('resetControls','不是SettingsStore.resetAddon'))
    for id in ['sounds.editor.copy','sounds.editor.deleteSelection','sounds.editor.keepSelection','sounds.editor.paste','sounds.editor.play','sounds.editor.redo','sounds.editor.stop','sounds.editor.trim.clear','sounds.editor.undo']:
        expect(id,source_suffix='scratch-gui/src/containers/sound-editor.jsx')
    expect('sounds.library.preview',source_suffix='scratch-gui/src/containers/play-button.jsx')
    expect('sounds.library.preview-stop',source_suffix='scratch-gui/src/containers/play-button.jsx')
    for id in ['paint.selection.keyboard-delete','paint.reshape.doubleclick-remove-point']: expect(id,'commanded')
    if 'paint.reshape.delete-segments' in by_id:semantic_errors.append('R08 reshape segment deletion subbranch double-counted')
    if not any(x['id']=='paint.reshape.delete-segments' for x in ledger['aliases']):semantic_errors.append('R08 removed subbranch alias absent')
    for suffix in ['duration','delay','project-audio','mic-mix','wait-flag','end-stop']:
        expect('addon.mediarecorder.option.'+suffix,'limited' if suffix=='mic-mix' else 'commanded')
    for suffix in ['project-id','project-url','cursor-auto-center']:expect('package.'+suffix,'commanded')
    reset_names=['runtime','player','cursor','cloud','advanced','target','application','steamworks']
    for suffix in reset_names:
        id='package.reset.'+suffix;expect(id,'commanded')
        if id in by_id and not by_id[id].get('resetKeys'):semantic_errors.append('Packager reset exact key list absent: '+id)
    for typ in ['geolocate','notify','read-clipboard']:
        for choice in ['allow','deny']:expect('permission.'+typ+'.'+choice,kind='excluded-control')
    for choice in ['allow','deny']:expect('permission.embed.'+choice,'commanded',effect_words=('Boolean','DOM'))
    expect('extension.embed-dom-execution','pending',kind='unconfirmed-candidate')
    if 'decodedBrotli' not in by_id.get('extension.embed-dom-execution',{}).get('reviewNotes',[''])[0]:
        semantic_errors.append('R13 unresolved decoded iframe execution evidence not disclosed')
    vibration=next((a for a in inventory['addons'] if a['id']=='tw-disable-vibration'),{})
    if 'permission.record-video.deny' in vibration.get('actionIds',[]):semantic_errors.append('Vibration wrongly points to camera deny')
    for suffix in ['navigator-vibrate','gamepad-pulse','gamepad-play-effect']:
        id='addon.tw-disable-vibration.'+suffix;expect(id,'limited')
        if id not in vibration.get('actionIds',[]):semantic_errors.append('Vibration semantic actionRef absent: '+id)
    expect('extension.load.faceSensing','pending','lib/libraries/extensions/index.jsx',('extensionURL','没有faceSensing','D7'))
    if 'https://extensions.turbowarp.org/lab/face-sensing.js' not in by_id.get('extension.load.faceSensing',{}).get('proposedCommand',''):semantic_errors.append('FaceSensing exact gallery URL absent')
    notes=CENSUS/'independent-review-notes.md'
    if not notes.is_file():semantic_errors.append('Independent review report absent')
    elif any('## R'+str(i).zfill(2)+' ' not in notes.read_text() for i in range(1,16)):semantic_errors.append('Independent review report missing a finding')
    actual_count=sum(a['kind'] in ['action','automatic-after-action'] for a in actions)
    if ledger['stats']['actualActionCount']!=actual_count:semantic_errors.append('Desktop actual action count includes excluded controls')
    errors += semantic_errors
    errors += ['Duplicate ID: ' + x for x in duplicate_ids]
    errors += ['Missing area: ' + x for x in missing_areas]
    errors += ['Missing field: ' + x for x in missing_fields]
    errors += invalid_sources
    return {'jsonParsed': parsed, 'ledgerRecords': len(actions),
            'actualActionCount': ledger['stats']['actualActionCount'],
            'duplicateIdCount': len(duplicate_ids), 'duplicateIds': duplicate_ids,
            'missingAreaCount': len(missing_areas), 'missingAreas': missing_areas,
            'missingRequiredFieldCount': len(missing_fields), 'invalidSourceCount': len(invalid_sources), 'independentSemanticErrorCount': len(semantic_errors),
            'missingAddonCount': len(missing_addons), 'addonCount': len(addon_ids),
            'addonDispositions': dict(sorted(collections.Counter(a['disposition'] for a in inventory['addons']).items())),
            'implementationPending': sum(a['implementationStatus'] == 'pending' for a in actions),
            'acceptancePending': sum(a['acceptanceStatus'] == 'pending' for a in actions),
            'coverageComplete': ledger['coverageComplete'], 'openIssues': ledger['openIssues'],
            'errors': errors}


if __name__ == '__main__':
    result = check()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(1 if result['errors'] else 0)
