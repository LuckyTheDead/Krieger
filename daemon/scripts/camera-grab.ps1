$ErrorActionPreference = 'SilentlyContinue'
# Can ffmpeg see the webcam, and can it pull a frame? This is the honest test of
# whether a camera-based security system is even possible on this box.
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
if (-not $exe) { Write-Output 'NO FFMPEG'; exit 1 }
$ff = $exe.FullName

Write-Output "session=$((Get-Process -Id $PID).SessionId)"
Write-Output "ffmpeg=$ff"
Write-Output ''
Write-Output '=== DirectShow video devices ==='
# dshow needs a real sink or it exits without enumerating; NUL is the trick.
$list = & $ff -hide_banner -list_devices true -f dshow -i dummy 2>&1
$list | Select-String 'Camera|Webcam|video|Integrated' |
  ForEach-Object { '  ' + $_.ToString().Trim() }

Write-Output ''
Write-Output '=== attempt one frame ==='
$out = "$env:USERPROFILE\camera-probe.jpg"
Remove-Item $out -EA SilentlyContinue
# Try the friendly name first, then the generic device class.
foreach ($dev in @('Integrated Webcam', 'video=Integrated Webcam', 'video=Camera')) {
  $err = & $ff -hide_banner -loglevel error -f dshow -i $dev -frames:v 1 -y $out 2>&1
  if (Test-Path $out) {
    $fi = Get-Item $out
    Write-Output ("CAPTURE OK using '{0}': {1:N1} KB" -f $dev, ($fi.Length / 1KB))
    Write-Output ("path: {0}" -f $out)
    exit 0
  }
  Write-Output ("  '{0}' failed: {1}" -f $dev, (($err | Select-Object -First 1) -replace '\s+', ' '))
}
Write-Output 'CAPTURE FAILED from session 0'
Write-Output 'Expected: DirectShow needs an interactive desktop. Session 0 has none.'
Write-Output 'Fix: a scheduled task set to "Run only when user is logged on".'