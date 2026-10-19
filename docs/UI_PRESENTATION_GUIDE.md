# ServiceBoot UI: presentation and viva guide

Use this guide to explain the browser dashboard to a professor. Quoted passages are ready to say aloud; the technical notes help with follow-up questions.

Prepared: 19 October 2026. Based on the current dashboard implementation and the committed benchmark data. Suggested presentation: 5–8 minutes, followed by questions.

## 1. Your opening explanation — 30 seconds

> “ServiceBoot is a local service orchestrator. In a project with a database, cache, and API, starting processes in a random order can cause failures because the API may start before its dependencies are ready. We describe the services in YAML, build a dependency graph, and start them in a valid order. This dashboard makes the configuration, startup strategy, process status, logs, and measured algorithm comparisons easy to understand.”

Then make the scope clear:

> “The browser is a control and observation layer over our Node.js CLI and process engine. It runs real local processes; the graph is a visualization of the plan, not a simulation of execution.”

**Important:** the bundled demos use real Node.js mock processes. Services named `postgres` and `redis` in `small.yml` are not actual PostgreSQL or Redis installations. They simulate delayed TCP readiness so the experiment is reproducible with Node alone. The API mock exposes an HTTP health endpoint.

## 2. Before the professor arrives

From the repository root:

```sh
npm install
npm run ui
```

Open **http://127.0.0.1:4173**. Keep the terminal that launched the dashboard available. If a dashboard is already running on that port, use it instead of launching a second one.

Rehearse these checks:

1. Select `samples/small.yml` and confirm the graph has `postgres` and `redis` before `api`.
2. Start services, observe readiness, then press **Stop** before switching configurations.
3. Confirm the Benchmarks page loads the saved report.
4. Keep this guide open for the viva. Let the live timing values appear naturally; do not promise a specific runtime.

If another CLI run owns this workspace, stop it from its original terminal or run `node bin/serviceboot.js down` from the same workspace before the demo. The dashboard refuses to take over an existing live CLI run.

### Why can the page be active before you run a command?

> “Someone has already started the dashboard's Node.js HTTP server. It continues running independently of the browser tab. Opening the page does not start the configured services; those start when I press Start services.”

There are three separate pieces:

| Piece | Role | Lifetime |
| --- | --- | --- |
| Browser tab | Shows the UI and sends local HTTP requests | Closing it does not stop the backend or services |
| Dashboard server | Serves HTML/CSS/JS and handles dashboard API requests on port 4173 | Starts with `npm run ui`; Ctrl+C in its terminal requests shutdown |
| CLI and service processes | Execute the selected configuration | Start through **Start services**; stop through **Stop** or the existing CLI shutdown path |

On a normal dashboard shutdown, the server awaits cleanup of its owned run. The **Stop** button leaves the dashboard server available for the next demonstration. A hard-killed server does not get to perform graceful cleanup; the existing PID-file/`down` mechanism is the recovery tool.

## 3. Explain the navigation

> “I separated the interface into three questions: what will start, what is happening, and how the algorithms compare.”

| View | Question it answers | What to point at |
| --- | --- | --- |
| **Overview** | What is configured, and how will it start? | Configuration, counts, dependency graph, strategy, service table, start/stop controls |
| **Live logs** | What actually happened during this run? | Process output, readiness events, failures, restarts, exit events |
| **Benchmarks** | How did the strategies perform in recorded experiments? | Per-configuration startup bars, successful runs, CPU and memory summary, report provenance |

Navigation is in a sidebar on a wide screen and moves to the bottom on a narrow screen. The breadcrumb and active navigation item identify the current view. **Quick guide** explains the workflow without leaving the dashboard.

## 4. Overview: explain every feature

### A. Configuration picker and YAML tab

**Do:** select `samples/small.yml`, then open **YAML**.

> “This is the source configuration used by the engine. Each service declares a command, dependencies, and a readiness check. The UI reads the existing YAML rather than maintaining a second, separate service definition.”

