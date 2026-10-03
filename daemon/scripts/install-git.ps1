$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dest = "$env:USERPROFILE\tools"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Portable git: download the 7z SFX-free archive instead of running the
# installer. The installer reported exit 0 while creating NO directory at all
# when passed /D=, so the silent path is unreliable here. Extracting is
# deterministic and needs no installer semantics.
$url = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/PortableGit-2.47.1-64-bit.7z.exe'
$sfx = "$dest\portablegit.exe"
$target = "$dest\git"

if (-not (Test-Path "$target\cmd\git.exe")) {
  Write-Host "downloading portable git..."
  Invoke-WebRequest -UseBasicParsing $url -OutFile $sfx
  Write-Host "extracting to $target ..."
  # The 7z SFX takes -o<dir> and runs silently with -y.
  $p = Start-Process -FilePath $sfx -ArgumentList "-o`"$target`"", '-y' -Wait -PassThru -NoNewWindow
  Write-Host "sfx exit: $($p.ExitCode)"
}

# Discover, do not assume: report whatever git.exe actually exists.
$found = Get-ChildItem -Path $dest -Filter git.exe -Recurse -ErrorAction SilentlyContinue |
         Select-Object -First 1
if ($found) {
  Write-Host "GIT_OK $($found.FullName)"
  Write-Host "version: $(& $found.FullName --version)"
} else {
  Write-Host 'FAIL: no git.exe anywhere under tools'
  Get-ChildItem -Path $dest | ForEach-Object { Write-Host "  present: $($_.Name)" }
  exit 1
}