$ErrorActionPreference = 'SilentlyContinue'
# Report ffmpeg install state without shell-escaping gymnastics. One-liners with
# \$ inside an ssh command arrive already unquoted and fail to parse; this is a
# file for that reason, not preference.
$zip = "$env:USERPROFILE\tools\ffmpeg.zip"
if (Test-Path $zip) {
  Write-Output ("zip: {0:N0} bytes" -f (Get-Item $zip).Length)
} else {
  Write-Output 'zip: absent'
}
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
if ($exe) {
  Write-Output ("exe: {0}" -f $exe.FullName)
  Write-Output ("version: {0}" -f ((& $exe.FullName -hide_banner -version 2>&1) | Select-Object -First 1))
} else {
  Write-Output 'exe: not present yet'
}
Write-Output ("powershell procs: {0}" -f (Get-Process powershell | Measure-Object).Count)