# Handover: Person 2 → Person 3

Date: 2026-10-12. Node 22.16.0 on Windows. Engine phases 1–6 are implemented.
Read [CONTRACT.md](../CONTRACT.md) and [AGENT_RULES.md](AGENT_RULES.md).
Contract sections 1–8 and the protected acceptance tests/helpers were preserved;
Phase 6 additions are listed in contract section 9. No dependencies were added.

## Continue here

```sh
npm test
npm run test:engine
node bin/serviceboot.js plan --config samples/wide.yml
node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel
node bin/serviceboot.js down
node bin/serviceboot.js up --config samples/restart.yml
```

Run `down` in another terminal from the same working directory as `up`. The
restart sample uses ports 4131/4132; it replaces the crashing mock twice and
leaves its healthy sibling running. Ctrl+C or down stops that sibling too.

## APIs and events

`require('../src/engine')` exports:

- `runEngine({services, groups, algorithm, maxParallel = Infinity, emitter})`
  resolves `{algorithm, effectiveAlgorithm, totalMs, readyMs, pids}`. Services
  stay running. Sequential/parallel/adaptive obey the contract's level barriers.
- `stopAll({graceMs = 3000}) -> Promise<void>` cancels startup and recovery,
  drains pending work, then stops deeper levels before dependencies. Concurrent
  callers share a promise; repeat calls are safe.
- `getRunning() -> [{name, pid, level}]` supplies currently live service leaders.
- `getTreePids(rootPid) -> Promise<number[]>` supplies a leader and all descendants
  from one process snapshot. It uses POSIX ps or Windows PowerShell CIM, with a
  five-second command timeout. An absent root is still included; check liveness
  when consuming a snapshot.

PID means the process-group leader, usually a shell wrapper. Measuring only it
misses the actual Node service's CPU/memory. Use getTreePids and aggregate the
tree. result.pids and readyMs are startup snapshots; a successful early retry
appears in the initial result, but later replacements do not mutate it. Use
getRunning for current leaders and service:starting/ready for live UI updates.

The nine original events remain exactly as contract section 6 specifies. Every
payload has `ts` from performance.now(). The new tenth event is:

```js
service:restarting {name, attempt, maxRetries, code, signal, ts}
```

It follows old-tree cleanup and announces an interruptible backoff before the
next service:starting. Attempts start at 1 and consume a lifetime budget shared
by startup and later crashes. Backoff is 500 ms × attempt. A replacement checks
readiness again, without preflight. Startup crash exhaustion fails the run and
cleans all started services. After readiness, exhaustion leaves only that service
down and emits service:failed/crash; siblings and dependents keep their processes.
Dependents are NOT restarted. Code-zero exits and exits from our own shutdown
never restart. Replacement spawn/timeout failures end that service's recovery
with their respective reason. Recovery emits no additional run:done/run:failed.

## Phase 6 additions

- `src/engine/pidfile.js`: synchronous write/addService/read/remove, with optional
  cwd. Atomic temporary-file/rename publication of `.serviceboot/pids.json` stores
  `{cliPid, startedAt, config, services:[{name,pid,level}]}`. Restarts replace
  entries by name. Owner checks protect updates/removal of a newer run's file.
- CLI `down` needs no config/options. Internal `src/engine/down.js` exports
  `down({cwd}?) -> Promise<boolean>`. A live CLI receives POSIX SIGTERM or Windows
  taskkill /T /F; down waits for cleanup/file removal, with a ten-second deadline.
  A crashed CLI is recovered from saved services, deepest levels first. The final
  record is reread after a live owner dies to include recent replacements.
  Nothing running prints `Nothing to stop` and exits 0; runtime/IO errors exit 3.
- CLI up rejects an active saved cliPid with the exact contract-section-9 message.
  A stale record warns, cleans its remaining service trees, and then proceeds.
  Clean shutdown removes the owned file; partial cleanup failures retain it.
- `src/engine/recovery.js` owns retry state and exports internal launch, shared by
  runners and runtime recovery. The live context tracks recovery tasks so stopAll
  cancels and drains them before taking its shutdown snapshot.
- The process manager also exports internal isPidAlive/requestCliStop. Windows
  cleanup discovers descendants of a dead shell from CIM parent IDs; taskkill
  cannot follow a dead shell by itself. Synchronous force-stop batches owned
  targets in one taskkill invocation and clears completed ownership entries.
- `samples/restart.yml`, four CLI down process tests, seven recovery process tests,
  a parent/grandchild metrics test, and five new unit cases verify these features.
  Directory test entry points load the new files. `.serviceboot/` is Git-ignored.

## Limits and remaining platform checks

A recycled PID in a stale record could be killed by mistake. There is no lock
serializing simultaneous up invocations: the guard checks a published PID file.
Use one working directory per run. Malformed metadata fails without discarding
the record. Windows SIGTERM cannot be delivered as a console signal, so down
uses forced tree termination there. POSIX ps/process-group/SIGTERM branches and
Node 18 compatibility still need execution on their respective platforms; this
Phase 6 verification ran on Windows/Node 22 only.

The supplied native POSIX CLI SIGINT acceptance case is skipped on Windows.
Separate real-engine Windows callback tests cover graceful/forced signal handlers;
the Phase 5 handover records the earlier native console Ctrl+C checks.

UI styling, CPU/memory sampling and benchmarking are Person 3's work. Keep the
startup result/event shapes, exact adaptive reasons and readiness barriers. Stop
the engine before another run; pass one emitter for logs and recovery events.

## Verification

Final commands ran with `NODE_OPTIONS=--unhandled-rejections=strict` and
ENGINE_PATH unset against the shipped engine. Both exited 0, without warnings or
unhandled rejections. Actual final TAP summaries:

```text
npm test:
# tests 172
# suites 0
# pass 168
# fail 0
# cancelled 0
# skipped 4
# todo 0
# duration_ms 37233.5254

npm run test:engine:
# tests 32
# suites 0
# pass 31
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 114059.7723

Leftover mock-service processes: 0
Leftover ServiceBoot CLI processes: 0
Root PID file present: False
```

See [full unit output](verification/engine-phase6-unit-verified.txt),
[full engine output](verification/engine-phase6-engine-verified.txt) and
[actual post-run inspection](verification/engine-phase6-cleanup.txt). The process
tests also assert death of observed descendant PIDs and finish by themselves.
Earlier investigation transcripts remain in verification/engine-phase6-*.txt.
The protected acceptance suite and its timing thresholds were not edited.

The first investigation found Windows orphan mocks behind dead shell PIDs;
cleanup now uses CIM to reach those descendants. Another check identified the
restart event preceding cleanup, so it now marks actual backoff. A full-suite
forced-stop timing failure led to batching taskkill targets. A new timed CLI PID
fixture failed once with a missing record; four isolated repeats passed. Its
final fixture triggers the crash explicitly after discovery instead of relying
on a wall-clock exit timer, and captures CLI output if metadata disappears.
