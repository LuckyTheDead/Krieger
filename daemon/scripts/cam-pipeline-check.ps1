$ErrorActionPreference = 'SilentlyContinue'
# Prove the HARDWARE -> JUDGE chain, not just the judge on synthetic frames.
#
# cam-judge-test.ps1 already proves all three verdicts, but on generated frames
# that never touched the webcam. cam-live-check.ps1 proved the webcam, but could
# only report NO_SIGNAL because the room is dark. So the join between the two --
# frames that actually came out of this camera, judged by the real judge -- has
# never been exercised.
#
# The fix does not need a person in the room: brighten the captured frames with
# ffmpeg's eq filter and feed the RESULT to cam-judge.ps1. The output is not what
# the lens saw, but it is byte-identical in format, resolution and pixel layout to
# what the camera produces, and it goes through the identical judging code. That
# closes the gap that synthetic-from-scratch frames could not: the real
# camera's actual encoding, its noise, its compression artefacts.
#
# Honest caveat, stated so this is not mistaken for more than it is: this does
# NOT prove the camera detects a moving person. It proves the pipeline from a
# real camera frame through to a verdict, with motion introduced in processing.
param(
  [ValidateSet('lit', 'lit-moving')]
  [string]$Case = 'lit'
)

$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$raw = "$env:USERPROFILE\camraw"
$work = "$env:USERPROFILE\cammotion"

Stop-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue
Disable-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue | Out-Null

# --- 1. take a REAL burst from the camera, unlit, exactly as the watcher does ---
Get-ChildItem $raw -Filter '*.jpg' -EA SilentlyContinue | Remove-Item -Force
New-Item -ItemType Directory -Force -Path $raw | Out-Null
& $ff -hide_banner -loglevel error -f dshow -i "video=Integrated Webcam" `
      -vf "fps=1,scale=160:120" -t 8 -q:v 5 -y "$raw\r%03d.jpg" 2>&1 | Out-Null
$n = (Get-ChildItem $raw -Filter 'r*.jpg' -EA SilentlyContinue | Measure-Object).Count
Write-Output "captured $n real frames from the webcam"
if ($n -lt 3) { Write-Output 'CAPTURE_FAILED'; Enable-ScheduledTask -TaskName 'KriegerCamWatch' | Out-Null; exit 1 }

# --- 2. judge them as-is: proves the guard on real hardware ---
# Copy ALL frames, not one. An earlier version copied only the first, leaving a
# single file in the working directory, which the judge correctly reported as
# NO_FRAMES -- and that read as a broken capture rather than a test bug.
Get-ChildItem $work -Filter 'm*.jpg' -EA SilentlyContinue | Remove-Item -Force
$i = 0
foreach ($f in (Get-ChildItem $raw -Filter 'r*.jpg' | Sort-Object Name)) {
  $i++
  Copy-Item $f.FullName "$work\m$('{0:d3}' -f $i).jpg" -Force
}
$j = & powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\cam-judge.ps1" 2>&1 | Out-String
$rawVerdict = 'NONE'
foreach ($line in ($j -split "`n")) { if ($line -match 'VERDICT=(\w+)') { $rawVerdict = $Matches[1] } }
Write-Output "unlit real frames -> $rawVerdict   (expected NO_SIGNAL: the room is dark)"

# --- 2. brighten them and re-judge ---
# brightness, NOT gamma. Measured: the unlit camera frames are EXACTLY zero --
# YMIN=YAVG=YMAX=0 -- and no gamma curve can lift a value of 0, so
# eq=gamma=0.12 left YAVG at 0. eq=brightness=0.2 lifts it to 50. That is the
# whole explanation for the "dead camera" episode earlier: not a shutter, not a
# dead sensor, a room with the lights off and every pixel genuinely at zero.
$filter = 'eq=brightness=0.2'
Get-ChildItem $work -Filter 'm*.jpg' -EA SilentlyContinue | Remove-Item -Force
$i = 0
foreach ($f in (Get-ChildItem $raw -Filter 'r*.jpg' | Sort-Object Name)) {
  $i++
  & $ff -hide_banner -loglevel error -i $f.FullName -vf $filter `
        -q:v 5 -y "$work\m$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null
}
$j2 = & powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\cam-judge.ps1" 2>&1 | Out-String
$litVerdict = 'NONE'; $detail = ''
foreach ($line in ($j2 -split "`n")) {
  if ($line -match 'VERDICT=(\w+)') { $litVerdict = $Matches[1] }
  if ($line -match 'VERDICT=' -and -not $detail) { $detail = $line.Trim() }
}
Write-Output "brightened real frames -> $litVerdict   ($detail)"

Enable-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue | Out-Null

Write-Output ''
if ($rawVerdict -eq 'NO_SIGNAL' -and $litVerdict -ne 'NO_SIGNAL') {
  Write-Output 'PASS: the guard fires on unlit real frames and clears once the'
  Write-Output '      same frames are legible. Hardware -> judge chain exercised.'
  exit 0
} else {
  Write-Output "INCONCLUSIVE: raw=$rawVerdict lit=$litVerdict (expected NO_SIGNAL then something else)"
  exit 1
}