$ErrorActionPreference = 'SilentlyContinue'
# What exactly does signalstats print, and where does it go?
# Earlier attempts got nothing, and the motion detector then reported an empty
# mean -- which its dark-frame guard correctly turned into a false NO_SIGNAL
# alarm. A guard fed an empty reading is worse than no guard, because it looks
# like a real result.
$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$f = (Get-ChildItem "$env:USERPROFILE\cammotion" -Filter 'm*.jpg' |
      Sort-Object Name | Select-Object -First 1)

Write-Output "ffmpeg : $ff"
Write-Output "sample : $($f.FullName)  ($($f.Length) bytes)"

Write-Output ''
Write-Output '--- variant 1: metadata=print:file=- with stderr merged ---'
$o = & $ff -hide_banner -v error -i $f.FullName `
      -vf "signalstats,metadata=print:file=-" -f null - 2>&1
Write-Output ("  lines: {0}" -f @($o).Count)
$o | Select-Object -First 6 | ForEach-Object { '  | ' + $_.ToString().Trim() }

Write-Output ''
Write-Output '--- variant 2: print to a temp file, then read it ---'
$tmp = "$env:TEMP\ss.txt"
Remove-Item $tmp -EA SilentlyContinue
& $ff -hide_banner -v error -i $f.FullName `
      -vf "signalstats,metadata=print:file=$tmp" -f null 2>&1 | Out-Null
if (Test-Path $tmp) {
  Write-Output ("  file size: {0}" -f (Get-Item $tmp).Length)
  Get-Content $tmp | Select-Object -First 8 | ForEach-Object { '  | ' + $_.Trim() }
} else {
  Write-Output '  NO FILE WRITTEN'
}

Write-Output ''
Write-Output '--- variant 3: the no-arg fallback, which prints to stderr ---'
$o3 = & $ff -hide_banner -i $f.FullName -vf "signalstats,metadata=print" -f null - 2>&1
Write-Output ("  lines: {0}" -f @($o3).Count)
$o3 | Select-String 'YAVG|YMIN|YMAX' | Select-Object -First 4 |
  ForEach-Object { '  | ' + $_.ToString().Trim() }