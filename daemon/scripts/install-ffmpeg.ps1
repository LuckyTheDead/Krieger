$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Static ffmpeg, no installer and no admin, under the user profile.
#
# Two things learned doing this the first time:
#   - a PARTIAL ffmpeg.zip left behind by a killed attempt makes the next
#     Invoke-WebRequest fail with an IOException that looks like a network
#     problem. Delete it first, every time.
#   - the download is ~80MB and my own tool calls time out waiting, so this runs
#     detached via pcdispatch rather than in the foreground.
$dest = "$env:USERPROFILE\tools"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$zip = "$dest\ffmpeg.zip"
$target = "$dest\ffmpeg"

$existing = Get-ChildItem -Path $dest -Filter ffmpeg.exe -Recurse -EA SilentlyContinue |
            Select-Object -First 1
if ($existing) {
  Write-Host "already installed: $($existing.FullName)"
} else {
  if (Test-Path $zip) {
    Write-Host "removing partial download ($((Get-Item $zip).Length) bytes)"
    Remove-Item $zip -Force
  }
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }

  $mirrors = @(
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
  )
  $ok = $false
  foreach ($url in $mirrors) {
    try {
      Write-Host "trying $url"
      Invoke-WebRequest -UseBasicParsing $url -OutFile $zip -TimeoutSec 600
      $len = (Get-Item $zip).Length
      Write-Host "downloaded $len bytes"
      if ($len -lt 1000000) { throw "suspiciously small ($len bytes), treating as failure" }
      $ok = $true
      break
    } catch {
      Write-Host "  failed: $($_.Exception.Message)"
      if (Test-Path $zip) { Remove-Item $zip -Force -EA SilentlyContinue }
    }
  }
  if (-not $ok) { Write-Host 'FFMPEG_FAILED: every mirror failed'; exit 1 }

  Write-Host 'extracting...'
  Expand-Archive -Path $zip -DestinationPath $target -Force
  Remove-Item $zip -Force
}

$exe = Get-ChildItem -Path $target -Filter ffmpeg.exe -Recurse -EA SilentlyContinue |
       Select-Object -First 1
if ($exe) {
  Write-Host "ffmpeg: $($exe.FullName)"
  Write-Host "version: $(& $exe.FullName -hide_banner -version 2>&1 | Select-Object -First 1)"
  Write-Host 'FFMPEG_OK'
} else {
  Write-Host 'FAIL: ffmpeg.exe not found after extract'
  exit 1
}