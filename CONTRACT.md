# ServiceBoot Contract (shared by Person 1, 2, 3)

## 1. Config file (serviceboot.yml)
version: 1
services:
  <name>:                          # name matches /^[A-Za-z0-9_-]+$/
    command: "node app.js"         # required, non-empty string
    cwd: "./dir"                   # optional, relative to the config file's folder
    env: { KEY: value }            # optional, values converted to strings
    depends_on: [other, names]     # optional
    ready_check: "port 5432" | "http http://127.0.0.1:3000/health" | "none"   # optional, default none
    ready_timeout_ms: 30000        # optional, default 30000
    ready_interval_ms: 500         # optional, default 500
    restart: never | on-failure    # optional, default never
    max_retries: 3                 # optional, default 3 (used only with on-failure)

## 2. Service object (what the parser outputs and the engine reads)
{ name, command, cwd (ABSOLUTE path), env ({string:string}), dependsOn (string[]),
  readyCheck: {type:'port', port:number} | {type:'http', url:string} | {type:'none'},
  timeoutMs, intervalMs, restart ('never'|'on-failure'), maxRetries }
readyCheck 'none' means: ready as soon as the process has spawned successfully.
Port checks connect to 127.0.0.1.

## 3. Plan: loadPlan(configPath) in src/plan.js
returns { services: {[name]: Service}, order: string[] (declaration order),
          groups: string[][], analysis: {depth, width, total, chosen, reason} }
groups = levels. level(service) = 0 if no deps, else 1 + max(level of its deps).
Names inside a level keep declaration order (deterministic).

## 4. Adaptive rule (src/graph/adaptive.js)
depth = groups.length. width = size of the largest group. total = number of services.
chosen = 'parallel' if width > depth * 2, otherwise 'sequential'.
reason strings (exact):
 parallel:   "Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution."
 sequential: "Width (W) <= Depth (D) x 2. Graph is small or mostly linear. Auto-selecting SEQUENTIAL execution to save concurrency overhead."

## 5. Engine interface (Person 2 implements in src/engine/index.js)
runEngine({ services, groups, algorithm, maxParallel, emitter })
  algorithm: 'sequential' | 'parallel' | 'adaptive'. maxParallel: number, default Infinity.
  emitter: a Node EventEmitter.
  Resolves { algorithm, effectiveAlgorithm, totalMs, readyMs: {name: ms}, pids: {name: pid} }
  Rejects (Error) if any service fails; before rejecting it stops everything it started.
  Sequential: flatten groups in order, start one, wait ready, next.
  Parallel: per level start services concurrently (at most maxParallel at a time),
    wait until all in the level are ready, then next level.
  Adaptive: call analyze(groups), emit 'adaptive:decision', run the chosen algorithm.
stopAll({ graceMs = 3000 }) -> Promise<void>
  Stops every running service: deeper levels first (reverse dependency order),
  SIGTERM, then SIGKILL after graceMs. Leaves zero orphan processes.

## 6. Events (emitter.emit(name, payload)); every payload also has ts (performance.now() ms)
run:start         {algorithm, total}
adaptive:decision {width, depth, chosen, reason}
service:starting  {name, pid, level}
service:log       {name, stream:'stdout'|'stderr', line}
service:ready     {name, pid, ms}      // ms = time from spawn to ready
service:failed    {name, reason:'spawn'|'timeout'|'crash', error}
service:exited    {name, code, signal}
run:done          {algorithm, effectiveAlgorithm, totalMs}
run:failed        {error}

## 7. Errors and exit codes
ConfigError (src/config/errors.js): name 'ConfigError', .errors = string[] (ALL problems, not just the first).
CLI exit codes: 0 ok, 1 config error, 2 usage error, 3 runtime/engine failure.

## 8. CLI
serviceboot plan [--config FILE] [--json]
serviceboot up   [--config FILE] [--algorithm sequential|parallel|adaptive]
                 [--max-parallel N] [--exit-after-ready]
Default config: ./serviceboot.yml. Default algorithm: adaptive.

## 9. Additions by Person 2

### Persistent CLI ownership and down

`serviceboot down` (no options) stops the run recorded in the current working
directory. It does not require a configuration file. Exit 0 on success, with
`Nothing to stop` when no CLI/service is running; runtime/IO failures exit 3.

`up` owns `./.serviceboot/pids.json`, relative to its current working directory,
with `{cliPid, startedAt, config, services:[{name, pid, level}]}`. startedAt is an
ISO timestamp; config is an absolute path. Each service:starting replaces that
service's entry, including restarts. Clean shutdown removes the owned file.
An active cliPid rejects up with exit 3 and the message:
`ServiceBoot is already running (pid X). Run "serviceboot down" first.`
A stale cliPid prints a warning, cleans recorded leftovers with down, and proceeds.
Malformed records reject without spawning or deleting unrelated metadata.

