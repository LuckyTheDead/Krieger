$ErrorActionPreference = 'SilentlyContinue'
# Is the agent daemon actually resident, or did the task exit after --once?
#
# The scheduler writes no pid file and no scheduler.log of its own -- it only
# appends to runs.jsonl -- so task state plus the run log are the evidence
# available. That is not enough on its own: a task can show "Running" briefly.
#
# So look for the live node process directly, via tasklist (which needs no WMI
# filter and therefore no quoting gymnastics) and by watching CPU accumulate.
Write-Output '=== node processes ==='
Get-Process node -EA SilentlyContinue |
  ForEach-Object {
    $age = [int]((Get-Date) - $_.StartTime).TotalMinutes
    Write-Output ("  pid={0,-6} cpu={1,8:N1}s  uptime={2}min  rss={3:N0}MB" -f `
      $_.Id, $_.CPU, $age, ($_.WorkingSet64 / 1MB))
  }

Write-Output ''
Write-Output '=== is one of them the scheduler? (it must survive a CPU sample) ==='
$before = @{}
Get-Process node -EA SilentlyContinue | ForEach-Object { $before[$_.Id] = $_.CPU }
Start-Sleep -Seconds 15
$after = Get-Process node -EA SilentlyContinue
if (-not $after) { Write-Output '  no node processes at all'; exit 1 }
foreach ($p in $after) {
  $was = if ($before.ContainsKey($p.Id)) { $before[$p.Id] } else { $null }
  if ($null -eq $was) {
    Write-Output ("  pid={0} NEW since last sample" -f $p.Id)
  } else {
    $d = $p.CPU - $was
    Write-Output ("  pid={0,-6} cpu +{1:N1}s over 15s  age={2}min" -f $p.Id, $d, [int]((Get-Date) - $p.StartTime).TotalMinutes)
  }
}

Write-Output ''
Write-Output '=== run log ==='
$rl = "$env:USERPROFILE\tiny-agent-git\daemon\runs.jsonl"
if (Test-Path $rl) {
  Write-Output ("  {0} entries" -f (Get-Content $rl | Measure-Object -Line).Lines)
  Get-Content $rl -Tail 3 | ForEach-Object {
    if ($_.Length -gt 160) { Write-Output ("  " + $_.Substring(0, 160) + '...') }
    else { Write-Output "  $_" }
  }
}