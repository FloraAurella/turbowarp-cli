const {atomicWrite, readLocalFile} = require('./project');
const {resourceError} = require('./errors');
const specs = require('./command-catalog').moduleSpecs['monitor-commands.js'];
const parseNumber = text => {
  if (typeof text !== 'string' || !text.trim() || !Number.isFinite(Number(text))) throw new Error('Expected a finite number');
  return Number(text);
};
const findVariable = (session, selector, target) => {
  const matches = Object.values(target.variables).filter(variable => variable.id === selector || variable.name === selector);
  if (matches.length === 1) return {variable: matches[0], target};
  const stage = session.project.vm.runtime.getTargetForStage();
  if (target !== stage && !matches.length) return findVariable(session, selector, stage);
  throw resourceError(matches.length, `Variable/list not found or ambiguous: ${selector}`, selector);
};
const findMonitor = (session, selector) => {
  const entries = Array.from(session.project.vm.runtime.getMonitorState().valueSeq());
  const exact = entries.find(entry => entry.id === selector);
  if (exact) return exact;
  const matches = entries.filter(entry => Object.values(entry.params || {}).includes(selector));
  if (matches.length !== 1) throw resourceError(matches.length, 'Monitor not found or ambiguous', selector);
  return matches[0];
};
const parseCSV = text => {
  const rows = []; let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {field += '"'; index++;}
      else quoted = !quoted;
    } else if (!quoted && character === ',') {row.push(field); field = '';}
    else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += character;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field');
  if (field || row.length) {row.push(field); rows.push(row);}
  return rows;
};
const execute = async (session, command, args, options) => {
  const [action, selector, a, b] = args;
  const vm = session.project.vm;
  const runtime = vm.runtime;
  if (action === 'list') return [...runtime.getMonitorState().valueSeq()].map(item => ({...item}));
  if (['import-list', 'export-list', 'value', 'set-item', 'insert-item', 'delete-item'].includes(action)) {
    const {variable, target} = findVariable(session, selector, session.project.target(options.target));
    if (action === 'value') {
      let value; try {value = JSON.parse(a);} catch {value = a;}
      if (variable.type === 'list' && !Array.isArray(value)) throw new Error('List value must be a JSON array');
      vm.setVariableValue(target.id, variable.id, value); runtime.emitProjectChanged(); return {id: variable.id, value};
    }
    if (variable.type !== 'list') throw new Error('This action requires a list');
    if (action === 'export-list') {
      const format = options.format || 'text';
      if (!['text', 'csv', 'json'].includes(format)) throw new Error('Format must be text/csv/json');
      const text = format === 'json' ? JSON.stringify(variable.value, null, 2) + '\n' :
        variable.value.map(item => format === 'csv' ? '"' + String(item).replaceAll('"', '""') + '"' : String(item)).join('\n') + '\n';
      return atomicWrite(a, Buffer.from(text), options.force);
    }
    if (action === 'import-list') {
      const bytes = await readLocalFile(a, 16 * 1024 * 1024);
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      const format = options.format || (/\.csv$/i.test(a) ? 'csv' : /\.json$/i.test(a) ? 'json' : 'text');
      let values;
      if (format === 'json') {values = JSON.parse(text); if (!Array.isArray(values)) throw new Error('List JSON must be an array');}
      else if (format === 'csv') {
        const column = options.column === undefined ? 1 : parseNumber(options.column);
        if (!Number.isInteger(column) || column < 1) throw new Error('CSV column is a 1-based positive integer');
        values = parseCSV(text).map(row => row[column - 1] ?? '');
      } else if (format === 'text') {values = text.replace(/\r\n?/g, '\n').split('\n'); if (values.at(-1) === '') values.pop();}
      else throw new Error('Format must be text/csv/json');
      if (values.length > 100000 || values.some(value => !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('List contains too many items or non-scalar values');
      variable.value = values; runtime.emitProjectChanged(); return {id: variable.id, count: values.length};
    }
    const index = parseNumber(a);
    if (!Number.isInteger(index) || index < 1 || index > variable.value.length + (action === 'insert-item' ? 1 : 0)) throw new Error('List index is 1-based and must be in range');
    if (action === 'set-item') variable.value[index - 1] = b;
    if (action === 'insert-item') variable.value.splice(index - 1, 0, b);
    if (action === 'delete-item') variable.value.splice(index - 1, 1);
    runtime.emitProjectChanged(); return {id: variable.id, value: variable.value};
  }
  const monitor = findMonitor(session, selector);
  let update;
  if (action === 'show' || action === 'hide') update = {visible: action === 'show'};
  else if (action === 'mode') {
    if (!['default', 'large', 'slider', 'list'].includes(a)) throw new Error('Invalid monitor mode');
    if (monitor.mode === 'list' && a !== 'list' || monitor.mode !== 'list' && a === 'list') throw new Error('List/scalar monitor modes cannot be exchanged');
    update = {mode: a};
  } else if (action === 'move') update = {x: parseNumber(a), y: parseNumber(b)};
  else if (action === 'size') {
    const width = parseNumber(a), height = parseNumber(b);
    if (width < 0 || height < 0 || width > 4096 || height > 4096) throw new Error('Monitor dimensions must be in 0..4096');
    update = {width, height};
  } else if (action === 'range') {
    if (monitor.mode === 'list') throw new Error('List monitor has no slider range');
    const min = parseNumber(a), max = parseNumber(b);
    if (min > max) throw new Error('Slider minimum cannot exceed maximum');
    const discrete = !/[.,]/.test(a) && !/[.,]/.test(b);
    update = {sliderMin: min, sliderMax: max, isDiscrete: discrete};
  } else throw new Error('Unknown monitor action');
  runtime.requestUpdateMonitor({id: monitor.id, ...update}); runtime.emitProjectChanged();
  return {id: monitor.id, ...update};
};
module.exports = {specs, requiresProject: () => true, isReadOnly: (command, args) => ['list', 'export-list'].includes(args[0]), execute, parseCSV};
