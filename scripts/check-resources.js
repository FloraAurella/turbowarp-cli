const {inspect} = require('../src/resource-state');
const result = inspect();
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.complete ? 0 : 1;
