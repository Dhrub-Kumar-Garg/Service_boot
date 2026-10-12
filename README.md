# ServiceBoot

A Node.js OS lab CLI that reads `serviceboot.yml`, validates services, and plans their startup in dependency levels. Person 1's foundation and Person 2's process manager and readiness checks are complete. Sequential, Parallel, and Adaptive execution will be implemented in later engine phases.

Requires Node.js 18+. Plain JavaScript (CommonJS), no build step; `js-yaml` is the only direct runtime dependency.

## Install and check

```sh
npm install
npm test
npm run test:engine
```

Phase 2 verification on Windows with Node 22.16.0: `npm test` has 144 tests, 140 passing and four platform skips. All 21 readiness tests pass. `runEngine` remains `NOT IMPLEMENTED`; the engine acceptance suite is the target for later phases. Process-tree tests require permission to run Windows `taskkill`; this workspace's sandbox denies it. See the [Phase 2 handover and actual output](handover/02-person2-phase2.md) and [Phase 1 process manager handover](handover/02-person2-phase1.md).

## Commands

```sh
node bin/serviceboot.js plan --config samples/wide.yml
node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel
```

`plan` works now; add `--json` for the complete plan. `up` currently exits 3 with the engine stub message. Defaults are `./serviceboot.yml` and algorithm `adaptive`; `up` also accepts `--max-parallel N` and `--exit-after-ready`. Use `--help` for usage.

## Folder map

| Path | Purpose |
| --- | --- |
| `bin/`, `src/cli/` | CLI entry point, argument parsing, plain output, signal wiring |
| `src/config/` | YAML parsing, validation, normalized Service objects |
| `src/graph/`, `src/plan.js` | DAG, cycles, deterministic levels, adaptive analysis |
| `src/engine/` | Process spawning, logs, tree termination, safe events, TCP/HTTP/HTTPS readiness; `runEngine` remains a stub |
| `mock/`, `samples/` | Real TCP/HTTP mock and five example configurations |
| `test/unit/` | Foundation, CLI, mock, and helper tests |
| `test/engine/`, `test/helpers/` | Engine acceptance tests and process helpers |
| `handover/` | Continuation guide and real verification output |

Read [CONTRACT.md](CONTRACT.md) and the [Person 1 → Person 2 handover](handover/01-person1-to-person2.md) before implementing the engine. The final Person 1 release is tagged `p1-done`.

## Engine Phase 1

`src/engine/process-manager.js` spawns shell commands with the configured cwd and environment, emits starting/log/exit events, and retains the last 20 log lines. POSIX shutdown signals the whole process group and escalates from SIGTERM to SIGKILL. Windows shutdown uses `taskkill /T /F` to stop the process tree. Shutdown awaits process death and pipe cleanup; normal engine process exit has a synchronous cleanup fallback.

`require('./src/engine')` now exports `getRunning()` and a basic `stopAll({graceMs = 3000})` that stops managed processes concurrently. Reverse dependency shutdown, startup cancellation, and the algorithms are still pending. The [saved agent rules](handover/AGENT_RULES.md) apply to subsequent phases.

## Engine Phase 2

`src/engine/readiness.js` exports `isPortOpen`, `httpOk`, `waitForReady`, and `preflightPort`. Port readiness connects to 127.0.0.1. HTTP/HTTPS readiness accepts only 2xx status headers, closes the response body and request, and preserves HTTPS certificate validation. Readiness polling has an overall deadline and short probe deadlines; abort and process exit interrupt both active probes and sleeps.

Call preflightPort before the initial spawn to reject an already busy readiness port, then call waitForReady immediately after spawning. Preflight is not used on restarts. These helpers are verified independently; integration into runEngine, reverse dependency shutdown, startup cancellation, and algorithms comes in later phases. See the [Phase 2 handover](handover/02-person2-phase2.md) for error messages and cleanup ownership.
