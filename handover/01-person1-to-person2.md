# Handover: Person 1 -> Person 2

Date: 2026-10-12.

Verified implementation commit: `94d81cd4c568f985ab4faccb5f2f100239e5d764` (`phase 5: engine contract tests`). Final Person 1 release: tag `p1-done`, which also includes these Phase 6 documents. Resolve that release's hash with `git rev-parse p1-done`; the document names the verified code commit rather than trying to embed its own future commit hash.

## 0. START HERE (5-minute quick start)

From the repo root, with Node.js 18+:

```sh
npm install
npm test
npm run test:engine
node bin/serviceboot.js plan --config samples/wide.yml
```

Expected now: `npm test` exits 0 with 106 passing tests on macOS; `npm run test:engine` exits 1 with all 18 tests failing with `NOT IMPLEMENTED`. This red suite is Person 2's implementation target. Windows skips three mock signal tests and the engine CLI SIGINT test; Windows was not run for this handover.

Actual fresh-clone wide plan output (exit 0):

```text
Config: samples/wide.yml  (10 services)
Start order (levels):
  Level 0: w1, w2, w3, w4, w5, w6, w7, w8
  Level 1: api1, api2
Graph analysis: depth=2 width=8
Adaptive decision: PARALLEL
Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution.
```

Fresh-clone check: `git clone . /tmp/sb-check`, then `npm install` and every check above plus plans for the other four samples. Node was `v20.19.4`, npm `10.8.2`, on `darwin arm64`, with `ENGINE_PATH` unset. Full, unedited command output and exit statuses are in [verification/phase6-fresh-clone.txt](verification/phase6-fresh-clone.txt), including the initial sandbox socket failures and the successful permitted rerun. No source or test fixes were necessary.

Actual test summary excerpts:

```text
npm test:
# tests 106
# suites 0
# pass 106
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1552.77875

npm run test:engine:
# tests 18
# suites 0
# pass 0
# fail 18
# cancelled 0
# skipped 0
# todo 0
# duration_ms 148.955875
```

All engine failures include `NOT IMPLEMENTED: Person 2 implements this (see CONTRACT.md section 5)`. Actual sample results: small and linear select SEQUENTIAL (exit 0), wide selects PARALLEL (exit 0), cyclic reports `a -> b -> c -> a` (exit 1), and invalid reports all three validation problems (exit 1). The transcript includes each complete output. Wide `up --algorithm parallel` currently exits 3 with the stub message.

## 1. What is done

| Feature | File | Exported function(s) | How to try it |
| --- | --- | --- | --- |
| Shared interface and defaults | `CONTRACT.md` | None | Read all eight sections; keep it immutable |
| Config error aggregation | `src/config/errors.js` | `ConfigError` class | Plan `samples/invalid.yml` |
| YAML parsing and normalization | `src/config/parser.js` | `parseReadyCheck`, `parseConfigString`, `parseConfig` | Plan `samples/small.yml`; config unit tests |
| All-problem validation | `src/config/validator.js` | `validateRaw` | Plan `samples/invalid.yml` |
| Adjacency maps and cycle detection | `src/graph/dag.js` | `buildGraph`, `detectCycle` | Plan `samples/cyclic.yml`; graph unit tests |
| Deterministic startup levels | `src/graph/topo.js` | `topoLevels`, `flatten` | Plan `samples/linear.yml` |
| Adaptive graph analysis | `src/graph/adaptive.js` | `analyze` | Plan `samples/wide.yml` |
| Complete load pipeline | `src/plan.js` | `loadPlan` | `plan --json` via the CLI |
| CLI parsing, events, signal wiring | `src/cli/index.js`, `bin/serviceboot.js` | `main` from CLI module; bin has no exports | `node bin/serviceboot.js --help`; `plan`; stub `up` |
| TCP/HTTP fake service | `mock/mock-service.js` | `main` (also executable) | Manual command in section 8; mock unit tests |
| Five config examples | `samples/*.yml` | None | Plan each sample |
| Executable engine requirements | `test/engine/engine.contract.test.js` | None | `npm run test:engine` |
| Real-process test helpers | `test/helpers/index.js` | `freePort`, `makeServices`, `record`, `isAlive`, `waitDead` | Read `test/helpers/README.md`; helper unit tests |
| Engine interface placeholder | `src/engine/index.js` | Async `runEngine`, `stopAll` | Both currently reject with `NOT IMPLEMENTED` |