`src/engine/pidfile.js` exports synchronous `write(record, {cwd}?)`,
`addService({name,pid,level}, {cwd,cliPid}?)`, `read({cwd}?)` and
`remove({cwd,cliPid}?)`. cwd defaults to process.cwd(). write supplies defaults for
cliPid, startedAt, config and services, validates the record, and uses a temporary
file plus rename in the same directory. read returns null if absent. addService
requires the same owner (default process.pid); remove with cliPid removes only
that owner's file. remove returns whether a file was removed.

`src/engine/down.js` exports internal `down({cwd}?) -> Promise<boolean>` (whether
anything was running). A live CLI receives POSIX SIGTERM or Windows taskkill
/PID /T /F. down waits up to 10 seconds for its file to disappear; if the CLI dies
first (including forced Windows termination), it finishes from the recorded
services. An already dead CLI is recovered directly with terminatePid, deepest
levels first and peers concurrently, then the file is removed. Partial cleanup
errors retain the file for a later attempt. Removal checks ownership so an old
CLI/down cannot delete a newer run's record. Simultaneous up invocations are not
serialized by a lock; the live-PID guard applies to an existing published record.
On Windows, if a recorded shell is already dead, cleanup discovers surviving
descendants from CIM parent PIDs before using taskkill; a dead shell alone does
not mean its service tree has stopped.
After stopping a live CLI, down rereads its final record to include replacements
published while the stop request was being delivered.
The synchronous Windows force-stop fallback batches owned targets into one
taskkill invocation and clears completed ownership entries before the exit hook.

Known limitation: a recycled PID in a stale file could be killed by mistake.
Use the same working directory for up and down. Hard-killed CLIs cannot remove
their own records. `.serviceboot/` is ignored by Git.

### Crash recovery

New event: `service:restarting {name, attempt, maxRetries, code, signal, ts}`.
attempt starts at 1. Backoff is 500 ms times attempt, interruptible by stopAll.
The event is emitted after old-tree cleanup, immediately before backoff.
The retry budget is per service for the entire run, shared by startup and later
recovery; it does not reset when a replacement becomes ready. Each replacement
emits the usual service:starting/ready events. Preflight is only for initial starts.

restart on-failure retries nonzero exits and unexpected signals, up to maxRetries.
Before first readiness, exhausted retries are a terminal startup crash: the
existing first-failure abort/cleanup policy applies. Code 0 before readiness is
an early exit/crash error but is not retried. Startup spawn errors and readiness
timeouts are not retried. After readiness, code 0 and exits caused by our own
shutdown do not restart. Exhausted crash retries emit service:failed with reason
crash and leave that service down while other services keep running. A replacement
spawn/readiness failure ends recovery with its spawn/timeout reason. Dependents
are NOT restarted. restart never retains its previous behavior.

stopAll cancels and drains recovery/backoff tasks before stopping process trees;
no replacement may spawn after cancellation. The initial run:done/result describes
startup, not the lifetime of supervised services. Later recovery does not emit
another run:done or run:failed. `samples/restart.yml` demonstrates two replacements
of a crashing mock and a healthy sibling.
Regular termination and the synchronous force-stop fallback mark owned handles
as stopping so their exit signals cannot trigger automatic recovery.
`src/engine/recovery.js` exports internal `launch(service, ctx, {preflight}?)`,
shared by startup runners and later recovery; it owns per-service retry state.
A new run is blocked until stopAll clears the supervised run context, including
periods with no live leader while recovery is in backoff.

### Process-tree metrics

`getTreePids(rootPid) -> Promise<number[]>` is exported from the process manager
and src/engine/index.js. It returns rootPid plus all descendants in one OS process
snapshot, using POSIX `ps -A -o pid=,ppid=` or Windows PowerShell CIM CSV. Invalid
PIDs reject; command failures/timeouts reject. A disappeared root still appears
in the returned array; membership can change immediately after the snapshot.

pid = group leader (shell wrapper); use getTreePids(pid) for CPU/memory metrics;
result.pids can be stale after restarts, getRunning() is the live source.
readyMs and pids returned by runEngine are startup snapshots.

The process manager additionally exports internal `isPidAlive(pid)` (single-PID
existence probe) and `requestCliStop(pid)` (platform-specific CLI stop request),
used by PID ownership/down. Platform branches remain inside the process manager.

## 10. Additions by Person 3

Sections 1–9 are unchanged. Everything below is additive.

### CLI

```
serviceboot up        ... [--plain] [--quiet] [--no-color]
serviceboot benchmark [--config FILE]... [--runs N] [--algorithms LIST]
                      [--max-parallel N] [--out FILE] [--sample-ms N] [--no-metrics]
```

