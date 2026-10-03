$ErrorActionPreference = 'SilentlyContinue'
# What is actually in the Windows Security log, and what would be worth alerting
# on? Measured, not assumed: an audit policy nobody reads is the same as none.
#
# This matters for the security system because the exposure watcher covers
# CONFIGURATION change (a new listening port) but says nothing about ACCESS. A
# machine with BitLocker off and SMB reachable can be logged into without any
# port changing at all.

Write-Output '=== audit policy: which events are actually recorded? ==='
$pol = auditpol /get /subcategory:"Logon","Logoff","Account Lockout","Special Logon", `
             "Other Object Access Events","Audit Process Creation","Security Group Modification", `
             "User Account Management" 2>&1
foreach ($line in ($pol -split "`r?`n")) {
  if ($line -match 'Subcategory|Setting|->') { '  ' + $line.Trim() }
}

Write-Output ''
Write-Output '=== event volume by interesting ID, last 7 days ==='
# 4624 logon, 4625 failed logon, 4720 account created, 4726 account deleted,
# 4728/4732 member added to a group, 1102 audit log cleared.
$ids = @(4624, 4625, 4720, 4726, 4728, 4732, 4724, 4672, 1102, 4697, 7045)
$since = (Get-Date).AddDays(-7)
foreach ($id in $ids) {
  $c = (Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=$id; StartTime=$since } -EA SilentlyContinue |
        Measure-Object).Count
  if ($c -gt 0) { Write-Output ("  {0,-6} {1}" -f $id, $c) }
}

Write-Output ''
Write-Output '=== failed logons (4625) in the last 24h: where from? ==='
$fail = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=(Get-Date).AddHours(-24) } -EA SilentlyContinue
Write-Output ("  total: {0}" -f @($fail).Count)
$fail | Select-Object -First 20 | ForEach-Object {
  $x = [xml]$_.ToXml()
  $ip = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'IpAddress' }).'#text'
  $user = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'TargetUserName' }).'#text'
  $type = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'LogonType' }).'#text'
  Write-Output ("  {0}  user={1} type={2}" -f $ip, $user, $type)
}

Write-Output ''
Write-Output '=== successful logons (4624) in the last 24h, by type ==='
$ok = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4624; StartTime=(Get-Date).AddHours(-24) } -EA SilentlyContinue
$byType = @{}
foreach ($e in $ok) {
  $x = [xml]$e.ToXml()
  $t = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'LogonType' }).'#text'
  if (-not $byType.ContainsKey($t)) { $byType[$t] = 0 }
  $byType[$t]++
}
foreach ($k in ($byType.Keys | Sort-Object)) { Write-Output ("  type {0,-3} {1}" -f $k, $byType[$k]) }

Write-Output ''
Write-Output '=== audit log cleared? (1102 means someone covered tracks) ==='
$clr = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=1102; StartTime=(Get-Date).AddDays(-30) } -EA SilentlyContinue
if ($clr) {
  foreach ($c in $clr) { Write-Output ("  CLEARED at {0}" -f $c.TimeCreated) }
} else {
  Write-Output '  never in the last 30 days'
}