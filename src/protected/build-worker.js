'use strict';

require('../native-environment');
process.once('message', async message => {
  try {
    const {buildHTML} = require('./index');
    const result = await buildHTML(Buffer.from(message.bytes, 'base64'), message.options);
    process.send({ok: true, html: Buffer.from(result.html).toString('base64'), report: result.report}, () => process.exit(0));
  } catch (error) {
    process.send({ok: false, error: error.message, code: error.code, details: error.details}, () => process.exit(1));
  }
});
