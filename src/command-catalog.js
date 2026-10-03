'use strict';
const path = require('node:path');
const {CommandError} = require('./errors');

// Lightweight command definitions shared by validation, implementations and help.
const moduleSpecs = Object.create(null);
moduleSpecs['runtime-commands.js'] = (() => {
  const rule = (min, max = min, options = []) => ({min, max, options});
  const specs = {runtime: {
  start: rule(0, 0, ['project', 'fps', 'compile', 'no-compile', 'turbo', 'seed', 'paused', 'watch', 'target', 'trace', 'max-frames', 'lifetime', 'answer']),
  pause: rule(0), resume: rule(0), stop: rule(0), status: rule(0),
  step: rule(0, 1, ['frames', 'thread']), input: rule(1, 4, ['frame', 'button']), answer: rule(1, 1, ['frame', 'question']),
  watch: rule(0, 2, ['target', 'limit']), trace: rule(0, 1, ['limit', 'since']),
  breakpoint: rule(0, 2, ['target', 'limit', 'since']), clones: rule(0)
}};
  return specs;
})();

moduleSpecs['project-io-commands.js'] = (() => {
  const spec = (min, max = min, options = []) => ({min, max, options});
  const edit = ['project', 'target', 'out', 'force'];
  const output = ['project', 'target', 'output', 'force'];
  const specs = {
  library: {categories: spec(1, 1, ['dir']), list: spec(1, 1, ['dir', 'category', 'query', 'offset', 'limit']),
    search: spec(2, 2, ['dir', 'category', 'offset', 'limit']), load: spec(2, 2, [...edit, 'dir']), status: spec(0, 0, ['dir'])},
  backpack: {use: spec(1), list: spec(0, 0, ['dir']), save: spec(2, 3, [...edit, 'dir']), load: spec(1, 1, [...edit, 'dir'])},
  project: {fetch: spec(1, 2, ['output', 'force', 'allow', 'max-bytes', 'timeout-ms']),
    import: spec(1, 1, ['project', 'out', 'force']), 'import-sprite': spec(1, 1, ['project', 'out', 'force']),
    'export-sprite': spec(0, 1, output), export: spec(0, 1, ['project', 'output', 'force']),
    'restore-use': spec(1), 'restore-list': spec(0, 0, ['dir']), 'restore-save': spec(1, 1, ['project', 'dir']),
    restore: spec(1, 1, ['project', 'dir', 'out', 'force'])}
};
  return specs;
})();

moduleSpecs['package-commands.js'] = (() => {
  const spec = (min, max = min, options = []) => ({min, max, options});
  const specs = {pack: {
  help: spec(0), inspect: spec(0, 1), get: spec(1), set: spec(2, 2, ['allow']),
  config: spec(1, 1, ['allow']), reset: spec(0, 1), 'reset-group': spec(1), 'cursor-center': spec(0, 0, ['allow']),
  export: spec(0, 1, ['output', 'force']), import: spec(1, 1, ['allow']),
  build: spec(0, 1, ['project', 'output', 'target', 'allow', 'cache', 'force', 'opt']),
  preview: spec(0, 1, ['project', 'output', 'allow', 'cache', 'force', 'opt']),
  targets: spec(0), download: spec(1, 1, ['cache', 'allow'])
}};
  return specs;
})();

moduleSpecs['extension-commands.js'] = (() => {
  const spec = (min, max = min, options = []) => ({min, max, options});
  const specs = {
  ext: {help: spec(0), list: spec(0, 1), inspect: spec(1), doc: spec(1, 2, ['output', 'force']),
    load: spec(1, 1, ['project', 'out', 'force', 'allow']),
    'load-file': spec(1, 1, ['allow']), 'load-text': spec(1, 1, ['allow']), 'load-url': spec(1, 1, ['allow'])},
  permission: {help: spec(0), list: spec(0), inspect: spec(0), log: spec(0), check: spec(1, 1, ['allow'])}
};
  return specs;
})();

