$ErrorActionPreference = 'SilentlyContinue'
$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$out = "$env:USERPROFILE\cammontest2"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -Filter '*.jpg' -EA SilentlyContinue | Remove-Item -Force

# Reproduce the 'static' fixture and measure each frame's real mean.
for ($i=1; $i -le 8; $i++) {
  $g = 0x50 + ($i % 3)
  & $ff -hide_banner -v error -f lavfi -i "color=c=$('{0:x6}' -f $g):s=160x120:d=1" `
    -frames:v 1 "$out\s$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null
}
Write-Host 'generated:'
Get-ChildItem $out -Filter '*.jpg' | ForEach-Object {
  $o = & $ff -hide_banner -v info -i $_.FullName `
       -vf "signalstats,metadata=print:file=-" -f null - 2>&1 | Out-String
  $m = 'PARSE_FAIL'
  foreach ($line in ($o -split "`n")) { if ($line -match 'YAVG=([\d.]+)') { $m = $Matches[1]; break } }
  Write-Host ("  {0}  {1} bytes  YAVG={2}" -f $_.Name, $_.Length, $m)
}
Write-Host ''
Write-Host 'guard threshold is 12; if these read near 0 the fixture is not grey at all'