## 2. Your job in one sentence

Implement `src/engine/index.js` (`runEngine`, `stopAll`) so `npm run test:engine` goes fully green and `node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel` boots all services.

## 3. What you can use from my code

All modules use CommonJS named exports. Parsing, validation, graph analysis, and `loadPlan` are synchronous; helpers `freePort`, `makeServices`, and `waitDead` return promises.

```js
const { ConfigError } = require('../config/errors');
const { parseReadyCheck, parseConfigString, parseConfig } = require('../config/parser');
const { validateRaw } = require('../config/validator');
const { buildGraph, detectCycle } = require('../graph/dag');
const { topoLevels, flatten } = require('../graph/topo');
const { analyze } = require('../graph/adaptive');
```

These relative imports are from `src/engine/`. `require('../plan').loadPlan(configPath)` returns:

```text
{
  services: { [name]: Service },
  order: string[],                // YAML declaration order
  groups: string[][],             // zero-based dependency levels
  analysis: { depth, width, total, chosen, reason }
}

Service = {
  name: string, command: string, cwd: absolutePath,
  env: { [key]: string }, dependsOn: string[],
  readyCheck: {type:'port', port:number}
            | {type:'http', url:string} | {type:'none'},
  timeoutMs: number, intervalMs: number,
  restart: 'never' | 'on-failure', maxRetries: number
}
```

Defaults: cwd is the config's folder, env `{}`, dependsOn `[]`, readyCheck `{type:'none'}`, timeoutMs `30000`, intervalMs `500`, restart `'never'`, maxRetries `3`. Provided cwd resolves against the config folder; env values use `String(value)`. Merge overrides with the parent's environment when spawning; the parser returns service overrides only.

`parseConfigString(yamlText, baseDir)` and `parseConfig(filePath)` return `{services, order}`; YAML/file/validation errors become `ConfigError` with `.errors: string[]`. `parseReadyCheck(str)` returns the union above or throws a plain Error. `validateRaw(raw)` returns all problems and does not check graph cycles.

`buildGraph(services)` returns `{dependsOn:{[name]:string[]}, dependents:{[name]:string[]}}`. `detectCycle(services, order?)` returns `null` or one closed path. The optional explicit order supports numeric names. `topoLevels(services, order)` returns levels or throws ConfigError with the closed cycle path; `flatten(groups)` concatenates levels. Use the parser's `order`, since JavaScript object enumeration reorders integer-like keys. These graph functions expect validated Service objects.

`analyze(groups)` returns `{depth, width, total, chosen, reason}`; chosen is lowercase `'sequential'` or `'parallel'`. Reasons are exactly:

```text
Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution.
Width (W) <= Depth (D) x 2. Graph is small or mostly linear. Auto-selecting SEQUENTIAL execution to save concurrency overhead.
```

Keep the engine's exports and result exactly as CONTRACT section 5 specifies. Every event payload needs `ts` from `performance.now()` and the fields in section 6. The existing CLI listens to all nine events, prints one line per event, passes Infinity when maxParallel is omitted, and owns user SIGINT/SIGTERM handling. Let its call to `stopAll` cancel pending startup as well as ready services.

## 4. Engine checklist, mapped to tests

Numbers below are the actual full-suite TAP numbers in `test/engine/engine.contract.test.js`, not the original phase's twelve task categories. Tests 1–6 are ORDERING: sequential diamond/wide (1–2), parallel diamond/wide (3–4), adaptive diamond/wide (5–6). Successful-run assertions also check result maps, event fields/timestamps, startup order, and the complete previous-level readiness barrier.