moduleSpecs['paint-commands.js'] = (() => {
  const editOptions=['project','target','out','force','mode','nodes','rect'];
  const readOptions=['project','target','mode','nodes','rect'];
  const styleOptions=['fill','stroke','stroke-width','alpha','fill-alpha','stroke-alpha','gradient','property','hue','saturation','brightness','font','font-size','font-weight','text-anchor'];
  const spec=(min,max=min,options=editOptions)=>({min,max,options});
  const specs={paint:{
  nodes:spec(1,1,readOptions),source:spec(1,1,readOptions),select:spec(1,1,readOptions),
  add:spec(2,2,[...editOptions,'spec',...styleOptions]),
  ...Object.fromEntries(['rectangle','rect','ellipse','circle','line','path','brush','text'].map(action=>[action,spec(1,1,[...editOptions,'spec',...styleOptions,'outlined','size'])])),
  erase:spec(1,1,[...editOptions,'spec','size','alpha']),
  copy:spec(1,2,[...readOptions,'output','force']),cut:spec(1,2,[...editOptions,'output']),paste:spec(1,2,[...editOptions,'from','spec','dx','dy','x','y','alpha','smoothing']),
  delete:spec(1,1),clear:spec(1,1),crop:spec(1,1),clone:spec(1,1,[...editOptions,'dx','dy']),group:spec(1,1),ungroup:spec(1,1),
  order:spec(1,2,[...editOptions,'direction']),align:spec(1,2,[...editOptions,'direction']),distribute:spec(1,2,[...editOptions,'direction']),
  transform:spec(1,1,[...editOptions,'spec','dx','dy','smoothing']),move:spec(1,1,[...editOptions,'spec','dx','dy']),
  rotate:spec(2,2,[...editOptions,'spec','expand','smoothing']),scale:spec(2,3,[...editOptions,'spec','smoothing']),resize:spec(3,3,[...editOptions,'smoothing']),
  skew:spec(2,3,[...editOptions,'spec']),'flip-x':spec(1,1),'flip-y':spec(1,1),
  style:spec(1,1,[...editOptions,...styleOptions]),fill:spec(1,1,[...editOptions,'spec',...styleOptions]),
  'fill-all':spec(1,1,[...editOptions,'spec','alpha']),flood:spec(1,1,[...editOptions,'spec','alpha']),
  'text-style':spec(1,1,[...editOptions,...styleOptions]),'text-set':spec(1,2,[...editOptions,'text']),
  'gradient-swap':spec(1,1,[...editOptions,'property']),
  points:spec(1,2,[...readOptions,'path']),
  ...Object.fromEntries(['point-add','point-delete','point-set','pointed','curved'].map(action=>[action,spec(1,1,[...editOptions,'path','segments','spec','after','t'])])),
  sample:spec(1,3,[...readOptions,'spec']),eyedropper:spec(3,3,[...editOptions,'property']),
  'replace-color':spec(1,1,[...editOptions,'spec','from-color','to-color','alpha']),opacity:spec(1,1,[...editOptions,'spec','alpha']),
  'snap-move':spec(4,4,[...editOptions,'spec','config','zoom']), 'snap-scale':spec(3,4,[...editOptions,'spec','config','zoom']),
  defaults:spec(0,0,['config','output','force','spec']),
  history:spec(0,0,['project']),undo:spec(0,0,['project','out','force']),redo:spec(0,0,['project','out','force'])
}};
  return specs;
})();

moduleSpecs['asset-commands.js'] = (() => {
  const editOptions=['project','target','out','force'];
  const readOptions=['project','target'];
  const spec=(min,max=min,options=editOptions)=>({min,max,options});
  const rangeOptions=['range','units'];
  const specs={asset:{
  list:spec(1,1,readOptions),info:spec(2,2,readOptions),duplicate:spec(2,2,[...editOptions,'name']),
  reorder:spec(3),size:spec(2,4,[...editOptions,'smoothing']),center:spec(2,4),convert:spec(3,3,[...editOptions,'rate','resolution']),
  blank:spec(1,2,[...editOptions,'mode','width','height','resolution']),select:spec(2),rename:spec(3),delete:spec(2),
  export:spec(2,3,[...readOptions,'output','force']),share:spec(3,3,[...editOptions,'name']),
  effect:spec(3,3,[...editOptions,...rangeOptions]),trim:spec(2,4,[...editOptions,...rangeOptions]),
  fade:spec(3,3,[...editOptions,...rangeOptions]),mute:spec(2,2,[...editOptions,...rangeOptions]),
  'delete-range':spec(2,2,[...editOptions,...rangeOptions]),'keep-range':spec(2,2,[...editOptions,...rangeOptions]),
  copy:spec(2,3,[...readOptions,...rangeOptions,'output','force']),paste:spec(2,3,[...editOptions,...rangeOptions,'from']),
  'copy-to-new':spec(2,2,[...editOptions,...rangeOptions,'name']),range:spec(2,2,[...readOptions,...rangeOptions]),
  render:spec(2,3,[...readOptions,...rangeOptions,'output','force']),
  history:spec(0,0,['project']),undo:spec(0,0,['project','out','force']),redo:spec(0,0,['project','out','force'])
}};
  return specs;
})();

