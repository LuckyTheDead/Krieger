$ErrorActionPreference = 'Continue'
# Register the Security-log watcher on a repeat trigger, alongside the camera
# watcher. Same reasoning: an intrusion that is only investigated afterwards is
# an intrusion that was already lost.
#
# Do NOT put ">> logfile 2>&1" in the -File argument. PowerShell receives it as
# part of the script PATH, so it is never a shell redirect -- the task ran with
# result 0 forever and produced no log file at all, which reads exactly like
# "the watcher is working and has nothing to report". The redirect has to live in
# a wrapper script, because that is the only place a shell actually parses it.
$wrapper = "$env:USERPROFILE\logon-watch-run.bat"
@'
@echo off
rem Wrapper so the redirect is parsed by cmd, not handed to PowerShell as text.
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\${PC_USER}\logon-watch.ps1 >> C:\Users\${PC_USER}\logwatch.log 2>&1
'@ | Set-Content -Path $wrapper -Encoding ASCII

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'KriegerLogWatch' -Action $action -Trigger $trigger `
  -Principal $principal -Force -EA SilentlyContinue | Out-Null

$t = Get-ScheduledTask -TaskName 'KriegerLogWatch' -EA SilentlyContinue
if (-not $t) { Write-Output 'registration FAILED'; exit 1 }
Write-Output "registered: $($t.TaskName) state=$($t.State)"
Write-Output "execute: $((($t.Actions | Select-Object -First 1).Execute))"
Write-Output 'every 2 minutes -> C:\Users\${PC_USER}\logwatch.log'

Write-Output '--- run once now, and REQUIRE the log to appear ---'
$log = "$env:USERPROFILE\logwatch.log"
Remove-Item $log -EA SilentlyContinue
Start-ScheduledTask -TaskName 'KriegerLogWatch'
Start-Sleep -Seconds 15
if (Test-Path $log) {
  Write-Output 'log created:'
  Get-Content $log | ForEach-Object { "  $_" }
} else {
  # Do not report success when the artifact is absent. An unwritten log is the
  # exact failure this was written to catch.
  Write-Output 'FAIL: task ran but no log file was produced'
  exit 1
}
Get-ScheduledTaskInfo -TaskName 'KriegerLogWatch' |
  Select-Object LastRunTime, LastTaskResult |
  ForEach-Object { "last run: $($_.LastRunTime) result: $($_.LastTaskResult)" }