| Person 2 task | Acceptance coverage | Additional manual checks needed |
| --- | --- | --- |
| Spawner: command, cwd, env, PID, log lines, spawn errors | 1–6, 18 exercise real spawning and one start event per service | Missing executable; cwd/env propagation; stdout/stderr framing; paths with spaces; shell-child PID ownership |
| Readiness: port, HTTP/HTTPS, none; deadlines and probe cancellation | Port: 1–11, 15–18; timeout: 13 | Engine HTTP/HTTPS and none are **not covered**; use HTTP samples, failed health status, connection errors, and none readiness; mock HTTP itself has unit tests |
| Sequential: flatten levels; wait for ready before next spawn | 1–2, 7, sequential half of 8 | Run the linear sample |
| Parallel: start concurrently within a level, then barrier | 3–4, 8, 15 | Six-root test requires at least four in flight and parallel totalMs < 0.6 × sequential totalMs |
| maxParallel: readiness slots, default Infinity | 9 checks cap 2 and six ready services; uncapped 8 | Other caps, repeated runs; CLI validates positive integers |
| Adaptive dispatch and exact reason | 5–6, 10–11 | Reuse `analyze`; boundary equality and empty analysis already have graph unit tests |
| Crash/timeout teardown before rejection; no dependent spawn | 12–14 | Spawn failure and crashes after readiness; cancel all timers/probes/queued starts; inspect cleanup before rejection |
| restart on-failure, maxRetries, cancellation during shutdown | **Not covered**; only parsed and validated today | Check clean exit vs failure, retry limit including 0, retry readiness, PID replacement, and no restart while stopping; document policy choices without weakening terminal-failure cleanup |
| SIGINT/SIGTERM through the CLI | 17 tests real SIGINT (skipped on win32) | Real SIGTERM, interrupts during startup, repeated signals; CLI unit tests simulate these with mocked engine functions |
| stopAll: reverse levels, await exits, idempotence | 15 checks dependent exit before its dependencies; afterEach calls stopAll | Repeated/overlapping calls, partially started runs, already exited children |
| Escalation and cross-platform process-tree kill | 16 checks death after a 500 ms grace; 12–17 check observed PID cleanup | **Windows kill behavior and descendant process trees are not proven**; exercise on Windows and Linux, including shell grandchildren |
| `down` using a persistent PID file | **Not covered; not implemented** | New extension: CONTRACT section 8 only defines plan/up. Define and document PID-file location/format, ownership, stale-PID checks, cleanup, and down arguments/exit behavior; test by hand in a separate invocation |

Remaining test index: 7 no sequential overlap; 8 concurrent and faster; 9 max-parallel; 10 wide adaptive; 11 linear adaptive; 12 startup crash; 13 readiness timeout; 14 dependent blocked; 15 reverse stopAll; 16 force kill; 17 CLI SIGINT; 18 no double spawn. A fully green suite alone does not prove uncovered behavior.

## 5. Decisions made

- Levels follow the longest dependency path: roots are level 0; other nodes are one level after their deepest dependency. Kahn's algorithm processes complete frontiers and preserves declaration order within each level.
- Adaptive uses strict `width > depth * 2`. Equality selects sequential. Depth counts levels, including roots; empty analysis is depth/width/total 0 and sequential.
- Port checks and mock listeners use `127.0.0.1` to avoid IPv6 resolution differences. Sample HTTP URLs also use that address.
- `none` means ready after a successful spawn; it does not wait for a port or log message.
- Observable order matters: run:start precedes starts; adaptive decision precedes service starts; starting precedes ready; dependencies and the full previous level are ready before the next level starts; run:done follows all readiness events. Reverse shutdown waits for dependent exits before stopping their dependencies. Concurrent peers may arrive in any order.
- Contract tests start real mocks so scheduling, TCP readiness, exit signals, elapsed time, and orphan checks exercise the OS. Events are compared by arrival index, avoiding fragile comparisons of almost-equal timestamps.