moduleSpecs['block-commands.js'] = (() => {
  const readOptions = ['project', 'target'];
  const editOptions = [...readOptions, 'out', 'force'];
  const selectionOptions = ['mode', 'single'];
  const fileOptions = [...readOptions, ...selectionOptions, 'output', 'force'];
  const spec = (min, max = min, options = readOptions) => ({min, max, options});
  const specs = {blocks: {
  schema: spec(0, 1, ['project', 'target']),
  list: spec(0), inspect: spec(0, 1, [...readOptions, 'block', 'mode', 'single']),
  count: spec(0, 0, [...readOptions, 'shadows']), find: spec(0, 1, [...readOptions, 'opcode', 'field', 'value', 'var-id']),
  add: spec(1, 1, [...editOptions, 'inputs', 'fields', 'mutation', 'after', 'parent', 'input', 'at']),
  duplicate: spec(0, 1, [...editOptions, ...selectionOptions, 'block', 'at']),
  copy: spec(0, 2, [...fileOptions, 'block']), export: spec(0, 2, [...fileOptions, 'block']),
  cut: spec(0, 2, [...editOptions, ...selectionOptions, 'block', 'output']),
  paste: spec(0, 1, [...editOptions, 'at', 'from', 'variables']),
  import: spec(0, 1, [...editOptions, 'at', 'from', 'variables']),
  share: spec(2, 2, [...editOptions, ...selectionOptions, 'at', 'variables']),
  switch: spec(2, 2, [...editOptions, 'input-map', 'field-map', 'inputs', 'fields']),
  connect: spec(1, 2, [...editOptions, 'after', 'parent', 'input']),
  disconnect: spec(1, 1, [...editOptions, ...selectionOptions, 'heal', 'at']),
  heal: spec(1, 1, [...editOptions, 'at']), move: spec(1, 3, [...editOptions, 'at']),
  cleanup: spec(0, 0, [...editOptions, 'at', 'gap', 'columns', 'column-width']),
  'clean-up': spec(0, 0, [...editOptions, 'at', 'gap', 'columns', 'column-width']),
  delete: spec(1, 1, [...editOptions, ...selectionOptions, 'heal']), clear: spec(0, 0, editOptions),
  'set-field': spec(0, 3, [...editOptions, 'block', 'field', 'value', 'var-id']),
  'field-menu': spec(2), mutation: spec(2, 2, editOptions),
  'procedure-add': spec(1, 1, [...editOptions, 'params', 'warp', 'type', 'at']),
  'procedure-call': spec(1, 1, [...editOptions, 'values', 'after', 'parent', 'input', 'at']),
  'procedure-edit': spec(1, 1, [...editOptions, 'name', 'params', 'warp', 'type']),
  'procedure-delete': spec(1, 1, editOptions)
}};
  return specs;
})();

