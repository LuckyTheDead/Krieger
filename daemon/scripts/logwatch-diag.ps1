$ErrorActionPreference = 'SilentlyContinue'
# Why is logwatch.log never created? The task ran with result 0, so it succeeded,
# but the redirect target did not appear. Check each link in the chain rather than
# assume the watcher is broken.

Write-Output '=== task state and last result ==='
$t = Get-ScheduledTask -TaskName 'KriegerLogWatch' -EA SilentlyContinue
if ($t) {
  Write-Output ("  state={0}" -f $t.State)
  Get-ScheduledTaskInfo -TaskName 'KriegerLogWatch' |
    Select-Object LastRunTime, LastTaskResult, LastTaskMessage, NumberOfMissedRuns |
    ForEach-Object {
      Write-Output ("  lastRun={0}  result={1}" -f $_.LastRunTime, $_.LastTaskResult)
      Write-Output ("  message={0}" -f $_.LastTaskMessage)
      Write-Output ("  missedRuns={0}" -f $_.NumberOfMissedRuns)
    }
  Write-Output ''
  Write-Output '=== the exact action the task runs ==='
  $a = $t.Actions | Select-Object -First 1
  Write-Output ("  execute  : {0}" -f $a.Execute)
  Write-Output ("  arguments: {0}" -f $a.Arguments)
} else {
  Write-Output '  TASK NOT REGISTERED'
}

Write-Output ''
Write-Output '=== does the log path exist / is it writable? ==='
foreach ($p in @("$env:USERPROFILE\logwatch.log", "$env:USERPROFILE\logon-watch-state.json")) {
  $d = Split-Path $p -Parent
  Write-Output ("  {0}" -f $p)
  Write-Output ("    dir exists : {0}" -f (Test-Path $d))
  Write-Output ("    file exists: {0}" -f (Test-Path $p))
}
Write-Output ("  USERPROFILE={0}" -f $env:USERPROFILE)

Write-Output ''
Write-Output '=== run the action MYSELF, verbatim, to see what it prints ==='
if ($t) {
  $a = $t.Actions | Select-Object -First 1
  Write-Output ("  > {0} {1}" -f $a.Execute, $a.Arguments)
  $out = & $a.Execute $a.Arguments.Split(' ') 2>&1 | Out-String
  Write-Output ("  output: '{0}'" -f $out.Trim())
  Write-Output ("  log exists after: {0}" -f (Test-Path "$env:USERPROFILE\logwatch.log"))
}