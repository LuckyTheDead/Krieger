$ErrorActionPreference = 'Stop'
# Run the depth-4 combined-DSL ARC search on the PC, detached, with output
# flushed per line so progress is visible while it runs rather than appearing
# all at once at the end.
$py = 'C:\Users\${PC_USER}\tools\python\python.exe'
$dir = 'C:\Users\${PC_USER}\arc80'
Set-Location $dir

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = "/c `"$py -u obj_experiment.py 4 2000000 80 > d4.log 2>&1`""
$psi.UseShellExecute = $false
$p = [System.Diagnostics.Process]::Start($psi)
Write-Host "launched pid $($p.Id)"
Write-Host "log: $dir\d4.log"