#!/usr/bin/env bash
# ServiceBoot demo scripts (Linux / macOS).  Person 3.
#
#   ./demos/demo.sh            run every demo in order
#   ./demos/demo.sh race       one demo: race | adaptive | max-parallel | restart |
#                              crash | busy-port | ctrl-c | hard-kill | benchmark
#
# Rules followed here:
# - Only processes THIS script started are ever signalled (their PIDs are kept
#   in variables). No `pkill node`, no killing by name.
# - A trap stops anything left over if the script itself is interrupted.
# - After every demo, an orphan check lists any mock-service process still
#   running on this demo's ports. An empty list is the expected result.
set -u
cd "$(dirname "$0")/.." || exit 1

SB="node bin/serviceboot.js"
OWNED=()                      # PIDs started by this script
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/serviceboot-demo.XXXXXX")"

bold()  { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
note()  { printf '\033[2m# %s\033[0m\n' "$*"; }
run()   { printf '\033[36m$ %s\033[0m\n' "$*"; "$@"; local code=$?; printf '\033[2m(exit code %s)\033[0m\n' "$code"; return $code; }

cleanup() {
  for pid in "${OWNED[@]:-}"; do
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null
  done
  $SB down >/dev/null 2>&1 || true
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

orphan_check() {
  # Lists ServiceBoot mock services still alive. Nothing printed = no orphans.
  local left
  left="$(ps -A -o pid=,args= | grep -E '[m]ock-service\.js --port 41[0-9]{2}' || true)"
  if [ -z "$left" ]; then echo "orphan check: none (OK)"; else echo "orphan check: STILL RUNNING:"; echo "$left"; fi
  if [ -f .serviceboot/pids.json ]; then echo "PID file: present"; else echo "PID file: absent (OK)"; fi
}

wait_for() { # wait_for FILE PATTERN SECONDS
  local i=0
  while ! grep -q "$2" "$1" 2>/dev/null; do
    sleep 0.1; i=$((i + 1))
    if [ "$i" -ge $(( $3 * 10 )) ]; then return 1; fi
  done
  return 0
}

demo_race() {
  bold "1. Sequential vs Parallel on the wide graph (8 independent services + 2 dependents)"
  note "Run back-to-back, not at the same time: two runs would fight over the same ports and CPU."
  run $SB plan --config samples/wide.yml
  local seq par
  seq=$($SB up --config samples/wide.yml --algorithm sequential --exit-after-ready --plain | sed -n 's/^Ready: .*totalMs=\([0-9.]*\).*/\1/p')
  par=$($SB up --config samples/wide.yml --algorithm parallel   --exit-after-ready --plain | sed -n 's/^Ready: .*totalMs=\([0-9.]*\).*/\1/p')
  node -e '
    const [s, p] = process.argv.slice(1).map(Number);
    const bar = ms => "█".repeat(Math.max(1, Math.round(ms / Math.max(s, p) * 50)));
    console.log(`sequential ${bar(s)} ${s.toFixed(0)} ms`);
    console.log(`parallel   ${bar(p)} ${p.toFixed(0)} ms`);
    console.log(`parallel was ${(s / p).toFixed(2)}x faster on this run (single run; use the benchmark for averages)`);
  ' "$seq" "$par"
  orphan_check
}

demo_adaptive() {
  bold "2. Adaptive decision: wide graph vs linear chain"
  note "Rule: PARALLEL if width > depth x 2, otherwise SEQUENTIAL."
  run $SB plan --config samples/wide.yml
  run $SB plan --config samples/linear.yml
  run $SB up --config samples/wide.yml --exit-after-ready --quiet
  orphan_check
}

demo_max_parallel() {
  bold "3. Resource limit: --max-parallel 2 on the wide graph"
  note "At most 2 services may be starting (spawned but not yet ready) at the same time."
  run $SB up --config samples/wide.yml --algorithm parallel --max-parallel 2 --exit-after-ready --quiet
  orphan_check
}

demo_restart() {
  bold "4. Crash recovery: restart: on-failure, max_retries: 2"
  note "'crashing' exits with code 1 every 1.5 s; it is restarted twice, then left down. 'healthy' keeps running."
  local log="$LOG_DIR/restart.log"
  $SB up --config samples/restart.yml --plain >"$log" 2>&1 &
  local pid=$!; OWNED+=("$pid")
  wait_for "$log" 'service:failed crashing' 15 || echo "(timed out waiting for exhaustion)"
  grep -E '^(service:(starting|ready|restarting|failed|exited)|Ready:)' "$log"
  note "Stopping the run with SIGTERM (what 'serviceboot down' sends)."
  kill -TERM "$pid"; wait "$pid"; echo "(up exit code $?)"
  orphan_check
}

demo_crash() {
  bold "5. Startup crash: api dies before it becomes ready"
  run $SB up --config samples/crash.yml --exit-after-ready --plain
  note "Expected: service:failed api reason=crash, db and cache stopped, exit code 3."
  orphan_check
}

demo_busy_port() {
  bold "6. Busy port: something already listens on postgres's port 4101"
  node mock/mock-service.js --port 4101 --name intruder >/dev/null 2>&1 &
  local intruder=$!; OWNED+=("$intruder")
  sleep 0.5
  run $SB up --config samples/small.yml --exit-after-ready --plain
  note "Expected: 'Port 4101 is already in use', exit code 3, nothing started."
  kill -TERM "$intruder"; wait "$intruder" 2>/dev/null
  orphan_check
}

demo_ctrl_c() {
  bold "7. Ctrl+C (SIGINT) during a live run"
  local log="$LOG_DIR/ctrlc.log"
  $SB up --config samples/wide.yml --plain >"$log" 2>&1 &
  local pid=$!; OWNED+=("$pid")
  wait_for "$log" '^Ready:' 20 || echo "(timed out waiting for Ready)"
  note "All 10 services ready. Sending SIGINT to the CLI (pid $pid), exactly like pressing Ctrl+C."
  kill -INT "$pid"; wait "$pid"; echo "(up exit code $? - expected 130)"
  grep -c '^service:exited' "$log" | sed 's/^/service:exited events: /'
  orphan_check
}

demo_hard_kill() {
  bold "8. Hard-killed CLI (kill -9) then 'serviceboot down' recovers the orphans"
  local log="$LOG_DIR/hardkill.log"
  $SB up --config samples/small.yml --plain >"$log" 2>&1 &
  local pid=$!; OWNED+=("$pid")
  wait_for "$log" '^Ready:' 20 || echo "(timed out waiting for Ready)"
  kill -9 "$pid"; wait "$pid" 2>/dev/null
  note "SIGKILL cannot be caught: the CLI died without cleaning up. Its services are orphans now:"
  ps -A -o pid=,args= | grep -E '[m]ock-service\.js --port 410[1-3]' || true
  run cat .serviceboot/pids.json
  run $SB down
  orphan_check
}

demo_benchmark() {
  bold "9. Benchmark (3 runs per algorithm and config) + charts"
  run $SB benchmark --runs 3 --out results/results.json
  if python3 -c 'import matplotlib' 2>/dev/null; then
    run python3 scripts/charts.py results/results.json --out charts
  else
    note "matplotlib missing: python3 -m pip install -r scripts/requirements.txt"
  fi
}

case "${1:-all}" in
  race) demo_race ;;
  adaptive) demo_adaptive ;;
  max-parallel) demo_max_parallel ;;
  restart) demo_restart ;;
  crash) demo_crash ;;
  busy-port) demo_busy_port ;;
  ctrl-c) demo_ctrl_c ;;
  hard-kill) demo_hard_kill ;;
  benchmark) demo_benchmark ;;
  all) demo_race; demo_adaptive; demo_max_parallel; demo_restart; demo_crash; demo_busy_port; demo_ctrl_c; demo_hard_kill ;;
  *) echo "usage: $0 [all|race|adaptive|max-parallel|restart|crash|busy-port|ctrl-c|hard-kill|benchmark]"; exit 2 ;;
esac
