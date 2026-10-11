const fs = require('node:fs');
const path = require('node:path');
const {status} = require('../src/acceptance-state');
const {commandSpecs} = require('../src/commands');

const result = status();
const root = path.resolve(__dirname, '..');
const mandatoryFiles = ['bin/tw.js', 'tw', 'README.md', 'LICENSE', 'package-lock.json', 'index.d.ts', 'src/sdk.js', 'docs/project-agent-usage.md',
  'docs/census/m1-census.json', 'docs/census/m1-census.md', 'docs/addons-inventory.json',
  'docs/addons-disposition.md', 'docs/completion-audit.md', 'docs/quickstart.md', 'docs/command-reference.md',
  'docs/acceptance-evidence.json', 'docs/census/action-acceptance.json', 'docs/census/action-acceptance.md',
  'resources/RESOURCE-MANIFEST.json'];
const missingFiles = mandatoryFiles.filter(file => !fs.existsSync(path.join(root, file)));
const rules = [];
for (const [command, definition] of Object.entries(commandSpecs)) {
  const actions = definition.options ? [['', definition]] : Object.entries(definition);
  for (const [action, rule] of actions) {
    if (!Number.isInteger(rule.min) || !Number.isInteger(rule.max) || rule.min < 0 || rule.max < rule.min ||
      !Array.isArray(rule.options) || new Set(rule.options).size !== rule.options.length) rules.push(`${command} ${action}`);
  }
}
console.log(JSON.stringify({...result, missingFiles, invalidCommandSchemas: rules,
  commandFamilies: Object.keys(commandSpecs).length}, null, 2));
process.exitCode = missingFiles.length || rules.length ? 1 : result.releaseReady ? 0 : 2;
