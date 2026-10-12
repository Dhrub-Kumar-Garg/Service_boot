# Engine test helpers

Import helpers with `require('../helpers')` from engine tests.

- `freePort()` listens on `127.0.0.1:0`, reads the assigned port, then closes the server. The returned port is free, not reserved; run acceptance tests serially.
- `await makeServices(specs)` creates complete contract Service objects using the real mock service and distinct free ports. Specs accept `name`, `deps` (default `[]`), `delay` (default `300`), and `extraArgs` (default `[]`). It returns `{ services, groups }`, with levels computed by `topoLevels`. Tests can override a returned service's timeout.
- `record(emitter)` records contract events as `{ name, payload, i }`, where `i` is arrival order. `find(eventName, serviceName?)` returns the first match; `filter(eventName, serviceName?)` returns all matches. `maxInFlight()` counts services started but not yet ready or failed.
- `isAlive(pid)` probes a positive PID using `process.kill(pid, 0)`.
- `waitDead(pids, timeoutMs = 3000)` accepts an array of PIDs or the result's `pids` object. It polls every 50 ms and resolves `true` once all PIDs are dead, otherwise `false` at the deadline.

`npm run test:engine` loads `src/engine/index.js` by default. To verify another implementation, set `ENGINE_PATH` to its absolute path (or a path relative to the shell's working directory). For example, on macOS/Linux: `ENGINE_PATH=/tmp/reference-engine.js npm run test:engine`. In PowerShell: `$env:ENGINE_PATH='C:\temp\reference-engine.js'; npm run test:engine`; remove the override afterwards with `Remove-Item Env:ENGINE_PATH`.

The CLI SIGINT test preloads `engine-preload.js` when an override is present, so it exercises the same selected engine through the real CLI. No production module is edited. All acceptance cases have a 30-second timeout. Teardown always calls `stopAll({ graceMs: 500 })`; a final cleanup kills any surviving observed test PID so failed implementations do not leave test processes running. OS SIGINT testing is skipped on Windows.
