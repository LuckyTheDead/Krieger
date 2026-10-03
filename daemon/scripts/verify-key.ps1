$ErrorActionPreference = 'SilentlyContinue'
# Does a genuinely FRESH process inherit the key? The installer reported that a
# new process did not see it, which is expected and not a failure: the
# PowerShell it spawned inherited THIS shell's environment block, which was built
# before the variable existed. What matters is whether a process started fresh --
# which is how Task Scheduler launches the daemon -- sees it.
#
# Read-only: this only reads.

Write-Output '=== 1. registry (User scope) ==='
$k = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
if ($k) { Write-Output ("  present, length {0}" -f $k.Length) }
else { Write-Output '  ABSENT' }

Write-Output ''
Write-Output '=== 2. THIS process (inherited before the change) ==='
$p = $env:OPENROUTER_API_KEY
Write-Output ("  {0}" -f $(if ($p) { "present, length $($p.Length)" } else { 'absent - expected, this shell predates the change' }))

Write-Output ''
Write-Output '=== 3. a fresh process, built from the registry ==='
# cmd.exe started from here inherits this environment, so it is not independent
# either. The real question is whether the TASK SCHEDULER-launched process will
# see it, and Task Scheduler reads the User environment at launch time.
# So: start a process with an explicitly rebuilt environment block.
$rebuilt = [System.Environment]::GetEnvironmentVariables('User')
Write-Output ("  user-scope variables rebuilt: {0}" -f $rebuilt.Count)
$hasKey = $rebuilt.Contains('OPENROUTER_API_KEY')
Write-Output ("  OPENROUTER_API_KEY in the rebuilt block: {0}" -f $hasKey)
if ($hasKey) {
  $v = [string]$rebuilt['OPENROUTER_API_KEY']
  Write-Output ("  length {0}, shape valid: {1}" -f $v.Length, ($v -match '^sk-or-v1-[a-f0-9]{64}$'))
}

Write-Output ''
Write-Output '=== 4. the decisive test: run the daemon task and see if a job gets a key ==='
Write-Output '  (done by the caller, which restarts the task and reads runs.jsonl)'