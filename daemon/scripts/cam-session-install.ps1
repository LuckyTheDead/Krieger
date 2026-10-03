$ErrorActionPreference = 'Continue'
# Capture a frame from INSIDE the logged-on interactive session.
#
# Why: everything so far ran in session 0, which has no window station and no
# desktop. DirectShow still opened the device and produced valid JPEGs, but every
# frame measured pure black (YMIN=YMAX=YAVG=0) while a reference grey image read
# 128 through the identical code path. That is the signature of a device that
# initialises without a data path, which an interactive session supplies.
#
# A scheduled task set to run "only when the user is logged on" executes in
# session 1 and is the standard way to do camera capture on Windows. It also
# means the capture keeps working after a reboot without anyone logging in by
# hand -- provided the machine auto-logs in, which is a separate decision.
#
# This registers the task and runs it once as a test.

$outDir = "$env:USERPROFILE\camframes"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$grab = "$env:USERPROFILE\grab-in-session.ps1"

# The capture itself, as a standalone script the task can invoke.
@'
$ErrorActionPreference = 'SilentlyContinue'
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
$ff = $exe.FullName
$out = "$env:USERPROFILE\camframes\session1.jpg"
Remove-Item $out -EA SilentlyContinue
Write-Output "running in session $((Get-Process -Id $PID).SessionId)"
& $ff -hide_banner -loglevel error -f dshow -i "video=Integrated Webcam" `
      -frames:v 1 -q:v 3 -y $out 2>&1
if (Test-Path $out) {
  Write-Output ("captured: {0:N0} bytes" -f (Get-Item $out).Length)
} else {
  Write-Output 'capture failed'
}
'@ | Set-Content -Path $grab -Encoding UTF8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$grab`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# RunLevel Limited + Interactive token is what puts this in session 1. A task
# that runs whether or not the user is logged on lands in session 0 again, which
# is the state we are trying to escape.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'KriegerCamGrab' -Action $action -Trigger $trigger `
  -Principal $principal -Force -EA SilentlyContinue | Out-Null

$t = Get-ScheduledTask -TaskName 'KriegerCamGrab' -EA SilentlyContinue
if ($t) {
  Write-Output "registered: $($t.TaskName) state=$($t.State)"
} else {
  Write-Output 'registration failed'
  exit 1
}

Write-Output '--- running it now (should land in session 1) ---'
Start-ScheduledTask -TaskName 'KriegerCamGrab'
Start-Sleep -Seconds 12

$f = "$outDir\session1.jpg"
if (Test-Path $f) {
  Write-Output ("OK: {0:N0} bytes at {1}" -f (Get-Item $f).Length, $f)
} else {
  Write-Output 'no file produced'
}
Get-ScheduledTaskInfo -TaskName 'KriegerCamGrab' |
  Select-Object LastRunTime, LastTaskResult |
  ForEach-Object { "last run: $($_.LastRunTime) result: $($_.LastTaskResult)" }