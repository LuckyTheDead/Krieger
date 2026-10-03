<#
.SYNOPSIS
  One-shot setup so this PC accepts SSH from the Termux phone on the LAN.

.DESCRIPTION
  Installs/starts OpenSSH Server, installs the phone's public key with the
  ACLs Windows requires, opens the firewall, and verifies the result.

  Safe to run more than once. Every step checks before it changes anything.

.NOTES
  Requires Administrator; it will re-launch itself elevated if needed.
  Run:  powershell -ExecutionPolicy Bypass -File setup-pscp.ps1
#>

[CmdletBinding()]
param(
  # The phone's public key. Override only to use a different key.
  [string]$PhoneKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICfd/APCJN7QmWlIVCzYtVZvAbZlMCYLvM7WBuPEpWc4 krieger@termux-samsung-a16',

  # Expected host key of the PC, so the phone can pin it. Empty = skip the pin.
  [string]$ExpectedHostKeyFingerprint = 'SHA256:MHmJTypl4TaqHXZFpFvyykH78al0DIq2WFr3H0z1qkM',

  # Set to $true to also turn OFF password login once keys work.
  [switch]$DisablePasswords
)

$ErrorActionPreference = 'Stop'
$script:Warnings = @()

# ---------------------------------------------------------------- helpers ---

function Write-Step  { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host "    OK   $m" -ForegroundColor Green }
function Write-Warn2 { param([string]$m) Write-Host "    WARN $m" -ForegroundColor Yellow; $script:Warnings += $m }
function Write-Bad   { param([string]$m) Write-Host "    FAIL $m" -ForegroundColor Red }

# Re-launch elevated. Without this, Add-WindowsCapability and the ACL work fail
# partway through and leave a half-configured server.
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host 'Requesting administrator rights...'
  $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($DisablePasswords) { $arg += ' -DisablePasswords' }
  Start-Process powershell -Verb RunAs -ArgumentList $arg
  exit
}

Write-Host ''
Write-Host '  PC <-> phone SSH setup' -ForegroundColor White
Write-Host "  user: $env:USERNAME  |  $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Write-Host ''

# ------------------------------------------- 1. OpenSSH server is present ---

Write-Step 'Checking OpenSSH Server'
$sshdCap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue |
           Select-Object -First 1

if (-not $sshdCap) {
  Write-Bad 'OpenSSH.Server capability not found on this Windows build.'
  Write-Host '       Install it from Settings > System > Optional features, then re-run.'
  exit 1
}

if ($sshdCap.State -ne 'Installed') {
  Write-Host '    not installed, installing (a few minutes)...'
  Add-WindowsCapability -Online -Name $sshdCap.Name | Out-Null
  Write-Ok 'OpenSSH Server installed'
} else {
  Write-Ok 'OpenSSH Server already installed'
}

$sshdExe = "$env:WINDIR\System32\OpenSSH\sshd.exe"
if (-not (Test-Path $sshdExe)) { Write-Bad "sshd.exe missing at $sshdExe"; exit 1 }
Write-Ok "sshd.exe at $sshdExe"

# ------------------------------------------------- 2. the service is running --

Write-Step 'Starting the sshd service'
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Bad 'sshd service missing even though the capability is installed.'
  Write-Host '       Try: Remove-WindowsCapability then re-run this script.'
  exit 1
}
if ($svc.StartType -ne 'Automatic') {
  Set-Service -Name sshd -StartupType Automatic
  Write-Ok 'startup set to Automatic'
} else { Write-Ok 'startup already Automatic' }

if ($svc.Status -ne 'Running') {
  Start-Service sshd
  Start-Sleep -Seconds 2
}
if ((Get-Service sshd).Status -eq 'Running') { Write-Ok 'sshd running' }
else { Write-Bad 'sshd did not start'; exit 1 }

# ------------------------------------------------------- 3. host key + port --

Write-Step 'Host key and listening port'
$hk = "$env:ProgramData\ssh\ssh_host_ed25519_key"
if (Test-Path $hk) {
  $fp = & ssh-keygen -lf $hk 2>$null
  Write-Ok "host key: $fp"
  if ($ExpectedHostKeyFingerprint) {
    if ($fp -match [regex]::Escape($ExpectedHostKeyFingerprint)) {
      Write-Ok 'fingerprint matches what the phone expects'
    } else {
      Write-Warn2 "fingerprint differs from the one the phone recorded ($ExpectedHostKeyFingerprint)."
      Write-Warn2 'That is fine if you reinstalled sshd. Tell the phone the new value before it pins it.'
    }
  }
} else {
  Write-Warn2 'no ed25519 host key yet; sshd generates it on first start'
}

