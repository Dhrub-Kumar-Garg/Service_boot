const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../../src/engine');

test('getTreePids rejects invalid roots before starting an OS command', async () => {
  for (const pid of [0, -1, 1.5, '123', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(engine.getTreePids(pid), { name: 'TypeError', message: 'pid must be a positive safe integer' });
  }
});
