const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pidfile = require('../../src/engine/pidfile');

// Windows: replacing pids.json while another process is reading it fails with
// EPERM for a moment. write() must retry instead of crashing the running CLI.
test('PIDFILE: transient EPERM/EBUSY on rename is retried; other errors are not', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-pid-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rename = fs.renameSync;
  let failures = 2;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (failures-- > 0) throw Object.assign(new Error('locked'), { code: failures ? 'EPERM' : 'EBUSY' });
    return rename(from, to);
  });
  pidfile.write({ config: 'a.yml' }, { cwd });
  assert.equal(pidfile.read({ cwd }).config, 'a.yml');

  fs.renameSync.mock.mockImplementation(() => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); });
  assert.throws(() => pidfile.write({ config: 'b.yml' }, { cwd }), { code: 'EIO' });
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.serviceboot')), ['pids.json'], 'no temporary file left behind');
});
