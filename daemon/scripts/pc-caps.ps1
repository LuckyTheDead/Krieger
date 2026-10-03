$ErrorActionPreference = 'SilentlyContinue'
# Read-only inventory of what this PC actually offers, so capabilities can be
# judged by measurement rather than by what is assumed to exist.
# Writes one JSON object to stdout.

$o = [ordered]@{}

# --- security posture ---
$o.bitlocker = @(
  Get-BitLockerVolume | ForEach-Object { "$($_.MountPoint)=$($_.ProtectionStatus)" }
)
$o.defender = (Get-MpComputerStatus).RealTimeProtectionEnabled
$o.uacEnabled = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').EnableLUA
$o.smartscreen = (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\SmartScreen').EnableSmartScreen
$o.rdp = [bool](Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -EA SilentlyContinue) -eq $false
$o.smbDisabled = ((Get-SmbServerConfiguration).EnableSMB2Protocol -eq $false)

# --- what is reachable on the LAN (is anything exposed beyond ssh?) ---
$o.listening = @(
  Get-NetTCPConnection -State Listen |
    Group-Object LocalPort |
    ForEach-Object { "$($_.Name) ($($_.Count))" } |
    Sort-Object
)

# --- sleep/hibernate settings: does this machine ever actually sleep? ---
$o.sleepTimeoutAc = (powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null | Select-String 'Current AC Power Setting').ToString().Trim()
# `powercfg` is an exe, not a cmdlet: it must be called as a command. Writing
# $powercfg makes PowerShell parse `/a` as division and the whole script fails
# to compile.
$o.sleepStates = @(& powercfg /a 2>$null | Select-String 'S3|S1|L1|Standby' | ForEach-Object { $_.ToString().Trim() })

# --- power: plugged in or on battery? decides if long jobs are safe ---
$b = Get-CimInstance Win32_Battery
$o.onBattery = if ($b) { $b.BatteryStatus -ne 2 } else { $false }
$o.upsPresent = [bool](Get-CimInstance Win32_UPSBattery -EA SilentlyContinue)

# --- disk health, since this now holds experiment output ---
$o.disks = @(
  Get-PhysicalDisk | ForEach-Object {
    "$($_.FriendlyName): $($_.HealthStatus) $($_.MediaType) $([math]::Round($_.Size/1GB,0))GB"
  }
)

# --- developer tooling actually present ---
$o.tools = @{}
foreach ($t in @('python', 'py', 'node', 'npm', 'git', 'gcc', 'cl', 'dotnet', 'java', 'javac', 'make', 'cmake', 'perl', 'ruby', 'go', 'rustc', 'docker', 'wsl')) {
  $p = (Get-Command $t -EA SilentlyContinue | Select-Object -First 1).Source
  if ($p) { $o.tools[$t] = $p }
}

# --- WSL, which would give a Linux env for anything Windows cannot run ---
$o.wsl = @(
  Get-ChildItem "$env:SystemRoot\System32\wsl.exe" -EA SilentlyContinue |
    ForEach-Object { 'present' }
)

$o | ConvertTo-Json -Depth 4