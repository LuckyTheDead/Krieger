$ErrorActionPreference = 'SilentlyContinue'
# Report every listening TCP port with its owning process and, crucially, whether
# it is reachable from the LAN or only on loopback.
#
# The bind address is the whole point. A service on 127.0.0.1 is invisible to
# anyone else; the same service on 0.0.0.0 or :: answers every device on the
# network. That is a one-character difference with real consequences, so it is
# reported per port rather than as a total.
#
# Read-only. Emits one JSON object on stdout.

$rows = @()
# Key by (port, scope, process) so the same service bound to both 0.0.0.0 and ::
# collapses to one entry. Without this, sshd appears twice and the LAN count can
# exceed the total, which is the kind of wrong number that gets a report ignored.
$seen = @{}
foreach ($c in (Get-NetTCPConnection -State Listen)) {
  $proc = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { '<exited-or-system>' }
  $scope = if ($c.LocalAddress -in @('0.0.0.0', '::')) { 'ALL' } else { 'LOCAL' }
  $key = "$($c.LocalPort)|$scope|$name"
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $rows += [ordered]@{
    port    = [int]$c.LocalPort
    bind    = if ($scope -eq 'ALL') { '0.0.0.0' } else { [string]$c.LocalAddress }
    scope   = $scope
    process = $name
    pid     = [int]$c.OwningProcess
  }
}

# UDP too: a service can be reachable without ever appearing as a TCP listener.
$udp = @()
$seenU = @{}
foreach ($c in (Get-NetUDPEndpoint -EA SilentlyContinue)) {
  $proc = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
  $scope = if ($c.LocalAddress -in @('0.0.0.0', '::')) { 'ALL' } else { 'LOCAL' }
  $name = if ($proc) { $proc.ProcessName } else { '<exited-or-system>' }
  $key = "$($c.LocalPort)|$scope|$name"
  if ($seenU.ContainsKey($key)) { continue }
  $seenU[$key] = $true
  $udp += [ordered]@{
    port    = [int]$c.LocalPort
    bind    = if ($scope -eq 'ALL') { '0.0.0.0' } else { [string]$c.LocalAddress }
    scope   = $scope
    process = $name
    pid     = [int]$c.OwningProcess
  }
}

[ordered]@{
  when       = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
  computer   = $env:COMPUTERNAME
  listening  = @($rows | Sort-Object port, scope)
  udp        = @($udp | Sort-Object port, scope)
  lanPorts   = @($rows | Where-Object { $_.scope -eq 'ALL' } | Select-Object -ExpandProperty port -Unique)
} | ConvertTo-Json -Depth 4 -Compress