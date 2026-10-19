const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const manager = require('../../src/engine/process-manager');
const pidfile = require('../../src/engine/pidfile');
const { makeServices, isAlive, waitDead } = require('../helpers');

const bin = path.resolve(__dirname, '../../bin/serviceboot.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, { recovering = false } = {}) {
  // macOS aliases /var to /private/var; spawned processes report canonical cwd.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-down-')));
  const plan = await makeServices([{ name: 'root', delay: 0 },
    { name: 'dependent', deps: ['root'], delay: 0 }]);
  const services = Object.fromEntries(Object.values(plan.services).map(service => [service.name, {
    command: service.command, cwd: service.cwd, depends_on: service.dependsOn,
    ready_check: `port ${service.readyCheck.port}`, ready_interval_ms: 50,
    restart: recovering && service.name === 'root' ? 'on-failure' : 'never', max_retries: 2
  }]));
  fs.writeFileSync(path.join(cwd, 'serviceboot.yml'), JSON.stringify({ version: 1, services }));
  const child = spawn(process.execPath, [bin, 'up', '--algorithm', 'parallel'], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let failure;
  let originalSaved;
  let treePids = [];
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.on('error', error => { failure = error; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (isAlive(child.pid)) await manager.requestCliStop(child.pid);
    const saved = pidfile.read({ cwd });
    const remaining = saved?.services || (treePids.some(isAlive) ? originalSaved?.services : []) || [];
    for (const service of remaining) await manager.terminatePid(service.pid, { graceMs: 0 });
    for (const pid of treePids) if (isAlive(pid)) await manager.terminatePid(pid, { graceMs: 0 });
    await closed;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('Ready:')) {
    assert.ifError(failure);
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, `CLI never ready: ${output}`);
    await pause(25);
  }
  const saved = pidfile.read({ cwd });
  originalSaved = saved;
  treePids = (await Promise.all(saved.services.map(service => manager.getTreePids(service.pid)))).flat();
  return { cwd, child, exited, closed, saved, treePids, getOutput: () => output };
}

function invoke(cwd, args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd, windowsHide: true, encoding: 'utf8', timeout: 20000
  });
  assert.ifError(result.error);
  return result;
}

test('DOWN: hard-killed CLI leaves orphans that down removes with the PID file', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.saved.cliPid, f.child.pid);
  assert.deepEqual(f.saved.services.map(service => service.level), [0, 1]);
  assert.equal(f.saved.config, path.join(f.cwd, 'serviceboot.yml'));
  // Killing just the CLI simulates a crash, preserving its shell service trees.
  f.child.kill('SIGKILL');
  await f.exited;
  assert.ok(f.treePids.some(isAlive), 'actual service descendants survived the CLI crash');
  assert.ok(pidfile.read({ cwd: f.cwd }));
  const result = invoke(f.cwd, ['down']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ServiceBoot stopped/);
  assert.ok(await waitDead(f.treePids));
  await f.closed;
  assert.equal(pidfile.read({ cwd: f.cwd }), null);
  const again = invoke(f.cwd, ['down']);
  assert.equal(again.status, 0);
  assert.equal(again.stdout.trim(), 'Nothing to stop');
});

test('DOWN: active owner blocks duplicate up and down stops the live CLI', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const duplicate = invoke(f.cwd, ['up']);
  assert.equal(duplicate.status, 3);
  assert.match(duplicate.stderr, new RegExp(`ServiceBoot is already running \\(pid ${f.child.pid}\\)\\. Run "serviceboot down" first\\.`));
  const result = invoke(f.cwd, ['down']);
  assert.equal(result.status, 0, result.stderr);
  await f.closed;
  assert.ok(await waitDead([f.child.pid, ...f.treePids]));
  assert.equal(pidfile.read({ cwd: f.cwd }), null);
});

test('DOWN: stale up warns, cleans orphan services, and publishes its new owner', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.child.kill('SIGKILL');
  await f.exited;
  const restarted = invoke(f.cwd, ['up', '--exit-after-ready']);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.stderr, /stale.*cleaning recorded leftovers/i);
  assert.match(restarted.stdout, /Ready:/);
  assert.ok(await waitDead(f.treePids));
  await f.closed;
  assert.equal(pidfile.read({ cwd: f.cwd }), null);
});

test('DOWN: CLI replaces the saved PID on recovery and down stops the latest process', { timeout: 30000 }, async t => {
  const f = await fixture(t, { recovering: true });
  const initialPid = f.saved.services.find(service => service.name === 'root').pid;
  // Cause the crash after fixture discovery, so machine scheduling cannot
  // make it race the initial readiness and process-tree snapshots.
  await manager.terminatePid(initialPid, { graceMs: 0 });
  const deadline = Date.now() + 10000;
  let saved;
  do {
    assert.ok(Date.now() < deadline, f.getOutput());
    await pause(25);
    saved = pidfile.read({ cwd: f.cwd });
    assert.ok(saved, `PID file unexpectedly disappeared: ${f.getOutput()}`);
  } while (saved.services.find(service => service.name === 'root').pid === initialPid);
  assert.equal(saved.services.filter(service => service.name === 'root').length, 1);
  assert.equal(saved.services.find(service => service.name === 'root').level, 0);
  assert.equal(saved.services.find(service => service.name === 'dependent').pid,
    f.saved.services.find(service => service.name === 'dependent').pid);
  assert.match(f.getOutput(), /service:restarting root/);
  const latestTree = await manager.getTreePids(saved.services.find(service => service.name === 'root').pid);
  const result = invoke(f.cwd, ['down']);
  assert.equal(result.status, 0, result.stderr);
  await f.closed;
  assert.ok(await waitDead([...f.treePids, ...latestTree]));
  assert.equal(pidfile.read({ cwd: f.cwd }), null);
});
