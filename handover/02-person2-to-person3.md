# Handover: Person 2 → Person 3

Date: 2026-10-12. Release tag: `p2-done`; resolve its code commit with
`git rev-parse 'p2-done^{commit}'`. Verification host: Windows, Node 22.16.0,
npm 10.9.2. CONTRACT sections 1–8 and protected tests/helpers are unchanged.

## 0. START HERE (quick start with real expected output)

From the repository root with the existing dependencies installed:

```sh
npm test
npm run test:engine
node bin/serviceboot.js plan --config samples/wide.yml
node bin/serviceboot.js up --config samples/wide.yml --algorithm adaptive --exit-after-ready
node bin/serviceboot.js up --config samples/small.yml --exit-after-ready
node bin/serviceboot.js down
```

These commands were executed for this release. Actual Windows test counts:
172 unit tests = 168 passes/4 POSIX skips; 32 engine tests = 31 passes/1 POSIX
SIGINT skip. PIDs/timings differ per run. Real plan/startup/idle-down output:

```text
Config: samples/wide.yml  (10 services)
Start order (levels):
  Level 0: w1, w2, w3, w4, w5, w6, w7, w8
  Level 1: api1, api2
Graph analysis: depth=2 width=8
Adaptive decision: PARALLEL
Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution.
Ready: 10 services (algorithm=adaptive, effectiveAlgorithm=parallel, totalMs=2037.7591000000002)
Ready: 3 services (algorithm=adaptive, effectiveAlgorithm=sequential, totalMs=1643.615)
Nothing to stop
```

`--exit-after-ready` stops the services after measuring startup. Omit it for a
live run; use Ctrl+C or down from another terminal in the SAME working directory.

Actual startup totalMs, excluding later shutdown:

| Sample / request | Effective algorithm | Real totalMs |
| --- | --- | --- |
| wide-sequential | sequential | 9668.395499999999 |
| wide-parallel | parallel | 2040.5816 |
| wide-adaptive | parallel | 2037.7591000000002 |
| linear-adaptive | sequential | 2739.2062 |
| small-adaptive | sequential | 1694.297 |

Calculated from these real runs: parallel was 4.738× faster with 78.894% lower startup time. These are individual CLI startup measurements.

Five consecutive unit/engine pairs used strict rejection mode, ENGINE_PATH unset:

| Round | Unit: pass / skip; TAP ms | Engine: pass / skip; TAP ms | Exit codes; remaining processes |
| --- | --- | --- | --- |
| 1 | 168 / 4; 37519.078 | 31 / 1; 122094.9582 | 0 / 0; 0 after both |
| 2 | 168 / 4; 38546.7148 | 31 / 1; 116249.3533 | 0 / 0; 0 after both |
| 3 | 168 / 4; 40939.212 | 31 / 1; 119638.9009 | 0 / 0; 0 after both |
| 4 | 168 / 4; 37546.0548 | 31 / 1; 117111.738 | 0 / 0; 0 after both |
| 5 | 168 / 4; 41575.8251 | 31 / 1; 120291.2991 | 0 / 0; 0 after both |

All ten commands exited 0 on their own. No flaky test, warning or unhandled rejection was observed; no test/CLI/mock process or PID file remained after any suite. No engine/test changes or timing-bound changes were needed.

See [stability summary](verification/p2-release-stability-summary.txt) and the ten
full `verification/p2-release-N-unit.txt`/`p2-release-N-engine.txt` transcripts.
[Behaviour summary](verification/p2-release-behaviour-summary.txt) records the
individual sample commands and outcomes. A separate child-process check ran all
18 test files independently: 204 tests, 199 passes, 5 POSIX skips, zero failures.
All files finished naturally, with no remaining test processes. See
[file list](verification/p2-release-independent-file-list.txt),
[full output](verification/p2-release-independent-files.txt) and
[completion check](verification/p2-release-independent-summary.txt).

## 1. What is done

