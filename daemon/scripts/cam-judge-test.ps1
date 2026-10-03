$ErrorActionPreference = 'SilentlyContinue'
# Exercise all three verdicts of cam-judge.ps1 against synthetic frames with
# known ground truth. The watcher is disabled during this, so nothing
# overwrites the frames between generation and judging.
#
# No param() block: an EMPTY param() is itself a parse error ("An expression was
# expected after '('"), which reads like a quoting fault rather than a typo.

$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$out = "$env:USERPROFILE\cammotion"

# Nothing may be watching while this runs.
Stop-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue
Disable-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue | Out-Null

$pass = 0; $fail = 0
function Check($label, $expect, $got) {
  # ${label} rather than $label: PowerShell reads the colon after a variable as
  # part of the name, so "$label: expected" is a parse error, not a format.
  if ($expect -eq $got) { Write-Host "  ok   ${label} -> $got"; $script:pass++ }
  else { Write-Host "  FAIL ${label}: expected ${expect}, got ${got}"; $script:fail++ }
}

function Gen($case) {
  Get-ChildItem $out -Filter 'm*.jpg' -EA SilentlyContinue | Remove-Item -Force
  switch ($case) {
    'dark'   { for ($i=1; $i -le 8; $i++) {
                 & $ff -hide_banner -v error -f lavfi -i "color=c=black:s=160x120:d=1" `
                   -frames:v 1 "$out\m$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null } }
    'static' { for ($i=1; $i -le 8; $i++) {
                 # '0x6a6a6a' renders at YAVG ~106 on this ffmpeg, comfortably
                 # clear of the guard threshold of 12. My first attempt used
                 # 0x50 + jitter, which measured YAVG=9 and tripped NO_SIGNAL --
                 # the guard was right and the fixture was wrong, not the other
                 # way round. The jitter mimics sensor noise so the frames are
                 # not byte-identical, with no object movement.
                 $g = 0x6a + ($i % 3)
                 & $ff -hide_banner -v error -f lavfi -i "color=c=$('{0:x6}' -f $g):s=160x120:d=1" `
                   -frames:v 1 "$out\m$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null } }
    'moving' { for ($i=1; $i -le 8; $i++) {
                 $x = 10 + $i * 14
                 & $ff -hide_banner -v error `
                   -f lavfi -i "color=c=0x808080:s=160x120:d=1" `
                   -f lavfi -i "color=c=white:s=40x40:d=1" `
                   -filter_complex "[0][1]overlay=$x`:40" -frames:v 1 `
                   "$out\m$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null } }
  }
}

function Verdict() {
  $o = & powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\cam-judge.ps1" -Quiet 2>&1 | Out-String
  foreach ($line in ($o -split "`n")) {
    if ($line -match 'SET VERDICT=(\w+)') { return $Matches[1] }
  }
  return 'NONE'
}

Write-Host '=== cam-judge.ps1 verdict tests ==='

Gen 'moving'; Check 'moving block reports MOTION' 'MOTION' (Verdict)
Gen 'static'; Check 'static scene reports STILL'  'STILL'  (Verdict)
Gen 'dark';   Check 'black scene reports NO_SIGNAL' 'NO_SIGNAL' (Verdict)

Write-Host ''
Write-Host "passed: $pass  failed: $fail"
if ($fail -eq 0) { exit 0 } else { exit 1 }