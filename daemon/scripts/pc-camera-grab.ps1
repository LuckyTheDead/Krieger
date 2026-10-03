$ErrorActionPreference = 'Stop'
# Attempt a real webcam capture and save one JPEG.
#
# This MUST run as the LOGGED-ON user in session 1. From an SSH session we are
# in session 0, which has no window station -- that is why CopyFromScreen failed
# with "The handle is invalid". A service, or a scheduled task set to run only
# when the user is logged on, gets the real desktop.
#
# If this reports "session 0", the capture route is closed from here and the
# capture has to be moved into a task that runs in the interactive session.

Write-Output "session=$((Get-Process -Id $PID).SessionId)"
$out = "$env:USERPROFILE\camera-probe.jpg"

try {
  Add-Type -AssemblyName System.Drawing
  # WIA-style enumeration: find the first device that claims to be a camera.
  $devices = [System.Runtime.InteropServices.Marshal]::GetActiveObject("WIA.DeviceManager")
} catch {
  # WIA is not always registered; fall back to DirectShow via ffmpeg if present.
  Write-Output "WIA unavailable: $($_.Exception.Message)"
  $devices = $null
}

if ($devices) {
  Write-Output "WIA device manager reachable"
}

# The honest path: System.Drawing cannot open a video device, so use ffmpeg if
# present. Without ffmpeg there is no way to pull frames on this box yet.
$ff = (Get-Command ffmpeg -EA SilentlyContinue).Source
if (-not $ff) { $ff = "$env:USERPROFILE\tools\ffmpeg\bin\ffmpeg.exe" }

if (Test-Path $ff) {
  Write-Output "ffmpeg: $ff"
  # List DirectShow video devices.
  & $ff -hide_banner -list_devices true -f dshow -i dummy 2>&1 |
    Select-String 'Camera|Integrated|video' | ForEach-Object { "  $($_.ToString().Trim())" }
  # Grab a single frame.
  & $ff -hide_banner -loglevel error -f dshow -i video="Integrated Webcam" -frames:v 1 -y $out 2>&1
  if (Test-Path $out) {
    $fi = Get-Item $out
    Write-Output "CAPTURE OK: $out ($([math]::Round($fi.Length/1KB,1)) KB)"
  } else {
    Write-Output "CAPTURE FAILED: no file produced"
  }
} else {
  Write-Output "NO FFMPEG. Cannot capture a frame on this box yet."
  Write-Output "Install route: a static ffmpeg build into tools\ffmpeg (no installer needed)."
}