| Feature | File | Exports | How to try |
| --- | --- | --- | --- |
| Config/all-error validation | src/config/parser.js, validator.js, errors.js | parseConfig, parseConfigString, parseReadyCheck, validateRaw, ConfigError | plan invalid.yml; npm test |
| DAG/cycles/dependency levels | src/graph/dag.js, topo.js | buildGraph, detectCycle, topoLevels, flatten | plan cyclic.yml/linear.yml |
| Adaptive/load pipeline | src/graph/adaptive.js, src/plan.js | analyze, loadPlan | plan wide.yml --json |
| Three startup algorithms | src/engine/index.js, runners.js | runEngine; internal startOne/runSequential/runParallel | up wide with each --algorithm |
| Reverse-level concurrent shutdown | src/engine/index.js | stopAll | --exit-after-ready; STOPALL tests |
| Live leaders/full process trees | src/engine/index.js, process-manager.js | getRunning, getTreePids | TREE PIDS test; metrics below |
| Shell/env/logs/tree termination | src/engine/process-manager.js | spawnService, terminate, terminatePid, killAllSync, isGroupAlive; internal helpers | process unit tests; orphan drills |
| TCP/HTTP/HTTPS/none readiness | src/engine/readiness.js | isPortOpen, httpOk, waitForReady, preflightPort | up small; readiness tests |
| Safe timestamps/error reasons | src/engine/events.js, errors.js | createEmit, EngineError | real event table below |
| Retry/backoff supervision | src/engine/recovery.js | internal launch | up restart.yml; RESTART tests |
| Atomic PID file/ownership | src/engine/pidfile.js | write, addService, read, remove | inspect .serviceboot/pids.json during up |
| Persistent down/orphan recovery | src/engine/down.js, src/cli/index.js | internal down; CLI main | down from same directory; DOWN tests |
| CLI flags/signals/plain output | bin/serviceboot.js, src/cli/index.js | main; bin is executable | --help, plan/up/down, Ctrl+C |
| Mock/six configurations | mock/mock-service.js, samples/*.yml | mock main | sample commands/manual mock |
| Contract/regression coverage | test/engine/, test/unit/, test/helpers/ | helpers unchanged | npm test; npm run test:engine |
| Reproducible real-CLI drills | handover/verification/p2-release-drills.js | executable helper | startup-kill/startup-crash/busy-port/restart-events |

Public engine exports: runEngine, stopAll, getRunning, getTreePids. runEngine
resolves `{algorithm,effectiveAlgorithm,totalMs,readyMs,pids}` with services alive.
Startup failures reject EngineError with reason spawn/timeout/crash and serviceName
after cleanup; cancellation uses aborted. PID-file/down helpers are internal.

## 2. Your job in one sentence

Person 3 implements the full CLI/UI, service-tree metrics, benchmark/results.json,
Python/matplotlib charts, demo scripts, docs, screenshots and the OS-lab report,
preserving the verified engine behaviour.

## 3. Event reference

Every payload includes ts = performance.now() milliseconds, local to that process.
These lines are copied verbatim from real CLI stdout: wide adaptive success,
startup-crash failure, and restart recovery. Success and failure run events require
different runs; none was synthesized. Do not compare absolute ts across processes.

| Event | Payload fields besides ts | One REAL captured example line |
| --- | --- | --- |
| run:start | algorithm,total | `run:start algorithm=adaptive total=10 ts=135.1708` |
| adaptive:decision | width,depth,chosen,reason | `adaptive:decision width=8 depth=2 chosen=parallel reason=Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution. ts=137.4064` |
| service:starting | name,pid,level | `service:starting w1 pid=3116 level=0 ts=185.065` |
| service:log | name,stream:'stdout'\|'stderr',line | `service:log w1 stream=stdout line=[w1] starting ts=510.0425` |
| service:ready | name,pid,ms | `service:ready w1 pid=3116 ms=831.1 ts=1026.9537` |
| service:failed | name,reason:spawn/timeout/crash,error | `service:failed crash reason=crash error=exited with code 1 before becoming ready\n[crash] starting ts=328.12` |
| service:exited | name,code,signal | `service:exited api1 code=1 signal=null ts=2636.4347` |
| run:done | algorithm,effectiveAlgorithm,totalMs | `run:done algorithm=adaptive effectiveAlgorithm=parallel totalMs=2037.7591000000002 ts=2175.2179` |
| run:failed | error | `run:failed error=exited with code 1 before becoming ready\n[crash] starting ts=1230.0023` |
| service:restarting | name,attempt,maxRetries,code,signal | `service:restarting crashing attempt=1 maxRetries=2 code=1 signal=null ts=2747.6204` |

Sources: [wide adaptive](verification/p2-release-wide-adaptive.txt),
[startup crash](verification/p2-release-startup-crash.txt),
[restarting up](verification/p2-release-restart-events.txt).
CLI error/log newlines are escaped; emitter payloads retain actual strings.
service:exited is once per spawned process, so restarted names have several
starting/ready/exited events. Later recovery emits no new run:done/run:failed;
listen to service:failed for exhaustion after readiness.

## 4. What you need from the engine for each of your tasks

UI: subscribe to all ten emitter events above. service:log supplies stdout/stderr
lines. starting/ready update live PID/status; restarting supplies attempt/backoff.
Do not infer readiness from logs. Preserve usable plain output when not a TTY.
Remove your listeners/timers at shutdown; the CLI owns signal/fatal handling.

Metrics: getRunning() plus await getTreePids(pid), then aggregate CPU/memory over
the shell AND descendants. result.readyMs/totalMs provide startup measurements.
Poll every >=500 ms; Windows tree queries are slow, so use a longer interval if
needed and avoid overlapping queries. result.pids is a startup snapshot and can
be stale after restarts; getRunning is the live source. Processes can disappear
mid-sample. Context switches only where the OS exposes counters; missing or
unsupported fields must be unavailable, not invented zeroes.

Benchmark: call loadPlan and runEngine serially, record results/events/raw metrics,
and ALWAYS await stopAll() in finally between runs. Never run two at once. Stop
and drain your collector too. Keep startup totalMs separate from shutdown and
whole-command wall time. Failed timings are not successful samples.

```js
const { EventEmitter } = require('node:events');
const { loadPlan } = require('./src/plan');
const { runEngine, stopAll, getRunning, getTreePids } = require('./src/engine');
async function example() {
  const emitter = new EventEmitter();
  emitter.on('service:log', ({ name, stream, line }) => { /* render UI */ });
  try {
    const result = await runEngine({ ...loadPlan('samples/wide.yml'), algorithm: 'adaptive', emitter });
    for (const service of getRunning()) {
      const treePids = await getTreePids(service.pid); // pass to your OS sampler
    }
    return result;
  } finally { await stopAll(); }
}
```

This root-relative integration sketch shows how to connect an OS sampler.
Existing flags: --exit-after-ready measures, cleans and exits; --max-parallel N
limits started-but-not-ready services within a level. Defaults: adaptive/Infinity.

## 5. Decisions made

- POSIX detached process groups let negative-PID signals reach shells/services/
  grandchildren. TERM requests cleanup; KILL escalates after the grace period.
- PID is the shell/group leader; full-tree metrics avoid near-zero wrapper usage.
  Windows CIM parent IDs recover children behind dead shells.
- Initial port preflight rejects stale/busy listeners. Restarts skip preflight.
- Sequential flattens levels; parallel holds readiness slots and a whole-level
  barrier. Adaptive uses exact analyze width > 2 × depth/reason strings.
- stopAll aborts startup/recovery/backoff, drains work, then stops deeper levels
  first; peers stop concurrently with a barrier before dependencies. Concurrent
  calls share a promise. A supervised run context remains until stopAll clears it.
- First terminal startup failure owns the failure events; cancelled peers are
  silent. Cleanup finishes before rejection.
- maxRetries is a lifetime service budget shared by startup and later crashes.
  Backoff = 500 ms × attempt. Code 0/our shutdown never restarts. Startup crash
  exhaustion fails the run; after-ready exhaustion leaves only that service down.
  Dependents are not restarted. Replacement spawn/timeout ends its recovery with
  that reason. Readiness ms refers to each replacement's own spawn.
- Windows has no deliverable graceful SIGTERM; stop/down use taskkill /T /F.
  Synchronous force-stop batches owned targets to keep signal cleanup fast.
- ts = performance.now(); results are startup snapshots. Atomic PID metadata uses
  same-directory temp+rename; active owners block up, stale owners warn/clean.

## 6. Known issues / not done

- A recycled PID in a stale file could be killed by mistake. No lock serializes
  simultaneous up invocations; the guard checks an existing published record.
- Dependents are NOT restarted; no application health repair after initial ready.
- Trees are snapshots. A vanished root still appears in getTreePids; handle races
  and liveness. Windows enumeration has a five-second command timeout.
- Windows/Node 22 ran here. Linux/macOS groups/ps/native SIGTERM/SIGINT and Node 18
  still need execution on those hosts. Four POSIX unit cases/one engine SIGINT
  case skip on Windows. Automated callback tests are not native console keypress
  tests. Phase 5 has earlier real console evidence; after UI changes, manually
  recheck Windows Ctrl+C once/twice. Windows SIGTERM is unavailable.
- Full UI, metrics collector, benchmark/results.json, charts, demo scripts,
  screenshots and report remain Person 3's work.
- No flaky test was observed in the five release rounds or independent-file run. Earlier Phase 6 investigations remain in verification/engine-phase6-*.txt; the release evidence here is separate.

Actual failure drill results:

```text
ACTION: child.kill('SIGKILL') on CLI pid=28044; readyEvents=0
EXIT [down after hard kill]: code=0 signal=null
service:failed crash reason=crash error=exited with code 1 before becoming ready\n[crash] starting ts=328.12
EXIT [startup crash up]: code=3 signal=null
error: Port 53268 is already in use (is a previous run still alive? try "serviceboot down")
EXIT [busy port up]: code=3 signal=null
drill=startup-kill exit=0 remainingMockOrCliProcesses=0 pidFilePresent=False
drill=startup-crash exit=0 remainingMockOrCliProcesses=0 pidFilePresent=False
drill=busy-port exit=0 remainingMockOrCliProcesses=0 pidFilePresent=False
drill=restart-events exit=0 remainingMockOrCliProcesses=0 pidFilePresent=False
```

Startup kill used child.kill('SIGKILL'), equivalent forceful single-process
termination on Windows, before ANY service was ready. POSIX kill -9 was not run
on this Windows host. [Startup-kill](verification/p2-release-startup-kill.txt),
[crash](verification/p2-release-startup-crash.txt),
[busy-port](verification/p2-release-busy-port.txt) and
[per-drill checks](verification/p2-release-drill-summary.txt) retain real evidence.

## 7. Fragile areas / don't touch

Preserve CONTRACT sections 1–8, existing interfaces/events/exit codes and exact
adaptive/cycle messages. New Person 3 interfaces go in section 9 and your handover.
Do not weaken test/engine requirements or edit protected acceptance tests/helpers.
Keep declaration order/special names and do not mutate normalized plans.

Preserve stopAll abort/drain/reverse-level barriers, its concurrency guard and
first-failure ownership. process-manager.js owns platform branches, groups,
dead-shell ownership, Windows tree termination and synchronous exit cleanup.
Never replace tree kills with wrapper-only kills. Every added socket/timer/
listener/collector needs cleanup. Fix causes instead of loosening timing tests.

## 8. Debug tips

```sh
node --test --test-name-pattern="ORDERING|TIMEOUT|STOPALL" test/engine/
node mock/mock-service.js --port 4199 --name manual --delay 300 --http --exit-after 1000 --exit-code 0
```

Those selected tests and manual mock command were executed for this release:

```text
Selected test result: tests=8 pass=8 fail=0 skipped=0 duration_ms=21306.5588
[manual] starting
[manual] listening on 127.0.0.1:4199
```

Other useful patterns: RESTART, DOWN, TREE PIDS. Mock crash flags: --exit-after 100
--exit-code 1 with longer --delay; --never-ready hangs readiness;
--ignore-sigterm exercises POSIX escalation. Choose free ports. Inspect PID files
and command lines before killing anything; never kill all node.exe processes.

Windows PowerShell orphan checks. Suite/sample/drill logs record the process
inspection results; these exact commands were also executed for the final check:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*mock-service*' | Select-Object ProcessId,ParentProcessId,CommandLine
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*serviceboot.js*' | Select-Object ProcessId,ParentProcessId,CommandLine
Test-Path .serviceboot/pids.json
```

