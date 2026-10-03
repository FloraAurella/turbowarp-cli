const fs = require('node:fs');
const path = require('node:path');

const filename = value => {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) ||
    value.includes('\\') || value.split('/').includes('..') || /%2e|%2f|%5c/i.test(value) ||
    /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('~')) throw new Error('Unsafe local path: traversal, URL, control character or implicit home expansion');
  return path.resolve(value);
};
const components = full => {
  let current = path.parse(full).root;
  return full.slice(current.length).split(path.sep).filter(Boolean).map(part => current = path.join(current, part));
};
const expected = (stat, last, directory) => !last || directory ? stat.isDirectory() : stat.isFile();
const systemAlias = (cursor, resolved) => process.platform === 'darwin' && ['/tmp', '/var'].includes(cursor) && resolved === '/private' + cursor;
const symlinkError = cursor => Object.assign(new Error('ELOOP: Refusing symlink or non-regular file/directory: ' + cursor), {code: 'ELOOP'});
const checkedPath = async (value, {directory = false, missing = false} = {}) => {
  const full = filename(value), parts = components(full);
  if (!parts.length && !directory) throw new Error('A root directory is not a file');
  for (let index = 0; index < parts.length; index++) {
    const cursor = parts[index]; let stat;
    try {stat = await fs.promises.lstat(cursor);} catch (error) {if (missing && error.code === 'ENOENT') return full; throw error;}
    if (stat.isSymbolicLink()) {
      if (!systemAlias(cursor, await fs.promises.realpath(cursor)) || index === parts.length - 1 && !directory) throw symlinkError(cursor);
      stat = await fs.promises.stat(cursor);
    }
    if (!expected(stat, index === parts.length - 1, directory)) throw new Error('Expected a regular file/directory: ' + cursor);
  }
  return full;
};
const checkedPathSync = (value, {directory = false, missing = false} = {}) => {
  const full = filename(value), parts = components(full);
  if (!parts.length && !directory) throw new Error('A root directory is not a file');
  for (let index = 0; index < parts.length; index++) {
    const cursor = parts[index]; let stat;
    try {stat = fs.lstatSync(cursor);} catch (error) {if (missing && error.code === 'ENOENT') return full; throw error;}
    if (stat.isSymbolicLink()) {
      if (!systemAlias(cursor, fs.realpathSync(cursor)) || index === parts.length - 1 && !directory) throw symlinkError(cursor);
      stat = fs.statSync(cursor);
    }
    if (!expected(stat, index === parts.length - 1, directory)) throw new Error('Expected a regular file/directory: ' + cursor);
  }
  return full;
};
module.exports = {filename, checkedPath, checkedPathSync};
