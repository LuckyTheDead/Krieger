$ErrorActionPreference = 'SilentlyContinue'
# Summarise camwatch.log: verdict distribution, and whether the picture ever
# became bright enough to judge.
#
# Worth having because "every check said NO_SIGNAL" and "the camera is broken"
# look identical in the log. This separates them by reporting the brightness
# trend, so it is visible whether the room is simply dark or something changed.

$log = "$env:USERPROFILE\camwatch.log"
if (-not (Test-Path $log)) { Write-Output 'no log'; exit 0 }

$lines = Get-Content $log
Write-Output ("entries: {0}" -f $lines.Count)

$groups = @{}
foreach ($l in $lines) {
  if ($l -match 'VERDICT=(\w+)') {
    $v = $Matches[1]
    if (-not $groups.ContainsKey($v)) { $groups[$v] = 0 }
    $groups[$v]++
  }
}
Write-Output ''
Write-Output 'verdicts:'
foreach ($k in ($groups.Keys | Sort-Object)) {
  $pct = [math]::Round(100 * $groups[$k] / $lines.Count, 1)
  Write-Output ("  {0,-14} {1,3}  ({2}%)" -f $k, $groups[$k], $pct)
}

Write-Output ''
Write-Output 'brightness trend (mean= column, i.e. how lit the room was):'
$means = @()
foreach ($l in $lines) {
  if ($l -match 'mean=([\d.]+)') { $means += [double]$Matches[1] }
  elseif ($l -match 'median=([\d.]+)') { $means += [double]$Matches[1] }
}
if ($means.Count) {
  Write-Output ("  samples={0}  min={1:N2}  max={2:N2}  last={3:N2}" -f `
    $means.Count, ($means | Measure-Object -Minimum).Minimum,
    ($means | Measure-Object -Maximum).Maximum, $means[-1])
  $bright = @($means | Where-Object { $_ -ge 12 }).Count
  Write-Output ("  checks with a readable picture: {0} of {1}" -f $bright, $means.Count)
  if ($bright -eq 0) {
    Write-Output '  => the room has been too dark for the camera to judge anything.'
    Write-Output '     That is the guard working, not the camera failing.'
  }
} else {
  Write-Output '  no brightness values in the log'
}

Write-Output ''
Write-Output 'first and last entries:'
Write-Output ("  {0}" -f $lines[0])
Write-Output ("  {0}" -f $lines[-1])