The picker lists supported `.yml` filenames from the repo root and `samples/`. Filenames use letters, digits, underscores, or hyphens. To add a configuration, edit or create the file outside the dashboard and refresh the page. The YAML view is **read-only**; this is not an in-browser editor or upload form.

Useful fields to explain:

| YAML field | Say this |
| --- | --- |
| `command` | “The shell command for the actual local process.” |
| `depends_on` | “These services must be ready before this service may start.” |
| `ready_check` | “Our definition of readiness: a TCP connection, an HTTP success response, or successful spawning.” |
| `cwd` / `env` | “The working directory and environment overrides used for the process.” |
| `ready_timeout_ms` / `ready_interval_ms` | “How long we allow readiness to take, and how often we check.” |
| `restart` / `max_retries` | “Whether failed services may restart, with a bounded retry budget.” |

For omitted options, normalization applies the defaults in [CONTRACT.md](../CONTRACT.md). A relative `cwd` is resolved against the configuration file's directory, not the browser's location.

### B. Summary values

| Value | Meaning | Important qualification |
| --- | --- | --- |
| **Services** | Number of declared services in the selected valid configuration | Not the number of all Node processes on the computer |
| **Dependency levels** | Number of startup groups, including level 0 | This is graph depth measured as number of levels |
| **Ready to go** | Services whose latest dashboard status is ready, out of the configured total | Before startup it is zero; after stopping, services are stopped rather than ready |
| **Startup time** | Engine-measured duration until all services initially become ready | Not page load time, individual service latency, or a browser stopwatch |

> “The first two values describe the plan. The readiness count and startup time come from the execution events. A dash means the measurement is not available yet; it does not mean zero.”

The displayed startup time remains as the **last startup** after Stop. It is not the total time the services have been running.

### C. Dependency graph

Switch to **Graph** and point to the arrows.

> “Each node is a service. An arrow goes from a dependency to the service that needs it. Here, postgres and redis are independent roots in level 0. The API depends on both, so it is in level 1.”

```text
postgres ──┐
           ├──> api
redis ─────┘

 Level 0       Level 1
```

Explain the grouping:

> “A root has level zero. Every other service is one level after its deepest dependency. We use Kahn's topological algorithm level by level and preserve declaration order inside each group.”

Example: if `x` depends on a level-0 service and a level-1 service, `x` must be in level 2. Graph width is the number of nodes in the largest level. Graph depth is the number of levels. Independent services can share a level; a chain cannot.

The graph shows dependency structure, not CPU activity or continuous health monitoring. Use the service table and logs for live execution status. Larger graphs can scroll.

### D. Startup strategies

| Strategy | Ready-to-say explanation | Small-config behavior |
| --- | --- | --- |
| **Sequential** | “Start one service, wait until it is ready, then start the next in flattened level order.” | postgres → redis → api |
| **Parallel** | “Start services concurrently within a level. Wait until the entire level is ready before starting the next level.” | postgres and redis together; then api |
| **Adaptive** | “Apply a fixed graph heuristic to select sequential or parallel automatically.” | Selects sequential for depth 2 and width 2 |

Adaptive's exact rule:

```text
width > 2 × depth  → parallel
otherwise          → sequential
```

| Configuration | Services | Depth | Width | Adaptive decision |
| --- | ---: | ---: | ---: | --- |
| `small.yml` | 3 | 2 | 2 | Sequential: 2 ≤ 4 |
| `linear.yml` | 5 | 5 | 1 | Sequential: 1 ≤ 10 |
| `wide.yml` | 10 | 2 | 8 | Parallel: 8 > 4 |

> “Adaptive is a deterministic heuristic, not machine learning and not a guarantee of the fastest result. Equality selects sequential. Our recorded small-graph results actually show parallel outperforming the adaptive choice.”

**Concurrent startups:** blank means no configured cap. A value such as 2 limits the number of services that are starting but have not yet become ready. Once a service is ready, it frees a startup slot while its process continues running. The cap applies to parallel execution, including adaptive when it selects parallel. It is not a CPU limit, memory limit, or limit on the total number of running services.

