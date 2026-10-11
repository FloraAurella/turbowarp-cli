'use strict';
const fs = require('node:fs/promises');
const JSZip = require('@turbowarp/jszip');
const {blankProject} = require('../../src/project');

// Test code creates the complete fixture from scratch. No workspace project or
// archived tutorial output is read, copied, or published.
const demoProject = async () => {
  const zip = await JSZip.loadAsync(await blankProject());
  const project = JSON.parse(await zip.file('project.json').async('string'));
  project.targets[1].blocks = {
    'demo-flag': {opcode: 'event_whenflagclicked', next: 'demo-move', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0},
    'demo-move': {opcode: 'motion_movesteps', next: null, parent: 'demo-flag', inputs: {STEPS: [1, [4, '25']]}, fields: {}, shadow: false, topLevel: false}
  };
  zip.file('project.json', JSON.stringify(project));
  return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
};
const writeDemoProject = async filename => {await fs.writeFile(filename, await demoProject()); return filename;};
module.exports = {demoProject, writeDemoProject};
