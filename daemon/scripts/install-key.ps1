$ErrorActionPreference = 'Stop'

# Install the OpenRouter API key as a USER-level environment variable on the PC.
#
# Deliberately NOT done by passing the key as a command-line argument: on this
# box those arguments land in the job logs and in runs.jsonl, so the key would
# be written to disk in plaintext in several places. Instead the key arrives as
# STDIN to this script and is applied through [Environment]::SetEnvironmentVariable,
# which writes it to the registry without it ever appearing in a process
# argument list.
#
# Reads the key from stdin, so nothing sensitive is on the command line.

$ErrorActionPreference = 'Stop'

# Read stdin. [Console]::In is the reliable way under -File; the pipeline form
# ($input | ...) returns nothing there.
$raw = [Console]::In.ReadToEnd()
$key = $raw.Trim()

if (-not $key) {
  Write-Output 'FAIL: no key arrived on stdin'
  exit 1
}

# Validate the shape without printing it.
if ($key -notmatch '^sk-or-v1-[a-f0-9]{64}$') {
  Write-Output ("FAIL: does not look like an OpenRouter key (prefix seen: {0}..., length {1})" -f `
    $key.Substring(0, [Math]::Min(10, $key.Length)), $key.Length)
  exit 1
}
Write-Output ("key accepted: length {0}, shape valid" -f $key.Length)

# Set at User scope, so it applies to this account's processes without needing
# admin, and without putting it in a place every account can read.
[Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', $key, 'User')
$verify = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
if ($verify -ne $key) {
  Write-Output 'FAIL: readback mismatch -- the variable did not persist'
  exit 1
}
Write-Output 'set at User scope, readback matches'

# Zero the local copies so the plaintext does not linger in this process.
$key = $null
$verify = $null

# Verify an actual process will see it. A freshly spawned process inherits the
# User environment, which is the thing that actually matters -- the scheduler is
# launched by Task Scheduler, not by this shell.
Write-Output ''
Write-Output 'checking a NEW process sees it:'
$probe = & powershell -NoProfile -Command "`$k=[Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY','Process'); if(`$k){ 'yes, length ' + `$k.Length } else { 'NO -- a new process does not inherit it' }"
Write-Output ("  {0}" -f ($probe | Out-String).Trim())

Write-Output ''
Write-Output 'next: start (or restart) the agent daemon so it picks the key up.'
Write-Output '  Start-ScheduledTask -TaskName KriegerAgentDaemon'