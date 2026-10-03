$ErrorActionPreference = 'SilentlyContinue'
# Is the camera frame actually showing something, or is it black?
#
# This matters more than it looks. A working camera pointed at a dark room, or
# covered, produces a perfectly valid JPEG and would look identical to a working
# camera pointed at a lit hallway in any check that only asks "did a file
# appear". So measure the signal, don't infer it.
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
$ff = $exe.FullName
$src = "$env:USERPROFILE\camera-probe.jpg"

if (-not (Test-Path $src)) { Write-Output 'no probe frame'; exit 1 }

# signalstats reports per-frame luminance statistics in the log.
$log = & $ff -hide_banner -v error -i $src -vf "signalstats,metadata=print" -f null - 2>&1
$mean = $log | Select-String 'lavfi.signalstats.YAVG' | Select-Object -First 1
$std  = $log | Select-String 'lavfi.signalstats.YDIF' | Select-Object -First 1

Write-Output '=== luminance of the captured frame ==='
if ($mean) { Write-Output ('  ' + $mean.ToString().Trim()) } else { Write-Output '  (no signalstats output)' }
if ($std)  { Write-Output ('  ' + $std.ToString().Trim()) }

# Grab several frames over a few seconds: a person moving produces variation,
# a dark or covered lens does not.
Write-Output ''
Write-Output '=== 10 frames over 10s, frame-level YDIF (motion signal) ==='
$vals = & $ff -hide_banner -v error -f dshow -i "video=Integrated Webcam" `
         -vf "fps=1,signalstats,metadata=print" -t 10 -f null - 2>&1 |
       Select-String 'YDIF' |
       ForEach-Object {
         if ($_ -match '=(\d+\.?\d*)') { [double]$Matches[1] }
       }
if ($vals) {
  Write-Output ("  frames: {0}" -f $vals.Count)
  Write-Output ("  YDIF min/max/avg: {0:N1} / {1:N1} / {2:N1}" -f `
      ($vals | Measure-Object -Minimum).Minimum,
      ($vals | Measure-Object -Maximum).Maximum,
      ($vals | Measure-Object -Average).Average)
  $max = ($vals | Measure-Object -Maximum).Maximum
  if ($max -lt 2) {
    Write-Output '  verdict: essentially static -- dark room, lens covered, or nothing in view'
  } else {
    Write-Output '  verdict: frame content is VARYING, so the camera sees a live scene'
  }
} else {
  Write-Output '  no frames captured'
}