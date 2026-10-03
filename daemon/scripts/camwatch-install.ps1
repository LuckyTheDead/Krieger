$ErrorActionPreference = 'SilentlyContinue'
# Register the periodic webcam watcher.
#
# A task that runs on a REPEAT trigger, because the interesting signal is what
# changes over time, not one capture. Default: every 5 minutes.
#
# It also runs the capture in the INTERACTIVE session (Interactive logon type,
# Limited run level), because DirectShow opens the camera more reliably there.
# Verified to work from session 0 as well, so this is defensive rather than
# strictly required.

$bat = "$env:USERPROFILE\camwatch.bat"
if (-not $bat) { $bat = "$env:USERPROFILE\camwatch.bat" }

if (-not (Test-Path $bat)) { Write-Output "MISSING: $bat"; exit 1 }

$action = New-ScheduledTaskAction -Execute $bat
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'KriegerCamWatch' -Action $action -Trigger $trigger `
  -Principal $principal -Force -EA SilentlyContinue | Out-Null

$t = Get-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue
if (-not $t) { Write-Output 'registration FAILED'; exit 1 }
Write-Output "registered: $($t.TaskName)  state=$($t.State)"
Write-Output "bat: $bat"

Write-Output '--- run once now, to confirm it produces frames ---'
Remove-Item "$env:USERPROFILE\camwatch.log" -EA SilentlyContinue
Start-ScheduledTask -TaskName 'KriegerCamWatch'
Start-Sleep -Seconds 20

$log = "$env:USERPROFILE\camwatch.log"
if (Test-Path $log) {
  Write-Output 'log:'
  Get-Content $log | ForEach-Object { "  $_" }
} else {
  Write-Output 'no log produced -- the task did not run'
}
Get-ScheduledTaskInfo -TaskName 'KriegerCamWatch' |
  Select-Object LastRunTime, LastTaskResult |
  ForEach-Object { "last run: $($_.LastRunTime)  result: $($_.LastTaskResult)" }