$ErrorActionPreference = 'SilentlyContinue'
# One place to see whether the security watchers are actually alive, rather than
# inferring it from task state -- a task can be Ready, return result 0, and
# produce no output at all. That happened: the logwatch redirect lived inside a
# PowerShell argument, so it ran "successfully" forever and never wrote a file.
#
# So this checks the ARTIFACTS, not the tasks.

Write-Output '=== scheduled tasks ==='
foreach ($n in @('TinyAgentBoot', 'KriegerCamGrab', 'KriegerCamWatch', 'KriegerLogWatch')) {
  $t = Get-ScheduledTask -TaskName $n -EA SilentlyContinue
  if ($t) {
    $i = Get-ScheduledTaskInfo -TaskName $n -EA SilentlyContinue
    Write-Output ("  {0,-18} {1,-8} lastRun={2} result={3}" -f `
      $n, $t.State, $i.LastRunTime.ToString('MM-dd HH:mm:ss'), $i.LastTaskResult)
  } else {
    Write-Output ("  {0,-18} NOT REGISTERED" -f $n)
  }
}

Write-Output ''
Write-Output '=== artifacts (the real evidence) ==='
foreach ($f in @(
    @{ n = 'camwatch.log';    d = 'camera verdicts' },
    @{ n = 'logwatch.log';    d = 'security events' },
    @{ n = 'tiny-agent-boot.log'; d = 'phone boot hook' })) {
  foreach ($base in @("$env:USERPROFILE", 'C:\Users\${PC_USER}')) {
    $p = Join-Path $base $f.n
    if (Test-Path $p) {
      $i = Get-Item $p
      Write-Output ("  {0,-22} {1,9:N0} bytes  modified {2}  ({3})" -f `
        $f.n, $i.Length, $i.LastWriteTime.ToString('HH:mm:ss'), $f.d)
      break
    }
  }
}

Write-Output ''
Write-Output '=== recent camera verdicts ==='
$cp = "$env:USERPROFILE\camwatch.log"
if (Test-Path $cp) { Get-Content $cp -Tail 4 | ForEach-Object { "  $_" } }

Write-Output ''
Write-Output '=== recent security events ==='
$lp = "$env:USERPROFILE\logwatch.log"
if (Test-Path $lp) {
  Get-Content $lp -Tail 6 | ForEach-Object { "  $_" }
} else {
  Write-Output '  logwatch.log ABSENT -- the watcher is not writing, which is a fault'
}