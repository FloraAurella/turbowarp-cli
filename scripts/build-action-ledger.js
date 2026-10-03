const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'docs/census');
const splitRow = line => {
  const cells = []; let cell = '', escaped = false;
  for (const character of line.slice(1)) {
    if (escaped) {cell += character; escaped = false; continue;}
    if (character === '\\') {escaped = true; cell += character; continue;}
    if (character === '|') {cells.push(cell.trim()); cell = '';}
    else cell += character;
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
};
const actions = [];
const files = fs.readdirSync(source).filter(file => file.endsWith('.md') && !file.startsWith('m1-')).sort();
for (const file of files) {
  const bytes = fs.readFileSync(path.join(source, file));
  const lines = bytes.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('|')) continue;
    const cells = splitRow(lines[index]);
    if (cells.length < 7) continue;
    const id = cells[0].replace(/`/g, '');
    if (!/^[a-z][\w-]*\.[\w.-]+$/i.test(id)) continue;
    const disposition = cells[cells.length - 1].replace(/`/g, '').trim();
    if (!['commanded','limited','not-applicable','dom-only'].includes(disposition)) continue;
    actions.push({id, area:file.slice(0,-3), name:cells[1], trigger:cells[2], ref:cells[3],
      effect:cells[4], proposedCommand:cells.slice(5,-1).join(' | '), proposedDisposition:disposition,
      implementationStatus:'pending', evidence:`docs/census/${file}:${index + 1}`,
      sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
}
const duplicateIds = [...new Set(actions.map(action => action.id).filter((id,index,array) => array.indexOf(id) !== index))];
const ledger = {coverageComplete:false, sourceAreas:files, actions, duplicateIds,
  missingAreas:['monitors-prompts','extensions-addons','project-io','paint-tools'],
  warning:'Generated from partial, unreviewed census drafts. proposedDisposition is not implementation/acceptance status.'};
fs.writeFileSync(path.join(source,'m1-census.json'),JSON.stringify(ledger,null,2)+'\n');
console.log(JSON.stringify({actions:actions.length,areas:files.length,duplicateIds,coverageComplete:false},null,2));
