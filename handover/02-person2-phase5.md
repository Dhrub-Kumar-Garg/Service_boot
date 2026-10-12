# Person 2: Phase 5 shutdown and signals

Date: 2026-10-12. Follow CONTRACT.md, AGENT_RULES.md and the Person 1 handover. No contract, saved-rule, protected acceptance-test or test/helpers changes. No dependency additions. Public engine exports remain runEngine, stopAll and getRunning; CLI exports remain main. Process-manager exports are unchanged.

## Implementation

stopAll is a promise-returning function rather than an async wrapper, so simultaneous callers receive the identical promise. It installs shutdownOperation before aborting the active context; synchronous abort listeners therefore cannot start a second shutdown. The first caller's grace period owns the shared operation. Invalid grace periods still reject TypeError.

Shutdown waits for ctx.startingDone, the worker-drain barrier, rather than the runEngine promise. runEngine itself waits for shutdown before rejecting; awaiting the whole run would deadlock. Cancellation stops queued work and interrupts probes. The shutdown snapshot includes spawned/not-ready services and owned process groups whose leader has exited. Handles are grouped by level in a Map and levels run deepest first. Promise.all terminates peers concurrently; each level finishes before the next begins. Per-handle error catches allow all cleanup attempts to finish before the first cleanup error is rethrown. Successful termination waits for process/group death and pipe cleanup as in Phase 1. Repeated calls after completion are safe. service:exited still comes only from the process manager's once exit listener.

The first SIGINT or SIGTERM during up awaits stopAll and returns 130 or 143. Windows cannot deliver SIGTERM as a console signal; this is documented in the CLI code comment. A second signal invokes killAllSync, then process.exit immediately, preserving the first signal's exit code even if the second signal has a different name. Forced shutdown skips asynchronous grace periods; synchronous OS tree-kill commands still take execution time.

CLI signal-cancellation rejects with reason aborted without printing an error or run:failed diagnostic. Shutdown can win the startup race without leaving its later rejection unobserved. A signal arriving before startup's scheduled microtask prevents that startup from being invoked. All graceful paths remove SIGINT, SIGTERM, uncaughtException and unhandledRejection listeners, emitter listeners and the keep-alive timer.

Fatal handlers print once and attempt stopAll, using killAllSync as fallback if cleanup rejects. They then exit 3 even if an unrelated timer is alive. Strict rejection mode can report one rejected promise through both fatal events; diagnostics and cleanup are deduplicated. Existing plain event formatting remains unchanged for ordinary runs.

## Verification actually run

Windows, Node v22.16.0. Completed automated checks used NODE_OPTIONS=`--unhandled-rejections=strict` and permitted loopback/taskkill access. Test runners finished by themselves after correcting the test-isolation issue below. Linux/macOS and Node 18 were not run.

The repository has 18 protected contract cases, not 12. Two new process-based signal callback cases bring the engine suite to 20. Protected case 17 uses POSIX child.kill('SIGINT') and intentionally skips Windows. The new cases exercise the real CLI/engine/process manager and ten wide-sample mocks, invoking Node's SIGINT callbacks in the child. They assert graceful/forced exit 130, dead observed PIDs, and shutdown within five seconds of the interrupt, separately from startup time. Console keyboard delivery was checked independently below.

Requested targeted command, exit 0:

```sh
node --test --test-name-pattern="STOPALL|SIGKILL|CLI SIGINT" test/engine/
```

```text
# tests 5
# pass 4
# fail 0
# skipped 1
# duration_ms 8798.2358
```

[Complete targeted output](verification/phase5-targeted.txt).

Requested whole engine command, exit 0:

```sh
node --test test/engine/
```

```text
# tests 20
# pass 19
# fail 0
# skipped 1
# duration_ms 33597.0794
```

[Complete engine output](verification/phase5-engine.txt). All runnable contract cases pass. The one skipped case is the existing Windows SIGINT skip. The earlier [contract-only targeted run](verification/phase5-targeted-contract.txt) passed two with one skip; the earlier [contract-only full run](verification/phase5-engine-contract.txt) passed 17 with one skip.

`npm test`, exit 0:

```text
# tests 167
# pass 163
# fail 0
# skipped 4
# duration_ms 20000.6848
```

[Complete unit output](verification/phase5-unit.txt). New tests cover exact shared-promise identity, peer concurrency/level barriers, best-effort cleanup after an OS error, stopping not-ready services, startup abort, one exit per service, cancellation diagnostics/listener cleanup, second-signal force before a stalled cleanup finishes, fatal exception/rejection handling, non-Error rejection and cleanup-error fallback. The old repeated-signal test was migrated from ignoring the second signal to asserting kill-before-exit while still calling stopAll once. [Additional isolated signal verification](verification/phase5-signal-integration.txt) passed all eight cases before the two real-process cases were moved into test/engine as required by the saved rules.

Initial unit-test failure, retained in [the initial transcript](verification/phase5-unit-initial.txt):

```text
not ok 161 - stopAll includes not-ready services, aborts startup and emits one exit per process
error: 'pid must be a positive safe integer'
```

The preceding test mocked getManagedHandles twice. Restoring the second mock left the first mock installed, so the real-process test saw fake handles without PIDs. Fixed the test to mock once and change its local snapshot variable. Interrupted the stalled initial test run with Ctrl+C; process inspection then found zero mocks. The corrected full unit run passed and exited on its own. Protected tests and their timing bounds are unchanged.

## Console Ctrl+C checks

Ran this exact command in a Windows console twice:

```sh
node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel
```

Both runs reported Ready: 10 services. Sent Ctrl+C once on the first run, then two rapid Ctrl+C inputs on the second. Checked Windows Node command lines after each:

```text
After one Ctrl+C: leftover mock-service processes = 0
After two Ctrl+C presses: leftover mock-service processes = 0
```

[Complete raw console tool output](verification/phase5-console.json), including terminal control sequences. The interrupted PowerShell wrapper reports exit 1, which does not establish Node's exit code. Separate real-engine callback tests verify the Node exit code is 130 and the forced path invokes killAllSync; console cleanup checks verify zero mock processes after keyboard input.

Final inspection and log scan:

```text
Leftover mock-service processes: 0
Completed strict test logs: 0 warnings or unhandled rejections.
```

[Saved final checks](verification/phase5-checks.txt). Process inspection used Get-CimInstance Win32_Process with Name='node.exe' and CommandLine -like '*mock-service*'. Whitespace/protected-file checks pass. No process.platform branch was added outside src/engine/process-manager.js.

## Continuation

Phase 5 is complete for the requested shutdown/signal scope. Post-readiness crash supervision, restart/on-failure retries, down/PID persistence, UI/metrics/benchmarking and POSIX execution verification remain beyond this phase. Windows tree termination uses taskkill /T /F; this run does not prove POSIX graceful signal delivery or escalation.
