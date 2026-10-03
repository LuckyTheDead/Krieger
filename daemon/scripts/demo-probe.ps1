# Capability demo: gather real system facts and try a screenshot.
# Writes results as JSON so nothing depends on quote-parsing over the wire.

$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}

# --- identity / OS ---
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$out.computer = $cs.Name
$out.user     = [Environment]::UserName
$out.os       = $os.Caption
$out.version  = $os.Version
$out.build    = $os.BuildNumber
$out.arch     = $os.OSArchitecture
$out.installed = $os.InstallDate
$out.uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
$out.lastBoot = $os.LastBootUpTime
$out.cpu      = $cpu.Name
$out.cores    = "$($cpu.NumberOfCores) physical / $($cpu.NumberOfLogicalProcessors) logical"
$out.ramGB    = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
$out.hostname = $env:COMPUTERNAME

# --- storage ---
$disks = @()
foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
  $disks += [ordered]@{
    drive = $d.DeviceID
    totalGB = [math]::Round($d.Size / 1GB, 1)
    freeGB  = [math]::Round($d.FreeSpace / 1GB, 1)
    usedPct = [math]::Round((1 - ($d.FreeSpace / $d.Size)) * 100, 1)
    fs      = $d.FileSystem
  }
}
$out.disks = $disks

# --- network ---
$nets = @()
foreach ($n in (Get-NetIPConfiguration)) {
  $nets += [ordered]@{
    iface    = $n.InterfaceAlias
    ip       = ($n.IPv4Address | Select-Object -First 1).IPAddress
    gateway  = ($n.IPv4DefaultGateway | Select-Object -First 1).NextHop
  }
}
$out.network = $nets

$wifi = netsh wlan show interfaces
$out.wifi = (($wifi | Select-String -Pattern '^\s+(Name|State|Signal|Channel|Radio type)\s*:') -join ' | ') -replace '\s+', ' '

# --- processes ---
$procs = Get-Process | Where-Object { $_.CPU -ne $null } |
         Sort-Object -Property CPU -Descending | Select-Object -First 8
$out.topCpu = @($procs | ForEach-Object {
  [ordered]@{ name = $_.ProcessName; cpuSec = [math]::Round($_.CPU, 1); memMB = [math]::Round($_.WorkingSet64 / 1MB, 0) }
})
$out.processCount = (Get-Process).Count
$out.progCount    = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' |
                      Where-Object DisplayName).Count

# --- security posture, read-only ---
$fw = Get-NetFirewallProfile | Select-Object Name, Enabled
$out.firewall = @($fw | ForEach-Object { "$($_.Name)=$($_.Enabled)" })
$out.defender = (Get-MpComputerStatus).RealTimeProtectionEnabled
$bitlocker = Get-BitLockerVolume -MountPoint 'C:' | Select-Object -First 1
$out.bitlocker = if ($bitlocker) { $bitlocker.ProtectionStatus.ToString() } else { 'unknown' }
$out.lastLogon = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$out.sshPort22 = [bool](Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)

# --- screenshot attempt: the honest test, may legitimately fail over SSH ---
$shot = "$env:USERPROFILE\Documents\pc-screen.png"
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($b.Width -gt 0 -and $b.Height -gt 0) {
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $fi = Get-Item $shot
    $out.screenshot = "OK: $shot ($([math]::Round($fi.Length/1KB,1)) KB, $($b.Width)x$($b.Height))"
  } else {
    $out.screenshot = "NO DESKTOP: virtual screen reported $($b.Width)x$($b.Height) -- SSH session has no attached display"
  }
} catch {
  $out.screenshot = "FAILED: $($_.Exception.Message)"
}

# --- clock: proves when this ran, independent of any claim ---
$out.probeTime = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
$out.probeTz   = [System.TimeZoneInfo]::Local.Id

$out | ConvertTo-Json -Depth 5 | Set-Content "$env:USERPROFILE\probe.json" -Encoding UTF8
Write-Host "probe written"
