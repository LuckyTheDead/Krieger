$ErrorActionPreference = 'SilentlyContinue'
# Why does the watcher keep reporting a growing backlog? Diagnose rather than
# guess. Three candidate causes, each distinguished here:
#   A. the high-water mark is not advancing (state write broken)
#   B. RecordId is not a valid ordering key across event ids
#   C. genuinely new events keep arriving each run

$saved = (Get-Content "$env:USERPROFILE\logon-watch-state.json" -Raw | ConvertFrom-Json).recordIds

Write-Output '=== recorded marks ==='
foreach ($p in $saved.PSObject.Properties) { Write-Output ("  {0} -> {1}" -f $p.Name, $p.Value) }

Write-Output ''
Write-Output '=== highest RecordId per watched id, as the log actually has it ==='
foreach ($id in @(1102, 4624, 4625, 4672, 4697, 4720, 4726, 4728, 4732, 7045)) {
  $e = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=$id } -MaxEvents 1 -EA SilentlyContinue |
       Select-Object -First 1
  if ($e) {
    Write-Output ("  {0,-6} newest RecordId={1,-8} at {2:HH:mm:ss}" -f $id, $e.RecordId, $e.TimeCreated)
  }
}

Write-Output ''
Write-Output '=== how many 4624 sit above the recorded 4624 mark? ==='
$m = [int64]$saved.'4624'
$all = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4624 } -EA SilentlyContinue
Write-Output ("  total 4624 in log      : {0}" -f @($all).Count)
Write-Output ("  recorded mark for 4624 : {0}" -f $m)
Write-Output ("  with RecordId > mark   : {0}" -f @($all | Where-Object { $_.RecordId -gt $m }).Count)
Write-Output ("  max RecordId among them: {0}" -f (($all | Where-Object { $_.RecordId -gt $m } | Measure-Object RecordId -Maximum).Maximum))

Write-Output ''
Write-Output '=== the point: RecordId is per-LOG, not per-event-id ==='
Write-Output '  So comparing a 4624 mark against a 4672 event is meaningless,'
Write-Output '  and a single global "last seen RecordId" is the correct design.'
$newest = (Get-WinEvent -LogName Security -MaxEvents 1).RecordId
Write-Output ("  newest RecordId in the whole log: {0}" -f $newest)