$ErrorActionPreference = 'SilentlyContinue'
# "Filtered" from the phone is an OBSERVATION. This explains WHY, so the claim
# can be checked rather than trusted: which firewall rules cover SMB and NetBIOS,
# and on which profiles.
#
# Get-NetFirewallProfile reports DefaultInboundAction = NotConfigured, which
# means the effective value comes from local policy rather than the profile
# default. That is not an answer, so resolve it properly.

Write-Output '=== effective default inbound action ==='
$pol = Get-NetFirewallProfile -PolicyStore ActiveStore -EA SilentlyContinue
foreach ($p in $pol) {
  Write-Output ("  {0,-8} enabled={1}  defaultInbound={2}  defaultOutbound={3}" -f `
    $p.Name, $p.Enabled, $p.DefaultInboundAction, $p.DefaultOutboundAction)
}

Write-Output ''
Write-Output '=== inbound rules for the ports we found filtered ==='
foreach ($port in @(445, 139, 135, 49580)) {
  $filters = Get-NetFirewallPortFilter -EA SilentlyContinue |
              Where-Object { $_.LocalPort -eq "$port" -or $_.LocalPort -eq 'Any' }
  $matching = @()
  foreach ($f in $filters) {
    $rule = $f | Get-NetFirewallRule -EA SilentlyContinue
    if ($rule -and $rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound') {
      if ($f.LocalPort -eq "$port") { $matching += $rule }
    }
  }
  Write-Output ("  port {0}:" -f $port)
  if ($matching) {
    foreach ($m in $matching) {
      Write-Output ("    BLOCKING  '{0}'  action={1}  profile={2}" -f $m.DisplayName, $m.Action, $m.Profile)
    }
  } else {
    # No explicit rule for this port: it is being filtered by the profile's
    # default inbound action rather than by a named rule.
    Write-Output '    no explicit blocking rule; filtered by the default inbound action'
  }
}

Write-Output ''
Write-Output '=== rules that explicitly ALLOW these ports inbound ==='
foreach ($port in @(445, 139, 135, 49580)) {
  $allow = Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -EA SilentlyContinue |
           ForEach-Object { $r = $_
             $pf = $r | Get-NetFirewallPortFilter -EA SilentlyContinue
             if ($pf.LocalPort -eq "$port") { $r } } |
           Where-Object { $_ }
  if ($allow) {
    foreach ($a in $allow) {
      Write-Output ("  port {0} ALLOWED by '{1}' profile={2}" -f $port, $a.DisplayName, $a.Profile)
    }
  } else {
    Write-Output ("  port {0}: nothing allows it inbound" -f $port)
  }
}

Write-Output ''
Write-Output '=== so: is the SMB exposure real? ==='
Write-Output '  Observation from the phone: 445 and 139 TIME OUT, while 22 connects.'
Write-Output '  That is consistent with the firewall dropping them before the service.'
Write-Output '  The default inbound action above decides whether that is by design or'
Write-Output '  luck, and whether a future profile change would expose them silently.'