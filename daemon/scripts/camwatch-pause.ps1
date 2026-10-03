$ErrorActionPreference = 'SilentlyContinue'
# Stop the periodic watcher so a self-test can own the frames directory.
$ErrorActionPreference = 'Continue'
$t = Get-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue
if ($t) {
  Stop-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue
  Disable-ScheduledTask -TaskName 'KriegerCamWatch' -EA SilentlyContinue | Out-Null
  Write-Output 'KriegerCamWatch disabled'
} else {
  Write-Output 'KriegerCamWatch was not registered'
}
$t2 = Get-ScheduledTask -TaskName 'TinyAgentBoot' -EA SilentlyContinue
Write-Output "TinyAgentBoot state: $(if($t2){$t2.State}else{'absent'})"