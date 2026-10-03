$ErrorActionPreference = 'SilentlyContinue'
# Identify the owner of each listening port. Read-only.
# A .ps1 file rather than a one-liner: nested quoting through ssh -> cmd ->
# powershell mangles backslashes and $vars before they arrive.

$ports = Get-NetTCPConnection -State Listen |
         Select-Object -ExpandProperty LocalPort -Unique |
         Sort-Object

foreach ($p in $ports) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -EA SilentlyContinue |
       Select-Object -First 1
  if (-not $c) { continue }
  $proc = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { '<exited or system>' }
  # 0.0.0.0 / :: means reachable from the network, not just loopback.
  $scope = if ($c.LocalAddress -in @('0.0.0.0', '::')) { 'ALL INTERFACES' } else { $c.LocalAddress }
  $flag = if ($scope -eq 'ALL INTERFACES' -and $p -ne 22) { '  <-- LAN-exposed' } else { '' }
  "{0,-6} {1,-22} {2}{3}" -f $p, $name, $scope, $flag
}