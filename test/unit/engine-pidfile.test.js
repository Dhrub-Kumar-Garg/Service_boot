const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pidfile = require('../../src/engine/pidfile');

function directory(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-pidfile-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('pid file is atomic, replaces restarted service entries and protects ownership', t => {
  const cwd = directory(t);
  assert.equal(pidfile.read({ cwd }), null);
  const record = pidfile.write({ config: '/config.yml' }, { cwd });
  assert.equal(record.cliPid, process.pid);
  assert.ok(Number.isFinite(Date.parse(record.startedAt)));
  pidfile.addService({ name: 'a', pid: 100, level: 0 }, { cwd });
  pidfile.addService({ name: 'b', pid: 200, level: 1 }, { cwd });
  pidfile.addService({ name: 'a', pid: 300, level: 0 }, { cwd });
  assert.deepEqual(pidfile.read({ cwd }).services, [
    { name: 'b', pid: 200, level: 1 }, { name: 'a', pid: 300, level: 0 }
  ]);
  assert.equal(pidfile.remove({ cwd, cliPid: process.pid + 1 }), false);
  assert.throws(() => pidfile.addService({ name: 'x', pid: 500, level: 0 },
    { cwd, cliPid: process.pid + 1 }), /ownership changed/);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.serviceboot')), ['pids.json']);
  assert.equal(pidfile.remove({ cwd, cliPid: process.pid }), true);
  assert.equal(pidfile.remove({ cwd }), false);
});

test('a failed atomic rename preserves the old record and removes its temporary file', t => {
  const cwd = directory(t);
  const record = pidfile.write({ config: 'old.yml' }, { cwd });
  t.mock.method(fs, 'renameSync', () => { throw new Error('rename failed'); });
  assert.throws(() => pidfile.write({ config: 'new.yml' }, { cwd }), /rename failed/);
  assert.deepEqual(pidfile.read({ cwd }), record);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.serviceboot')), ['pids.json']);
});

test('unsafe PID records and malformed JSON are rejected', t => {
  const cwd = directory(t);
  for (const pid of [0, -1, '123', 1.5]) {
    assert.throws(() => pidfile.write({ cliPid: pid }, { cwd }), /Invalid ServiceBoot pid file/);
    assert.throws(() => pidfile.write({ services: [{ name: 'x', pid, level: 0 }] }, { cwd }), /Invalid/);
  }
  pidfile.write({}, { cwd });
  fs.writeFileSync(path.join(cwd, '.serviceboot', 'pids.json'), '{broken');
  assert.throws(() => pidfile.read({ cwd }), SyntaxError);
});