moduleSpecs['addon-commands.js'] = (() => {
  const configOptions = ['config'];
  const readOptions = ['project', 'target'];
  const editOptions = [...readOptions, 'out', 'force'];
  const spec = (min, max = min, options = configOptions) => ({min, max, options});
  const specs = {addon: {
  list: spec(0), inspect: spec(1), get: spec(1), enabled: spec(1, 2), setting: spec(2, 3),
  default: spec(0, 1), defaults: spec(0, 1), reset: spec(0, 1), 'reset-setting': spec(2),
  presets: spec(1, 2), preset: spec(2), commands: spec(0, 1, []),
  'block-count': spec(0, 0, [...readOptions, 'shadows']), find: spec(1, 1, [...readOptions, 'kind']),
  switch: spec(2, 2, [...editOptions, 'input-map', 'field-map', 'inputs', 'fields']),
  'rename-broadcast': spec(2, 2, editOptions), 'initial-sprite': spec(0, 0, [...editOptions, 'config', 'x', 'y']),
  'move-layer': spec(1, 2, editOptions), variables: spec(0, 1, readOptions),
  'set-variable': spec(2, 2, editOptions), 'set-list': spec(2, 2, editOptions), 'rename-variable': spec(2, 2, editOptions),
  'replace-variable': spec(2, 2, editOptions), 'swap-scope': spec(2, 2, [...editOptions, 'cloud']),
  'cleanup-plus': spec(0, 0, [...editOptions, 'delete-orphans', 'delete-unused', 'make-space', 'gap']),
  'copy-single': spec(1, 2, [...readOptions, 'output', 'force']), 'copy-all': spec(0, 0, [...readOptions, 'output', 'force']),
  'cut-single': spec(1, 2, [...editOptions, 'output']), 'paste-at': spec(0, 1, [...editOptions, 'at', 'variables']),
  'snap-move': spec(4, 4, [...editOptions, 'config', 'zoom', 'threshold', 'spec']),
  'snap-scale': spec(3, 4, [...editOptions, 'config', 'zoom', 'threshold', 'spec']),
  'costume-next': spec(0, 0, editOptions), 'costume-previous': spec(0, 0, editOptions)
}};
  return specs;
})();

moduleSpecs['device-commands.js'] = (() => {
  const spec = (min, max = min, options = []) => ({min, max, options});
  const exportOptions = ['output', 'force'];
  const inputOptions = ['project', 'frame', ...exportOptions];
  const specs = {device: {
  capabilities: spec(0, 0, exportOptions), permissions: spec(0, 0, exportOptions),
  permission: spec(2), 'input-list': spec(0, 0, ['project', ...exportOptions]),
  'video-frame': spec(1, 1, [...inputOptions, 'mirror']),
  loudness: spec(1, 1, [...inputOptions, 'format', 'sample-rate', 'channels']),
  gamepad: spec(1, 1, inputOptions), key: spec(2, 2, inputOptions),
  mouse: spec(2, 3, [...inputOptions, 'button']), wheel: spec(1, 2, inputOptions),
  'user-data': spec(1, 1, inputOptions), cloud: spec(2, 2, inputOptions),
  replay: spec(1, 1, ['project', 'validate-only', ...exportOptions]),
  'socket-mock': spec(0, 1, exportOptions),
  camera: spec(0), microphone: spec(0), scan: spec(0, 1, ['extension']),
  connect: spec(0, 1, ['extension', 'peripheral'])
}};
  return specs;
})();

moduleSpecs['settings-commands.js'] = (() => {
  const options = ['project', 'out', 'force'];
  const specs = {settings: {
  list: {min: 0, max: 0, options: ['project']},
  schema: {min: 0, max: 0, options: []},
  get: {min: 1, max: 1, options: ['project']},
  set: {min: 2, max: 2, options},
  size: {min: 2, max: 2, options},
  store: {min: 0, max: 0, options},
  reset: {min: 0, max: 0, options},
  export: {min: 1, max: 1, options: ['project', 'force']}
}};
  return specs;
})();

moduleSpecs['monitor-commands.js'] = (() => {
  const edit = ['project', 'target', 'out', 'force'];
  const read = ['project', 'target'];
  const spec = (min, max = min, options = edit) => ({min, max, options});
  const specs = {monitors: {list: spec(0, 0, ['project']), show: spec(1), hide: spec(1),
  mode: spec(2), move: spec(3), size: spec(3), range: spec(3),
  'import-list': spec(2, 2, [...edit, 'format', 'column']),
  'export-list': spec(2, 2, [...read, 'format']),
  value: spec(2), 'set-item': spec(3), 'insert-item': spec(3), 'delete-item': spec(2)}};
  return specs;
})();

moduleSpecs['record-commands.js'] = (() => {
  const spec = (min, max = min, options = []) => ({min, max, options});
  const specs = {record: {
  capabilities: spec(0, 0, ['output', 'allow']),
  start: spec(0, 1, ['project', 'output', 'format', 'duration', 'delay', 'fps', 'waitflag', 'flag-frame',
    'stopOnStop', 'stop-frame', 'projectaudio', 'microphonemix', 'audio-track', 'mic-track', 'soundfiles',
    'encoder', 'probe', 'allow', 'answer', 'seed'])
}};
  return specs;
})();

