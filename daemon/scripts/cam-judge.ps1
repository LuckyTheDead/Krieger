param(
  [string]$Dir = "$env:USERPROFILE\cammotion",
  [switch]$Quiet
)
$ErrorActionPreference = 'SilentlyContinue'

# Judge a captured frame sequence. Outputs SET VERDICT=... / SET MED=... /
# SET SPR=... lines so a .bat caller can capture them, and prints a one-line
# summary for a human.
#
# Why this is a .ps1 and not batch: the batch version needed a variable set
# inside a FOR block, and cmd expands %VAR% BEFORE the block runs, so the
# previous-frame path was always empty on the first pass. The sequence summed
# to nothing and the log line came out "VERDICT= frames= mean=" with every field
# blank -- silently, because an unset variable expands to nothing rather than
# erroring. PowerShell has no equivalent trap.

$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName
if (-not $ff) {
  if (-not $Quiet) { Write-Output 'VERDICT=NO_FFMPEG' }
  'SET VERDICT=NO_FFMPEG'; 'SET MED=?'; 'SET SPR=?'; exit 1
}

$frames = @(Get-ChildItem $Dir -Filter 'm*.jpg' -EA SilentlyContinue | Sort-Object Name)
if ($frames.Count -lt 3) {
  if (-not $Quiet) { Write-Output ("VERDICT=NO_FRAMES count={0}" -f $frames.Count) }
  'SET VERDICT=NO_FRAMES'; 'SET MED=?'; 'SET SPR=?'; exit 1
}

# Mean luminance of the newest frame, for the dark-frame guard. Read from
# STDOUT, not from a file named by metadata=print:file=<path>: that argument
# treats backslashes as escape characters, so a Windows path like
# C:\Users\...\Temp\ss.txt never produces a file and the read silently fails.
# Verified both ways here -- file= gave no file at all, file=- gave YAVG=65.25.
# An unparsed value is reported as MEASURE_FAILED rather than 0, because 0 looks
# exactly like a covered camera and would be believed.
$avg = $null
$o = & $ff -hide_banner -v info -i $frames[-1].FullName `
      -vf "signalstats,metadata=print:file=-" -f null - 2>&1 | Out-String
foreach ($line in ($o -split "`n")) {
  if ($line -match 'YAVG=([\d.]+)') { $avg = [double]$Matches[1]; break }
}

if ($null -eq $avg) {
  if (-not $Quiet) { Write-Output 'VERDICT=MEASURE_FAILED' }
  'SET VERDICT=MEASURE_FAILED'; 'SET MED=?'; 'SET SPR=?'; exit 1
}
if ($avg -lt 12) {
  if (-not $Quiet) { Write-Output ("VERDICT=NO_SIGNAL mean={0:N1}" -f $avg) }
  "SET VERDICT=NO_SIGNAL"; "SET MED=$([int]($avg*10)/10)"; 'SET SPR=?'; exit 0
}

# Difference between consecutive frames. metadata=print:file=- goes to STDOUT
# while ffmpeg's own logging goes to stderr -- reading only stderr finds
# nothing and silently yields zero comparisons.
$sums = @()
for ($i = 1; $i -lt $frames.Count; $i++) {
  $o = & $ff -hide_banner -v info -i $frames[$i - 1].FullName -i $frames[$i].FullName `
       -lavfi "blend=all_mode=difference,signalstats,metadata=print:file=-" `
       -f null - 2>&1 | Out-String
  foreach ($line in ($o -split "`n")) {
    if ($line -match 'YAVG=([\d.]+)') { $sums += [double]$Matches[1]; break }
  }
}
if ($sums.Count -lt 3) {
  if (-not $Quiet) { Write-Output ("VERDICT=NO_PAIRS pairs={0}" -f $sums.Count) }
  'SET VERDICT=NO_PAIRS'; 'SET MED=?'; 'SET SPR=?'; exit 1
}

# Drop the first pair: auto-exposure is still settling and reads high on a
# completely still room (measured 27.9 vs a settled 1.4).
$steady = $sums[1..($sums.Count - 1)]
$med = ($steady | Sort-Object)[[int]($steady.Count / 2)]
$spread = ($steady | ForEach-Object { [math]::Abs($_ - $med) } | Measure-Object -Maximum).Maximum
$wander = @($steady | Where-Object { [math]::Abs($_ - $med) -gt 3.0 }).Count

# Two terms, because spread alone misses constant-velocity motion: a subject
# stepping a fixed offset each frame produces an identical difference every
# pair, so spread collapses (measured median 11.16, spread 0.017) and a
# spread-only rule reads STILL.
$sustained = $med -gt 6.0
$verdict = if ($wander -gt 0 -or $sustained) { 'MOTION' } else { 'STILL' }

$medS = [int]($med * 10) / 10
$sprS = [int]($spread * 10) / 10
if (-not $Quiet) {
  Write-Output ("VERDICT={0} frames={1} mean={2:N1} median={3} spread={4} pairs={5}" -f `
    $verdict, $frames.Count, $avg, $medS, $sprS, $sums.Count)
}
"SET VERDICT=$verdict"
"SET MED=$medS"
"SET SPR=$sprS"