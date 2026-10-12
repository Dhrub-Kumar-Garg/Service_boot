# Person 2: Phase 4 failures and adaptive execution

Date: 2026-10-12. Read CONTRACT.md, AGENT_RULES.md and the Person 1 handover before continuing. The contract, saved rules, protected acceptance test and test/helpers files are unchanged. No dependencies or public exports were added.

## Implementation

`src/engine/index.js` still exports runEngine, stopAll and getRunning. `src/engine/runners.js` still exports startOne, runSequential and runParallel. Input validation, level numbering, startup caps and the running-engine guard retain their Phase 3 behavior.

For adaptive, runEngine calls analyze(groups) from src/graph/adaptive.js, emits adaptive:decision with exactly `{width, depth, chosen, reason}` plus ts, and dispatches the chosen runner. The reason is copied verbatim from analyze. Event order is run:start, adaptive:decision, then service events. Success returns `{algorithm, effectiveAlgorithm, totalMs, readyMs, pids}`; algorithm remains adaptive and effectiveAlgorithm is the chosen runner. Services stay running on success.

startOne claims a startup failure by storing it in ctx.failure and aborting the shared AbortController before emitting service:failed. JavaScript runs this section synchronously, so only one worker can claim the failure. Other workers see ctx.aborted and reject with reason aborted without emitting service:failed, even if their own probe has also reported a crash or timeout. Queued startups and later dependency levels cannot begin. Aborted waits remove their readiness listeners and close active probes as in Phase 2.

Parallel retains its Promise.allSettled barrier, observing every worker rejection and draining any spawn or preflight already in progress. runEngine preserves ctx.failure instead of selecting an error by worker declaration order. It awaits stopAll({graceMs:1000}), emits run:failed `{error: failure.message}` after cleanup, then rejects the original EngineError with the root reason and serviceName. Both failure event error fields are strings. If cleanup itself unexpectedly fails, that error is attached as cleanupError without replacing the startup cause.

Existing process-manager/readiness behavior detects a process exiting between spawn and readiness as reason crash, including its last five tail lines. Services whose dependency failed never emit service:starting. stopAll still waits for worker drainage rather than the entire runEngine promise, preventing the cleanup/rejection deadlock. Its public default grace remains 3000 ms; automatic startup-failure cleanup uses 1000 ms. POSIX uses process-group signals and escalation; Windows uses taskkill /T /F.

## Verification actually run

Windows, Node v22.16.0. All five test invocations used NODE_OPTIONS=`--unhandled-rejections=strict`, with permitted loopback socket and Windows process-tree cleanup access. The runners finished by themselves.

The exact requested command ran three times:

```sh
node --test --test-name-pattern="ORDERING|ADAPTIVE|CRASH|TIMEOUT|DEPENDENT" test/engine/
```

Actual output summaries, all exit 0:

```text
Run 1:
# tests 11
# pass 11
# fail 0
# skipped 0
# duration_ms 16848.7998

Run 2:
# tests 11
# pass 11
# fail 0
# skipped 0
# duration_ms 15786.3206

Run 3:
# tests 11
# pass 11
# fail 0
# skipped 0
# duration_ms 15795.4514
```

Complete output: [run 1](verification/phase4-targeted-1.txt), [run 2](verification/phase4-targeted-2.txt), [run 3](verification/phase4-targeted-3.txt). Each includes all six ORDERING cases, both ADAPTIVE cases, startup CRASH, READY TIMEOUT and DEPENDENT NOT STARTED.

`npm test`, exit 0:

```text
# tests 158
# pass 154
# fail 0
# skipped 4
# duration_ms 19302.458
```

[Complete unit output](verification/phase4-unit.txt). Four platform skips cover Windows limitations in existing signal/process checks. Updated obsolete adaptive-stub assumptions in runner/CLI tests to assert successful decisions, startup and cleanup. A real failing-cwd CLI check preserves runtime exit-code-3 coverage. New deterministic unit cases reject two peer probes together to verify first-failure arbitration independent of declaration order, and release a peer's pending preflight after root failure to verify it never spawns. The existing real spawn-error case also checks that run:failed follows service:exited.

`npm run test:engine`, exit 0:

```text
# tests 18
# pass 17
# fail 0
# skipped 1
# duration_ms 27273.7398
```

[Complete engine output](verification/phase4-engine.txt). All runnable acceptance cases pass, including concurrency/speed, maxParallel, reverse shutdown, stubborn-process termination and double-spawn protection. The real CLI SIGINT case is skipped on Windows by the existing protected test.

Scanning all five strict test logs and inspecting Windows processes after all runs produced:

```text
Leftover mock-service processes: 0
All five strict test logs: 0 warnings or unhandled rejections.
```

The process inspection used:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object CommandLine -like '*mock-service*'
```

It returned no rows. Protected-file diff checks pass. No process.platform branch was introduced outside the process manager.

## Continuation

Phase 4 is complete. Post-readiness crash supervision, restart/on-failure retry behavior, down/PID persistence and UI/metrics/benchmarking remain beyond this phase. Linux/macOS and Node 18 were not executed here; a green Windows acceptance suite does not verify those platform-specific paths.
