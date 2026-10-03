$ErrorActionPreference = 'SilentlyContinue'
# Prove camwatch's verdict path fires MOTION, not just NO_SIGNAL.
#
# Every live check so far has returned NO_SIGNAL because the room is dark at
# 00:xx. That exercises the guard but leaves the two other verdicts unproven in
# the actual scheduled batch, which is where the parsing bugs were.
#
# So: generate a synthetic moving sequence into the same directory camwatch
# reads, and invoke the judging half of the batch against it. No camera needed
# and no change to the guard's behaviour -- the capture step is bypassed
# deliberately so this tests only what it claims to.
param(
  [ValidateSet('moving', 'static', 'dark')]
  [string]$Case = 'moving'
)

$out = "$env:USERPROFILE\cammotion"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -Filter 'm*.jpg' -EA SilentlyContinue | Remove-Item -Force

$ff = (Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1).FullName

Write-Output "case: $Case"
switch ($Case) {
  'dark' {
    for ($i = 1; $i -le 8; $i++) {
      & $ff -hide_banner -v error -f lavfi -i "color=c=black:s=160x120:d=1" `
        -frames:v 1 "$out\m$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null
    }
  }
  'static' {
    for ($i = 1; $i -le 8; $i++) {
      & $ff -hide_banner -v error -f lavfi -i "color=c=0x505050:s=160x120:d=1" `
        -frames:v 1 "$out\m$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null
    }
  }
  'moving' {
    for ($i = 1; $i -le 8; $i++) {
      $x = 10 + $i * 14
      & $ff -hide_banner -v error `
        -f lavfi -i "color=c=0x303030:s=160x120:d=1" `
        -f lavfi -i "color=c=white:s=40x40:d=1" `
        -filter_complex "[0][1]overlay=$x`:40" -frames:v 1 `
        "$out\m$('{0:d3}' -f $i).jpg" 2>&1 | Out-Null
    }
  }
}

$n = (Get-ChildItem $out -Filter 'm*.jpg' -EA SilentlyContinue | Measure-Object).Count
Write-Output "generated $n frames"
if ($n -lt 3) { Write-Output 'TOO_FEW_FRAMES'; exit 1 }

# Run the batch's judging half only: skip the capture, keep everything after it.
# The batch captures from the real camera, which would overwrite these frames.
$lines = Get-Content '$env:USERPROFILE\camwatch.bat'
$judgeStart = ($lines | Select-String -Pattern 'set "SUMS=' | Select-Object -First 1).LineNumber
$tail = $lines[($judgeStart - 1)..($lines.Count - 1)]
# Drop the capture-related preamble; we only want sum + judge.
$script = ($tail -join "`r`n") -replace [regex]::Escape('$FF'), $ff
Set-Content "$env:TEMP\judge-only.bat" $script -Encoding ASCII
Write-Output '--- running the judging half ---'
& cmd /c "$env:TEMP\judge-only.bat" 2>&1 | Out-Null

$line = Get-Content "$env:USERPROFILE\camwatch.log" -Tail 1
Write-Output "logged: $line"
if ($line -match 'VERDICT=(\w+)') { Write-Output "VERDICT=$($Matches[1])" }
else { Write-Output 'NO_VERDICT' }