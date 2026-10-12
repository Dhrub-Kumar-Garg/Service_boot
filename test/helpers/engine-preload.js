// Used only by the acceptance test's CLI subprocess. The real CLI still imports
// src/engine normally; this preload substitutes the selected reference engine
// in that subprocess's module cache without changing any production file.
if (process.env.ENGINE_PATH) {
  const path = require('node:path');
  const target = require.resolve('../../src/engine');
  require(target);
  require.cache[target].exports = require(path.resolve(process.env.ENGINE_PATH));
}
