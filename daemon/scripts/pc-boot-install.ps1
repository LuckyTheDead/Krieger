$ErrorActionPreference = 'Continue'
# Register the boot hook to run at logon. Idempotent: re-running replaces the
# task rather than adding a second one.
$script = "$env:USERPROFILE\pc-boot.ps1"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName 'TinyAgentBoot' -Action $action -Trigger $trigger `
  -Principal $principal -Force -EA SilentlyContinue | Out-Null

$t = Get-ScheduledTask -TaskName 'TinyAgentBoot' -EA SilentlyContinue
if ($t) {
  Write-Host "registered: $($t.TaskName) state=$($t.State)"
  Write-Host "next run:  $(($t.Triggers | Select-Object -First 1).CimClass.CimClassName)"
} else {
  Write-Host 'FAILED to register'
  exit 1
}

# Verify it actually runs, rather than trusting registration.
Write-Host '--- test run ---'
& powershell -NoProfile -ExecutionPolicy Bypass -File $script
Get-Content "$env:USERPROFILE\tiny-agent-boot.log" -Tail 3