### E. Start, Stop, and disabled controls

> “Start services launches the existing CLI with this configuration and algorithm. While a run is active, I cannot change its configuration or strategy or start a second run. Stop uses the existing shutdown mechanism to stop dependents before their dependencies.”

On POSIX systems, the engine requests graceful termination, then escalates if necessary. Windows process-tree termination uses the platform-specific implementation. The dashboard delegates this work rather than implementing a second engine.

The run status moves between **Not started**, **Starting up**, **Running**, **Stopping**, **Stopped**, and **Run failed**. A run can still have surviving services after a supervised service exhausts its restart budget; inspect individual rows and logs rather than treating the overall Running label as an all-services-healthy guarantee.

### F. Service table and search

| Column | How to explain it |
| --- | --- |
| **Service** | “The configured name, its graph level, and the PID once it has started.” |
| **Status** | “Waiting, Starting, Ready, Restarting, Failed, or Stopped, based on the observed events.” |
| **Readiness check** | “The exact TCP address, HTTP URL, or successful-spawn criterion.” |
| **Depends on** | “The prerequisite services. Roots have no dependencies.” |
| **Ready in** | “That service's reported spawn-to-ready duration; waiting before it is launched is not included.” |

The PID can be the shell/group leader used to launch a service. A service may own a process tree, so one table row does not imply exactly one OS process. Recovery can replace its PID.

**Find a service** filters rows by name. It does not change the graph, stop a process, or alter scheduling. **View live logs** opens the Logs view.

### G. The most important sentence: started versus ready

> “A PID only tells us that a process exists. It does not prove that the service can accept work. We wait for the configured readiness condition before allowing the next dependency level to start.”

- **TCP:** a successful connection to the configured port on `127.0.0.1`.
- **HTTP/HTTPS:** a response with a status from 200 through 299.
- **None:** successful process spawning; it does not prove application health.

The dashboard's readiness display is event-based. It is not an ongoing health-check monitor after startup.

## 5. Live logs: demonstrate evidence, not just animation

**Do:** start a valid sample, then open **Live logs**.

> “These are real CLI events and service stdout/stderr lines. They let us verify that the API started after its dependencies became ready and that shutdown happened in reverse dependency order.”

| Feature | What to say |
| --- | --- |
| **Event stream** | “Events explain process creation, readiness, restarts, failures, and exits.” |
| **Filter logs** | “I can search a service name or an event such as `service:ready`.” |
| **Follow output** | “When enabled, the view follows new lines. I can turn it off to inspect earlier events.” |
| **Download logs** | “Export the currently retained run history as text. This includes all retained lines, not just the visible search matches.” |
| **Timestamps** | “Displayed wall-clock times are when the dashboard received each line. The event payload's `ts` uses the engine's monotonic clock.” |
| **Empty state** | “No run output has arrived yet; this is not fabricated example data.” |

The browser fetches state approximately every **750 ms**, after the previous request finishes. It uses HTTP polling, not WebSockets. A small display delay does not change the engine's measured timings.

The server retains the latest **1,000 log lines** in memory and resets the history for a new run. This is not a permanent logging database. A browser filter changes only what is displayed.

Useful events to point out:

| Event | Meaning |
| --- | --- |
| `run:start` | Execution begins with a requested algorithm and service count |
| `adaptive:decision` | The heuristic's graph dimensions, chosen strategy, and reason |
| `service:starting` | A service is launched, with PID and level |
| `service:ready` | Its readiness condition passed, with measured duration |
| `service:log` | A line from service stdout or stderr |
| `service:restarting` | A retry is scheduled, with attempt and retry limit |
| `service:failed` | A spawn, readiness timeout, or crash failure |
| `service:exited` | A process exited, including its code or signal |
| `run:done` | Initial startup completed; services normally continue running |
| `run:failed` | Startup failed and the engine attempted cleanup |

## 6. Benchmarks: explain the measurements correctly

Open **Benchmarks** before discussing speed.

