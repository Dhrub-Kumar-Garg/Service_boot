# Person 2: Phase 1 process manager

Date: 2026-10-12. This is a checkpoint for the next engine phase, not the final Person 3 handover.

Read [AGENT_RULES.md](AGENT_RULES.md), [CONTRACT.md](../CONTRACT.md), and [01-person1-to-person2.md](01-person1-to-person2.md) first. The user's global rules are saved verbatim. CONTRACT.md, the engine acceptance test, and all test helpers are unchanged. No dependencies were added.

## What exists

1. Config parsing and validation produce normalized service objects.
2. Graph code detects cycles and builds deterministic dependency levels.
3. Adaptive analysis and the plan CLI work; the wide sample selects parallel.
4. Real TCP/HTTP mocks, process helpers, and engine acceptance tests are present.
5. Phase 1 implements process management and basic shutdown; runEngine remains NOT IMPLEMENTED.

## Exports and choices

| Module | Exports / behavior |
| --- | --- |
| `src/engine/errors.js` | `EngineError(message, {reason, serviceName})`; extends Error, name EngineError, retains reason and serviceName |
| `src/engine/events.js` | `createEmit(emitter)` returns a timestamped emit function; copies payload, catches synchronous listener exceptions and logs them to stderr |
| `src/engine/process-manager.js` | `spawnService`, `createLineSplitter`, `isGroupAlive`, `terminate`, `terminatePid`, `killAllSync`, `getRunning`, internal `getManagedHandles` |
| `src/engine/index.js` | `runEngine` (unchanged stub), basic `stopAll({graceMs = 3000})`, `getRunning()` |

`spawnService(service, {level, emit})` resolves after the shell's spawn event to `{name, level, child, pid, hasExited, stopping, exited, tail}`. Pass `createEmit(emitter)` as emit. A bad cwd/shell spawn rejects EngineError with reason spawn. A missing command inside a valid shell instead spawns successfully, then exits nonzero.

`pid` is the spawned shell's PID and, on POSIX, its process group ID. stdout/stderr use UTF-8 decoding and independent line buffers. `createLineSplitter(onLine)` returns `{write(decodedString), end()}`; end is idempotent, flushes a nonempty remainder and ignores later writes. CRLF is normalized, empty lines are kept, and a lone CR is preserved. `tail` holds the last 20 strings in observed arrival order across both streams. Ordering is guaranteed within each stream; the OS does not supply a total ordering between stdout and stderr.

Implemented events are `service:starting {name, pid, level}`, `service:log {name, stream, line}`, and `service:exited {name, code, signal}`, all timestamped via createEmit. hasExited changes and getRunning drops the handle on exit; final partial log lines can arrive afterward on close. terminate also awaits close, so completion includes final logs and removal of engine pipe/lifecycle listeners.

The running registry contains non-exited handles. A separate ownership map retains POSIX groups whose shell exited while descendants survive. `getManagedHandles()` snapshots this internal map for stopAll; callers should use getRunning for public status. Concurrent termination calls for a PID share the same operation. Repeated terminate on an already cleaned handle returns without targeting a reused PID.

POSIX termination sends SIGTERM to `-pid`, awaits leader exit or the grace deadline, probes the whole group, sends SIGKILL if needed, and polls for group disappearance for at most 2000 ms. Unknown raw PIDs use polling during grace. Windows runs taskkill `/PID <pid> /T /F` and awaits completion and confirmed PID death. Unexpected OS errors propagate; a surviving group produces EngineError reason timeout. The first spawn installs one synchronous process exit hook; killAllSync covers every owned group/tree and reports cleanup failures to stderr.

Basic stopAll launches cleanup concurrently and awaits every attempt before reporting any failure. It deliberately does not yet implement reverse-level order or startup cancellation; those belong to later phases. No CONTRACT section 9 was added.

## Verification actually run

Environment: Windows, Node v22.16.0, npm 10.9.2, ENGINE_PATH unset. Linux, macOS, and Node 18 were not run.

Handover quick start:

```text
npm install
added 2 packages in 14s

npm test (exit 0)
# tests 106
# pass 103
# fail 0
# skipped 3
# duration_ms 5109.236

npm run test:engine (exit 1)
# tests 18
# pass 0
# fail 17
# skipped 1
# duration_ms 192.039

node bin/serviceboot.js plan --config samples/wide.yml (exit 0)
Config: samples/wide.yml  (10 services)
Start order (levels):
  Level 0: w1, w2, w3, w4, w5, w6, w7, w8
  Level 1: api1, api2
Graph analysis: depth=2 width=8
Adaptive decision: PARALLEL
Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution.
```

