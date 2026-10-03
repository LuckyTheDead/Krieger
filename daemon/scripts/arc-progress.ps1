$ErrorActionPreference = 'SilentlyContinue'
# Is the ARC arm actually progressing, or stalled? Sample CPU twice with a gap
# and report the delta. A rising delta is work; flat is a hang; and a rising
# delta with a flat log is just buffering.
$p1 = Get-Process -Id 6984 -EA SilentlyContinue
if (-not $p1) { Write-Output 'NOT RUNNING'; exit }
$c1 = $p1.CPU; $r1 = $p1.WorkingSet64
Write-Output ("cpu0={0:N1} rss={1:N0}MB" -f $c1, ($r1/1MB))
Start-Sleep -Seconds 20
$p2 = Get-Process -Id 6984 -EA SilentlyContinue
if (-not $p2) { Write-Output 'EXITED DURING SAMPLE'; exit }
Write-Output ("cpu1={0:N1} rss={1:N0}MB" -f $p2.CPU, ($p2.WorkingSet64/1MB))
Write-Output ("delta_cpu={0:N1}s over 20s wall" -f ($p2.CPU - $c1))
$l = Get-Item C:\Users\${PC_USER}\arc80\d4.log
Write-Output ("log={0} bytes  mtime={1}" -f $l.Length, $l.LastWriteTime.ToString('HH:mm:ss'))
Write-Output ("wall-min={0:N0}  cpu-min={1:N0}" -f ((Get-Date) - $p1.StartTime).TotalMinutes, ($p1.CPU / 60))
Write-Output ("results-written={0}" -f (Test-Path C:\Users\${PC_USER}\arc80\obj_experiment.json))