moduleSpecs['gamepad-mapping-commands.js'] = (() => {
  const spec = (min, max = min, options = []) => ({min, max, options});
  const common = ['project', 'allow'];
  const editing = [...common, 'target', 'frame'];
  const specs = {gamepad: {
  create: spec(0, 1, [...editing, 'index', 'buttons', 'axes', 'empty']),
  show: spec(0, 0, [...common, 'target', 'output', 'force']),
  'set-button': spec(2, 2, editing), 'set-axis': spec(2, 2, editing),
  'select-controller': spec(1, 1, common), reset: spec(0, 0, [...editing, 'empty']),
  export: spec(0, 1, [...common, 'target', 'output', 'force']),
  import: spec(1, 1, editing), store: spec(1, 1, common)
}};
  return specs;
})();

moduleSpecs['target-commands.js'] = (() => {
  const edits = ['project', 'target', 'out', 'force'];
  const reads = ['project', 'target'];
  const spec = (min, max = min, options = edits) => ({min, max, options});
  const specs = {targets: {
  list: spec(0, 0, ['project']), info: spec(0, 0, reads), find: spec(1, 1, ['project']),
  reorder: spec(2, 2, ['project', 'out', 'force']), layer: spec(1),
  draggable: spec(1), effect: spec(2), 'clear-effects': spec(0),
  'folder-create': spec(1), 'folder-add': spec(1), 'folder-remove': spec(0),
  'folder-rename': spec(2, 2, ['project', 'out', 'force']),
  'folder-remove-all': spec(1, 1, ['project', 'out', 'force']),
  export: spec(1, 1, [...reads, 'force'])
}};
  return specs;
})();

moduleSpecs['font-commands.js'] = (() => {
  const spec = (min, max = min, options = []) => ({min, max, options});
  const edit = ['project', 'out', 'force'];
  const specs = {font: {
  list: spec(0, 0, ['project']), builtins: spec(0), inspect: spec(1, 1, ['project']),
  builtin: spec(1, 2, [...edit, 'fallback']), 'add-builtin': spec(1, 2, [...edit, 'fallback']),
  add: spec(2, 2, [...edit, 'fallback']), 'from-file': spec(2, 2, [...edit, 'fallback']), custom: spec(2, 2, [...edit, 'fallback']),
  system: spec(1, 1, [...edit, 'fallback']), delete: spec(1, 1, edit), reset: spec(0, 0, edit), load: spec(0, 0, ['project']),
  export: spec(1, 2, ['project', 'output', 'force']), measure: spec(2, 2, ['project', 'size']),
  render: spec(2, 3, ['project', 'output', 'force', 'size', 'width', 'height'])
}};
  return specs;
})();

