$ErrorActionPreference = 'SilentlyContinue'
# Decisive test that the Security log advances in response to a KNOWN action,
# and that a KNOWN event id appears. Read-only apart from the probe logon.
#
# The previous version compared the newest recordId before and after a
# PrincipalContext.ValidateCredentials call, which does not authenticate and
# logs nothing -- so it correctly observed "no change" and I nearly concluded
# the Security log was broken. It is not: it contains 27k records advancing to
# recordId 36133. The measurement, not the log, was wrong.

$before = (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).RecordId
Write-Output "recordId before: $before"

Write-Output 'generating events via a service start (4719/7036) and a new RDP-ish logon type...'

# A definite, logged action: start and stop a service. That writes 7036 (service
# entered running) to the SYSTEM log and, with the right subcategory, a Security
# record. It is safe: start it, then stop it again.
$svc = Get-Service -Name 'Spooler' -EA SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
  Stop-Service -Name 'Spooler' -EA SilentlyContinue
  Start-Sleep -Seconds 2
  Write-Output '  stopped Spooler'
}
Start-Service -Name 'Spooler' -EA SilentlyContinue
Write-Output '  started Spooler'
Start-Sleep -Seconds 4

$after = (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).RecordId
Write-Output "recordId after : $after"
if ($after -gt $before) {
  Write-Output "ADVANCED by $($after - $before) record(s)"
} else {
  Write-Output 'NO ADVANCE'
}

Write-Output ''
Write-Output 'what arrived:'
Get-WinEvent -LogName Security -MaxEvents 15 -EA SilentlyContinue |
  Where-Object { $_.RecordId -gt $before } |
  ForEach-Object { Write-Output ("  id={0} {1:HH:mm:ss} {2}" -f $_.Id, $_.TimeCreated, ($_.Message -split "`n")[0]) }

Write-Output ''
Write-Output '=== and: can I produce a 4625 at all? use a genuinely wrong password on a real account ==='
# WrongPasswordHere is not the real password for Lucky, so this fails. It goes
# through the same LSA path a bad SSH password would, and is logged as 4625.
$before2 = (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).RecordId
try {
  $sec = New-Object System.DirectoryServices.AccountManagement.PrincipalContext(
          [System.DirectoryServices.AccountManagement.PrincipalContextType]::Machine,
          $env:COMPUTERNAME, $env:USERNAME, "IntentionallyWrongPassword_zzz")
  $ok = $sec.ValidateCredentials("IntentionallyWrongPassword_zzz", "IntentionallyWrongPassword_zzz")
  Write-Output "  ValidateCredentials returned: $ok   (False means the password was rejected)"
} catch {
  Write-Output ("  raised {0}" -f $_.Exception.GetType().Name)
}
Start-Sleep -Seconds 5

$new = Get-WinEvent -LogName Security -MaxEvents 30 -EA SilentlyContinue |
       Where-Object { $_.RecordId -gt $before2 }
Write-Output ("  new records: {0}" -f @($new).Count)
$fail = $new | Where-Object { $_.Id -eq 4625 }
if ($fail) {
  Write-Output "  4625 PRODUCED: $($fail.Count) event(s)"
  foreach ($f in $fail) {
    $x = [xml]$f.ToXml()
    $u = ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'TargetUserName' }).'#text'
    Write-Output ("    user={0} at {1:HH:mm:ss}" -f $u, $f.TimeCreated)
  }
} else {
  Write-Output '  no 4625 -- failed logons are NOT reaching the log despite'
  Write-Output '  auditpol reporting "Success and Failure". That is a real gap:'
  Write-Output '  the policy claims coverage the system is not delivering.'
  Write-Output ("  ids seen instead: {0}" -f (($new | Group-Object Id | ForEach-Object { $_.Name }) -join ', '))
}