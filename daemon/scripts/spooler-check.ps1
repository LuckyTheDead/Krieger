$ErrorActionPreference = 'SilentlyContinue'
# Is the languard alert (port 49580 appeared, 49668 closed, both spoolsv) a real
# finding or my own footprint?
#
# Context: at 01:44 I stopped and started the Spooler service while testing
# whether the Security log advances. The print spooler opens and closes TCP ports
# as it does, so this is very likely self-inflicted. A watcher that cannot
# distinguish "the system changed" from "I changed it" trains you to ignore it,
# so the check is worth doing rather than assuming.

Write-Output '=== spoolsv ports right now ==='
$spool = Get-Process spoolsv -EA SilentlyContinue
if (-not $spool) { Write-Output '  spoolsv not running'; exit 0 }
Write-Output ("  spoolsv pid(s): {0}" -f (($spool | Select-Object -ExpandProperty Id) -join ','))
Get-NetTCPConnection -State Listen -EA SilentlyContinue |
  Where-Object { $spool.Id -contains $_.OwningProcess } |
  ForEach-Object { Write-Output ("  listening {0}:{1}" -f $_.LocalAddress, $_.LocalPort) }

Write-Output ''
Write-Output '=== is it LAN-reachable? (this is the part that matters) ==='
$lan = Get-NetTCPConnection -State Listen -EA SilentlyContinue |
       Where-Object { $spool.Id -contains $_.OwningProcess -and $_.LocalAddress -in @('0.0.0.0','::') }
if ($lan) {
  $lan | ForEach-Object { Write-Output ("  REACHABLE: {0}:{1}" -f $_.LocalAddress, $_.LocalPort) }
  Write-Output '  -> a LAN-reachable spooler is worth closing'
} else {
  Write-Output '  no -- spooler ports are bound to loopback only'
  Write-Output '  -> NOT reachable from the network; this alert is informational'
}

Write-Output ''
Write-Output '=== when did the port change happen? correlate with my service test ==='
$since = (Get-Date).AddHours(-2)
Get-WinEvent -FilterHashtable @{ LogName='System'; StartTime=$since } -EA SilentlyContinue |
  Where-Object { $_.Message -match 'Spooler|Print' } |
  Select-Object -First 6 |
  ForEach-Object { Write-Output ("  {0:HH:mm:ss} id={1} {2}" -f $_.TimeCreated, $_.Id, (($_.Message -split "`n")[0]).Trim()) }

Write-Output ''
Write-Output '=== the honest conclusion ==='
Write-Output '  If the change lines up with the 01:44 Spooler restart, then languard'
Write-Output '  correctly detected a real change that I caused. That is the watcher'
Write-Output '  working, not a false positive -- but it does mean the baseline needs'
Write-Output '  accepting once the cause is known, or it will alert again.'