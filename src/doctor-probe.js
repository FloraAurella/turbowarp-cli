'use strict';
require('./native-environment');
require('./network-policy').install();
(async () => {
  const results = [];
  for (const name of ['@napi-rs/canvas', '@resvg/resvg-js', 'node-gles-webgl2', 'node-web-audio-api']) {
    try {
      if (name === 'node-web-audio-api') await import(name);
      else require(name);
      results.push({name, loadable: true});
    } catch (error) {results.push({name, loadable: false, error: error.message});}
  }
  process.stdout.write(JSON.stringify(results) + '\n');
})().catch(error => {console.error(error.message); process.exitCode = 1;});
