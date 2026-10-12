# ServiceBoot

A Node.js OS lab CLI that reads `serviceboot.yml`, validates services, and starts them in dependency levels. Sequential, Parallel and Adaptive execution use real processes and readiness checks, with cleanup on startup failure.

Requires Node.js 18+. Plain JavaScript (CommonJS), no build step; `js-yaml` is the only direct runtime dependency.

## Install and check

```sh
npm install
npm test
npm run test:engine
```

Person 2 release verification on Windows with Node 22.16.0: five consecutive `npm test`/`npm run test:engine` pairs passed under `NODE_OPTIONS=--unhandled-rejections=strict`. Each pair had 168 unit passes/four POSIX skips and 31 engine passes/one POSIX SIGINT skip, with no warnings, hangs or remaining test/mock processes. Real sample runs and hard-kill/crash/busy-port drills also cleaned their processes. See the [Person 2 handover and actual outputs](handover/02-person2-to-person3.md). The [Phase 5 handover](handover/02-person2-phase5.md) records earlier native Windows console Ctrl+C checks. Linux/macOS verification remains a manual follow-up.

## Commands

```sh
node bin/serviceboot.js plan --config samples/wide.yml
node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel
node bin/serviceboot.js down
```

`plan` works now; add `--json` for the complete plan. `up` boots services and leaves them running; use `--exit-after-ready` to stop and exit after successful startup. `--max-parallel N` limits simultaneous startups until readiness. Defaults are `./serviceboot.yml` and algorithm `adaptive`, which chooses parallel when graph width exceeds twice its depth and otherwise chooses sequential. Use `--help` for usage.

During `up`, the first Ctrl+C requests shutdown and exits 130 after cleanup. POSIX SIGTERM requests shutdown and exit 143; Windows does not deliver SIGTERM as a console signal. A second interrupt forces synchronous process-tree cleanup and immediate CLI exit. An uncaught exception or unhandled rejection prints an error, attempts cleanup, and exits 3.

## Engine

Sequential starts one service at a time, waiting for readiness. Parallel starts
services together within each dependency level, with `--max-parallel` limiting
startups until ready; the entire level finishes before the next. Adaptive chooses
parallel when width > 2 × depth, otherwise sequential. `--exit-after-ready`
measures startup, then stops the services and exits.

`up` records process leaders in `.serviceboot/pids.json`; run `down` from the same
working directory to stop a live CLI or recover a hard-killed run. Shutdown stops
dependents before dependencies and cancels readiness/retry waits. Windows uses
forced process-tree termination because it cannot deliver graceful SIGTERM.

`restart: on-failure` retries nonzero exits/unexpected signals up to `max_retries`,
with backoff of 500 ms × attempt. The budget is shared across startup and later
recovery. After-ready exhaustion leaves that service down; siblings continue and
dependents are not restarted. A clean code-zero exit does not restart.