const editOptions = ['project', 'target', 'out', 'force'];
const readOptions = ['project', 'target'];
const spec = (min, max = min, options = readOptions) => ({min, max, options});
const COMMANDS = {
  help: spec(0, 1, ['json']), doctor: spec(0, 0, ['json']), capabilities: spec(0, 0, ['json']),
  check: spec(0, 0, []), new: spec(0, 1, ['out', 'force']), open: spec(1, 1, ['force']),
  info: spec(0, 0, ['project']), history: spec(0, 0, ['project']), save: spec(0, 1, ['project', 'out', 'force']),
  undo: spec(0, 0, ['project', 'out', 'force']), redo: spec(0, 0, ['project', 'out', 'force']),
  render: spec(0, 1, ['project', 'out', 'force']), package: spec(0, 1, ['project', 'out', 'force']),
  run: spec(0, 0, ['project', 'out', 'force', 'frames', 'fps', 'answer', 'compile', 'turbo', 'seed', 'watch', 'target', 'trace']),
  sprite: {list: spec(0, 0, ['project']), select: spec(1, 1, ['project']), set: spec(2, 2, editOptions),
    rename: spec(1, 1, editOptions), add: spec(1, 1, ['project', 'out', 'force', 'file']),
    duplicate: spec(0, 0, editOptions), delete: spec(0, 0, editOptions), front: spec(0, 0, editOptions), back: spec(0, 0, editOptions)},
  var: {list: spec(0), add: spec(1, 2, [...editOptions, 'type']), set: spec(2, 2, editOptions),
    rename: spec(2, 2, editOptions), delete: spec(1, 1, editOptions)},
  block: {list: spec(0), add: spec(1, 1, [...editOptions, 'inputs', 'fields', 'after', 'parent', 'input']),
    field: spec(3, 3, editOptions), input: spec(3, 3, editOptions),
    move: spec(1, 1, [...editOptions, 'after', 'parent', 'input']), delete: spec(1, 1, editOptions)},
  script: {demo: spec(0, 1, editOptions), validate: spec(1, 1, readOptions), apply: spec(1, 1, editOptions)},
  costume: {list: spec(0), add: spec(1, 1, editOptions), use: spec(1, 1, editOptions),
    rename: spec(2, 2, editOptions), delete: spec(1, 1, editOptions), export: spec(2, 2, [...readOptions, 'force'])},
  sound: {list: spec(0), add: spec(1, 1, editOptions), rename: spec(2, 2, editOptions), delete: spec(1, 1, editOptions),
    export: spec(2, 2, [...readOptions, 'force']), render: spec(2, 2, [...readOptions, 'force', 'volume', 'pan', 'pitch']),
    effect: spec(2, 2, editOptions), trim: spec(3, 3, editOptions)},
  stage: {info: spec(0, 0, ['project']), tempo: spec(1, 1, ['project', 'out', 'force'])},
  list: {all: spec(0), get: spec(1), add: spec(1, 2, editOptions), append: spec(2, 2, editOptions),
    clear: spec(1, 1, editOptions), set: spec(2, 2, editOptions), insert: spec(3, 3, editOptions),
    replace: spec(3, 3, editOptions), remove: spec(2, 2, editOptions), rename: spec(2, 2, editOptions), delete: spec(1, 1, editOptions)},
  broadcast: {list: spec(0, 0, ['project']), add: spec(1, 1, ['project', 'out', 'force']),
    rename: spec(2, 2, ['project', 'out', 'force']), delete: spec(1, 1, ['project', 'out', 'force'])},
  comment: {list: spec(0), add: spec(1, 1, [...editOptions, 'block']), set: spec(2, 2, editOptions),
    move: spec(3, 3, editOptions), delete: spec(1, 1, editOptions)},
  monitor: {list: spec(0, 0, ['project']), add: spec(1, 1, editOptions), set: spec(3, 3, editOptions), delete: spec(1, 1, editOptions)},
  proc: {list: spec(0), define: spec(1, 1, [...editOptions, 'params']), call: spec(1, 1, [...editOptions, 'values', 'after']),
    rename: spec(2, 2, editOptions), delete: spec(1, 1, editOptions)},
  bitmap: {resize: spec(3, 3, editOptions), 'flip-x': spec(1, 1, editOptions), 'flip-y': spec(1, 1, editOptions),
    fill: spec(2, 2, editOptions), convert: spec(1, 1, editOptions)},
  vector: {source: spec(1), nodes: spec(1), replace: spec(2, 2, editOptions), add: spec(3, 9, editOptions),
    set: spec(4, 4, editOptions), translate: spec(4, 4, editOptions), scale: spec(3, 4, editOptions),
    rotate: spec(3, 3, editOptions), delete: spec(2, 2, editOptions), front: spec(2, 2, editOptions), back: spec(2, 2, editOptions)},
  cloud: {use: spec(1, 1, ['project']), list: spec(0, 0, ['project']), sync: spec(0, 0, ['project']),
    add: spec(1, 2, ['project', 'out', 'force']), get: spec(1, 1, ['project']), set: spec(2, 2, ['project'])},
  input: {key: spec(2, 2, ['project']), mouse: spec(2, 3, ['project'])},
  sense: {color: spec(1), touching: spec(1)},
  pref: {list: spec(0, 0, ['config']), get: spec(1, 1, ['config']), set: spec(2, 2, ['config'])},
  quit: spec(0, 0, ['force']), exit: spec(0, 0, ['force'])
};
for (const definitions of Object.values(moduleSpecs)) {
  for (const [command, rules] of Object.entries(definitions)) {
    if (Object.hasOwn(COMMANDS, command)) throw new Error('Duplicate command: ' + command);
    COMMANDS[command] = rules;
  }
}
const BOOLEAN_OPTIONS = new Set(['force', 'compile', 'turbo', 'paused', 'no-compile', 'single', 'heal', 'shadows',
  'delete-orphans', 'delete-unused', 'validate-only', 'smoothing', 'outlined', 'expand', 'json']);
const VALUE_OPTIONS = new Set(Object.values(COMMANDS).flatMap(command => command.options ||
  Object.values(command).flatMap(action => action.options)).filter(name => !BOOLEAN_OPTIONS.has(name)));