- Output mode: when stdout is NOT a TTY (pipes, files, CI, tests) or `--plain`
  is given, `up` prints exactly the section 6 `event key=value` lines plus the
  `Ready: ...` line, unchanged from Person 2. On a TTY it prints the
  human-readable UI from `src/cli/ui.js`. `NO_COLOR` (any value), `TERM=dumb`
  or `--no-color` remove ANSI colours and the spinner. `--quiet` hides
  service stdout/stderr lines in the TTY UI only.
- `--config` may be repeated for `benchmark` only; `plan`/`up` reject a second
  one with exit 2. Default benchmark configs: samples/small.yml, linear.yml,
  wide.yml. `--runs` default 3; `--algorithms` comma list, default all three;
  `--sample-ms` integer >= 100, default 500; `--out` default
  `results/results.json` (results/ is git-ignored; committed evidence lives in
  report/).
- benchmark exit codes: 0 all runs succeeded; 1 config error (nothing started,
  nothing written); 2 usage; 3 at least one run failed (file still written);
  130/143 cancelled by SIGINT/SIGTERM (partial file written with
  `complete: false`). A second signal kills synchronously like `up`.
- benchmark refuses to start while a live `up` owns `.serviceboot/pids.json`,
  and records its own services there so `down` can recover a hard-killed run.

### Process-manager additions (platform branches stay in this file)

- `getForestPids(rootPids) -> Promise<Map<root, pid[]>>`: several trees from ONE
  process-table snapshot.
- `sampleProcesses(pids) -> Promise<[{pid, cpuMs, rssBytes, voluntaryCtx, involuntaryCtx}]>`:
  Linux `/proc/<pid>/stat` + `/status`; macOS `ps -o pid=,rss=,time=`;
  Windows CIM `Win32_Process`. Vanished PIDs and zombies are omitted. Fields the
  OS does not expose are `null`, never `0`.
- `samplerSupport() -> {platform, cpu, memory, contextSwitches, source}`.
- `parsePsTime(text)` (internal helper, exported for tests).

### Metrics collector: `src/metrics/collector.js`

`createCollector({intervalMs = 500}) -> {start(), stop({finalSample}) -> Promise<summary>, sampleOnce(), summary()}`

Each sample: live leaders from `getRunning()` (so restarts are followed), one
forest snapshot, one sampler call. Snapshots never overlap (setTimeout chain);
`stop()` clears the timer and awaits an in-flight query. A failed OS query is
counted in `errors`/`lastError` and never thrown into the measured run.

Definitions:
- `cpuPercent` = Σ per-process CPU-time delta ÷ wall-time delta × 100, summed
  over all service trees. 100 = one fully busy core. A PID first seen in a
  sample contributes all CPU time since its birth. First sample: `null`.
- `rssBytes` = Σ resident set size over all processes of all service trees.
  Shared pages are counted once per process, so this is an upper bound.
- context switches (Linux only): Σ of the last observed counters per process.
  Processes that exit between samples are counted up to their last sample.
- `orchestrator`: the ServiceBoot Node process itself (`process.memoryUsage`,
  `process.cpuUsage`), reported separately.

### Results JSON (schemaVersion 1)

```
{ schemaVersion: 1, tool: {name, version}, startedAt, finishedAt, command, complete,
  environment: {platform, osRelease, arch, cpuModel, logicalCpus, totalMemoryBytes, node},
  settings: {runsPerPair, algorithms, maxParallel (null = unlimited), metrics,
             sampleIntervalMs, cooldownMs, order},
  metricsSupport, units, configs: [{path, services, groups, analysis}],
  runs: [{config, round, algorithm, effectiveAlgorithm, outcome: ok|failed|cancelled,
          error, startupMs, readyMs: {name: ms}, shutdownMs, wallMs, restarts,
          adaptiveDecision, eventCounts, metrics: <collector summary incl. samples>}],
  summary: [{config, algorithm, effectiveAlgorithms, runs, successful, failed,
             startupMs, shutdownMs, perServiceReadyMs: {name: stats}, peakRssBytes,
             meanCpuPercent, peakCpuPercent, orchestratorPeakRssBytes,
             voluntaryContextSwitches, involuntaryContextSwitches}] }
stats = {n, mean, median, min, max, stdev (sample, n-1)} or null when unavailable.
```

`startupMs` is the engine's `totalMs` (run:start → all ready). `shutdownMs` is
`stopAll()` alone; `wallMs` covers the whole run including sampling and
shutdown. Only successful runs are timing samples; failures are counted.

### Engine fix by Person 3

`src/engine/readiness.js` → `waitForReady`: a final probe started with less than
5 ms of budget can only time out; its `timeout` result no longer overwrites the
previous real diagnostic. Behaviour and deadlines are otherwise unchanged.
