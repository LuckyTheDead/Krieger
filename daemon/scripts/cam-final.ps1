$ErrorActionPreference = 'SilentlyContinue'
# The camera streams 91 frames in 3s -- a full 30fps -- and every one is pure
# black. Device status OK, privacy Allow in all three registry locations. That is
# the signature of a physically covered lens: the pipeline works end to end, the
# sensor is simply not seeing photons.
#
# Confirm by checking whether the SENSOR is the problem versus the capture path,
# using the one other light-sensitive device on the machine. If the machine has
# no other camera, then software cannot distinguish "shutter shut" from "sensor
# dead", and that distinction needs eyes on the lid.
#
# Read-only.

Write-Output '=== every imaging device, not just class=Camera ==='
Get-PnpDevice -EA SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'camera|webcam|video|capture|image|scanner' } |
  ForEach-Object { "  [{0}] {1}" -f $_.Class, $_.FriendlyName }

Write-Output ''
Write-Output '=== does the device claim to be a UVC camera with a stream? ==='
$dev = Get-PnpDevice -Class Camera -EA SilentlyContinue | Select-Object -First 1
if ($dev) {
  "  instance: $($dev.InstanceId)"
  $key = "HKLM:\SYSTEM\CurrentControlSet\Enum\$($dev.InstanceId)"
  if (Test-Path $key) {
    # Device hardware IDs tell us the chip/driver family without guessing.
    (Get-ItemProperty $key -EA SilentlyContinue).HardwareIds |
      ForEach-Object { "  hw: $_" }
  } else {
    Write-Output '  (registry key not readable without admin; not diagnostic here)'
  }
}

Write-Output ''
Write-Output '=== brightness/exposure controls exposed by the driver ==='
# A working UVC camera usually exposes brightness and exposure. If the driver
# exposes nothing at all, that is consistent with a minimal or virtual device.
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
$ff = $exe.FullName
& $ff -hide_banner -f dshow -i "video=Integrated Webcam" -list_options true 2>&1 |
  Select-Object -First 20 | ForEach-Object { '  ' + $_.ToString().Trim() }