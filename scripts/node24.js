'use strict';
const {selectNode, runNode} = require('../src/node-runtime');
try {runNode(selectNode(), process.argv.slice(2));}
catch (error) {console.error(`tw: ${error.message}\n${error.hint || ''}`); process.exitCode = 1;}
