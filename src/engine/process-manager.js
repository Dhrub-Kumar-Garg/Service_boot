const { spawn, spawnSync, execFile } = require('node:child_process');
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
      // Windows retains a dead parent's PID in its children's ParentProcessId.
      // Keep ownership until tree cleanup, even after the shell closes its pipes.
      if (spawned && process.platform !== 'win32' && !isGroupAlive(handle.pid)) owned.delete(handle.pid);
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

function isPidAlive(pid) {
  validPid(pid);
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function requestCliStop(pid) {
  validPid(pid);
  if (process.platform === 'win32') {
    // Windows cannot deliver SIGTERM to another Node console. Stop its entire
    // process tree; down will remove the file after the CLI has died.
    if (isPidAlive(pid)) await killWindowsTree(pid);
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

function processSnapshotCommand() {
  const windows = process.platform === 'win32';
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation']
    : ['-A', '-o', 'pid=,ppid='];
  return { windows, command, args };
}

async function getTreePids(rootPid) {
  validPid(rootPid);
  const { windows, command, args } = processSnapshotCommand();
  const output = await new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000,
      maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return treeFromSnapshot(rootPid, output, windows);
}

function treeFromSnapshot(rootPid, output, windows) {
  const children = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = windows ? /^\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*$/.exec(line)
      : /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  // Parent PIDs identify a tree at one instant. Walking all generations includes
  // the actual Node service and grandchildren beneath its shell wrapper.
  const result = [rootPid];
  const seen = new Set(result);
  for (let index = 0; index < result.length; index++) {
    for (const pid of children.get(result[index]) || []) {
      if (pid > 0 && !seen.has(pid)) { seen.add(pid); result.push(pid); }
    }
  }
  return result;
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
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, timeout: 10000
    }, error => {
      if (!error || (typeof error.code === 'number' && !isGroupAlive(pid))) resolve();
      else reject(new EngineError(`taskkill failed for process ${pid}: ${error.message}`, {
        reason: 'crash', serviceName: owned.get(pid)?.name
      }));
    });
  });
}

async function terminateTree(pid, handle, graceMs) {
  if (process.platform === 'win32') {
    if (isGroupAlive(pid)) await killWindowsTree(pid);
    else {
      // taskkill cannot follow a dead shell. CIM still records the parent PID,
      // so discover its surviving descendants and kill deepest children first.
      const descendants = (await getTreePids(pid)).slice(1).reverse();
      for (const descendant of descendants) {
        if (isPidAlive(descendant)) await killWindowsTree(descendant);
      }
      for (const descendant of descendants) await waitGone(descendant, 2000, handle?.name);
    }
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
  for (const handle of owned.values()) handle.stopping = true;
  if (process.platform === 'win32') {
    try {
      const roots = [...owned.keys()];
      let snapshot;
      function inspectDeadShells() {
        if (snapshot !== undefined) return snapshot;
        // The exit hook cannot await CIM. Take one bounded synchronous
        // snapshot for all dead shells and recover their surviving children.
        const { command, args } = processSnapshotCommand();
        const result = spawnSync(command, args, { windowsHide: true,
          encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('Cannot inspect remaining Windows service trees');
        snapshot = result.stdout;
        return snapshot;
      }
      const targets = [...new Set(roots.flatMap(pid => isPidAlive(pid) ? [pid]
        : treeFromSnapshot(pid, inspectDeadShells(), true).slice(1)))].filter(isPidAlive);
      if (targets.length) {
        // taskkill accepts several /PID arguments. One invocation avoids
        // paying process startup and tree enumeration costs for every service.
        const result = spawnSync('taskkill', [...targets.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
        });
        if (result.error) throw result.error;
        if (result.status !== 0 && targets.some(isPidAlive)) throw new Error(`taskkill exited ${result.status}`);
      }
      // Forced exit invokes this hook again; never revisit completed trees.
      for (const pid of roots) owned.delete(pid);
    } catch (error) { console.error('ServiceBoot exit cleanup failed:', error); }
    return;
  }
  for (const pid of owned.keys()) {
    try {
      signalGroup(pid, 'SIGKILL');
      // A forced exit also invokes Node's exit hook. Do not inspect or kill
      // this completed tree twice, or target a PID reused after the first kill.
      owned.delete(pid);
    } catch (error) {
      console.error(`ServiceBoot exit cleanup failed (${pid}):`, error);
    }
  }
}

function getRunning() {
  return [...running.values()].map(({ name, pid, level }) => ({ name, pid, level }));
}

// Internal shutdown snapshot includes owned trees whose shell already exited.
function getManagedHandles() {
  return [...owned.values()];
}

module.exports = {
  spawnService, createLineSplitter, isGroupAlive, terminate, terminatePid,
  killAllSync, getRunning, getManagedHandles, isPidAlive, requestCliStop, getTreePids
};
