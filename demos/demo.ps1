# ServiceBoot demo scripts (Windows PowerShell 5.1+ / PowerShell 7).  Person 3.
#
#   .\demos\demo.ps1            run every demo in order
#   .\demos\demo.ps1 race       one demo: race | adaptive | max-parallel | restart |
#                               crash | busy-port | hard-kill | benchmark
#
# NOT EXECUTED by Person 3: written on Linux, where PowerShell was not available.
# Run it once on Windows before the demo and fix anything that differs.
#
# Windows notes:
# - Windows has no POSIX SIGTERM/SIGINT for another process. A live Ctrl+C can
#   only be pressed by a human in the console, so the Ctrl+C demo is MANUAL:
#     node bin/serviceboot.js up --config samples/wide.yml
#     (wait for "All 10 services ready", press Ctrl+C, expect exit code 130)
#     echo $LASTEXITCODE
# - Only processes this script started are stopped (Stop-Process -Id on saved
#   IDs, or "serviceboot down"). Never "Stop-Process -Name node".
param([string]$Demo = "all")
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")
$Owned = New-Object System.Collections.Generic.List[int]
$LogDir = Join-Path ([System.IO.Path]::GetTempPath()) ("serviceboot-demo-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $LogDir | Out-Null

function Bold($text) { Write-Host "`n=== $text ===" -ForegroundColor White }
function Note($text) { Write-Host "# $text" -ForegroundColor DarkGray }
function Run([string[]]$cliArgs) {
  Write-Host ("$ node bin/serviceboot.js " + ($cliArgs -join " ")) -ForegroundColor Cyan
  & node bin/serviceboot.js @cliArgs
  Write-Host "(exit code $LASTEXITCODE)" -ForegroundColor DarkGray
}
function OrphanCheck {
  $left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'mock-service\.js --port 41\d\d' }
  if ($left) { Write-Host "orphan check: STILL RUNNING:"; $left | Select-Object ProcessId, CommandLine | Format-Table -AutoSize }
  else { Write-Host "orphan check: none (OK)" }
  if (Test-Path .serviceboot/pids.json) { "PID file: present" } else { "PID file: absent (OK)" }
}
function StartUp([string[]]$cliArgs, [string]$log) {
  $p = Start-Process -FilePath node -ArgumentList (@("bin/serviceboot.js") + $cliArgs) -NoNewWindow -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $Owned.Add($p.Id)
  return $p
}
function WaitFor([string]$log, [string]$pattern, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern $pattern -Quiet)) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return $false
}
function ReadyMs([string]$text) {
  if ($text -match 'totalMs=([\d.]+)') { return [double]$Matches[1] } else { return $null }
}

function Demo-Race {
  Bold "1. Sequential vs Parallel on the wide graph"
  Note "Back-to-back, not simultaneous: two runs would fight over the same ports and CPU."
  Run @("plan", "--config", "samples/wide.yml")
  $seqOut = & node bin/serviceboot.js up --config samples/wide.yml --algorithm sequential --exit-after-ready --plain
  $parOut = & node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel --exit-after-ready --plain
  $seq = ReadyMs (($seqOut | Where-Object { $_ -like 'Ready:*' }) -join ' ')
  $par = ReadyMs (($parOut | Where-Object { $_ -like 'Ready:*' }) -join ' ')
  $max = [Math]::Max($seq, $par)
  "sequential {0} {1:N0} ms" -f ('#' * [Math]::Max(1, [int]($seq / $max * 50))), $seq
  "parallel   {0} {1:N0} ms" -f ('#' * [Math]::Max(1, [int]($par / $max * 50))), $par
  "parallel was {0:N2}x faster on this run (single run; use the benchmark for averages)" -f ($seq / $par)
  OrphanCheck
}
function Demo-Adaptive {
  Bold "2. Adaptive decision: wide graph vs linear chain"
  Run @("plan", "--config", "samples/wide.yml")
  Run @("plan", "--config", "samples/linear.yml")
  Run @("up", "--config", "samples/wide.yml", "--exit-after-ready", "--quiet")
  OrphanCheck
}
function Demo-MaxParallel {
  Bold "3. Resource limit: --max-parallel 2 on the wide graph"
  Run @("up", "--config", "samples/wide.yml", "--algorithm", "parallel", "--max-parallel", "2", "--exit-after-ready", "--quiet")
  OrphanCheck
}
function Demo-Restart {
  Bold "4. Crash recovery: restart on-failure, max_retries 2"
  $log = Join-Path $LogDir "restart.log"
  StartUp @("up", "--config", "samples/restart.yml", "--plain") $log | Out-Null
  if (-not (WaitFor $log 'service:failed crashing' 15)) { Note "timed out waiting for retry exhaustion" }
  Select-String -Path $log -Pattern '^(service:(starting|ready|restarting|failed)|Ready:)' | ForEach-Object { $_.Line }
  Note "Stopping it with 'serviceboot down' (Windows uses taskkill /T /F on the CLI tree)."
  Run @("down")
  OrphanCheck
}
function Demo-Crash {
  Bold "5. Startup crash: api dies before it becomes ready"
  Run @("up", "--config", "samples/crash.yml", "--exit-after-ready", "--plain")
  Note "Expected: service:failed api reason=crash, exit code 3."
  OrphanCheck
}
function Demo-BusyPort {
  Bold "6. Busy port: something already listens on 4101"
  $intruder = Start-Process -FilePath node -ArgumentList @("mock/mock-service.js", "--port", "4101", "--name", "intruder") -NoNewWindow -PassThru
  $Owned.Add($intruder.Id)
  Start-Sleep -Milliseconds 700
  Run @("up", "--config", "samples/small.yml", "--exit-after-ready", "--plain")
  Stop-Process -Id $intruder.Id -Force -ErrorAction SilentlyContinue
  OrphanCheck
}
function Demo-HardKill {
  Bold "7. Hard-killed CLI, then 'serviceboot down' recovers the orphans"
  $log = Join-Path $LogDir "hardkill.log"
  $p = StartUp @("up", "--config", "samples/small.yml", "--plain") $log
  if (-not (WaitFor $log '^Ready:' 20)) { Note "timed out waiting for Ready" }
  Stop-Process -Id $p.Id -Force   # kills only the CLI process, not its children
  Start-Sleep -Milliseconds 500
  Note "The CLI is gone; its services are orphans:"
  OrphanCheck
  Get-Content .serviceboot/pids.json
  Run @("down")
  OrphanCheck
}
function Demo-Benchmark {
  Bold "8. Benchmark + charts"
  Run @("benchmark", "--runs", "3", "--out", "results/results.json")
  & python scripts/charts.py results/results.json --out charts
}

try {
  switch ($Demo) {
    "race" { Demo-Race }
    "adaptive" { Demo-Adaptive }
    "max-parallel" { Demo-MaxParallel }
    "restart" { Demo-Restart }
    "crash" { Demo-Crash }
    "busy-port" { Demo-BusyPort }
    "hard-kill" { Demo-HardKill }
    "benchmark" { Demo-Benchmark }
    "all" { Demo-Race; Demo-Adaptive; Demo-MaxParallel; Demo-Restart; Demo-Crash; Demo-BusyPort; Demo-HardKill }
    default { "usage: .\demos\demo.ps1 [all|race|adaptive|max-parallel|restart|crash|busy-port|hard-kill|benchmark]"; exit 2 }
  }
} finally {
  foreach ($id in $Owned) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  & node bin/serviceboot.js down | Out-Null
  Remove-Item -Recurse -Force $LogDir -ErrorAction SilentlyContinue
}
