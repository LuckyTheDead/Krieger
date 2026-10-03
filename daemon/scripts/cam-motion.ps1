# Motion detection over the webcam, reporting three states rather than two.
#
# The shape of this is dictated by a bug that actually happened here: a camera
# returning a valid but BLACK frame is indistinguishable from "nothing is
# happening" to any naive change detector. That occurred in practice, and I
# wrongly diagnosed it as hardware failure. So this reports:
#
#   MOTION     content changed beyond threshold while the picture is valid
#   STILL      picture is valid, and content is not changing
#   NO_SIGNAL  picture is too dark or flat to conclude anything -- which is
#              what a covered, disabled or badly-lit camera looks like
#
# A system that says "all quiet" when it cannot see is worse than one that never
# started, because it gets trusted.
#
# Motion is measured on the PHONE, from the frames captured here. Comparing
# pixels through this shell pipe was unreliable (signalstats YDIF did not
# survive extraction), and a real pixel diff is both more honest and testable.
# So the PC's job is capture, and the phone's job is judgement.
#
# Read-only: captures frames and reports. Changes nothing on the PC.

# The parameter block must be the first executable statement in a .ps1. Putting it
# after $ErrorActionPreference caused "The assignment expression is not valid" --
# a parse error producing NO output at all, which my wrapper then reported as
# UNREACHABLE. A parse failure and an unreachable host look identical downstream,
# so this must be emitted as a real state, not silence.
param(
  [int]$Seconds = 10,
  # Frames below this mean luminance cannot be judged for motion.
  [double]$MinMeanLuma = 12.0
)

$ErrorActionPreference = 'SilentlyContinue'

$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
if (-not $exe) { Write-Output 'STATE=NO_FFMPEG'; exit 1 }
$ff = $exe.FullName

$seconds = if ($Seconds -gt 0) { $Seconds } else { 10 }
$outDir = "$env:USERPROFILE\cammotion"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Get-ChildItem $outDir -Filter '*.jpg' -EA SilentlyContinue |
  Remove-Item -Force -EA SilentlyContinue

# 1 fps, 160x120. Downscaling is not only about size: fewer pixels is what makes
# the diff cheap enough to run continuously.
& $ff -hide_banner -loglevel error -f dshow -i "video=Integrated Webcam" `
      -vf "fps=1,scale=160:120" -t $seconds -q:v 5 -y "$outDir\m%03d.jpg" 2>&1 | Out-Null

$frames = Get-ChildItem $outDir -Filter 'm*.jpg' -EA SilentlyContinue | Sort-Object Name
if ($frames.Count -lt 2) {
  Write-Output 'STATE=NO_FRAMES'
  Write-Output "captured=$($frames.Count)"
  exit 1
}

# Luminance per frame. PSCustomObject, NOT [ordered]@{}: Measure-Object -Property
# cannot reach into a hashtable's keys, so -Average came back EMPTY, and the
# dark-frame guard below then fired a confident false NO_SIGNAL on a scene
# averaging 112/255. A guard fed a missing reading produces a convincing wrong
# answer, which is worse than no guard at all.
$stats = @()
foreach ($f in $frames) {
  $s = & $ff -hide_banner -v error -i $f.FullName `
        -vf "signalstats,metadata=print:file=-" -f null - 2>&1
  $avg = $null; $max = $null
  foreach ($line in @($s)) {
    $str = [string]$line
    if ($str -match 'YAVG=([\d.]+)') { $avg = [double]$Matches[1] }
    if ($str -match 'YMAX=([\d.]+)') { $max = [double]$Matches[1] }
  }
  if ($null -eq $avg -or $null -eq $max) {
    Write-Output 'STATE=PARSE_ERROR'
    Write-Output "could not read luminance from $($f.Name); refusing to guess"
    exit 1
  }
  $stats += [PSCustomObject]@{ name = $f.Name; avg = [math]::Round($avg, 1); max = [math]::Round($max, 1) }
}

$meanAvg = ($stats | Measure-Object -Property avg -Average).Average
$maxLuma = ($stats | Measure-Object -Property max -Maximum).Maximum

# The guard, before any motion claim is made.
if ($meanAvg -lt $MinMeanLuma -or $maxLuma -lt 20) {
  Write-Output 'STATE=NO_SIGNAL'
  Write-Output ("MEAN_AVG={0:N1}" -f $meanAvg)
  Write-Output ("MAX_LUMA={0:N0}" -f $maxLuma)
  Write-Output 'REASON=picture too dark to tell an empty room from a covered lens'
  Write-Output 'ACTION=check the camera physically; this is NOT "all quiet"'
  exit 0
}

Write-Output 'STATE=OK'
Write-Output ("FRAMES={0}" -f $frames.Count)
Write-Output ("MEAN_AVG={0:N1}" -f $meanAvg)
Write-Output ("MAX_LUMA={0:N0}" -f $maxLuma)
Write-Output ("WINDOW={0}s" -f $seconds)
Write-Output 'FRAMELIST:'
foreach ($s in $stats) {
  Write-Output ("  {0} avg={1} max={2} bytes={3}" -f `
    $s.name, $s.avg, $s.max, (Get-Item (Join-Path $outDir $s.name)).Length)
}
# The phone pulls the frames and computes the actual diff. Emitting the manifest
# rather than a motion verdict keeps the judgement in one testable place.
Write-Output 'NEXT=pull frames and diff on the phone'