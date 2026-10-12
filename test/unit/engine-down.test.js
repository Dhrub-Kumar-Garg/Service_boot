const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../src/cli');

test('CLI down needs no config, reports nothing to stop, and rejects up options', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-empty-down-'));
  const previous = process.cwd();
  process.chdir(cwd);
  t.after(() => { process.chdir(previous); fs.rmSync(cwd, { recursive: true, force: true }); });
  const output = [];
  const errors = [];
  t.mock.method(console, 'log', message => output.push(message));
  t.mock.method(console, 'error', message => errors.push(message));
  assert.equal(await main(['down']), 0);
  assert.deepEqual(output, ['Nothing to stop']);
  for (const args of [['--config', 'missing.yml'], ['--algorithm', 'parallel'], ['--exit-after-ready']]) {
    assert.equal(await main(['down', ...args]), 2);
  }
  assert.equal(errors.length, 3);
  assert.ok(errors.every(message => /not valid for down/.test(message)));
  assert.deepEqual(fs.readdirSync(cwd), []);
});