const optionsFrom = argv => {
  if (!Array.isArray(argv) || !argv.every(token => typeof token === 'string')) throw new Error('Command arguments must be strings');
  const args = [], options = Object.create(null);
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!positional && token === '--') {positional = true; continue;}
    if (positional || !token.startsWith('--')) {args.push(token); continue;}
    const name = token.slice(2);
    if (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) throw new CommandError('UNKNOWN_OPTION', `Unknown option --${name}`, '使用 help <命令族> --json 查询接受的选项。', {option: name});
    if (Object.hasOwn(options, name)) throw new CommandError('INVALID_ARGUMENT', `Duplicate option --${name}`, '每个选项只能出现一次。', {option: name});
    if (BOOLEAN_OPTIONS.has(name)) options[name] = true;
    else {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`Missing value for --${name}`);
      options[name] = argv[++index];
      if (!options[name] && !['answer', 'text'].includes(name)) throw new Error(`Missing value for --${name}`);
    }
  }
  return {args, options};
};
const validateCommand = argv => {
  const {args, options} = optionsFrom(argv);
  const command = args.shift() || 'help';
  if (!Object.hasOwn(COMMANDS, command)) throw new CommandError('UNKNOWN_COMMAND', `Unknown command ${command}; use help`, '使用 help --json 查询命令目录。', {command});
  const definition = COMMANDS[command];
  const action = definition.options ? null : args[0];
  if (action !== null && !Object.hasOwn(definition, action)) throw new CommandError('UNKNOWN_COMMAND', `Unknown ${command} action ${action}`, `使用 help ${command} --json 查询子命令。`, {command, action});
  let rule = action === null ? definition : definition[action];
  if (command === 'vector' && action === 'add') {
    const shapes = {rect: [6, 7], circle: [5, 6], line: [6, 8], path: [3, 4], text: [5, 7]};
    if (!Object.hasOwn(shapes, args[2])) throw new Error('Shape must be rect/circle/line/path/text');
    rule = spec(...shapes[args[2]], editOptions);
  }
  const count = args.length - (action === null ? 0 : 1);
  if (count < rule.min || count > rule.max) throw new Error(`Invalid arguments for ${command}${action === null ? '' : ` ${action}`}: expected ${rule.min}..${rule.max}`);
  for (const name of Object.keys(options)) if (!rule.options.includes(name)) throw new Error(`Option --${name} is not allowed for ${command}${action === null ? '' : ` ${action}`}`);
  if (options.after && options.parent) throw new Error('Use either --after or --parent, not both');
  if (options.input && (!options.parent || options.after)) throw new Error('--input requires --parent');
  if (options.out && ['new', 'save', 'render', 'package'].includes(command) && args.length) throw new Error('Use a positional output path or --out, not both');
  if (options.out && !['render', 'package'].includes(command)) {
    const extension = command === 'run' ? '.png' : '.sb3';
    if (path.extname(options.out).toLowerCase() !== extension) throw new Error(command === 'run' ? 'Runtime output must end in .png' : 'Project output must end in .sb3');
  }
  if (command === 'run' && options.target && !options.watch) throw new Error('run --target requires --watch');
  if (command === 'input' && action === 'mouse' && args[3] !== undefined && !['down', 'up'].includes(args[3])) throw new Error('Mouse button must be down/up');
  return {command, args, options};
};

