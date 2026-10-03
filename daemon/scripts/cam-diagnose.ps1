$ErrorActionPreference = 'SilentlyContinue'
# The camera opens and delivers valid full-resolution JPEGs, but every pixel is
# zero. Narrow down why. Three candidates, in the order they should be checked:
#
#   A. A PHYSICAL privacy shutter / lens cover on the laptop. Many laptops have
#      one; with it shut the camera still opens and returns pure black. Cannot be
#      detected by software -- needs eyes on the lid.
#   B. The camera privacy TOGGLE (the keyboard shortcut, or Settings > Privacy >
#      Camera > "Change" per-app). That usually yields a blocked/failed open,
#      not black frames, so it is less likely but cheap to rule out.
#   C. A driver or BIOS-level disable (Device Manager, or a BIOS camera switch).
#
# Everything here is read-only.

Write-Output '=== device state ==='
Get-PnpDevice -Class Camera -EA SilentlyContinue |
  ForEach-Object {
    "  {0}`n    status={1}  problemcode={2}  present={3}" -f `
      $_.FriendlyName, $_.Status, $_.ProblemCode, $_.Present
  }

Write-Output ''
Write-Output '=== any disabled/error camera devices (Device Manager view) ==='
Get-PnpDevice -EA SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'camera|webcam' -and $_.Status -ne 'OK' } |
  ForEach-Object { "  $($_.FriendlyName): status=$($_.Status) problem=$($_.ProblemCode)" }

Write-Output ''
Write-Output '=== camera privacy toggles ==='
# Win10 keeps BOTH a global value and a per-store value.
$paths = @(
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged'
)
foreach ($p in $paths) {
  $v = (Get-ItemProperty $p -Name Value -EA SilentlyContinue).Value
  if ($null -ne $v) { "  $p = $v" } else { "  $p = <not set>" }
}

Write-Output ''
Write-Output '=== how many frames does the camera give before it stalls? ==='
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
$ff = $exe.FullName
$test = "$env:LOCALAPPDATA\Temp\camtest"
New-Item -ItemType Directory -Force -Path $test | Out-Null
Get-ChildItem $test -Filter *.jpg -EA SilentlyContinue | Remove-Item -Force
& $ff -hide_banner -loglevel error -f dshow -i "video=Integrated Webcam" `
      -t 3 -q:v 2 -y "$test\t%03d.jpg" 2>&1 | Out-Null
$n = (Get-ChildItem $test -Filter *.jpg -EA SilentlyContinue | Measure-Object).Count
Write-Output "  frames in 3s: $n   (a live camera gives ~90 at 30fps)"
if ($n -eq 0) {
  Write-Output '  the device produced NO frames -- it opened but never streamed'
}

Write-Output ''
Write-Output '=== camera formats the driver offers ==='
& $ff -hide_banner -list_options true -f dshow -i "video=Integrated Webcam" 2>&1 |
  Select-String 'pixel_format|video_size|framerate' |
  Select-Object -First 6 | ForEach-Object { '  ' + $_.ToString().Trim() }