Exit codes: 0 success, 1 config/cycle error, 2 usage error, 3 runtime/engine error;
SIGINT shutdown exits 130 and POSIX SIGTERM shutdown exits 143. All current APIs,
events and limitations are in [the contract](CONTRACT.md) and
[Person 3's handover](handover/02-person2-to-person3.md).

## Folder map

| Path | Purpose |
| --- | --- |
| `bin/`, `src/cli/` | CLI entry point, argument parsing, plain output, signal wiring |
| `src/config/` | YAML parsing, validation, normalized Service objects |
| `src/graph/`, `src/plan.js` | DAG, cycles, deterministic levels, adaptive analysis |
| `src/engine/` | Sequential/parallel/adaptive execution, startup failure cleanup, process spawning, logs, tree termination, safe events, TCP/HTTP/HTTPS readiness |
| `mock/`, `samples/` | Real TCP/HTTP mock and six example configurations |
| `test/unit/` | Foundation, CLI, mock, and helper tests |
| `test/engine/`, `test/helpers/` | Engine acceptance tests and process helpers |
| `handover/` | Continuation guide and real verification output |

Read [CONTRACT.md](CONTRACT.md) and the [Person 1 → Person 2 handover](handover/01-person1-to-person2.md) before implementing the engine. The final Person 1 release is tagged `p1-done`.

## Engine Phase 1

`src/engine/process-manager.js` spawns shell commands with the configured cwd and environment, emits starting/log/exit events, and retains the last 20 log lines. POSIX shutdown signals the whole process group and escalates from SIGTERM to SIGKILL. Windows shutdown uses `taskkill /T /F` to stop the process tree. Shutdown awaits process death and pipe cleanup; normal engine process exit has a synchronous cleanup fallback.

`require('./src/engine')` exports `getRunning()` and `stopAll({graceMs = 3000})`. Phase 1 introduced concurrent process cleanup; Phase 3 adds startup cancellation and shutdown by reverse dependency level. The [saved agent rules](handover/AGENT_RULES.md) apply to subsequent phases.

## Engine Phase 2

`src/engine/readiness.js` exports `isPortOpen`, `httpOk`, `waitForReady`, and `preflightPort`. Port readiness connects to 127.0.0.1. HTTP/HTTPS readiness accepts only 2xx status headers, closes the response body and request, and preserves HTTPS certificate validation. Readiness polling has an overall deadline and short probe deadlines; abort and process exit interrupt both active probes and sleeps.

The runners call preflightPort before the initial spawn to reject an already busy readiness port, then call waitForReady immediately after spawning. Preflight is not used on restarts. See the [Phase 2 handover](handover/02-person2-phase2.md) for error messages and cleanup ownership.

## Engine Phase 3

`runEngine({services, groups, algorithm, maxParallel = Infinity, emitter})` validates its inputs before spawning and defaults emitter to a Node EventEmitter. Sequential starts services in flattened level order and waits for each to become ready. Parallel uses a worker pool within each level and waits for the entire level before advancing. Each worker holds its slot until readiness.

Successful runs emit run:done and return `{algorithm, effectiveAlgorithm, totalMs, readyMs, pids}` while services continue running. Failed runs cancel pending startups, drain workers, stop started services, emit run:failed, and reject. stopAll also cancels ongoing startup and stops deepest levels first, with peers on each level stopped concurrently. A second run is rejected until the current services are stopped.

## Engine Phase 4

Adaptive calls the existing graph analysis and emits `adaptive:decision {width, depth, chosen, reason}` immediately after run:start, before service events. It runs the chosen runner with the supplied startup cap. The returned algorithm remains `adaptive`; effectiveAlgorithm reports `sequential` or `parallel`.

The first spawn, timeout or crash failure owns the failure events. It aborts peer readiness waits, blocks queued services and dependents, and emits service:failed once for the root cause. All parallel workers settle before `stopAll({graceMs:1000})` stops the started process trees. After cleanup, run:failed carries the root error message as a string, and runEngine rejects the original EngineError with its reason and serviceName. Later peer failures are silent. Crashes after readiness, restart policies and down/PID persistence remain for subsequent phases.

## Engine Phase 5

`stopAll({graceMs = 3000})` returns one shared promise to concurrent callers. It publishes that promise before aborting startup, so a reentrant abort listener joins the same shutdown. It waits for startup workers to finish, snapshots all owned handles including not-ready services, groups them by descending level, and terminates peers concurrently with a barrier between levels. If an OS termination fails, it still drains peers and attempts remaining levels before rejecting. Normal shutdown emits exactly one service:exited event per spawned service.

CLI signal handlers remain installed during shutdown so a second signal can call killAllSync and exit with the first signal's code. Expected signal cancellation prints no failure diagnostic. Graceful completion removes signal/fatal-event listeners and the CLI keep-alive timer. Fatal events are deduplicated when strict rejection mode reports the same error twice, and exit after best-effort cleanup even if unrelated handles remain alive.

## Engine Phase 6

`up` records its owner and service leaders atomically in `./.serviceboot/pids.json`, updates entries after replacements, and removes the file after clean shutdown. `down` uses that record from the same working directory, without needing a config. It stops a live CLI or recovers orphan service trees after a hard kill, deepest dependency levels first. An active owner blocks another `up`; a stale owner produces a warning and cleanup before startup continues. A recycled PID in a stale record could be killed by mistake.

`restart: on-failure` uses `max_retries` as a lifetime replacement budget, shared by startup and later crashes. Each retry emits `service:restarting`, waits 500 ms times its attempt number, and checks readiness again. A clean code-zero exit is not restarted. Exhaustion before readiness fails and cleans the startup; exhaustion after readiness leaves that service down while siblings and dependents retain their processes. Shutdown interrupts backoff and prevents respawning. Try `samples/restart.yml` to see two replacements alongside a healthy sibling.

The engine also exports `getTreePids(pid)` for CPU/memory collection. A service PID identifies its shell/group leader; inspect its full descendant tree for useful metrics. `result.pids` is a startup snapshot and can be stale after restarts; `getRunning()` supplies current leaders. See [CONTRACT section 9](CONTRACT.md#9-additions-by-person-2) and the [Person 2 → Person 3 handover](handover/02-person2-to-person3.md) for APIs, events, verification and remaining platform checks.
