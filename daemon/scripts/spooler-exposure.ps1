$ErrorActionPreference = 'SilentlyContinue'
# spoolsv is listening on 0.0.0.0:49580 and that is LAN-reachable. Before calling
# it a finding, establish WHAT is being served there -- a dynamic RPC port with
# nothing registered on it is a much smaller problem than an open print queue.
#
# Read-only: no configuration is changed.

Write-Output '=== port 49580 owner and purpose ==='
$c = Get-NetTCPConnection -State Listen -LocalPort 49580 -EA SilentlyContinue | Select-Object -First 1
if (-not $c) { Write-Output '  not listening now (dynamic port may have moved)'; exit 0 }
$p = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
Write-Output ("  process : {0} (pid {1})" -f $p.ProcessName, $c.OwningProcess)
Write-Output ("  binding : {0}:{1}" -f $c.LocalAddress, $c.LocalPort)

Write-Output ''
Write-Output '=== is a printer queue actually exposed? (PrintNightmare / RPC) ==='
Get-CimInstance Win32_Printer -EA SilentlyContinue |
  Select-Object Name, PortName, Network, Shared, Published |
  ForEach-Object {
    Write-Output ("  printer '{0}' port={1} network={2} shared={3} published={4}" -f `
      $_.Name, $_.PortName, $_.Network, $_.Shared, $_.Published)
  }
$count = @(Get-CimInstance Win32_Printer -EA SilentlyContinue).Count
Write-Output ("  printer count: {0}" -f $count)
if ($count -eq 0) {
  Write-Output '  no printers at all -- so 49580 is spooler bookkeeping, not a print service'
}

Write-Output ''
Write-Output '=== RPC endpoints spoolsv registered (the classic PrintNightmare vector) ==='
try {
  $rpc = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\RpcServer\RpcEndpointList' -EA SilentlyContinue |
         Where-Object { $_.Name -like 'spoolsv*' }
  foreach ($e in $rpc) {
    $bind = $e.GetValue('Bind')
    $note = $e.GetValue('EndpointAnnotation')
    $lan = if ($bind -match '0\.0\.0\.0' -or $bind -match '\[::\]') { '  <-- ALL INTERFACES' } else { '' }
    Write-Output ("  {0}  bind={1}{2}" -f $note, $bind, $lan)
  }
  if (-not $rpc) { Write-Output '  none registered' }
} catch {
  Write-Output ("  could not read the RPC endpoint list: {0}" -f $_.Exception.Message)
}

Write-Output ''
Write-Output '=== firewall: is 49580 permitted inbound? ==='
$rules = Get-NetFirewallPortFilter -EA SilentlyContinue |
         Where-Object { $_.LocalPort -eq '49580' -or $_.LocalPort -eq '49152-65535' }
if ($rules) {
  foreach ($r in $rules) {
    $fr = $r | Get-NetFirewallRule -EA SilentlyContinue
    Write-Output ("  rule '{0}' enabled={1} action={2} profile={3}" -f `
      $fr.DisplayName, $fr.Enabled, $fr.Action, $fr.Profile)
  }
} else {
  Write-Output '  no explicit rule for this port'
}

Write-Output ''
Write-Output '=== what the LAN actually says: does anything answer on 49580? ==='
Write-Output '  (tested from the phone -- see the next step)'