const HELP = `tw — TurboWarp 纯指令实验版（不是全功能对等发布版）

一次性命令：tw <命令> [参数] [--project 项目.sb3] [--out 输出路径]
连续编辑：  tw session                 每行一条指令，支持引号
机器协议：  tw session --jsonl         每行 {"id":1,"command":"info","args":[]}
首错停止：  tw session --jsonl --fail-fast
能力发现：  tw help [命令族] --json / tw capabilities --json
环境诊断：  tw doctor --json          检查 Node 24 和原生依赖

完整脚本
  blocks schema [opcode]             查询形状、输入、字段与菜单
  script validate script.json        只读校验；--project / --target 可指定项目与目标
  script apply script.json           追加完整脚本；一次撤销；--out 保存 SB3

项目
  new 项目.sb3                       新建项目（含舞台和一个角色）
  info --project 项目.sb3             查看角色、变量、造型、声音
  open 项目.sb3                      会话中打开
  save [项目.sb3] [--force]           原子保存；覆盖不同路径需要 --force
  undo / redo / history              会话撤销、重做、历史

角色（用 --target 名称选择；默认当前角色）
  sprite list
  sprite select 名称
  sprite set x 100                    属性：x/y/size/direction/visible/rotationStyle
  sprite rename 新名称
  sprite add 名称 [--file 造型.svg]
  sprite duplicate / sprite delete
  sprite front / sprite back

变量与列表
  var list
  var add 名称 [初始值]               加 --type list 创建列表
  var set 名称 值                     列表值用 '[1,2,3]'
  var rename 名称 新名称 / var delete 名称
  list add 名称 '[1,2]' / list append 名称 值 / list get 名称
  broadcast add 名称 / broadcast list
  cloud use 状态.json / cloud add 名称 初值 / cloud set 名称 值 / cloud get 名称
  monitor add 变量名 / monitor set 变量名 mode slider
  comment add 文本 / comment list
  proc define 名称 [--params '[{"name":"距离","type":"number"}]']
  proc call 名称 [--values '{"距离":25}'] --after 积木ID

积木
  block list
  block add event_whenflagclicked
  block add motion_movesteps --inputs '{"STEPS":25}' --after 积木ID
  block field 积木ID 字段 值
  block input 积木ID 输入名 值或积木ID
  block move 积木ID --after 父积木ID
  block delete 积木ID
  script demo [距离]                  一条指令创建“绿旗→移动”脚本

资产
  costume list / costume add 文件.svg / costume export 名称 输出.svg
  costume use 名称 / costume rename 名称 新名称 / costume delete 名称
  sound list / sound add 文件.wav / sound export 名称 输出.wav
  sound rename 名称 新名称 / sound delete 名称
  sound effect 名称 reverse/echo/robot/fade-in/fade-out/louder/softer/faster/slower/mute
  sound trim 名称 开始秒 结束秒
  bitmap resize 名称 宽 高 / bitmap flip-x 名称 / bitmap fill 名称 '#00ff00'
  vector source 名称 / vector replace 名称 文件.svg
  sound render 名称 输出.wav [--volume 50] [--pan -100] [--pitch 120]

运行与输出
  render 舞台.png
  run [--frames 30] [--fps 30] [--out 结果.png] [--answer 文本]
      [--seed 0..4294967295] [--watch 变量名或ID] [--target 角色] [--trace 1000]
  sense color '#ff0000'               触色查询
  sense touching 另一角色             碰撞查询
  input key space down / input mouse 0 0
  package 输出.html                   后缀 .html/.zip，离线打包
  pref list/get/set --config 配置.json  显式桌面v2格式兼容文件
  check                              输出未完成验收边界

重要：会话编辑用 save 保存；一次性修改用 --out 项目.sb3。
默认拒绝自定义可执行扩展、网络和设备；只读取显式命令路径。
支持本地 SB/SB2/SB3、1304 项离线素材、绘图/音效、持续调试、预录数据与安全打包。
任意扩展执行、全项目音轨录制、部分几何、真实硬件、GUI 差分和三平台验收仍未完成。`;

const commandHelp = (command, json = false) => {
  if (json) return require('./command-metadata').describe(COMMANDS, BOOLEAN_OPTIONS, command);
  if (!command) return HELP + '\n\n扩展指令族：' + Object.values(moduleSpecs).flatMap(rules => Object.keys(rules)).join('、') + '\n使用 help 指令族 查看参数与选项；help --json 提供机器目录；doctor --json 检查环境；capabilities --json 查看能力。';
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`Unknown command family ${command}`);
  const definition = COMMANDS[command];
  const renderRule = (name, rule) => `${name}：位置参数 ${rule.min}..${rule.max}；选项 ${rule.options.map(option => '--' + option + (BOOLEAN_OPTIONS.has(option) ? '' : ' 值')).join(' ') || '无'}`;
  const lines = definition.options ? [renderRule(command, definition)] :
    Object.entries(definition).map(([action, rule]) => renderRule(`${command} ${action}`, rule));
  return `${command} 指令参考\n${lines.join('\n')}\n--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。`;
};

module.exports = {moduleSpecs, commandSpecs: COMMANDS, optionsFrom, validateCommand, commandHelp, HELP, BOOLEAN_OPTIONS};
