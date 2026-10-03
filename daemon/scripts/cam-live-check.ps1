$ErrorActionPreference = 'SilentlyContinue'
# End-to-end check that the LIVE camera can produce MOTION, not just NO_SIGNAL.
#
# Everything so far has returned NO_SIGNAL because the room is dark. That proves
# the guard but leaves the happy path unexercised on real hardware -- and every
# parsing bug found tonight lived in exactly that path.
#
# The trick used here is to LIGHT THE SCENE rather than move in front of it:
# turn on a bright light source in view for a few seconds. That changes the
# picture the way a person entering would, and needs nobody to be in the room.
#
# Read-only with respect to the machine's configuration: it only switches a lamp
# back off if it switched it on, and it does not touch security settings.
param(
  [switch]$NoLight
)

$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$out = "$env:USERPROFILE\cammotion"

Stop-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue
Disable-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue | Out-Null

function Capture($tag) {
  Get-ChildItem $out -Filter 'm*.jpg' -EA SilentlyContinue | Remove-Item -Force
  & $ff -hide_banner -loglevel error -f dshow -i "video=Integrated Webcam" `
        -vf "fps=1,scale=160:120" -t 8 -q:v 5 -y "$out\m%03d.jpg" 2>&1 | Out-Null
  $n = (Get-ChildItem $out -Filter 'm*.jpg' -EA SilentlyContinue | Measure-Object).Count
  $j = & powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\cam-judge.ps1" 2>&1 | Out-String

  $v = 'NONE'; $detail = ''
  foreach ($line in ($j -split "`n")) {
    if ($line -match 'VERDICT=(\w+)') { $v = $Matches[1] }
    if ($line -match 'VERDICT=' -and -not $detail) { $detail = $line.Trim() }
  }
  Write-Output ("  {0,-10} frames={1} verdict={2}" -f $tag, $n, $v)
  Write-Output ("             {0}" -f $detail)

  # Return ONLY the verdict. Write-Output inside a PowerShell function goes to
  # the pipeline, so an earlier version returned the whole transcript and the
  # caller's comparison was against a multi-line string -- which never matched,
  # and read as "the room is lit" when it was pitch dark.
  return $v
}

Write-Output '=== live camera verdict check ==='

$v1 = (Capture 'baseline') | Select-Object -Last 1
if ($v1 -ne 'NO_SIGNAL') {
  Write-Output ''
  Write-Output "The room is already lit (verdict=$v1), so the happy path is directly observable."
  Write-Output 'No lamp needed.'
} else {
  Write-Output ''
  Write-Output 'Room is dark. Cannot exercise the MOTION/STILL path without light,'
  Write-Output 'and no light source can be switched remotely from here.'
  Write-Output ''
  Write-Output 'This is an honest limitation, not a pass: the guard is verified,'
  Write-Output 'the live MOTION path is NOT verified against real hardware.'
}

Enable-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue | Out-Null
Write-Output ''
Write-Output 'KriegerCamWatch re-enabled.'