Full baseline output: [unit](verification/phase1-baseline-unit.txt), [engine](verification/phase1-baseline-engine.txt).

Final npm test, run with permitted process-tree access (exit 0):

```text
# tests 123
# suites 0
# pass 119
# fail 0
# cancelled 0
# skipped 4
# todo 0
# duration_ms 7952.1878
```

[Full final unit output](verification/phase1-unit.txt). This includes all 17 new tests: 16 pass and one POSIX-only test skips. Checks cover live/dead PIDs, overlapping termination, log framing and UTF-8 fragments, bounded tail, cwd paths with spaces, environment merging, real grandchild cleanup on Windows, the stubborn mock's 1.5-second bound, spawn failure, missing command, registered and unregistered raw-PID cleanup, repeated stopAll, and a normal engine process exit killing shell/service/grandchild. The process test runner exited on its own. [Earlier isolated process run](verification/phase1-process.txt) has 16 tests (15 pass, one skip); the unregistered raw-PID test was added afterward and verified in the final full run.

Final acceptance suite (exit 1), deliberately still red:

```text
# tests 18
# suites 0
# pass 0
# fail 17
# cancelled 0
# skipped 1
# todo 0
# duration_ms 193.5282
```

Every failure contains `NOT IMPLEMENTED: Person 2 implements this (see CONTRACT.md section 5)`. Failing names and complete error traces: [final engine output](verification/phase1-engine.txt). They are the six ORDERING cases; SEQUENTIAL NO OVERLAP; PARALLEL IS CONCURRENT AND FASTER; MAX-PARALLEL; two ADAPTIVE cases; CRASH DURING STARTUP; READY TIMEOUT; DEPENDENT NOT STARTED; STOPALL; SIGKILL ESCALATION; and NO DOUBLE-SPAWN. CLI SIGINT skips on Windows.

## Failures investigated

The first process-suite attempt failed at module loading with `ReferenceError: Cannot access 'getRunning' before initialization` at src/engine/index.js:17. The misplaced import was moved above module.exports before rerunning.

The next sandbox run could spawn services but Windows taskkill failed. Exact failed test names:

- spawned service is alive, registered, then dead after concurrent terminate calls
- terminate kills an ordinary grandchild as part of the service tree
- mock ignoring SIGTERM dies within 1.5 seconds of terminate with a 300 ms grace
- terminatePid stops a service by raw PID
- stopAll stops peers concurrently and tolerates repeated shutdown

Their errors included `taskkill failed for process 10232 (exit 1)` (other observed PIDs: 36544, 34792, 34764). The bad-cwd test also failed its empty-registry assertion because those denied cleanups left services alive. Direct diagnosis:

```text
taskkill /PID 10232 /T /F
ERROR: Access denied
```

Process inspection also returned Access denied inside the sandbox. Permitted inspection identified only this test's runner (PID 25940) and descendants. Permitted `taskkill /PID 25940 /T /F` successfully cleaned that tree, then the tests passed outside the sandbox. No timing bounds or protected tests were changed.

Final inspection found one additional Node orphan from the initial denied run, PID 34864 (parent PID 31352, the initial synchronous-exit test's shell). That early test asserted only shell death; the final test now asserts shell, service, and grandchild death, and killAllSync now checks taskkill failure status instead of ignoring it. Permitted `taskkill /PID 34864 /T /F` removed that confirmed test orphan. Reinspection found only the three unrelated Codex runtime Node processes (cua-repl and two server.mjs processes), with no ServiceBoot test processes remaining.

One existing CLI unit test assumed BOTH engine functions were stubs. It now verifies runEngine's exact stub rejection plus successful empty stopAll and an empty getRunning result. CLI validation and runtime error checks remain, including the other up/stub tests. test/unit/index.js loads the new engine-process suite.

## Continue here

Implement readiness and scheduling in subsequent requested phases; retain the Phase 1 process manager. Add startup cancellation and reverse-level shutdown before claiming CONTRACT section 5 is complete. Restart policies, down/PID-file persistence, algorithms, and readiness are not implemented here. Person 3's UI/metrics/benchmark work has not started.

Run the POSIX tests on macOS/Linux, especially a grandchild ignoring SIGTERM after its leader exits. Verify host reaping of orphaned processes: kill(0) can still see a zombie until the OS reaps it. Windows tests demonstrate ordinary live-parent tree cleanup; descendants left after a naturally exited Windows parent and intentionally detached descendants need additional lifecycle work. Raw terminatePid assumes the caller has established ownership; future down must protect against stale/reused PIDs. The exit hook runs on normal Node exit, not uncatchable SIGKILL; CLI catchable signal handling is wired but full runEngine integration remains pending.
