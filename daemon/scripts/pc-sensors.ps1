$ErrorActionPreference = 'SilentlyContinue'
# What can this PC actually SEE? A home security system is only as good as its
# sensors, so inventory them rather than assuming. Read-only.
$o = [ordered]@{}

# --- cameras ---
$cams = @()
foreach ($d in (Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'camera|webcam|video' })) {
  $cams += $d.Name
}
$o.cameras = $cams
$o.cameraCount = $cams.Count

# Does ffmpeg exist? Without it, motion detection needs a different route.
$o.ffmpeg = (Get-Command ffmpeg -EA SilentlyContinue).Source

# --- display / session: is there even a desktop to capture? ---
# An SSH session has no interactive window station, which is why CopyFromScreen
# failed earlier. A logged-on console session is a different story.
$o.sessions = @(
  (quser) 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ }
)

# --- audio / siren-capable output (for an alarm) ---
$o.audioDevices = @(
  Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name }
)

# --- GPIO / physical sensors: almost certainly absent on a desktop, but ask ---
$o.gpio = @(
  Get-CimInstance Win32_PnPEntity |
    Where-Object { $_.Name -match 'gpio|arduino|usb.serial|FTDI|CP210' } |
    ForEach-Object { $_.Name }
)

# --- network vantage: what would this box see on the LAN? ---
$o.ip = (Get-NetIPConfiguration |
         Where-Object { $_.IPv4Address } |
         Select-Object -First 1).IPv4Address.IPAddress

# --- existing state I should build on rather than duplicate ---
$o.existing = @(
  Get-ChildItem C:\Users\${PC_USER}\jobs -Directory -EA SilentlyContinue |
    ForEach-Object { $_.Name }
)

$o | ConvertTo-Json -Depth 4