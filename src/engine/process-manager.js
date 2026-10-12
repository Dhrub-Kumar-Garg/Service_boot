const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { EngineError } = require('./errors');

const running = new Map();
// A shell can exit before its descendants. Keep ownership separately so an
// exited group leader does not make its remaining process group invisible.
const owned = new Map();
const closing = new WeakMap();
const terminations = new Map();
let exitHookInstalled = false;

function createLineSplitter(onLine) {
  let partial = '';
  let ended = false;
  return {
    write(chunk) {
      if (ended) return;
      partial += chunk;
      let newline;
      while ((newline = partial.indexOf('\n')) !== -1) {
        let line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        onLine(line);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (partial.length) onLine(partial);
      partial = '';
    }
  };
}

function spawnService(service, { level, emit }) {
  if (!exitHookInstalled) {
    // The exit event cannot await promises. This synchronous fallback is for
    // ordinary CLI exit; catchable signals will use asynchronous shutdown.
    process.once('exit', killAllSync);
    exitHookInstalled = true;
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(service.command, [], {
        shell: true,
        cwd: service.cwd,
        env: { ...process.env, ...service.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // On POSIX, detached creates a new process group with the shell as
        // leader. A negative PID later signals shell, service and grandchildren.
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (error) {
      reject(spawnError(error));
      return;
    }

    let resolveExit;
    let resolveClose;
    let spawned = false;
    const handle = {
      name: service.name, level, child, pid: child.pid,
      hasExited: false, stopping: false,
      exited: new Promise(done => { resolveExit = done; }),
      tail: []
    };
    closing.set(handle, new Promise(done => { resolveClose = done; }));

    function spawnError(error) {
      return new EngineError(`Cannot spawn ${service.name}: ${error.message}`, {
        reason: 'spawn', serviceName: service.name
      });
    }

    const splitters = [];
    for (const stream of ['stdout', 'stderr']) {
      const pipe = child[stream];
      // Pipes carry byte chunks, not log records. UTF-8 decoding preserves
      // characters across chunks; the splitter buffers incomplete log lines.
      pipe.setEncoding('utf8');
      const splitter = createLineSplitter(line => {
        handle.tail.push(line);
        if (handle.tail.length > 20) handle.tail.shift();
        emit('service:log', { name: service.name, stream, line });
      });
      const onData = chunk => splitter.write(chunk);
      pipe.on('data', onData);
      splitters.push({ pipe, splitter, onData });
    }

    function onError(error) {
      if (!spawned) reject(spawnError(error));
      else console.error(`ServiceBoot process error (${service.name}):`, error);
    }
    function onSpawn() {
      spawned = true;
      running.set(handle.pid, handle);
      owned.set(handle.pid, handle);
      emit('service:starting', { name: service.name, pid: handle.pid, level });
      resolve(handle);
    }
    function onExit(code, signal) {
      handle.hasExited = true;
      running.delete(handle.pid);
      emit('service:exited', { name: service.name, code, signal });
      resolveExit({ code, signal });
    }
    function onClose() {
      // close follows exit AND the closing of inherited stdout/stderr pipes.
      // Flush unterminated final lines only after all output has arrived.
      for (const { pipe, splitter, onData } of splitters) {
        pipe.removeListener('data', onData);
        splitter.end();
      }
      child.removeListener('error', onError);
      child.removeListener('spawn', onSpawn);
      child.removeListener('exit', onExit);
      if (!spawned) {
        handle.hasExited = true;
        resolveExit({ code: child.exitCode, signal: child.signalCode });
      }
      if (spawned && !isGroupAlive(handle.pid)) owned.delete(handle.pid);
      resolveClose();
    }
    child.on('error', onError);
    child.once('spawn', onSpawn);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

function validPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError('pid must be a positive safe integer');
  }
}

function isGroupAlive(pid) {
  validPid(pid);
  try {
    // Signal 0 probes existence without delivering a signal. Permission denial
    // means the process exists; only ESRCH means the OS cannot find it.
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForExit(handle, graceMs) {
  let timer;
  try {
    // Clear the losing timer even if the child exits immediately; otherwise it
    // keeps Node's event loop alive for the entire unused grace period.
    await Promise.race([
      handle.exited,
      new Promise(resolve => { timer = setTimeout(resolve, graceMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitGone(pid, timeoutMs, serviceName) {
  const deadline = performance.now() + timeoutMs;
  while (isGroupAlive(pid)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new EngineError(`Process group ${pid} is still alive after termination`, {
        reason: 'timeout', serviceName
      });
    }
    await delay(Math.min(20, remaining));
  }
}

function killWindowsTree(pid) {
  // Windows has no POSIX process-group signals or graceful SIGTERM. taskkill
  // /T follows the parent/child tree and /F forcibly stops every member.
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true
    });
    killer.once('error', reject);
    killer.once('close', code => {
      if (code === 0 || !isGroupAlive(pid)) resolve();
      else reject(new EngineError(`taskkill failed for process ${pid} (exit ${code})`, {
        reason: 'crash', serviceName: owned.get(pid)?.name
      }));
    });
  });
}

async function terminateTree(pid, handle, graceMs) {
  if (process.platform === 'win32') {
    if (isGroupAlive(pid)) await killWindowsTree(pid);
  } else {
    // SIGTERM requests orderly cleanup. SIGKILL cannot be caught or ignored.
    signalGroup(pid, 'SIGTERM');
    if (handle) await waitForExit(handle, graceMs);
    else {
      const deadline = performance.now() + graceMs;
      while (isGroupAlive(pid) && performance.now() < deadline) {
        await delay(Math.min(20, Math.max(0, deadline - performance.now())));
      }
    }
    // Probe the group, not hasExited: the shell may be dead while a grandchild
    // is still running and ignoring SIGTERM.
    if (isGroupAlive(pid)) signalGroup(pid, 'SIGKILL');
  }
  await waitGone(pid, 2000, handle?.name);
  if (handle) {
    await handle.exited;
    await closing.get(handle);
  }
  owned.delete(pid);
}

function terminatePid(pid, { graceMs = 3000 } = {}) {
  validPid(pid);
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 2147483647) {
    throw new TypeError('graceMs must be a finite non-negative timer duration');
  }
  const handle = owned.get(pid);
  if (handle) handle.stopping = true;
  if (terminations.has(pid)) return terminations.get(pid);
  const operation = terminateTree(pid, handle, graceMs).finally(() => {
    terminations.delete(pid);
  });
  terminations.set(pid, operation);
  return operation;
}

function terminate(handle, options) {
  handle.stopping = true;
  // After cleanup, this old handle must not target a newly reused OS PID.
  if (handle.hasExited && !owned.has(handle.pid)) return Promise.resolve();
  return terminatePid(handle.pid, options);
}

function killAllSync() {
  for (const pid of owned.keys()) {
    try {
      if (process.platform === 'win32') {
        if (isGroupAlive(pid)) {
          const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true
          });
          if (result.error) throw result.error;
          if (result.status !== 0 && isGroupAlive(pid)) {
            throw new Error(`taskkill exited ${result.status}`);
          }
        }
      } else signalGroup(pid, 'SIGKILL');
    } catch (error) {
      console.error(`ServiceBoot exit cleanup failed (${pid}):`, error);
    }
  }
}

function getRunning() {
  return [...running.values()].map(({ name, pid, level }) => ({ name, pid, level }));
}

// Internal shutdown snapshot includes owned POSIX groups whose shell exited.
function getManagedHandles() {
  return [...owned.values()];
}

module.exports = {
  spawnService, createLineSplitter, isGroupAlive, terminate, terminatePid,
  killAllSync, getRunning, getManagedHandles
};