Expected idle state: no process rows, False. Final real inspection: `remainingMockOrCliProcesses=0 pidFilePresent=False`. No matching rows were returned.

Linux/macOS commands for YOU to run (not executed on this Windows host):

```sh
export NODE_OPTIONS=--unhandled-rejections=strict
for i in 1 2 3 4 5; do npm test && npm run test:engine || break; done
node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel --exit-after-ready
pgrep -fl 'mock-service|bin/serviceboot.js'
ps -A -o pid=,ppid=,args= | grep -E '[m]ock-service|[b]in/serviceboot.js'
test ! -f .serviceboot/pids.json && echo 'PID file absent'
```

pgrep exit 1 means no matches, the desired result. For a native startup hard kill:

```sh
node bin/serviceboot.js up --config samples/wide.yml --algorithm sequential > /tmp/serviceboot-startup.log 2>&1 &
sb_cli=$!
while ! grep -q '^service:starting ' /tmp/serviceboot-startup.log; do
  kill -0 "$sb_cli" 2>/dev/null || break
  sleep 0.02
done
kill -9 "$sb_cli"
wait "$sb_cli" 2>/dev/null || true
node bin/serviceboot.js down
pgrep -fl 'mock-service|bin/serviceboot.js'
test ! -f .serviceboot/pids.json && echo 'PID file absent'
```

