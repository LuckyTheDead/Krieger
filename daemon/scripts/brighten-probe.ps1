$ErrorActionPreference = 'SilentlyContinue'
# Find a filter chain that actually lifts the near-black real camera frames above
# the guard threshold of 12/255. Measured rather than assumed: the first attempt
# used eq=gamma=0.12 and the result stayed at mean 0.0.
$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$f = Get-ChildItem "$env:USERPROFILE\camraw" -Filter 'r*.jpg' -EA SilentlyContinue |
     Sort-Object Name | Select-Object -First 1
if (-not $f) { Write-Output 'no real frames captured yet'; exit 1 }
Write-Output "sample: $($f.Name) ($($f.Length) bytes)"

$tmp = "$env:TEMP\yprobe.jpg"
$chains = @(
  'null',
  'eq=gamma=0.12',
  'eq=gamma=0.05',
  'eq=gamma=0.02',
  'eq=brightness=0.2',
  'eq=gamma=0.01:brightness=0.1',
  'eq=gamma=0.005:brightness=0.3',
  'eq=normalize=blackpt=black:whitept=white'
)
foreach ($c in $chains) {
  if ($c -eq 'null') {
    Copy-Item $f.FullName $tmp -Force
  } else {
    & $ff -hide_banner -loglevel error -i $f.FullName -vf $c -q:v 3 -y $tmp 2>&1 | Out-Null
  }
  $o = & $ff -hide_banner -v info -i $tmp -vf "signalstats,metadata=print:file=-" -f null - 2>&1 | Out-String
  $y = '?'
  foreach ($l in ($o -split "`n")) { if ($l -match 'YAVG=([\d.]+)') { $y = $Matches[1]; break } }
  $sz = (Get-Item $tmp).Length
  Write-Output ("  {0,-40} YAVG={1,-8} {2} bytes" -f $c, $y, $sz)
}