> “This page reads a saved report from report/results.json. The recording date, original machine, and run count are displayed so we do not confuse these results with live measurements from the presentation laptop.”

The current saved report records **45 runs**: three configurations × three algorithms × five repetitions. It was recorded on **13 October 2026**, on Linux with **2 logical CPUs**, using **Node v22.22.0**.

### Startup bars

Each card compares the mean successful startup time of the three algorithms on one configuration. Lower is faster. Each card has its own bar scale: compare numeric times, not bar lengths across different cards. Failed runs are not included in the timing averages.

Rounded values read from the saved report:

| Configuration | Sequential | Parallel | Adaptive |
| --- | ---: | ---: | ---: |
| Small | 1,594 ms | 1,023 ms | 1,530 ms |
| Linear | 2,544 ms | 2,541 ms | 2,544 ms |
| Wide | 9,089 ms | 1,592 ms | 1,590 ms |

> “Parallel helps the wide graph because many independent readiness waits can overlap. It adds little benefit to the linear chain because every service depends on the previous one. On the small graph, adaptive selected sequential even though parallel measured faster, which exposes the limitation of our simple heuristic.”

Do not claim these timings will repeat exactly on another computer. The mocks spend much of startup waiting, so this demonstrates startup orchestration, not a universal speedup for CPU-bound workloads.

### Beyond startup time

| Display | Meaning |
| --- | --- |
| **Successful runs** | Number of successful repetitions out of all repetitions for that pair |
| **Mean CPU** | Mean of the per-run average CPU measurements for the service process trees; 100% means one fully busy core |
| **Mean peak memory** | Mean of the per-run peak resident-memory totals across the service process trees |
| **Unavailable** | The measurement was unavailable; it is not silently replaced with zero |
| **Download JSON** | Download the full saved report for inspection or further analysis |

Memory totals can count shared pages more than once. The UI labels memory as MB but converts bytes using 1,048,576 bytes per displayed unit. The collector records the orchestrator separately; these UI columns describe service trees. Linux context-switch data is available in the broader metrics/report system but is not a separate dashboard chart or table column.

There is **no Run benchmark button** in this UI. To create fresh measurements, first stop the service run, then use:

```sh
node bin/serviceboot.js benchmark --runs 3 --out report/results.json
```

Refresh the page after the command completes to reload the report. The displayed instruction also suggests restarting the dashboard; a browser refresh is sufficient because the report endpoint reads the file on each request. Do not run a new benchmark during a short presentation unless its runtime is part of your plan.

## 7. A ready-to-follow 7-minute demonstration

| Time | Action | Say this |
| --- | --- | --- |
| 0:00–0:40 | Show Overview | “Our problem is starting dependent local services safely and observing what happens.” |
| 0:40–1:30 | Select small; show YAML, then Graph | “The API depends on both roots. The graph groups services into deterministic startup levels.” |
| 1:30–2:30 | Select Parallel; Start services | “The independent roots can start together, but the API must wait for the whole previous level to be ready.” |
| 2:30–3:20 | Open logs; filter `service:ready`, then clear the filter | “These events are the evidence for readiness and execution order. Individual readiness time differs from total startup time.” |
| 3:20–4:00 | Return to Overview; Stop | “Cleanup reverses the dependency order, stopping the API before its supporting services.” |
| 4:00–4:50 | Select wide; choose Adaptive; show its recommendation | “Width eight is greater than twice depth two, so adaptive chooses parallel.” |
| 4:50–5:50 | Open Benchmarks | “These are recorded experiments, not live machine metrics. The chain shows why graph shape matters.” |
| 5:50–6:30 | Overview; select invalid | “All configuration problems are reported before any service is launched.” |
| 6:30–7:00 | Return to small; show Quick guide | “The UI makes the OS engine easier to control and explain while reusing the existing CLI.” |

If time allows, run wide as well, wait for all ten services, and Stop before switching configurations. A live sequential-versus-parallel comparison requires two separate runs with a full Stop between them; use the same configuration and concurrency settings. Treat a single live comparison as a demonstration, not as statistically conclusive benchmarking.