Send back startup log, down output/exit status and remaining rows if any. Also
test live up with Ctrl+C once/twice and kill -TERM <CLI_PID> from another terminal,
then repeat orphan checks. These are OTHER-OS instructions, not claimed results.

## 9. A ready-to-paste, phased prompt set for Person 3

Paste global rules first, then one phase at a time. Start from p2-done.

### Global rules

```text
You are Person 3 for ServiceBoot, a Node.js OS lab CLI. Engine phases 1-6 are
complete at p2-done. Read CONTRACT.md, handover/AGENT_RULES.md and
handover/02-person2-to-person3.md first. Preserve sections 1-8; document additions
in section 9. Node 18+, CommonJS, no build step/new Node dependencies without
authorization. Python/matplotlib requirements belong in a separate Python file.
Preserve engine APIs/events/exit codes/exact adaptive reasons and ordering.
Do not edit protected tests/helpers or loosen bounds. process.platform branches
belong only in process-manager.js; expose additional OS helpers there if needed.
Explain OS concepts in comments. Clean timers/sockets/listeners/subprocesses.
Benchmarks are serial and ALWAYS await stopAll in finally. Metrics use live
getRunning/full getTreePids trees. Never fabricate counters/output/screenshots.
Run both full suites per phase, strict mode and orphan checks. Label unrun OS
checks. Commit and push completed work after every prompt.
```

