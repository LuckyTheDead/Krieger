$ErrorActionPreference = 'SilentlyContinue'
# Restart the agent daemon so it picks up the newly-set key, and prove a real
# agent job can now reach the model. The run log is the evidence: a job that
# previously failed in 0s with "No API key" must now either succeed or fail for
# a DIFFERENT reason, which is what distinguishes "key found" from "key ignored".
#
# Read-only apart from restarting the task.

$repo = "$env:USERPROFILE\tiny-agent-git"
$rl = Join-Path $repo 'daemon\runs.jsonl'

Write-Output '=== before ==='
$before = 0
if (Test-Path $rl) {
  $before = (Get-Content $rl | Measure-Object -Line).Lines
  $last = Get-Content $rl -Tail 1 | ConvertFrom-Json
  Write-Output ("  {0} entries; last: job={1} ok={2} error={3}" -f `
    $before, $last.job, $last.ok, $(if ($last.error) { $last.error.Substring(0, [Math]::Min(60, $last.error.Length)) } else { 'none' }))
}

Write-Output ''
Write-Output '=== restarting the daemon so it inherits the key ==='
Stop-ScheduledTask -TaskName 'KriegerAgentDaemon' -EA SilentlyContinue
Start-Sleep -Seconds 3
# Kill any stragglers from the previous run, or the port/pid would collide.
Get-Process node -EA SilentlyContinue |
  Where-Object { $_.Id -ne $PID } |
  ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
Start-Sleep -Seconds 2

Start-ScheduledTask -TaskName 'KriegerAgentDaemon'
Write-Output '  started; waiting for a job to run (self-review fires on its 2h schedule,'
Write-Output '  so this waits for the resident scheduler and forces one run instead)'

# The scheduler only runs jobs that are DUE. self-review runs at 13 */2, so it
# will not fire on demand. Run the job directly through the same code path the
# scheduler uses, which is the honest way to test it.
Start-Sleep -Seconds 20
$node = "$env:USERPROFILE\tools\node\node-v24.21.0-win-x64\node.exe"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = 'daemon\krieger.mjs run self-review'
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEnd()
$err = $p.StandardError.ReadToEnd()
$p.WaitForExit(300000) | Out-Null

Write-Output ''
Write-Output "=== result (exit $($p.ExitCode)) ==="
if ($out) { Write-Output '  stdout:'; ($out -split "`n" | Select-Object -First 12) | ForEach-Object { Write-Output "    $_" } }
if ($err) { Write-Output '  stderr:'; ($err -split "`n" | Select-Object -First 6) | ForEach-Object { Write-Output "    $_" } }

Write-Output ''
Write-Output '=== run log delta ==='
if (Test-Path $rl) {
  $after = (Get-Content $rl | Measure-Object -Line).Lines
  Write-Output ("  {0} -> {1} entries" -f $before, $after)
  if ($after -gt $before) {
    $e = Get-Content $rl -Tail 1 | ConvertFrom-Json
    Write-Output ("  job={0} ok={1} durationMs={2} toolCalls={3}" -f $e.job, $e.ok, $e.durationMs, $e.toolCalls)
    if ($e.error) {
      $msg = [string]$e.error
      if ($msg -match 'No API key') {
        Write-Output '  VERDICT: still no key -- the environment is not reaching the job'
      } else {
        Write-Output ("  VERDICT: key was found. New error is about something else: {0}" -f `
          $msg.Substring(0, [Math]::Min(120, $msg.Length)))
      }
    } else {
      Write-Output '  VERDICT: no error recorded'
    }
    if ($e.output) {
      $o = ([string]$e.output) -split "`n" | Where-Object { $_ } | Select-Object -First 8
      Write-Output '  output:'
      $o | ForEach-Object { Write-Output "    $_" }
    }
  }
}