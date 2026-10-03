$ErrorActionPreference = 'SilentlyContinue'
# Who is actually trying to log in? The earlier report showed user names but no
# source IPs, because IpAddress is a nested element in the EventData and my
# selector grabbed the wrong shape.
#
# Logon type 8 is NetworkCleartext: credentials in the clear over the network.
# A `FakeUser` failing that repeatedly, from a remote address, is worth knowing
# about on a machine whose disk is unencrypted and whose SMB is reachable.

$since = (Get-Date).AddHours(-48)
$evts = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=$since } -EA SilentlyContinue

Write-Output ("failed logons in the last 48h: {0}" -f @($evts).Count)
Write-Output ''

function Field($evt, $name) {
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

$rows = @()
foreach ($e in $evts) {
  $rows += [PSCustomObject]@{
    Time  = $e.TimeCreated
    User  = (Field $e 'TargetUserName')
    Type  = (Field $e 'LogonType')
    IP    = (Field $e 'IpAddress')
    Port  = (Field $e 'IpPort')
    Work  = (Field $e 'WorkstationName')
    Src   = (Field $e 'SourceNetworkAddress')
  }
}

Write-Output 'by user:'
$rows | Group-Object User | Sort-Object Count -Descending |
  ForEach-Object { Write-Output ("  {0,-14} {1}" -f $_.Name, $_.Count) }

Write-Output ''
Write-Output 'by source address:'
$rows | Group-Object IP | Sort-Object Count -Descending |
  ForEach-Object { Write-Output ("  {0,-22} {1}" -f $_.Name, $_.Count) }

Write-Output ''
Write-Output 'full detail:'
foreach ($r in $rows) {
  Write-Output ("  {0:HH:mm:ss} user={1,-12} type={2,-3} ip={3,-16} workstation={4}" -f `
    $r.Time, $r.User, $r.Type, $r.IP, $r.Work)
}

Write-Output ''
Write-Output '=== any NON-loopback source? (that is the part worth acting on) ==='
$remote = $rows | Where-Object { $_.IP -and $_.IP -ne '127.0.0.1' -and $_.IP -ne '::1' -and $_.IP -ne '-' }
if ($remote) {
  Write-Output "  YES: $($remote.Count) attempt(s) from off-box"
  $remote | ForEach-Object { Write-Output ("    {0:HH:mm:ss} {1} user={2} type={3}" -f $_.Time, $_.IP, $_.User, $_.Type) }
} else {
  Write-Output '  no -- every failure came from loopback'
  # No backslash before the apostrophe: in a single-quoted PowerShell string a
  # backslash is a literal character and the quote still terminates the string.
  # Escaping an apostrophe as \' produced "The string is missing the terminator"
  # and a parse error that pointed at a closing brace three lines later.
  Write-Output "  (consistent with my own failed SSH auth attempts, not an external attacker)"
}