### Optional demonstrations

| Sample or setting | What it demonstrates | What to say |
| --- | --- | --- |
| `linear.yml` | Five dependency levels, width one | “No scheduler can remove these declared readiness dependencies.” |
| `cyclic.yml` | A closed dependency path | “a depends on b, b on c, and c on a. There is no valid topological startup order, so we reject the plan.” |
| `invalid.yml` | Unknown dependency, duplicated readiness port, invalid readiness expression | “We aggregate independent validation errors instead of reporting only the first one.” |
| `crash.yml` | A dependent crashes during startup | “A terminal startup failure aborts further startup and cleans up the processes already launched.” |
| `restart.yml` | A crashing mock retries twice while a healthy sibling runs | “Recovery has a bounded retry budget and backoff. Exhausted post-readiness recovery leaves the failed service down; it does not automatically restart its dependents.” |
| Parallel with limit 2 | Bounded concurrent startup | “Only two services may be awaiting readiness at once; already-ready services keep running.” |

Always Stop between scenarios. Some samples reuse ports, including the restart/cyclic pair.

## 8. Connect the interface to OS concepts

| UI observation | OS or algorithm concept | Where to look in the repo |
| --- | --- | --- |
| PID appears when a service starts | Process creation; parent/child and shell-wrapper ownership | [process-manager.js](../src/engine/process-manager.js) |
| Multiple services are Starting together | Overlapping independent process startup; the OS schedules their work | [runners.js](../src/engine/runners.js) |
| Next level waits for Ready | Synchronization barrier | [runners.js](../src/engine/runners.js) |
| Port or HTTP check | Socket-based readiness and asynchronous I/O | [readiness.js](../src/engine/readiness.js) |
| Stop reverses the levels | Dependency-aware process cleanup and signals | [engine/index.js](../src/engine/index.js), [down.js](../src/engine/down.js) |
| Restarting state and new PID | Failure recovery, bounded retries, backoff | [recovery.js](../src/engine/recovery.js) |
| Event stream | IPC through child stdout/stderr pipes; event-driven observation | [dashboard/server.js](../src/dashboard/server.js), [cli/ui.js](../src/cli/ui.js) |
| Adaptive recommendation | A deterministic heuristic based on DAG depth and width | [adaptive.js](../src/graph/adaptive.js) |
| Rejected cycle | DFS cycle detection and topological-sort feasibility | [dag.js](../src/graph/dag.js), [topo.js](../src/graph/topo.js) |
| Saved CPU and memory values | Process-tree resource accounting and repeated experiments | [collector.js](../src/metrics/collector.js), [benchmark/index.js](../src/benchmark/index.js) |

> “Our strategies choose which service to launch and when to wait. We do not replace the operating system's CPU scheduler or implement CPU time slices.”

## 9. Explain the architecture in one minute

```text
Browser: HTML + CSS + JavaScript
    │ local HTTP requests; periodic state polling
    ▼
Dashboard: Node.js HTTP server
    ├── loadPlan → YAML parser/validator → DAG levels + analysis
    ├── Start → child Node CLI process → engine → service process trees
    │                            └── stdout/stderr → dashboard status + logs
    ├── Stop → existing down/PID-file cleanup path
    └── Benchmarks → read report/results.json
```

> “The frontend does presentation. The local backend loads plans and controls a CLI child process. The existing engine owns readiness, scheduling, retries, and process-tree cleanup. This avoids duplicating the engine's behavior in the browser.”

Files to open if asked:

- [index.html](../src/dashboard/public/index.html): the three views, controls, and quick-guide dialog.
- [style.css](../src/dashboard/public/style.css): palette, light theme, responsive layout, and focus styles.
- [app.js](../src/dashboard/public/app.js): user interactions, SVG graph rendering, state polling, filtering, and saved-report presentation.
- [server.js](../src/dashboard/server.js): local HTTP APIs, CLI subprocess, event-line buffering, bounded logs, and shutdown integration.

