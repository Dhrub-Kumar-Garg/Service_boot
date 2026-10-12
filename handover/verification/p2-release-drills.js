// Reproducible release drills using the real CLI, without mocked engine events.
// Run from the repository root: node handover/verification/p2-release-drills.js MODE
// MODE is startup-kill, startup-crash, busy-port, or restart-events.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const manager = require('../../src/engine/process-manager');
const pidfile = require('../../src/engine/pidfile');
const { isPortOpen } = require('../../src/engine/readiness');
const { freePort } = require('../../test/helpers');

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'bin/serviceboot.js');
const mock = path.join(root, 'mock/mock-service.js');
const children = [];
const leaders = new Set();
const observed = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quoted = value => /\s/.test(value) ? `"${value}"` : value;

function start(args, label, executable = process.execPath) {
  console.log(`COMMAND [${label}]: ${[executable, ...args].map(quoted).join(' ')}`);
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, output: '', stderr: '', exit: undefined, error: undefined, label };
  state.exited = new Promise(resolve => child.once('exit', (code, signal) => {
    state.exit = { code, signal };
    console.log(`EXIT [${label}]: code=${code} signal=${signal}`);
    resolve(state.exit);
  }));
  state.closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', error => { state.error = error; });
  child.stdout.on('data', chunk => { state.output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { state.stderr += chunk; process.stdout.write(chunk); });
  children.push(state);
  return state;
}

async function until(predicate, state, description, ms = 20000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ifError(state.error);
    assert.equal(state.exit, undefined, `${description}: CLI exited early\n${state.output}\n${state.stderr}`);
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await pause(20);
  }
}