$listen = (Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)
if ($listen) { Write-Ok 'port 22 is listening' }
else { Write-Warn2 'port 22 is not listening yet; it may need a moment or a restart' }

# ----------------------------------------------------------- 4. firewall ---

Write-Step 'Firewall'
$rule = Get-NetFirewallRule -Name 'sshd' -ErrorAction SilentlyContinue
if (-not $rule) {
  New-NetFirewallRule -Name 'sshd' `
    -DisplayName 'OpenSSH Server (sshd)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  Write-Ok 'inbound rule created for TCP 22'
} else {
  if ($rule.Enabled -ne 'True') { Enable-NetFirewallRule -Name 'sshd'; Write-Ok 'existing rule enabled' }
  else { Write-Ok 'rule already present and enabled' }
}

# If the network profile is Public, inbound is often still blocked at the
# profile level regardless of the rule, so name it rather than guess.
$prof = Get-NetConnectionProfile -ErrorAction SilentlyContinue
foreach ($p in $prof) {
  if ($p.NetworkCategory -eq 'Public') {
    Write-Warn2 "network profile on '$($p.InterfaceAlias)' is Public; some clients will be blocked."
    Write-Warn2 'Fix if needed: Set-NetConnectionProfile -InterfaceAlias <name> -NetworkCategory Private'
  }
}

# ---------------------------------------------------- 5. the authorized key --

Write-Step 'Installing the phone public key'

# THE part that breaks on Windows. sshd_config ends with:
#     Match Group administrators
#         AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
# So for an admin account the file in the user profile is IGNORED SILENTLY.
# We must write to whichever one this account actually reads.
$isAdmin = (New-Object Security.Principal.WindowsPrincipal `
            ([Security.Principal.WindowsIdentity]::GetCurrent())
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$targets = @()
if ($isAdmin) {
  $targets += Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
  $script:TargetsNote = 'admin path (ProgramData), because this account is in Administrators'
} else {
  $targets += (Join-Path $env:USERPROFILE '.ssh\authorized_keys')
  $script:TargetsNote = 'user path, because this account is not an Administrator'
}

# Always also write the user-profile file: harmless, and it keeps working if
# the account is ever removed from Administrators.
$userTarget = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
$targets += $userTarget
$targets = $targets | Select-Object -Unique

New-Item -ItemType Directory -Force -Path (Split-Path $userTarget -Parent) | Out-Null

foreach ($path in $targets) {
  $dir = Split-Path $path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  # No BOM, no CRLF, exactly one copy of the key. Windows OpenSSH silently
  # ignores a key file it cannot parse, and a trailing CR is enough to do it.
  $existing = @()
  if (Test-Path $path) {
    $existing = Get-Content $path -ErrorAction SilentlyContinue |
                Where-Object { $_ -and $_.Trim() -ne '' }
  }
  $hasKey = $existing | Where-Object { $_.Trim() -eq $PhoneKey.Trim() }

  if ($hasKey) {
    Write-Ok "key already present: $path"
  } else {
    $lines = @($existing) + $PhoneKey
    $text  = ($lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Ok "key written: $path"
  }
}

Write-Ok "using the $($script:TargetsNote)"

# ---------------------------------------------------------- 6. the ACLs ---

Write-Step 'Fixing permissions (this is where it usually fails)'

foreach ($path in $targets) {
  # Inheritance must be off, or SYSTEM/Administrators entries inherited from the
  # parent leave the file writable by too many principals.
  & icacls $path /inheritance:r | Out-Null

  if ($path -like '*administrators_authorized_keys') {
    # For the admin path the owner must be Administrators, not the user.
    & icacls $path /grant '*S-1-5-32-544:F' | Out-Null
    & icacls $path /setowner '*S-1-5-32-544' | Out-Null
  } else {
    & icacls $path /grant:r "$($env:USERNAME):(R)" | Out-Null
    # SYSTEM needs read, or sshd -- which runs as SYSTEM -- cannot read the file
    # at all and reports "bad permissions" while the key itself is correct.
    & icacls $path /grant:r '*S-1-5-18:(R)' | Out-Null
  }
  Write-Ok "ACL set: $path"
}

foreach ($dir in ($targets | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique)) {
  & icacls $dir /inheritance:r | Out-Null
  if ($dir -like '*ProgramData*') { & icacls $dir /grant '*S-1-5-32-544:(OI)(CI)F' | Out-Null }
  else { & icacls $dir /grant:r "$($env:USERNAME):(OI)(CI)(F)" | Out-Null }
  Write-Ok "dir ACL set: $dir"
}

# ------------------------------------------- 7. pubkey auth actually enabled --

Write-Step 'Confirming key authentication is allowed'
$conf = "$env:ProgramData\ssh\sshd_config"
if (Test-Path $conf) {
  $text = Get-Content $conf -Raw
  if ($text -match '(?m)^\s*PubkeyAuthentication\s+no') {
    (Get-Content $conf) -replace '(?m)^\s*PubkeyAuthentication\s+no', 'PubkeyAuthentication yes' |
      Set-Content $conf -Encoding ascii
    Write-Ok 'PubkeyAuthentication was off; enabled'
    Restart-Service sshd
  } else {
    Write-Ok 'PubkeyAuthentication already enabled'
  }

  # Confirm the file sshd will actually read exists, and say which one.
  $m = [regex]::Match($text, '(?ms)^Match\s+Group\s+administrators(.*?)(?=^\S|\z)')
  if ($m.Success) {
    if ($m.Groups[1].Value -match 'administrators_authorized_keys') {
      Write-Ok 'sshd will read administrators_authorized_keys for admin logins (written above)'
    } else {
      Write-Ok 'admin match block does not override the authorized_keys path'
    }
  }
} else {
  Write-Warn2 "no sshd_config at $conf"
}

# ----------------------------------------------- 8. optional: no passwords --

if ($DisablePasswords) {
  Write-Step 'Disabling password login'
  if (Test-Path $conf) {
    (Get-Content $conf) -replace '(?m)^\s*PasswordAuthentication\s+yes', 'PasswordAuthentication no' |
      Set-Content $conf -Encoding ascii
    Restart-Service sshd
    Write-Ok 'PasswordAuthentication set to no'
    Write-Warn2 'make sure the phone can log in BEFORE locking yourself out.'
  }
}

# ------------------------------------------------------------- 9. verify ---

Write-Step 'Verifying the PC can be reached on the LAN'
$addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
         Select-Object -ExpandProperty IPAddress -Unique

foreach ($a in $addrs) {
  $t = Test-NetConnection -ComputerName $a -Port 22 -WarningAction SilentlyContinue
  if ($t.TcpTestSucceeded) { Write-Ok "$a : 22 reachable" } else { Write-Warn2 "$a : 22 not reachable" }
}

$phone = Test-NetConnection -ComputerName '192.168.1.98' -Port 8022 -WarningAction SilentlyContinue
if ($phone.TcpTestSucceeded) {
  Write-Ok 'phone sshd (192.168.1.98:8022) is reachable from this PC'
} else {
  Write-Warn2 'phone sshd (192.168.1.98:8022) not reachable -- check both are on the same WiFi'
}

# ------------------------------------------------------------- summary ---

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host ''
Write-Host '  Tell the phone "done" and it will try to log in as: ' -ForegroundColor White
Write-Host "    $env:USERNAME@$($addrs | Select-Object -First 1)" -ForegroundColor White
Write-Host ''
Write-Host '  To undo everything later:' -ForegroundColor White
Write-Host '    Stop-Service sshd; Set-Service sshd -StartupType Disabled' -ForegroundColor DarkGray
Write-Host '    Remove-NetFirewallRule -Name sshd' -ForegroundColor DarkGray
Write-Host '    Remove-Item "$env:ProgramData\ssh\administrators_authorized_keys","$env:USERPROFILE\.ssh\authorized_keys" -ErrorAction SilentlyContinue' -ForegroundColor DarkGray
Write-Host ''

if ($script:Warnings.Count) {
  Write-Host "  $($script:Warnings.Count) warning(s) above -- read them before assuming success." -ForegroundColor Yellow
  Write-Host ''
}
