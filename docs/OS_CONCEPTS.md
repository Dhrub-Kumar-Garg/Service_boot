# OS concepts → where the code implements them

Every row points at real code in this repository. Only concepts the code
actually demonstrates are listed. What ServiceBoot does **not** use is listed at
the end, so nobody claims it in the viva.

| # | OS concept | What ServiceBoot does | File → function |
|---|---|---|---|
| 1 | **Process creation** | Each service is started as a child process through a shell (`/bin/sh -c` on POSIX, `cmd.exe` on Windows) with its own working directory and environment variables. Node's `child_process.spawn` performs fork/exec (POSIX) or `CreateProcess` (Windows) internally. | `src/engine/process-manager.js` → `spawnService` |
| 2 | **Process groups** | On POSIX each service shell becomes the leader of a **new process group** (`detached: true` → `setsid`). Signalling `-pid` reaches the shell, the service and every grandchild at once. | `process-manager.js` → `spawnService`, `signalGroup`, `isGroupAlive` |
| 3 | **Process trees** | A service PID is only the shell wrapper. The real work happens in descendants, which are found by walking parent-PID links in one process-table snapshot (`ps -A -o pid=,ppid=` / Windows CIM). Used for shutdown on Windows and for every metric. | `process-manager.js` → `getTreePids`, `getForestPids`, `treeFromSnapshot` |
| 4 | **Signals** | Graceful stop sends `SIGTERM` to the whole group, waits a grace period, then `SIGKILL` (which cannot be caught or ignored). The CLI handles `SIGINT` (Ctrl+C → exit 130) and `SIGTERM` (exit 143); a second Ctrl+C forces a synchronous kill. Windows has no deliverable SIGTERM, so it uses `taskkill /T /F`. | `process-manager.js` → `terminateTree`, `killAllSync`; `src/cli/index.js` → `runUp` (`onSignal`) |
| 5 | **Process lifecycle / monitoring** | Exit events record exit code or terminating signal; a crash before readiness fails the run, a crash after readiness can be restarted. Zombie (`Z`) processes are ignored by the sampler because they no longer run. | `process-manager.js` → `spawnService` (exit/close handlers); `src/engine/recovery.js` → `watch`, `recover` |
| 6 | **Inter-process communication** | Readiness is checked over **TCP sockets** (`net.connect`) and **HTTP** requests to the service. Service stdout/stderr are read through **pipes** and split into lines. | `src/engine/readiness.js` → `portProbe`, `httpProbe`, `waitForReady`; `process-manager.js` → `createLineSplitter` |
| 7 | **Concurrency** | Parallel startup launches every service of a dependency level at once and waits for all of them (`Promise.allSettled`) before the next level. One Node thread drives many OS processes through asynchronous I/O. | `src/engine/runners.js` → `runParallel` |
| 8 | **Synchronization / coordination** | A dependent never starts before all its dependencies are *ready*: a level **barrier** in `runParallel`, one-at-a-time ordering in `runSequential`, and an `AbortController` that cancels all waits on the first failure. Shutdown has the reverse barrier: deeper levels stop completely before shallower ones. These are asynchronous coordination primitives, not mutexes. | `runners.js` → `runSequential`, `runParallel`; `src/engine/index.js` → `stopAll` |
| 9 | **Resource allocation limits** | `--max-parallel N` caps how many services may be *starting* (spawned but not ready) at once inside a level: a fixed pool of N workers, each holding its slot until readiness. | `runners.js` → `runParallel` (worker pool) |
| 10 | **Scheduling on a dependency graph (DAG)** | Config → graph, cycle detection with the cycle path, Kahn-style topological levels, and the adaptive rule `width > 2 × depth → parallel`. These are *service-startup* strategies, not CPU scheduling algorithms. | `src/graph/dag.js` → `buildGraph`, `detectCycle`; `src/graph/topo.js` → `topoLevels`; `src/graph/adaptive.js` → `analyze` |
| 11 | **Fault recovery** | `restart: on-failure` retries with linear back-off (500 ms × attempt) and a lifetime retry budget, so a crash loop cannot run forever. | `src/engine/recovery.js` → `launch`, `retry` |
| 12 | **Persistent ownership / orphan recovery** | `up` writes `.serviceboot/pids.json` atomically (temp file + rename). If the CLI is killed with `SIGKILL`, `down` reads it and stops the orphaned process groups. | `src/engine/pidfile.js` → `write`; `src/engine/down.js` → `down` |
| 13 | **CPU time accounting** | Per-process user + kernel CPU time from `/proc/<pid>/stat` (clock ticks ÷ `CLK_TCK`), `ps time` on macOS, CIM `UserModeTime + KernelModeTime` on Windows. CPU% = Σ CPU-time delta ÷ wall-time delta. | `process-manager.js` → `sampleProcesses`; `src/metrics/collector.js` → `sampleOnce` |
| 14 | **Memory (resident set size)** | Physical memory per process (`VmRSS`, `ps rss`, Windows working set), summed over every process in each service tree. | same as 13 |
| 15 | **Context switches** | Linux only: `voluntary_ctxt_switches` (the process blocked and gave up the CPU) and `nonvoluntary_ctxt_switches` (the scheduler preempted it). Not exposed by this collector elsewhere, so reported as unavailable, never zero. | `process-manager.js` → `sampleLinux` |
| 16 | **File I/O** | YAML config parsing; atomic PID file; results JSON. | `src/config/parser.js` → `parseConfig`; `pidfile.js`; `src/cli/index.js` → `runBenchmarkCommand` |
| 17 | **Performance analysis** | Serial, round-robin repeated runs with monotonic timers; mean, median, min/max, sample stdev; charts. | `src/benchmark/index.js` → `runBenchmark`, `describe`; `scripts/charts.py` |

## Not used — do not claim these

- No direct `fork()`/`exec()` calls (Node does that inside `spawn`).
- No mutexes, semaphores, condition variables or shared memory.
- No threads or thread pool of our own (Node's internal libuv pool is not ours).
- No cgroups, `ulimit`, nice values or CPU/memory caps on services. The only
  "resource limit" is `--max-parallel`, a limit on concurrent *startups*.
- No CPU scheduling algorithms (FCFS/SJF/RR). Sequential/parallel/adaptive are
  service-startup orders on a dependency graph.
