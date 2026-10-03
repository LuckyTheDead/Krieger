$ErrorActionPreference = 'SilentlyContinue'
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
$ff = $exe.FullName
$src = "$env:USERPROFILE\camera-probe.jpg"

Write-Output '=== does signalstats exist in this build? ==='
$filters = & $ff -hide_banner -filters 2>&1 | Select-String 'signalstats|blackdetect|freezedetect'
if ($filters) { $filters | ForEach-Object { '  ' + $_.ToString().Trim() } }
else { Write-Output '  (no matching filters listed)' }

Write-Output ''
Write-Output '=== raw signalstats output, unfiltered, to see what it says ==='
$log = & $ff -hide_banner -i $src -vf "signalstats" -f null - 2>&1
$log | Select-Object -Last 14 | ForEach-Object { '  ' + $_.ToString().Trim() }

Write-Output ''
Write-Output '=== blackdetect (does it call the frame black?) ==='
& $ff -hide_banner -i $src -vf "blackdetect=d=0.1:pix_th=0.10" -f null -f null 2>&1 |
  Select-Object -Last 6 | ForEach-Object { '  ' + $_.ToString().Trim() }

Write-Output ''
Write-Output '=== mean brightness via a scale+metadata filter, as a fallback ==='
& $ff -hide_banner -i $src -vf "scale=1:1,format=gray" -f rawvideo - 2>$null |
  ForEach-Object { if ($_) { "  single-pixel mean: $_" } } | Select-Object -First 1