async function bounded(promise, description, ms = 20000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function captureLeaders(state) {
  for (const match of state.output.matchAll(/^service:starting \S+ pid=(\d+)/gm)) {
    const pid = Number(match[1]);
    leaders.add(pid); observed.add(pid);
  }
}

async function verifyDead(label) {
  const deadline = Date.now() + 3000;
  while ([...observed].some(manager.isPidAlive)) {
    assert.ok(Date.now() < deadline, 'a recorded service process is still alive');
    await pause(25);
  }
  assert.equal(pidfile.read(), null, 'clean shutdown removed the PID file');
  console.log(`CHECK [${label}]: observedPids=${JSON.stringify([...observed])} alive=0 pidFilePresent=false`);
}

async function invoke(args, label, expected) {
  const state = start([bin, ...args], label);
  const exit = await bounded(state.exited, label);
  await bounded(state.closed, `${label} pipes closed`);
  captureLeaders(state);
  assert.equal(exit.code, expected, state.stderr);
  return state;
}

async function main(mode) {
  assert.equal(pidfile.read(), null, 'run drills only when this working directory is idle');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-release-drill-'));
  const config = path.join(temporary, 'serviceboot.yml');
  const port = await freePort();
  let otherPort;
  do { otherPort = await freePort(); } while (otherPort === port);
  const command = (name, selectedPort, args = '') =>
    `${quoted(process.execPath)} ${quoted(mock)} --port ${selectedPort} --name ${name} ${args}`;
  function save(services) {
    const raw = { version: 1, services };
    fs.writeFileSync(config, JSON.stringify(raw, null, 2));
    console.log(`CONFIG [${mode}]: ${JSON.stringify(raw)}`);
  }
  let succeeded = false;
  try {
    if (mode === 'startup-kill') {
      save({ 'startup-a': { command: command('startup-a', port, '--delay 10000'), ready_check: `port ${port}` },
        'startup-b': { command: command('startup-b', otherPort, '--delay 10000'), ready_check: `port ${otherPort}` } });
      const up = start([bin, 'up', '--config', config, '--algorithm', 'parallel'], 'startup up');
      await until(() => (up.output.match(/^service:starting /gm) || []).length === 2 && up.output.includes('stream=stdout'), up, 'both not-ready services spawned');
      captureLeaders(up);
      for (const family of await Promise.all([...leaders].map(manager.getTreePids))) {
        for (const pid of family) observed.add(pid);
      }
      assert.ok(!up.output.includes('service:ready '), 'interrupt happened before any readiness');
      console.log(`ACTION: child.kill('SIGKILL') on CLI pid=${up.child.pid}; readyEvents=0`);
      up.child.kill('SIGKILL');
      await bounded(up.exited, 'hard-killed CLI exit');
      const saved = pidfile.read();
      assert.equal(saved.cliPid, up.child.pid);
      console.log(`PID FILE AFTER HARD KILL: ${JSON.stringify(saved)}`);
      await invoke(['down'], 'down after hard kill', 0);
      await bounded(up.closed, 'orphan stdout pipes closed');
      await verifyDead(mode);
    } else if (mode === 'startup-crash') {
      save({ crash: { command: command('crash', port, '--delay 5000 --exit-after 100 --exit-code 1'), ready_check: `port ${port}` },
        dependent: { command: command('dependent', otherPort), depends_on: ['crash'], ready_check: `port ${otherPort}` } });
      const up = await invoke(['up', '--config', config, '--algorithm', 'parallel'], 'startup crash up', 3);
      assert.match(up.output, /service:failed crash reason=crash/);
      assert.ok(!up.output.includes('service:starting dependent'));
      await verifyDead(mode);
    } else if (mode === 'busy-port') {
      const busy = start([mock, '--port', String(port), '--name', 'busy-drill', '--delay', '0'], 'manually started busy mock');
      observed.add(busy.child.pid);
      await until(() => busy.output.includes('listening on'), busy, 'manual mock listening');
      assert.equal(await isPortOpen(port), true);
      save({ busy: { command: command('second-process', port), ready_check: `port ${port}` } });
      const up = await invoke(['up', '--config', config], 'busy port up', 3);
      assert.match(up.stderr, new RegExp(`Port ${port} is already in use`));
      assert.ok(!up.output.includes('service:starting '));
      console.log(`ACTION: stop the manually started mock pid=${busy.child.pid}`);
      busy.child.kill('SIGKILL');
      await bounded(busy.closed, 'manual mock cleanup');
      assert.equal(await isPortOpen(port), false);
      await verifyDead(mode);
    } else if (mode === 'restart-events') {
      const up = start([bin, 'up', '--config', 'samples/restart.yml', '--algorithm', 'parallel'], 'real restarting up');
      await until(() => up.output.includes('service:failed crashing reason=crash'), up, 'two retries exhausted', 25000);
      captureLeaders(up);
      const saved = pidfile.read();
      assert.equal(saved.services.filter(service => service.name === 'crashing').length, 1);
      assert.equal((up.output.match(/^service:starting crashing /gm) || []).length, 3);
      assert.equal((up.output.match(/^service:restarting crashing /gm) || []).length, 2);
      const healthy = saved.services.find(service => service.name === 'healthy');
      for (const pid of await manager.getTreePids(healthy.pid)) observed.add(pid);
      assert.equal(manager.isPidAlive(healthy.pid), true);
      console.log(`CHECK: healthy sibling pid=${healthy.pid} remains alive after crash exhaustion`);
      await invoke(['down'], 'down after restart capture', 0);
      await bounded(up.closed, 'restarting CLI closed');
      await verifyDead(mode);
    } else throw new Error(`Unknown drill ${mode}`);
    succeeded = true;
  } finally {
    // On a failed drill, clean only processes created here or recorded by its CLI.
    for (const state of children) captureLeaders(state);
    for (const state of children) if (state.child.pid && manager.isPidAlive(state.child.pid)) {
      state.child.kill('SIGKILL');
    }
    const saved = pidfile.read();
    const ownRecord = saved && children.some(state => state.child.pid === saved.cliPid);
    for (const service of ownRecord ? saved.services : []) leaders.add(service.pid);
    if (!succeeded) for (const pid of leaders) await manager.terminatePid(pid, { graceMs: 0 });
    if (ownRecord) pidfile.remove({ cliPid: saved.cliPid });
    for (const state of children) await bounded(state.closed, `${state.label} final cleanup`);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