The dashboard adds no runtime dependency or build step. Frontend code is plain JavaScript; the backend is Node.js CommonJS with built-ins. `js-yaml` remains the project's only direct runtime dependency.

The HTTP interface is local: it binds to `127.0.0.1`, checks Host/Origin, and requires JSON for start/stop. This helps prevent another website from triggering local actions. It is not an authenticated multi-user hosting service and should not be presented as one.

## 10. Explain the visual design without overselling it

> “The interface uses a light background, limited navigation, and consistent colors to keep the dependency plan and service state readable. Color reinforces the labels; the labels still carry the meaning.”

| Palette | Role in the current UI |
| --- | --- |
| `#2A1A0E` | Main dark text |
| `#D4621A` | Primary Start action and brand accent |
| `#F4AE52` | Independent-service accents and sequential benchmark bars |
| `#FEF3E2` | Warm background accents and explanatory areas |
| `#287A74` | Ready/positive accents, navigation, and parallel benchmark bars |
| `#55A9A0` | Secondary teal accents, dependency markers, and adaptive bars |
| `#AEEED3` | Mint supporting accents |
| `#FFF8B0` | Soft yellow supporting accents |

Additional neutral colors are used for surfaces, borders, and secondary text. Do not claim every color corresponds to a unique runtime state; some are decorative. Other usability features include visible keyboard focus, labelled controls, Graph/YAML keyboard navigation, service search, narrow-screen navigation, and explicit empty/error states. These features do not constitute a formal accessibility certification.

## 11. Likely professor questions and short answers

**“Why add a UI when the CLI already works?”**

> “The CLI executes the workflow. The UI makes dependency order, readiness, logs, and comparisons visible in one place, which helps debugging and explaining the OS behavior.”

**“Does opening the website start all the services?”**

> “No. The dashboard server must already be running, and services start only after Start services. Closing the tab also does not stop them.”

**“Is this hosted on the internet?”**

> “This setup is a local server on 127.0.0.1. The browser is connecting to the same machine.”

**“Are postgres and redis actual databases in your demo?”**

> “No. They are names assigned to real Node mock processes with delayed TCP listeners. Actual database commands can be configured if those programs are installed.”

**“What is a DAG, and why do you need one?”**

> “A directed acyclic graph represents dependency relationships. Its lack of cycles allows a topological order in which prerequisites come first.”

**“How do you distinguish started from ready?”**

> “Started means the process was spawned. Ready means its configured check passed. For a none check, successful spawn is deliberately the whole criterion.”

**“Is Ready a continuous health guarantee?”**

> “No. It records readiness during startup or replacement startup. Process exit events still update state, but we do not continuously poll application health after initial readiness.”

**“Is your parallel algorithm a CPU scheduling algorithm?”**

> “It schedules concurrent service starts with a level barrier. The OS still schedules the processes on CPU cores.”

**“Why is there little speedup for the chain?”**

> “Only one service can proceed at each level, so there is no independent readiness work to overlap.”

**“Does Adaptive always choose the optimal algorithm?”**

> “No. It uses the fixed width-versus-depth rule. The small-graph measurements show a case where its choice is slower.”

**“Does max-parallel 2 mean only two services can run?”**

> “No. Only two can be in the starting-but-not-ready stage at once. Ready processes continue running without occupying startup slots.”

**“Why are the UI timings different from the time I observe?”**

> “They come from the engine's monotonic timing. Button handling, CLI launch overhead, and the browser's polling delay are not the same measurement.”

**“What happens if a dependency fails?”**

> “A terminal startup failure stops the processes already started and prevents later startup. After initial readiness, configured retries have different semantics; dependents are not automatically restarted.”

**“Can the dashboard stop an unrelated CLI run?”**

> “Its start action refuses an existing live workspace owner, and its Stop action is for its own child run. The CLI down command is the separate workspace recovery/control mechanism.”

**“Why not keep all logs forever?”**

