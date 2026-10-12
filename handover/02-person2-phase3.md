# Person 2: Phase 3 sequential and parallel engine

Date: 2026-10-12. Continue to follow CONTRACT.md and AGENT_RULES.md. The contract, saved rules, engine acceptance test and test/helpers files are unchanged. No dependencies were added; no CONTRACT section 9 was added.

## Implementation

src/engine/runners.js exports `startOne(service, ctx)`, `runSequential(services, groups, ctx)` and `runParallel(services, groups, maxParallel, ctx)`. ctx is internal engine state: levels Map, safe emit, aborted flag, AbortController, readyMs/pids maps, failure and abort(error). The public src/engine/index.js exports remain runEngine, stopAll and getRunning.

startOne checks cancellation, preflights the port, checks cancellation again, spawns, waits ready with the run's abort signal, checks cancellation before reporting readiness, emits service:ready and records elapsed readiness/PID values. A failed service emits service:failed with reason and error.message, except aborted waits, then rethrows. Level numbers come from the original groups. Preflight and readiness retain their Phase 2 behavior.

Sequential uses flatten(groups) and awaits each startup. Parallel uses one pool per level, sized min(maxParallel, level size). Slots cover spawn through readiness, not the lifetime of the running service. A slot freed by readiness can start another peer; the next level waits for EVERY service in the current level. Workers stop dequeuing immediately on cancellation. Promise.allSettled drains all workers on first failure before cleanup, preventing late spawns and unobserved peer rejections.

runEngine validates algorithms, caps and group membership before events or spawning. It rejects duplicate names too, preventing an invalid plan from double-spawning a service. It checks own service properties rather than inherited keys. A default EventEmitter is provided. Invalid options reject TypeError; a running service, active startup or ongoing shutdown rejects `Engine already running; call stopAll() first` without stopping the existing run. Callers supply normalized services/groups from loadPlan.

Events: run:start `{algorithm, total}` precedes startup; service:starting/log/exited still come from the process manager; service:ready `{name, pid, ms}` and service:failed `{name, reason, error: message}` come from runners; success emits run:done `{algorithm, effectiveAlgorithm, totalMs}`; failure emits run:failed `{error}` after cleanup. Safe emit adds ts on every payload. The effectiveAlgorithm equals the selected sequential/parallel algorithm. Success resolves `{algorithm, effectiveAlgorithm, totalMs, readyMs, pids}` and leaves services running. The result maps have null prototypes to support names such as __proto__ safely.

Adaptive is validated but deliberately throws the existing NOT IMPLEMENTED message after run:start, emits run:failed, and spawns nothing. Phase 4 will replace this branch with analyze(groups), adaptive:decision and dispatch to the existing runners. The CLI defaults to adaptive, so users must select sequential or parallel until then.

stopAll now aborts startup, waits for the worker-drain promise, and stops dependency levels deepest first. Peers at a level terminate concurrently; their exits finish before dependencies are signaled. Overlapping shutdown calls share cleanup. Waiting for worker drainage rather than the whole runEngine promise avoids a deadlock, since runEngine must itself wait for shutdown before rejecting. A completed shutdown releases the startup guard so a new run may begin. Terminal failure preserves the first error; an unexpected cleanup failure is also attached as error.cleanupError.

The per-run AbortSignal listener limit allows a wide parallel level to share cancellation without the default ten-listener warning. Readiness still removes its listeners at completion; this does not change process/global listener limits.

## Verification actually run

Windows, Node v22.16.0. Real process tests ran with permitted socket and taskkill access. The test runners exited on their own. Linux/macOS and Node 18 were not run.

The EXACT requested command:

```sh
node --test --test-name-pattern="ORDERING|NO OVERLAP|CONCURRENT|MAX-PARALLEL|DOUBLE-SPAWN" test/engine/
```

Actual output summary (exit 1):

```text
# tests 10
# pass 8
# fail 2
# skipped 0
# duration_ms 15770.0068
```

Only these Phase 4 cases failed:

```text
ORDERING: adaptive on diamond waits for every dependency
ORDERING: adaptive on wide waits for every dependency
error: NOT IMPLEMENTED: Person 2 implements this (see CONTRACT.md section 5)
```

All requested sequential/parallel cases passed. [Complete exact-command output](verification/phase3-requested.txt).

Then set NODE_OPTIONS to `--unhandled-rejections=strict` and ran:

```sh
node --test --test-name-pattern="ORDERING: (sequential|parallel)|NO OVERLAP|CONCURRENT|MAX-PARALLEL|DOUBLE-SPAWN|CRASH DURING STARTUP|READY TIMEOUT|DEPENDENT NOT STARTED|STOPALL|SIGKILL ESCALATION" test/engine/
```

Actual output (exit 0):

```text
# tests 13
# pass 13
# fail 0
# skipped 0
# duration_ms 19263.642
```

This includes the startup crash target, readiness timeout, blocked dependent, reverse shutdown and stubborn-process termination in addition to ordering, concurrency, cap and no-double-spawn cases. [Complete strict engine output](verification/phase3-strict-engine.txt).

`npm test` also ran with NODE_OPTIONS=`--unhandled-rejections=strict`, exit 0:

```text
# tests 155
# pass 151
# fail 0
# skipped 4
# duration_ms 15425.316
```

[Complete strict unit output](verification/phase3-unit.txt). Eleven new runner tests cover validation before spawning, default emitter, pool slots/level barrier, first-failure cancellation and event suppression, pre-aborted starts, startup guard/cancellation during preflight, special names, running-service guard, real spawn-error cleanup and HTTP/none integration. Existing CLI sample checks now boot sequential/parallel and assert three starts, ready events and exits.

Scanning both strict logs produced:

```text
Strict engine and unit logs: 0 warnings or unhandled rejections.
```

Requested Windows inspection after all tests:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object CommandLine -like '*mock-service*'
```

No rows; the assertion printed:

```text
Leftover mock-service processes: 0
```

## Test migrations and continuation

The old CLI stub assumptions are obsolete for sequential/parallel. The default adaptive CLI test still verifies exit 3 and the exact NOT IMPLEMENTED message, but now verifies run:start/run:failed output. The no-options runEngine test now expects its required TypeError. Algorithm acceptance still checks all three algorithms and positive caps; sequential/parallel expect successful real startup and cleanup, adaptive expects the Phase 4 stub. No protected assertions were changed. The Phase 1 shutdown unit test's title now says “all levels” because its three processes are at different levels; its cleanup assertions are unchanged.

Next: Phase 4 adaptive dispatch. Restart handling, sustained crash supervision after readiness, down/PID persistence, UI/metrics/benchmarks and POSIX execution verification remain outside Phase 3. Do not present all engine acceptance cases as green until adaptive and remaining lifecycle phases have been implemented and run.
