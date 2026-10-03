const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'baseline.json'), 'utf8'));
const dir = path.resolve(root, '../desktop-master/node_modules/scratch-gui/src/addons/addons');
const rows = baseline.addons.ids.map(id => {
  const filename = path.join(dir, id, '_manifest_entry.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('const manifest = ') + 'const manifest = '.length;
  const end = source.indexOf('export default manifest;');
  const manifestSource = source.slice(start, end).trim().replace(/;$/, '');
  const manifest = {name: (manifestSource.match(/\"name\":\s*\"([^\"]*)\"/) || [])[1] || id,
    description: (manifestSource.match(/\"description\":\s*\"([^\"]*)\"/) || [])[1] || ''};
  return {id, name: manifest.name, description: manifest.description, disposition: 'pending',
    source: `desktop-master/node_modules/scratch-gui/src/addons/addons/${id}/_manifest_entry.js`,
    sha256: crypto.createHash('sha256').update(source).digest('hex')};
});
fs.writeFileSync(path.join(root, 'docs/addons-inventory.json'), JSON.stringify({count: rows.length, fullyDispositioned: false, addons: rows}, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'docs/addons-disposition.md'), '# 81 addons 逐项待验收清单\n\n全部条目来自冻结 manifest；此文件不是完成清单。没有读执行源码并验证的条目保持 pending，不用 DOM-only 标签掩盖未实现的项目语义。\n\n| ID | 名称 | 功能 | 状态 |\n| --- | --- | --- | --- |\n' + rows.map(row => `| ${row.id} | ${row.name.replace(/\|/g,'\\|')} | ${row.description.replace(/\|/g,'\\|').replace(/\n/g,' ')} | pending |`).join('\n') + '\n');
console.log(JSON.stringify({count:rows.length,pending:rows.length,fullyDispositioned:false}));