### Phase 1: CLI + UI

```text
Implement full CLI presentation around existing plan/up/down. Use the ten events
for TTY status/progress, readiness timing, restart attempts and stdout/stderr
lines. Preserve useful non-TTY output, flags, exit codes and first/second signal
handling. UI must not spawn services itself. Dispose UI timers/listeners on all
exit paths. Document additions in section 9. Run real wide/small/restart/cyclic
commands, both suites/strict mode and native Ctrl+C once/twice; retain output and
verify no orphans. Commit "person 3 phase 1: CLI + UI" and push.
```

### Phase 2: metrics collector

```text
Implement an awaitable start/stop collector using getRunning + getTreePids. Sum
CPU/memory across the actual service tree; refresh leaders after restarts and
tolerate exits. Poll >=500 ms, avoid overlapping slow Windows queries, document
CPU normalization/units/timestamps. Context switches only where counters exist;
otherwise null with availability reason. Put OS branches in process-manager.js.
stop must clear timers and drain queries. Verify a real busy parent/
grandchild and restarts, prove no leaked handles, document API/schema in section
9, run full/strict tests. Commit "person 3 phase 2: metrics collector" and push.
```

### Phase 3: benchmark command + results.json

```text
Add a benchmark command comparing all algorithms on small/linear/wide, configurable
repetitions/startup cap. Runs must be serial; ALWAYS await stopAll in finally and
stop/drain collectors. Save versioned results.json with raw runs, config,
Node/OS/environment metadata, requested/effective algorithm, totalMs, readyMs,
units, metrics availability and outcomes. Derive statistics from measured runs;
separate startup from shutdown/wall time, and failures from successful samples.
Validate options/output path/error cleanup. Show real speed/adaptive results and
JSON, document command/schema in section 9, run full/strict tests and orphan
checks. Commit "person 3 phase 3: benchmark + results" and push.
```

### Phase 4: Python/matplotlib charts

```text
Write a Python script consuming the actual results.json schema to make startup
comparison, per-service readiness, CPU/memory figures where available. Include
units/sample counts/repetition spread/readable labels; missing is not zero.
Reject bad/missing data clearly. Add requirements and exact commands. Run it on
REAL benchmark JSON, inspect figures and keep provenance; never hard-code numbers
or manufacture data. Run Node regression suites/orphan checks. Commit
"person 3 phase 4: benchmark charts" and push.
```

### Phase 5: demo scripts

```text
Add POSIX shell/Windows PowerShell demos for algorithms, max-parallel, restart,
startup crash, busy port, Ctrl+C and hard-killed CLI/down. Use traps/finally,
owned PIDs and safe/free ports; never kill unrelated Node processes. Document
commands/exit codes/OS limitations. Run available-OS scripts, save real transcripts
and list other-OS manual checks without claiming they ran. Run full/strict tests
and orphan checks. Commit "person 3 phase 5: demo scripts" and push.
```

### Phase 6: docs/report/screenshots + final end-to-end verification + handover

```text
Finish README/usage and the report: DAG/scheduling/readiness, groups/trees/signals,
restarts, metric definitions, method, real results/charts, limitations/viva notes.
Capture REAL UI/chart screenshots and provenance. Run benchmark -> results.json
-> Python charts -> demos end to end. Run both suites five times, strict mode at
least once; fix engine causes of flakes without weakening tests. Check processes,
PID files and collector handles after every normal/failure/signal exit. Test a
fresh checkout/install and every documented command; label unrun OS checks. Write
final handover with APIs/schemas/events/output/artifacts/gaps. Commit/push, tag
verified release p3-done, push tag, and show git log and handover.
```