## 6. Known issues / not done

The engine is entirely a stub. Restart policy and retry count are parsed but not acted on. HTTP/HTTPS/none engine checks, real SIGTERM integration, Windows process-tree handling, and down/PID persistence need implementation and verification. `down` is a newly requested extension, not an existing contract command; CONTRACT.md was left unchanged.

Three CLI unit tests currently encode the stub's existence: “CLI up with the engine stub…”, “both engine stub functions…”, and “CLI accepts all three algorithms…”. Report these obsolete expectations when implementing the engine and explain any replacement; preserve their CLI validation/error coverage and all engine acceptance requirements. A real engine will otherwise break `npm test` even when acceptance tests pass.

This fresh-clone run used macOS and Node 20. Node 18, Linux, and Windows were not run in Phase 6. Three mock SIGTERM tests and engine test 17 skip on Windows. A temporary reference engine was used during Phase 5 and deleted; it is not shipped. Phase 6 verifies the shipped stub, not a working production engine.

## 7. Fragile areas / don't touch

Keep [CONTRACT.md](../CONTRACT.md) unchanged. If an interface is wrong or underspecified, report it and document extension choices outside that file. Preserve validator rules, all-error aggregation, and exact cycle/adaptive reason strings.

Keep explicit declaration order, especially numeric service names and special keys such as `__proto__`. Avoid mutating services/groups. Keep the test helper timing thresholds: delay 400 ms for the speed comparison, timeout 1000 ms with <4 s failure, 3 s cleanup, 2 s forced-stop bound, 5 s CLI exit, and per-test timeout 30 s. Investigate a failed bound before changing it; do not loosen it to hide a scheduling or teardown bug.

Run acceptance tests serially: `freePort` closes its allocation listener, so the port is available but not reserved. Every afterEach calls `stopAll({graceMs:500})` and then kills surviving observed PIDs as a safety cleanup. That fallback is not permission for engine teardown to leak processes. `ENGINE_PATH` is a test-only override; leave it unset when checking the production implementation.

## 8. Debug tips

Select the ORDERING family (six cases):

```sh
node --test --test-name-pattern="ORDERING" test/engine/
```

Actually run in the fresh clone: exit 1, six failures with the stub and twelve pattern skips. Full output is in the verification transcript.

Run a mock by hand; this example closes automatically after one second (choose another free port if 4101 is occupied):

```sh
node mock/mock-service.js --port 4101 --name handover --delay 300 --http --exit-after 1000 --exit-code 0
```

Actual output, exit 0:

```text
[handover] starting
[handover] listening on 127.0.0.1:4101
```

For a long-running probe, omit exit-after/exit-code and interrupt with Ctrl+C. For failure probes, use `--never-ready`, `--exit-after 100 --exit-code 1`, or `--ignore-sigterm`. Inspect `service:starting ... pid=...` and compare with `service:exited`; record helper indices show which dependency barrier was crossed.

Platform-specific process inspection instructions below were **not executed on Windows/Linux** during the macOS check. Inspect command lines before terminating any PID; other Node processes may belong to unrelated work.

Linux:

```sh
ps -eo pid,ppid,args | grep '[m]ock/mock-service.js'
```

Windows PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine
```

Use `waitDead` on the observed service PIDs as well; shell-spawned descendants require their own inspection. Local tests need permission to bind loopback sockets. `listen EPERM` in a restricted environment is not an engine assertion failure.

## 9. Ready-to-paste prompt for Person 2's IDE agent

```text
You are helping me build ServiceBoot, a Node.js CLI for an OS lab. It reads
serviceboot.yml, builds a service dependency DAG, and starts real local services
using Sequential, Parallel, and Adaptive algorithms. Three people work one after
another. Person 1's foundation is complete at tag p1-done. I am Person 2, responsible
for the OS engine. Person 3 will implement UI, metrics, and benchmarking.

