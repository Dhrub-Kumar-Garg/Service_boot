const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const manager = require('../../src/engine/process-manager');
const { isAlive } = require('../helpers');

const root = path.resolve(__dirname, '../..');

// Windows cannot deliver POSIX child.kill('SIGINT'). Invoke Node's signal
// callbacks in a child with the real CLI, engine and ten real mock services.
// Native console Ctrl+C is checked separately in the verification transcript.
for (const presses of [1, 2]) {
  test(`CLI SIGINT callbacks: real ${presses === 1 ? 'graceful' : 'forced'} cleanup exits 130 and kills the wide service tree`, { timeout: 20000 }, t => {
    const source = `
      const { performance } = require('node:perf_hooks');
      const manager = require('./src/engine/process-manager');
      const { main } = require('./src/cli');
      const kill = manager.killAllSync;
      manager.killAllSync = () => { console.log('FORCE:kill'); kill(); };
      let signalAt;
      const reportExit = code => console.log('CLI:exit code=' + code + ' shutdownMs=' + (performance.now() - signalAt));
      const exit = process.exit;
      process.exit = code => { reportExit(code); exit(code); };
      const log = console.log;
      console.log = (...args) => {
        log(...args);
        if (String(args[0]).startsWith('Ready:')) setImmediate(() => {
          signalAt = performance.now();
          process.emit('SIGINT');
          ${presses === 2 ? "process.emit('SIGINT');" : ''}
        });
      };
      main(['up', '--config', 'samples/wide.yml', '--algorithm', 'parallel'])
        .then(code => { reportExit(code); process.exitCode = code; });
    `;
    // Allow startup separately from shutdown: the contracted SIGINT bound is
    // five seconds from the interrupt, not five seconds from launching Node.
    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', source], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000
    });
    const pids = [...result.stdout.matchAll(/^service:starting \S+ pid=(\d+)/gm)]
      .map(match => Number(match[1]));
    t.after(async () => {
      for (const pid of pids) {
        if (isAlive(pid)) await manager.terminatePid(pid, { graceMs: 0 });
      }
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 130, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(pids.length, 10, result.stdout);
    assert.ok(pids.every(pid => !isAlive(pid)), 'cleanup finishes before CLI exit');
    const shutdownMs = Number(/CLI:exit code=130 shutdownMs=([\d.]+)/.exec(result.stdout)?.[1]);
    assert.ok(Number.isFinite(shutdownMs) && shutdownMs < 5000, result.stdout);
    if (presses === 2) assert.match(result.stdout, /FORCE:kill/);
    else {
      assert.ok(!result.stdout.includes('FORCE:kill'));
      assert.equal((result.stdout.match(/^service:exited /gm) || []).length, 10);
    }
  });
}
