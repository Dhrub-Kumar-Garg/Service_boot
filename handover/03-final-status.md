# Handover: Person 3 → final status

Date: 2026-10-13. Starting point: `p2-done` (9234482). Release tag: `p3-done`.
Verification host: **Linux** 6.18 x64 VM, 2 logical CPUs, 8 GB, Node v22.22.0,
Python 3.11 + matplotlib 3.x. Person 2 verified the engine on Windows; this
release is the first full run on Linux.

## 0. START HERE

```sh
npm ci
npm test                                   # expected: 193 passing
npm run test:engine                        # expected: 34 passing
node bin/serviceboot.js up --config samples/small.yml          # terminal UI, Ctrl+C to stop
node bin/serviceboot.js benchmark --runs 3                     # -> results/results.json
python3 scripts/charts.py results/results.json --out charts    # -> charts/*.png
./demos/demo.sh                                                # all scenarios + orphan checks
```

## 1. What is done (Person 3 scope from the distribution PDF)

| Task | Where | How to run |
|---|---|---|
| Full CLI: `up`, `down`, `plan`, `benchmark`, `--algorithm`, `--config`, `--max-parallel`, `--help`, exit codes | `src/cli/index.js` | `node bin/serviceboot.js --help` |
| Terminal UI: events, ANSI colours, spinner, per-service lines that never scramble, readiness bars, restart attempts; `NO_COLOR`/`--no-color`, non-TTY → plain lines, `--plain`, `--quiet` | `src/cli/ui.js` | `up` on a terminal; screenshots in `report/screenshots/` |
| Metrics collector: high-res total and per-service ready time (engine), CPU and memory summed over every service **process tree**, peak values, Linux context switches, "unavailable" elsewhere | `src/metrics/collector.js`; samplers in `src/engine/process-manager.js` (`getForestPids`, `sampleProcesses`, `samplerSupport`) | inside `benchmark` |
| `benchmark` command: all three algorithms, 3–5+ runs each, same configs, averages + spread, `results.json` | `src/benchmark/index.js`, `src/cli/index.js` (`runBenchmarkCommand`) | `benchmark --runs 5` |
| Python charts: startup, per-service readiness, peak memory, CPU, context switches | `scripts/charts.py`, `scripts/requirements.txt` | see §0 |
| Demo scripts: sequential-vs-parallel race, adaptive reveal on wide, plus max-parallel, restart, crash, busy port, Ctrl+C, kill -9 + down | `demos/demo.sh` (run), `demos/demo.ps1` (**not run**) | `./demos/demo.sh [name]` |
| Docs: README, OS concept → file/function mapping, final report, screenshots | `README.md`, `docs/OS_CONCEPTS.md`, `docs/REPORT.md`, `docs/ENGINE.md` (Person 2's README notes, moved verbatim) | — |
| End-to-end test + bug fixes | fresh clone run, 5×2 suite rounds, native Ctrl+C, three Linux fixes (§4) | §2 |
| Contract additions | `CONTRACT.md` §10 (sections 1–9 untouched) | — |

Commits (author Rachel Patni): readiness fix → phase 2 metrics → phase 3
benchmark engine → phase 1 CLI/UI + benchmark command → Linux race fixes →
phase 4 charts → phase 5 demos → phase 6 docs/report/handover.

## 2. How it was verified (real output, all files in `verification/`)

**Five consecutive rounds**, `NODE_OPTIONS=--unhandled-rejections=strict`:

| Round | Unit (pass/fail) | Engine (pass/fail) | Leftover mock/CLI processes; PID file |
|---|---|---|---|
| 1 | 193 / 0 | 34 / 0 | 0; absent |
| 2 | 193 / 0 | 34 / 0 | 0; absent |
| 3 | 193 / 0 | 34 / 0 | 0; absent |
| 4 | 193 / 0 | 34 / 0 | 0; absent |
| 5 | 193 / 0 | 34 / 0 | 0; absent |

Files: `p3-release-N-unit.txt`, `p3-release-N-engine.txt`,
`p3-release-orphans.txt`, `p3-release-summary.txt`. No skips on Linux (the
POSIX-only cases that Windows skipped all ran and passed).

**Native Ctrl+C** through a real pseudo-terminal (byte 0x03 → kernel sends
SIGINT to the foreground group), wide config, after all 10 ready:
once → exit 130 in 63 ms; twice → exit 130 in 40 ms; no mock processes and no
PID file left (`p3-native-ctrlc-1.txt`, `-2.txt`, script `p3-pty-ctrlc.py`).

**Fresh clone** of the code commit: `npm ci`, `plan`, `up` with all three
algorithms, `down`, `benchmark`, charts — all exit 0, no processes left
(`p3-fresh-clone.txt`).

**Demos**: `demos/transcripts/demo-all-linux.txt`, every orphan check clean,
exit codes as documented (crash 3, busy port 3, SIGTERM 143, Ctrl+C 130).

**Benchmark used in the report**: `report/results.json` (45 runs, all ok),
console output `report/benchmark-console.txt`.

## 3. Interfaces

Everything is in `CONTRACT.md` §10: CLI flags and exit codes, process-manager
additions, collector API and metric definitions, results JSON schema v1, the
readiness fix. Events, exit codes 0/1/2/3/130/143 and the plain `event
key=value` output are unchanged, so Person 1/2 tests pass untouched.

## 4. Decisions and fixes

- **Plain output whenever stdout is not a TTY.** Scripts, tests and CI keep
  Person 2's exact lines; humans get the UI. Each UI line is one synchronous
  write; the spinner is erased and redrawn around it, so parallel output never
  interleaves.
- **One process-table snapshot per sample** (`getForestPids`) instead of one
  `ps` per service: less measurement disturbance.
- **Benchmark is serial and round-robin**, `stopAll()` awaited in `finally`,
  collector drained, 300 ms cooldown; failures counted, never averaged.
  Benchmark writes the PID file too, so `down` can recover a killed benchmark.
- **Three Linux bugs fixed** (none visible on Windows):
  1. `src/engine/readiness.js`: a final probe with < 5 ms budget overwrote the
     real diagnostic (`HTTP 500`) with `timeout`. Failed the unit test
     deterministically on Linux.
  2. `mock/mock-service.js`: printed `starting` before installing its signal
     handlers; a SIGTERM reacting to that line could hit the default action
     (1 failure in 5 rounds).
  3. `src/cli/index.js` second Ctrl+C: exited right after SIGKILL, leaving the
     killed shells as zombies for init to reap; the forced-cleanup engine test
     saw them as alive (2 failures in 5 rounds, also in the p2-done baseline).
     Now the event loop gets ≤ 300 ms to reap them. Verified 0/5 + 8/8 isolated.

### Found on Rachel's Windows laptop before pushing

4. `src/engine/pidfile.js`: replacing `pids.json` while another process was
   reading it failed with `EPERM` (Windows locks open files). The CLI treated
   that as fatal and shut the run down. `write()`/`read()` now retry transient
   `EPERM`/`EACCES`/`EBUSY` for up to ~1.5 s. Failed `DOWN: CLI replaces the
   saved PID on recovery` on Windows; new unit test `PIDFILE: transient ...`.
5. `test/engine/metrics-benchmark.test.js`: the busy-tree service was an inline
   `node -e "..."` command; cmd.exe treated `<` inside it as a redirection, and
   the test's assertions in `finally` hid that error. The scripts are now files
   and assertions run after cleanup.

## 5. Known issues / not done (honest list)

- **Container without init (zombie reaping).** In this VM, PID 1 never reaps
  orphans. Zombies keep a process group "alive" for `kill(-pgid, 0)`, so
  `stopAll` waits out SIGTERM grace + 2 s and then throws "Process group … is
  still alive". At p2-done this produced 5 unit + 5 engine failures here
  (`p3-baseline-p2done-linux-no-reaper-*.txt`). All Linux evidence above was
  run under `verification/p3-subreaper.py`, which reaps like a normal init.
  Real Linux desktops are fine; in Docker use `--init`. A proper fix would make
  `isGroupAlive` ignore zombie members via `/proc` (process-manager.js only).
  Not done: it changes fragile Person 2 shutdown code.
- `demos/demo.ps1` and the Windows/macOS sampler paths (`sampleWindows`,
  `sampleDarwin`) were **not executed**. Run `.\demos\demo.ps1` once on Windows.
- Windows has no scripted Ctrl+C; demo.ps1 lists it as a manual step.
- Adaptive heuristic is suboptimal on `small.yml` (report §6.3). Unchanged on
  purpose: the rule is fixed in CONTRACT §4.
- Report numbers are from one Linux VM with 2 CPUs and sleeping mock services.
- Screenshots are rendered from real `script` recordings (raw files kept next
  to them), not captured from a desktop window. Take a live screenshot on your
  own machine for the slides if the faculty expects one.
- `--sample-ms` below ~200 ms adds measurable `ps` overhead to short runs.

## 6. What to do first (for the presentation)

1. On the demo laptop: `npm ci && npm test && npm run test:engine`, then
   `./demos/demo.sh race` (or `.\demos\demo.ps1 race`). Check nothing differs.
2. Rehearse with `docs/REPORT.md` §6.3 and §9 (viva notes): be able to explain
   process groups, SIGTERM vs SIGKILL, zombies, the level barrier, why adaptive
   lost on `small`, and why every service took ~1000 ms on `wide`.
3. If you re-run the benchmark on another machine, regenerate charts and
   update the tables in README/REPORT from the new `results.json` — never mix
   machines in one table.

## 7. Fragile areas

- Plain output format is parsed by Person 2's tests and `demos/demo.sh`
  (`Ready: ... totalMs=`). Do not change it.
- `src/engine/*` shutdown, signals and PID-file code: see Person 2 handover §7.
- `scripts/charts.py` depends on results schemaVersion 1; bump the version and
  the script together.
