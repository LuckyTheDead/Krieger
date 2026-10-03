$ErrorActionPreference = 'SilentlyContinue'
# Is there an interactive console session? This decides whether the webcam can
# be captured at all: an SSH session runs in session 0 with no window station,
# which is exactly why CopyFromScreen failed with "The handle is invalid".
# A logged-on console session has a real desktop, and a service running as the
# logged-on user can capture from it.

Write-Output "=== explorer.exe running? (proof of an interactive desktop) ==="
$expl = Get-Process explorer -EA SilentlyContinue
if ($expl) {
  Write-Output "YES - $($expl.Count) explorer process(es), session(s): $(($expl | Select-Object -ExpandProperty SessionId -Unique) -join ',')"
} else {
  Write-Output "NO - no explorer.exe, so there is no interactive desktop"
}

Write-Output ""
Write-Output "=== all processes by session id ==="
Get-Process -EA SilentlyContinue |
  Group-Object SessionId |
  ForEach-Object { "  session {0}: {1} processes" -f $_.Name, $_.Count }

Write-Output ""
Write-Output "=== camera device detail ==="
Get-PnpDevice -Class Camera -EA SilentlyContinue |
  ForEach-Object { "  $($_.FriendlyName)  status=$($_.Status)" }

Write-Output ""
Write-Output "=== can PowerShell enumerate capture devices? ==="
# If DirectShow is available we can enumerate, which tells us a capture route
# exists. Absence is not proof the camera is dead, only that this route is shut.
try {
  Add-Type -AssemblyName System.Windows.Forms -EA Stop
  $ok = $true
} catch {
  $ok = $false
}
Write-Output "  System.Windows.Forms loadable: $ok"

Write-Output ""
Write-Output "=== microphone/camera privacy setting (Win10 can disable both) ==="
$cam = Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam' -EA SilentlyContinue
Write-Output "  webcam consent value: $(if($cam){$cam.Value}else{'<not set>'})"
$m = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam' -EA SilentlyContinue
Write-Output "  machine-level webcam consent: $(if($m){$m.Value}else{'<not set>'})"