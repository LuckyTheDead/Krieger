$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dest = "$env:USERPROFILE\tools"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Prefer a real python.org build over the Microsoft Store stub, which is what
# `python` resolves to by default and refuses to run.
$url = 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe'
$exe = "$dest\python-3.12.7-amd64.exe"

if (-not (Test-Path "$dest\python\python.exe")) {
  Write-Host "Downloading $url"
  Invoke-WebRequest -UseBasicParsing $url -OutFile $exe

  Write-Host "Installing silently to $dest\python"
  $p = Start-Process -FilePath $exe -ArgumentList @(
        '/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'Include_launcher=0',
        "TargetDir=$dest\python", 'Include_test=0', 'Include_pip=1'
      ) -Wait -PassThru
  Write-Host "installer exit: $($p.ExitCode)"
}

$py = "$dest\python\python.exe"
if (Test-Path $py) {
  Write-Host "python: $(& $py --version 2>&1)"
  Write-Host "CHECK:  $(& $py -c 'import sys;print(sys.executable)' 2>&1)"
  Write-Host "PYTHON_OK"
} else {
  Write-Host 'python.exe missing after install'
  exit 1
}