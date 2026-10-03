$ErrorActionPreference = 'SilentlyContinue'
# The audit policy says Logon is "Success and Failure", yet a real LogonUser
# attempt produced no 4625. Either the P/Invoke call never reached LSA, or
# something is filtering the Security log. Both matter a great deal: an audit
# policy that claims coverage it does not deliver is worse than none, because it
# is trusted.
#
# Read-only apart from the deliberate failed logon.

Write-Output '=== 1. did the P/Invoke call actually attempt anything? ==='
# LogonUser returned an EMPTY string from Try(), which means the code path
# returned neither failure nor "UNEXPECTED SUCCESS". Check the type compiled and
# call it with obviously bad arguments so the return is unambiguous.
try {
  $t = [System.Type]::GetType('Lsa')
  Write-Output ("  type Lsa loaded: {0}" -f ($null -ne $t))
  if ($t) {
    $r = $t::Try('definitely_no_such_user_zzz', 'definitely_wrong_password_zzz')
    Write-Output ("  Try() returned: '{0}'" -f $r)
  }
} catch {
  Write-Output ("  call failed: {0}" -f $_.Exception.Message)
}

Write-Output ''
Write-Output '=== 2. what does the Security log itself say about its own state? ==='
$log = Get-WinEvent -ListLog Security
Write-Output ("  RecordCount : {0}" -f $log.RecordCount)
Write-Output ("  IsEnabled   : {0}" -f $log.IsEnabled)
Write-Output ("  LogMode     : {0}  (Circular/Retain/Blocking)" -f $log.LogMode)
Write-Output ("  MaxSize     : {0:N0} MB" -f ($log.MaximumSizeInBytes / 1MB))
Write-Output ("  oldest event: {0}" -f (Get-WinEvent -LogName Security -MaxEvents 1 -Oldest -EA SilentlyContinue).TimeCreated)
Write-Output ("  newest event: {0}" -f (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).TimeCreated)

Write-Output ''
Write-Output '=== 3. is there a filtering or audit channel problem? ==='
# A third-party audit policy tool can silently override category settings.
Write-Output 'auditpol subcategory settings actually in force:'
auditpol /get /category:"Logon/Logoff","Detailed Tracking" 2>&1 |
  ForEach-Object { if ($_ -match 'Category|Subcategory|Setting|->') { '  ' + $_.Trim() } }

Write-Output ''
Write-Output '=== 4. can we read 4625 at all, and when were the last few? ==='
$e = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625 } -MaxEvents 5 -EA SilentlyContinue
if ($e) {
  foreach ($x in $e) { Write-Output ("  {0:yyyy-MM-dd HH:mm:ss} recordId={1}" -f $x.TimeCreated, $x.RecordId) }
} else {
  Write-Output '  none returned'
}

Write-Output ''
Write-Output '=== 5. the decisive test: watch for ANY new Security record ==='
$before = (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).RecordId
Write-Output "  newest recordId before: $before"
Write-Output '  generating a new event...'
try {
  $sec = New-Object System.DirectoryServices.AccountManagement.PrincipalContext(
          [System.DirectoryServices.AccountManagement.PrincipalContextType]::Machine,
          $null, "another_missing_user_zzz", "wrongpassword")
  $null = $sec.ValidateCredentials("nope", "nope")
} catch { }
Start-Sleep -Seconds 4
$after = (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).RecordId
Write-Output "  newest recordId after : $after"
if ($after -gt $before) {
  Write-Output "  -> the log IS advancing; the specific 4625 was simply not produced"
} else {
  Write-Output '  -> the Security log did NOT advance at all'
}