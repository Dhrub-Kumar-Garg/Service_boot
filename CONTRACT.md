# ServiceBoot Contract (shared by Person 1, 2, 3)

## 1. Config file (serviceboot.yml)
version: 1
services:
  <name>:                          # name matches /^[A-Za-z0-9_-]+$/
    command: "node app.js"         # required, non-empty string
    cwd: "./dir"                   # optional, relative to the config file's folder
    env: { KEY: value }            # optional, values converted to strings
    depends_on: [other, names]     # optional
    ready_check: "port 5432" | "http http://127.0.0.1:3000/health" | "none"   # optional, default none
    ready_timeout_ms: 30000        # optional, default 30000
    ready_interval_ms: 500         # optional, default 500
    restart: never | on-failure    # optional, default never
    max_retries: 3                 # optional, default 3 (used only with on-failure)

## 2. Service object (what the parser outputs and the engine reads)
{ name, command, cwd (ABSOLUTE path), env ({string:string}), dependsOn (string[]),
  readyCheck: {type:'port', port:number} | {type:'http', url:string} | {type:'none'},
  timeoutMs, intervalMs, restart ('never'|'on-failure'), maxRetries }
readyCheck 'none' means: ready as soon as the process has spawned successfully.
Port checks connect to 127.0.0.1.

## 3. Plan: loadPlan(configPath) in src/plan.js
returns { services: {[name]: Service}, order: string[] (declaration order),
          groups: string[][], analysis: {depth, width, total, chosen, reason} }
groups = levels. level(service) = 0 if no deps, else 1 + max(level of its deps).
Names inside a level keep declaration order (deterministic).

## 4. Adaptive rule (src/graph/adaptive.js)
depth = groups.length. width = size of the largest group. total = number of services.
chosen = 'parallel' if width > depth * 2, otherwise 'sequential'.
reason strings (exact):
 parallel:   "Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution."
 sequential: "Width (W) <= Depth (D) x 2. Graph is small or mostly linear. Auto-selecting SEQUENTIAL execution to save concurrency overhead."

## 5. Engine interface (Person 2 implements in src/engine/index.js)
runEngine({ services, groups, algorithm, maxParallel, emitter })
  algorithm: 'sequential' | 'parallel' | 'adaptive'. maxParallel: number, default Infinity.
  emitter: a Node EventEmitter.
  Resolves { algorithm, effectiveAlgorithm, totalMs, readyMs: {name: ms}, pids: {name: pid} }
  Rejects (Error) if any service fails; before rejecting it stops everything it started.
  Sequential: flatten groups in order, start one, wait ready, next.
  Parallel: per level start services concurrently (at most maxParallel at a time),
    wait until all in the level are ready, then next level.
  Adaptive: call analyze(groups), emit 'adaptive:decision', run the chosen algorithm.
stopAll({ graceMs = 3000 }) -> Promise<void>
  Stops every running service: deeper levels first (reverse dependency order),
  SIGTERM, then SIGKILL after graceMs. Leaves zero orphan processes.

## 6. Events (emitter.emit(name, payload)); every payload also has ts (performance.now() ms)
run:start         {algorithm, total}
adaptive:decision {width, depth, chosen, reason}
service:starting  {name, pid, level}
service:log       {name, stream:'stdout'|'stderr', line}
service:ready     {name, pid, ms}      // ms = time from spawn to ready
service:failed    {name, reason:'spawn'|'timeout'|'crash', error}
service:exited    {name, code, signal}
run:done          {algorithm, effectiveAlgorithm, totalMs}
run:failed        {error}

## 7. Errors and exit codes
ConfigError (src/config/errors.js): name 'ConfigError', .errors = string[] (ALL problems, not just the first).
CLI exit codes: 0 ok, 1 config error, 2 usage error, 3 runtime/engine failure.

## 8. CLI
serviceboot plan [--config FILE] [--json]
serviceboot up   [--config FILE] [--algorithm sequential|parallel|adaptive]
                 [--max-parallel N] [--exit-after-ready]
Default config: ./serviceboot.yml. Default algorithm: adaptive.
