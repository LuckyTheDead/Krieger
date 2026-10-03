$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dest = "$env:USERPROFILE\tools"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$zip = "$dest\node.zip"

Write-Host "Querying nodejs.org for the current LTS..."
$index = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/index.json').Content | ConvertFrom-Json
$lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
if (-not $lts) { Write-Host 'no LTS entry found'; exit 1 }
$v = $lts.version
Write-Host "Latest LTS: $v ($($lts.lts))"

$url = "https://nodejs.org/dist/$v/node-$v-win-x64.zip"
Write-Host "Downloading $url"
Invoke-WebRequest -UseBasicParsing $url -OutFile $zip

Write-Host "Extracting..."
$target = "$dest\node"
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $target -Force
Remove-Item $zip -Force

$nodeExe = (Get-ChildItem -Path $target -Filter node.exe -Recurse | Select-Object -First 1).FullName
if (-not $nodeExe) { Write-Host 'node.exe not found after extract'; exit 1 }

Write-Host "node.exe: $nodeExe"
& $nodeExe --version
Write-Host "npm:      $((Get-ChildItem -Path $target -Filter npm.cmd -Recurse | Select-Object -First 1).FullName)"
Write-Host "INSTALL_OK"