Read CONTRACT.md fully (especially sections 5 and 6), the whole repo, and
handover/01-person1-to-person2.md before editing. CONTRACT.md is immutable: if you
think it is wrong, tell me instead of editing it.

GLOBAL RULES:
- Node.js 18+, plain JavaScript CommonJS, no TypeScript or build step.
- Only direct runtime dependency: js-yaml. Tests use node:test and node:assert.
- Cross-platform Windows/macOS/Linux; use node:path and 127.0.0.1, never localhost.
- Explain non-obvious scheduling/process logic in plain-English comments for a viva.
- Never claim something works without running it. Show real command/test output.
- Do not modify tests unless you find a real bug, and tell me if you do. The handover
  identifies three CLI unit tests that intentionally assume the old stub: report
  their obsolescence and explain the necessary migration before changing them.
  Preserve their behavior coverage and do not weaken engine acceptance assertions.
- Commit at the end of each implementation phase.

IMPLEMENT:
1. Replace src/engine/index.js's stub with async runEngine and stopAll matching the
   exact argument/result shapes and nine events in CONTRACT sections 5 and 6.
   Include performance.now() timestamps on every event payload.
2. Spawn commands using normalized absolute cwd and inherited env plus overrides.
   Track actual service PIDs and process descendants, capture stdout/stderr as lines,
   handle spawn errors and exits once, and avoid double spawning in normal runs.
3. Implement port polling on 127.0.0.1, HTTP/HTTPS health checks, and none readiness
   after successful spawn. Respect timeoutMs/intervalMs; cancel requests, sockets,
   polling, and timers when ready, failed, or stopped. Document HTTP success criteria.
4. Sequential: flatten groups and await each ready service before starting the next.
   Parallel: cap starts awaiting readiness by maxParallel (default Infinity), wait
   for the whole level, then advance. Adaptive: call analyze(groups), emit the exact
   decision, and dispatch the chosen algorithm.
5. On terminal spawn/crash/timeout failure, emit the required failure events, block
   dependents and queued starts, stop everything started, then reject an Error.
   Handle post-readiness crashes too. Implement restart on-failure with maxRetries;
   document retry behavior and how exhausted retries become terminal failures.
6. stopAll({graceMs=3000}): cancel ongoing startup and retries, stop deepest levels
   first, await dependent exits before their dependencies, SIGTERM then force kill
   after grace. Make cleanup repeatable and safe during partial startup and races.
   Leave no orphan services or descendants; verify Windows process-tree termination.
7. Integrate with the existing CLI SIGINT/SIGTERM and exit-after-ready wiring. Keep
   the plain output and exit codes; leave UI/benchmark work to Person 3.
8. Add down with PID-file persistence as a new extension. It is absent from the
   immutable contract: document the chosen command, file location/format, process
   ownership/stale-PID protection, reverse-order cleanup, and error behavior in
   README/handover without changing existing contracted interfaces.

VERIFY:
- Make npm run test:engine fully green against the real src engine with ENGINE_PATH
  unset; run it and show full real output. Run npm test and show its real output too.
- Run wide up --algorithm parallel and small up to exercise HTTP checks, stop cleanly,
  and verify observed PIDs are dead. Exercise sequential/adaptive/max-parallel as well.
- Test uncovered behavior by hand (or add meaningful new tests): HTTP/HTTPS/none,
  spawn errors, env/cwd/paths with spaces, restart limits, post-ready crashes, actual
  SIGTERM, startup interruption, down in another process, stale PID files, shell
  descendants, and Windows killing. Clearly say which OS checks were not run.
- Investigate timing failures; do not loosen helper thresholds to mask engine bugs.
- Run fresh-clone install/tests/sample plans. Never invent output or claim done
  without running the commands and inspecting the results.

At the end, update README for implemented behavior, write
handover/02-person2-to-person3.md with exact exports/events, verification output,
remaining gaps, and continuation instructions, then commit the engine phase.
```