> “This is a local demonstration dashboard. A bounded in-memory history avoids unbounded growth; retained logs can be downloaded before another run.”

**“Are the benchmark bars changing as the app runs?”**

> “No. They are loaded from a saved report with recording and environment details. A new CLI benchmark creates new measurements.”

**“What does 100% CPU mean?”**

> “One fully busy core, summed over the sampled service process trees. It is not automatically 100% of the entire multi-core machine.”

**“Is mean peak memory the largest peak across every run?”**

> “No. Each run has a peak, and this UI displays the mean of those peaks.”

**“How do you know the controls affect real processes?”**

> “The adapter spawns the existing CLI, captures its real output, and shows the resulting PIDs and readiness events. Integration tests start and stop real mock processes and check that observed PIDs die.”

**“What would you improve next?”**

> “Add live resource charts, a benchmark launcher in the browser, persistent log storage, and a YAML editor with validation. Those are possible extensions, not current UI features.”

## 12. Troubleshooting during the demo

| Symptom | Response |
| --- | --- |
| Page does not load | Check that `npm run ui` is running and that you opened the printed `127.0.0.1` URL |
| Dashboard port already occupied | Use the existing server or stop its original terminal; `PORT` can override the default if needed |
| Start is disabled | Check for an active run, an operation in progress, invalid configuration, or a disconnected backend |
| A sample service port is busy | Stop the previous run and inspect its logs; do not terminate unrelated processes blindly |
| “A CLI run already owns this workspace” | Stop that CLI run from its terminal or use `node bin/serviceboot.js down` from the same workspace |
| Config edits are not visible | Stop the current run if needed and refresh; edit YAML outside the UI |
| A filtered log view is empty | Clear the search and confirm that a run has produced events |
| Saved benchmark results seem different from live startup | Explain that they were recorded on another machine and are repeated-run averages |
| Backend disconnected banner | Check the dashboard terminal; the UI retries state polling |
| Need to finish quickly | Stop the live run, show the saved comparison, and use the 30-second conclusion below |

## 13. Claims to avoid

- “Adaptive uses AI” or “always finds the fastest strategy.”
- “Ready proves the service will remain healthy forever.”
- “Parallel means every service starts immediately regardless of dependencies.”
- “We control the operating system's CPU time slices.”
- “These benchmark CPU/memory numbers are live readings of this laptop.”
- “The graph animates actual CPU usage.”
- “There is a YAML editor, live benchmark runner, persistent log database, or live resource chart in this dashboard.”
- “Closing the browser stops the services.”
- “Each service is exactly one OS process.”
- “A green overall run label guarantees every supervised service is still healthy.”
- “The mock services prove production PostgreSQL/Redis behavior.”
- “All platforms were verified in this presentation” unless you have actually run the checks on them.

## 14. Your closing explanation — 20 seconds

> “The UI connects configuration, dependency planning, real process execution, and measured results. The main lesson is that starting a process is different from making a dependency ready, and graph structure determines which startup work can safely overlap. The dashboard makes those decisions observable while the existing OS engine handles the processes and cleanup.”

## 15. One-minute revision card

1. **Problem:** dependent services fail when prerequisites are not ready.
2. **Input:** YAML commands, dependencies, readiness checks, and restart policy.
3. **Plan:** validated DAG; deterministic levels; longest-path level definition.
4. **Strategies:** sequential one-by-one; parallel per level; adaptive uses strict `width > 2 × depth`.
5. **Execution:** actual OS processes; startup slots held until readiness; existing engine reused.
6. **Observe:** service status, PIDs, per-service readiness time, run startup time, bounded real logs.
7. **Stop:** dependents before dependencies; existing process-tree shutdown and PID ownership.
8. **Evidence:** saved, labelled benchmark results; repeated runs; graph shape explains speed differences.
9. **Scope:** local dashboard, read-only YAML, polling, no live resource charts or in-browser benchmark execution.
10. **Be honest:** mocks are mocks; timings vary; adaptive is a heuristic; features and verification are separate claims.
