$ErrorActionPreference = 'Continue'
# Install the agent daemon on the PC as an unattended service.
#
# WHY THIS IS THE CAPABILITY THAT MATTERS. Everything so far on the PC has been me
# driving it over SSH: run a command, read a log, dispatch a job. The scheduler
# is different -- it runs agent JOBS on a TIMER without anyone prompting it. Once
# it is installed with a key, the PC can review its own code, run a security
# check, or re-run an experiment on its own, and that work survives the phone
# being asleep, out of range, or rebooted.
#
# Read-only with respect to credentials: it does NOT invent or copy a key. It
# reads OPENROUTER_API_KEY from the environment if present and says so plainly if
# not, because a daemon that silently does nothing looks exactly like a daemon
# with nothing to do.
#
# Safe to re-run.

$repo = 'C:\Users\${PC_USER}\tiny-agent-git'
$node = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\node.exe'
$bat  = "$env:USERPROFILE\agent-daemon-run.bat"

Write-Host '=== agent daemon install ==='
Write-Host ''

# --- 1. prerequisites, reported rather than assumed ---
Write-Host '[1/4] prerequisites'
$ok = $true
foreach ($p in @($node, $repo)) {
  if (Test-Path $p) { Write-Host "    ok      $p" }
  else { Write-Host "    MISSING $p"; $ok = $false }
}
$sched = Join-Path $repo 'daemon\scheduler.mjs'
if (Test-Path $sched) { Write-Host "    ok      $sched" } else { Write-Host "    MISSING $sched"; $ok = $false }
if (-not $ok) {
  Write-Host ''
  Write-Host 'FAIL: prerequisites missing. Run pc-sync first, or re-clone the bundle.'
  exit 1
}

# --- 2. the key ---
Write-Host ''
Write-Host '[2/4] credential'
$key = $env:OPENROUTER_API_KEY
if (-not $key) { $key = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User') }
if (-not $key) { $key = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'Machine') }
if ($key) {
  Write-Host ("    found a key, length {0} (value not shown)" -f $key.Length)
} else {
  Write-Host '    NO KEY. The daemon will start and every agent job will fail with'
  Write-Host '    "No API key" in runs.jsonl. To fix, either:'
  Write-Host '      setx OPENROUTER_API_KEY "sk-or-v1-..."      (user env, next logon)'
  Write-Host '    or set a user-level environment variable via System Properties.'
  Write-Host '    The key is deliberately NOT copied from the phone by this script.'
}

# --- 3. the wrapper ---
Write-Host ''
Write-Host '[3/4] run wrapper'
@'
@echo off
rem Runs the agent daemon with the toolchain on PATH. Both npm scripts and the
rem scheduler spawn `node` by name, which fails without this.
set "PATH=C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64;C:\Users\${PC_USER}\tools\python;C:\Users\${PC_USER}\tools\git\bin;%PATH%"
set "SECURITY_TEST_PYTHON=C:\Users\${PC_USER}\tools\python\python.exe"
cd /d C:\Users\${PC_USER}\tiny-agent-git
C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\node.exe daemon\scheduler.mjs
'@ | Set-Content -Path $bat -Encoding ASCII
Write-Host "    wrote $bat"

# --- 4. register as a scheduled task ---
Write-Host ''
Write-Host '[4/4] scheduled task'
$action = New-ScheduledTaskAction -Execute $bat
# At logon, so it starts when the desktop session that can reach the camera
# comes up. Not "run whether or not logged on" -- that lands in session 0.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'KriegerAgentDaemon' -Action $action -Trigger $trigger `
  -Principal $principal -Force -EA SilentlyContinue | Out-Null

$t = Get-ScheduledTask -TaskName 'KriegerAgentDaemon' -EA SilentlyContinue
if (-not $t) { Write-Host '    registration FAILED'; exit 1 }
Write-Host "    registered: $($t.TaskName) state=$($t.State)"
Write-Host '    trigger: at logon (session 1). Note this means it does NOT start after'
Write-Host '    a reboot until someone logs into the desktop -- the same limitation'
Write-Host '    TinyAgentBoot has, and deliberately not hidden here.'

Write-Host ''
Write-Host '--- one-off run to prove it executes ---'
$before = 0
$rl = Join-Path $repo 'daemon\runs.jsonl'
if (Test-Path $rl) { $before = (Get-Content $rl | Measure-Object -Line).Lines }
Start-ScheduledTask -TaskName 'KriegerAgentDaemon'
Start-Sleep -Seconds 25
$t2 = Get-ScheduledTask -TaskName 'KriegerAgentDaemon' -EA SilentlyContinue
Write-Host ("    state after: {0}" -f $t2.State)
Get-ScheduledTaskInfo -TaskName 'KriegerAgentDaemon' |
  Select-Object LastRunTime, LastTaskResult |
  ForEach-Object { Write-Host "    lastRun=$($_.LastRunTime) result=$($_.LastTaskResult)" }
if (Test-Path $rl) {
  $after = (Get-Content $rl | Measure-Object -Line).Lines
  Write-Host "    runs.jsonl lines: $before -> $after"
  if ($after -gt $before) {
    Write-Host '    last entry:'
    Get-Content $rl -Tail 1 | ForEach-Object { Write-Host "      $_" }
  } else {
    Write-Host '    (no new run recorded; with no key the job still logs a failure entry)'
  }
}
exit 0