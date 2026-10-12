# Person 2: Phase 2 readiness checks

Date: 2026-10-12. Read CONTRACT.md, AGENT_RULES.md and the Person 1 handover before continuing. Phase 1 process management is unchanged. No dependency or protected test changes; CONTRACT.md sections 1–8 are unchanged and no section 9 was added. This is a checkpoint for the next engine phase, not the final Person 3 handover.

## Implemented API

All exports are CommonJS named exports from src/engine/readiness.js:

| Export | Result and behavior |
| --- | --- |
| `isPortOpen(port, host = '127.0.0.1', timeoutMs = 500)` | Promise of boolean; net.connect, always destroys the socket and clears the probe timer |
| `httpOk(url, timeoutMs = 1000)` | Promise of `{ok, detail}`; 2xx only; detail includes HTTP status, connection refused, timeout, or another transport error message |
| `waitForReady(service, {handle, signal})` | Promise of elapsed milliseconds measured from the call; none returns zero immediately |
| `preflightPort(service)` | Rejects busy port readiness checks before initial spawn; skips non-port checks |

HTTP and HTTPS use separate sockets per probe (`agent: false`). The status headers establish readiness; response bodies are destroyed rather than awaited. Redirects are not followed. HTTPS retains normal certificate and hostname validation. The parser already accepts HTTPS URLs; after the user answered “do the best possible thing” to the scope clarification, Phase 2 includes Node's built-in node:https. It adds no package dependency, and the verbatim AGENT_RULES.md file is unchanged.

waitForReady probes immediately and sleeps intervalMs between failed probes. Each probe is capped by `min(1000, intervalMs * 2, remainingDeadlineMs)`. Both active probes and sleep are canceled on abort or process exit. The loop checks exit/abort again before accepting a successful probe and rejects results arriving after the overall deadline.

Errors are EngineError with serviceName and these reasons/messages:

```text
crash:   exited with code X before becoming ready
         <last five available log lines, each on its own line>
aborted: readiness wait aborted
timeout: not ready after <timeoutMs>ms (last check: <detail>)
spawn:   Port N is already in use (is a previous run still alive? try "serviceboot down")
```

Call preflightPort only on initial starts, then spawnService, then waitForReady immediately after spawn. A port probe establishes whether a listener accepts connections, not which process owns it; the preflight rejects a listener that was already present. A port can still race between preflight and spawn, so this is not an OS port reservation. The down command mentioned by the required diagnostic is not implemented yet.

Readiness owns and cleans only its probes, timers and listeners. It does not terminate the service or emit ready/failed events. The future runEngine must do that, and must stop all started processes before rejecting terminal failures. Normalized service values are supplied by the existing parser/validator.

## Cleanup

Sockets and requests are destroyed on success, error, timeout and interruption. HTTP response bodies are destroyed too. Probe error listeners remain through transport close to absorb queued destruction errors, then are removed. Abort listeners and timers are removed on every completion path.

The handle.exited Promise is subscribed once per wait, not once per polling iteration. Promises cannot remove a .then reaction, so cleanup clears its callback to release the wait's state; a still-live handle retains only an empty subscription. One internal AbortController wakes active probes and sleeps for either user abort or process exit. Type none bypasses probes and subscriptions entirely.

## Actual verification

Windows, Node v22.16.0. Tests ran with permitted local socket/process-tree access, using the same permission approach established in Phase 1. No Phase 2 test failures occurred. Linux/macOS and Node 18 were not run.

Initial isolated readiness run (19 tests, before adding the stalled-TCP cancellation and real-crash tests): all 19 passed, exit 0. [Full isolated output](verification/phase2-readiness.txt).

Final `npm test` (exit 0, runner exited on its own):

```text
# tests 144
# suites 0
# pass 140
# fail 0
# cancelled 0
# skipped 4
# todo 0
# duration_ms 9693.7828
```

[Full final unit output](verification/phase2-unit.txt). All 21 new readiness tests pass; the four skips are unchanged existing Windows signal/POSIX cases.

Coverage includes port success/refusal/timeout, delayed port opening at 300 ms, never-ready deadlines, 503-to-200 polling, persistent HTTP 500 diagnostics, hanging headers, unfinished bodies, last-five-line crash diagnostics, exit/abort during sleeps and HTTP probes, cancellation of a stalled TCP probe, pre-aborted signals, immediate none readiness, busy/free preflight ports, real delayed and crashing mock processes, and HTTPS rejection/acceptance with a local test certificate. Tests track peer socket closure, check abort-listener removal, clean fixture servers/timers, and verify the process registry is empty after real mock cleanup.

The checked-in HTTPS certificate/key are disposable public fixtures used only on loopback. Tests first confirm rejection of the self-signed certificate, then inject its CA only inside the test. OpenSSL was used to generate the fixture and is not required to run the tests. See the [fixture notes](../test/unit/engine-readiness-fixtures/README.md).

`npm run test:engine` was not rerun in this phase: runEngine remains the unchanged NOT IMPLEMENTED stub. Prior acceptance output is saved in the Phase 1 handover. No algorithms, retries, reverse-level shutdown, startup cancellation integration, down, UI, metrics or benchmarks were implemented in Phase 2.
