$ErrorActionPreference = 'SilentlyContinue'
$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
$f = (Get-ChildItem "$env:USERPROFILE\cammotion" -Filter 'm*.jpg' |
      Sort-Object Name | Select-Object -First 1)

$o = & $ff -hide_banner -v error -i $f.FullName `
      -vf "signalstats,metadata=print:file=-" -f null - 2>&1

Write-Output "raw object count: $(@($o).Count)"
Write-Output "first object's .NET type: $(if(@($o).Count -gt 0){@($o)[0].GetType().FullName}else{'<none>'})"

$avg = 0.0; $max = 0.0; $matched = 0
foreach ($line in $o) {
  # The bug: -match coerces via ToString(), which is fine, but if $line is an
  # ErrorRecord the text can be prefixed with the ffmpeg invocation line, so a
  # strict '=' match still works -- the real risk is the loop never running.
  $s = [string]$line
  if ($s -match 'YAVG=([\d.]+)') { $avg = [double]$Matches[1]; $matched++ }
  if ($s -match 'YMAX=([\d.]+)') { $max = [double]$Matches[1] }
}
Write-Output "matched lines: $matched"
Write-Output ("avg={0}  max={1}" -f $avg, $max)

Write-Output ''
Write-Output '--- does Select-String work where -match in a loop did not? ---'
$hits = $o | Select-String -Pattern 'YAVG=([\d.]+)'
Write-Output ("Select-String hits: {0}" -f @($hits).Count)
if ($hits) { Write-Output ("  first: {0}" -f $hits[0].ToString().Trim()) }

Write-Output ''
Write-Output '--- and the Measure-Object route on the captured array ---'
$vals = @()
foreach ($line in $o) {
  if (([string]$line) -match 'YAVG=([\d.]+)') { $vals += [double]$Matches[1] }
}
Write-Output ("collected {0} values; avg of avgs = {1:N1}" -f $vals.Count,
              (($vals | Measure-Object -Average).Average))