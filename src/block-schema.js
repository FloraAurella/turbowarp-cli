'use strict';
const fs = require('node:fs');
const path = require('node:path');
let coreSchemas;
const frozenSchemas = () => {
  if (coreSchemas) return coreSchemas;
  coreSchemas = new Map();
  const base = path.dirname(require.resolve('scratch-blocks/package.json'));
  for (const folder of ['blocks_vertical', 'blocks_common']) {
    for (const file of fs.readdirSync(path.join(base, folder)).filter(name => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(base, folder, file), 'utf8');
      const declarations = [...source.matchAll(/Blockly\.Blocks\[['"]([^'"]+)['"]\]\s*=\s*\{/g)];
      declarations.forEach((match, index) => {
        const body = source.slice(match.index, declarations[index + 1]?.index ?? source.length);
        const inputs = {}, fields = {};
        for (const argument of body.matchAll(/"type"\s*:\s*"(input_value|input_statement|field_[\w]+)"([\s\S]*?)\n\s*\}/g)) {
          const text = argument[2], name = text.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
          if (!name || argument[1] === 'field_image' || argument[1] === 'field_label') continue;
          if (argument[1].startsWith('input_')) inputs[name] = argument[1] === 'input_statement' ? 'statement' :
            /"check"\s*:\s*"Boolean"/.test(text) ? 'boolean' : 'value';
          else {
            const choices = [...text.matchAll(/\[[^\]\n]+,\s*['"]([^'"]+)['"]\s*\]/g)].map(item => item[1]);
            fields[name] = {type: argument[1], choices,
              default: text.match(/"(?:text|colour|value)"\s*:\s*"([^"]*)"/)?.[1],
              min: text.match(/"min"\s*:\s*(-?\d+(?:\.\d+)?)/)?.[1],
              max: text.match(/"max"\s*:\s*(-?\d+(?:\.\d+)?)/)?.[1]};
          }
        }
        const shape = /"output_boolean"/.test(body) ? 'boolean' : /"output_(number|string)"/.test(body) || /"output"\s*:/.test(body) ? 'value' :
          /"shape_hat"/.test(body) ? 'hat' : /"shape_end"/.test(body) ? 'end' : 'statement';
        coreSchemas.set(match[1], {inputs, fields, shape});
      });
    }
  }
  coreSchemas.set('control_stop', {inputs: {}, fields: {STOP_OPTION: {choices: ['all', 'this script', 'other scripts in sprite']}}, shape: 'end'});
  return coreSchemas;
};
module.exports = {frozenSchemas};
