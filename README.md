# ServiceBoot

A Node.js OS lab CLI that reads `serviceboot.yml`, validates services, and starts them in dependency levels. Sequential and Parallel execution now use real processes and readiness checks. Adaptive execution is pending Phase 4.

Requires Node.js 18+. Plain JavaScript (CommonJS), no build step; `js-yaml` is the only direct runtime dependency.

## Install and check

```sh
npm install
npm test
npm run test:engine
```

Phase 3 verification on Windows with Node 22.16.0: `npm test` has 155 tests, 151 passing and four platform skips. All 13 selected sequential/parallel engine acceptance cases pass with `NODE_OPTIONS=--unhandled-rejections=strict`, with no warnings or leftover mock processes. Adaptive tests remain pending Phase 4. Process-tree tests require permission to run Windows `taskkill`; this workspace's sandbox denies it. See the [Phase 3 handover and actual output](handover/02-person2-phase3.md).

## Commands

```sh
node bin/serviceboot.js plan --config samples/wide.yml
node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel
```

`plan` works now; add `--json` for the complete plan. `up --algorithm sequential` and `up --algorithm parallel` boot services and leave them running; use `--exit-after-ready` to stop and exit after successful startup. `--max-parallel N` limits simultaneous startups until readiness. Defaults are `./serviceboot.yml` and algorithm `adaptive`, which currently exits 3 with `NOT IMPLEMENTED` until Phase 4. Use `--help` for usage.

## Folder map

| Path | Purpose |
| --- | --- |
| `bin/`, `src/cli/` | CLI entry point, argument parsing, plain output, signal wiring |
| `src/config/` | YAML parsing, validation, normalized Service objects |
| `src/graph/`, `src/plan.js` | DAG, cycles, deterministic levels, adaptive analysis |
| `src/engine/` | Sequential/parallel runners, process spawning, logs, tree termination, safe events, TCP/HTTP/HTTPS readiness |
| `mock/`, `samples/` | Real TCP/HTTP mock and five example configurations |
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

Successful runs emit run:done and return `{algorithm, effectiveAlgorithm, totalMs, readyMs, pids}` while services continue running. Failed runs cancel pending startups, drain workers, stop started services, emit run:failed, and reject. stopAll also cancels ongoing startup and stops deepest levels first, with peers on each level stopped concurrently. A second run is rejected until the current services are stopped. Adaptive dispatch, restart policies and monitoring crashes after readiness remain for subsequent phases.
