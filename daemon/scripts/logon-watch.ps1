$ErrorActionPreference = 'SilentlyContinue'
# Watch the Windows Security log for events worth knowing about, and record a
# baseline so only CHANGES are reported.
#
# Why this exists alongside the port watcher: languard covers CONFIGURATION
# change -- a new listening port. It says nothing about ACCESS. On a machine
# with BitLocker off and SMB reachable on every interface, someone can log in
# successfully without any port changing at all. Configuration watching and
# access watching are different halves of the same problem, and only the first
# one existed.
#
# Read-only: it queries the Security log and writes its own state file. It does
# not change any audit policy, and it does not delete or clear any log.

# Baseline of the newest record seen per event id, so a rerun reports only what
# is new rather than replaying the last 20MB of history every time.
$state = "$env:USERPROFILE\logon-watch-state.json"

function Get-Watched {
  # 4624 logon, 4625 failed logon, 4672 special privileges,
  # 4720 account created, 4726 account deleted,
  # 4728/4732 group membership added, 1102 audit log cleared,
  # 7045 a service was installed, 4697 a service was started.
  @(1102, 4624, 4625, 4672, 4697, 4720, 4726, 4728, 4732, 7045)
}

function EventField($evt, $name) {
  try {
    $x = [xml]$evt.ToXml()
    foreach ($d in $x.Event.EventData.Data) {
      if ($d.Name -eq $name) {
        if ($d -is [string]) { return $d }
        if ($d.'#text') { return $d.'#text' }
        return $d.InnerText
      }
    }
  } catch { }
  return ''
}

# How this watcher was verified, because getting there took three wrong probes.
# Every obvious way to GENERATE a 4625 from a remote script turns out not to log
# one:
#   - PrincipalContext.ValidateCredentials raises a RuntimeException WITHOUT
#     authenticating, so nothing is logged
#   - the same call against a real account with a wrong password also raises,
#     and logs nothing at all
#   - a hand-rolled LogonUser P/Invoke failed to compile ("type Lsa loaded:
#     False"), so it never reached LSA either
# Each produced zero new Security records, which read as "the Security log is
# broken". It is not: stopping and starting the Spooler service produces exactly
# 2 records (4624 and 4672). That is the liveness proof, and it lives in
# audit-gap-check2.ps1 rather than here, because it stops a service and must not
# run on every poll.
#
# Consequence for what is claimed: the detection path is proven against real
# events from a real action. The specific 4625 case is NOT proven, because a
# remote script cannot produce one on demand. Saying that is more useful than a
# synthetic substitute that would test the test rather than the system.

# First run records where we are and reports nothing. Reporting history on the
# first run would fire every alert for events predating the watcher.
$baseline = $false
if (-not (Test-Path $state)) { $baseline = $true }

$ids = Get-Watched
$since = if ($baseline) { (Get-Date).AddHours(-1) } else { $null }

if ($baseline) {
  $globalNewest = (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).RecordId
  @{ recorded = (Get-Date).ToString('o'); lastRecordId = [int64]$globalNewest } |
    ConvertTo-Json -Depth 3 | Set-Content $state -Encoding UTF8
  Write-Output 'BASELINE'
  Write-Output ("recorded lastRecordId={0}" -f $globalNewest)
  Write-Output 'From now on only new events are reported.'
  exit 0
}

# ONE global high-water mark, not one per event id.
#
# RecordId is a property of the LOG, not of an event within it: ids 4624 and
# 4672 interleave in one sequence. So a per-id mark is meaningless -- a 4672 at
# RecordId 36653 sits above the "4624 mark" of 35802 even though 183 real 4624
# events live in that gap. With per-id marks the watcher processed only ~10 events
# per run while 183 were waiting, and the reported backlog grew every time:
# 272, then 288, 302, 308. A single global RecordId is the correct key, because
# it orders the whole log monotonically.
#
# Read into a hashtable: assigning to a property that does not exist on a
# PSCustomObject silently creates a SECOND property of the same name instead of
# updating the first, which is a second, independent way for the mark to never
# advance.
$raw = Get-Content $state -Raw | ConvertFrom-Json
$lastSeen = [int64]($raw.lastRecordId)
if ($lastSeen -lt 0) { $lastSeen = 0 }

# One query, newest-first, filtered in memory. Asking for "everything newer than
# X" per id means ten full scans of a 27k-record log.
$newest = Get-WinEvent -LogName Security -MaxEvents 4000 -EA SilentlyContinue |
          Where-Object { $_.RecordId -gt $lastSeen -and $ids -contains $_.Id }

$found = @()
foreach ($e in $newest) {
  $found += [PSCustomObject]@{
    Id     = $e.Id
    Time   = $e.TimeCreated
    User   = (EventField $e 'TargetUserName')
    Type   = (EventField $e 'LogonType')
    IP     = (EventField $e 'IpAddress')
    Status = (EventField $e 'Status')
    Proc   = (EventField $e 'ProcessName')
    Rec    = $e.RecordId
  }
}

# Advance the mark to the newest record seen in the whole log, watched or not.
# Advancing only to the newest WATCHED event would re-scan the unwatched records
# on every run forever.
$globalNewest = (Get-WinEvent -LogName Security -MaxEvents 1 -EA SilentlyContinue).RecordId
if ($globalNewest -gt $lastSeen) { $lastSeen = [int64]$globalNewest }

@{ recorded = (Get-Date).ToString('o'); lastRecordId = $lastSeen } |
  ConvertTo-Json -Depth 3 | Set-Content $state -Encoding UTF8

if ($found.Count -eq 0) {
  Write-Output 'QUIET'
  Write-Output 'no new watched events'
  exit 0
}

Write-Output ("EVENTS {0}" -f $found.Count)
$interesting = $found | Where-Object {
  $_.Id -in @(1102, 4720, 4726, 4728, 4732, 7045, 4625)
}
foreach ($e in ($interesting | Sort-Object Time)) {
  $why = switch ($e.Id) {
    1102 { 'AUDIT LOG CLEARED -- someone covered tracks' }
    4625 { 'failed logon' }
    4720 { 'ACCOUNT CREATED' }
    4726 { 'ACCOUNT DELETED' }
    4728 { 'ADDED TO A LOCAL GROUP' }
    4732 { 'ADDED TO A GLOBAL GROUP' }
    7045 { 'SERVICE INSTALLED' }
    default { 'event' }
  }
  Write-Output ("  {0:yyyy-MM-dd HH:mm:ss} id={1} {2}" -f $e.Time, $e.Id, $why)
  Write-Output ("      user={0} ip={1} type={2} status={3} proc={4}" -f $e.User, $e.IP, $e.Type, $e.Status, $e.Proc)
}

$plain = @($found | Where-Object { $_.Id -in @(4624, 4672) }).Count
if ($plain -gt 0) { Write-Output ("  (+{0} routine logon/privilege events not shown)" -f $plain) }