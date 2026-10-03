$ErrorActionPreference = 'SilentlyContinue'
$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$f = Get-ChildItem "$env:USERPROFILE\cammotion" -Filter 'm*.jpg' | Sort-Object Name | Select-Object -First 1
Write-Output "frame: $($f.FullName) ($($f.Length) bytes)"

$tmp = "$env:TEMP\ss-dbg.txt"
Remove-Item $tmp -EA SilentlyContinue
Write-Output "tmp path: $tmp"
Write-Output '--- running with metadata:print:file=$tmp ---'
& $ff -hide_banner -i $f.FullName -vf "signalstats,metadata=print:file=$tmp" -f null >$null 2>&1
Write-Output "file exists after run: $(Test-Path $tmp)"
if (Test-Path $tmp) {
  Write-Output "size: $((Get-Item $tmp).Length)"
  Get-Content $tmp | Select-Object -First 8 | ForEach-Object { '  | ' + $_ }
} else {
  Write-Output '  NO FILE -- so the temp path is the problem'
  Write-Output '  (metadata=print:file=X needs a path ffmpeg can write; TEMP may be odd here)'
}

Write-Output ''
Write-Output '--- alternative: write to stdout instead of a file ---'
$o = & $ff -hide_banner -v info -i $f.FullName -vf "signalstats,metadata=print:file=-" -f null - 2>&1 | Out-String
foreach ($line in ($o -split "`n")) {
  if ($line -match 'YAVG=([\d.]+)') { Write-Output "  YAVG=$($Matches[1]) via stdout"; break }
}