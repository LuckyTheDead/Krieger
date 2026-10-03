$ErrorActionPreference = 'SilentlyContinue'
# Capture a short burst of frames so brightness and motion can be measured
# OFFLINE, on the phone. Trying to get ffmpeg to print statistics over an SSH
# pipe proved unreliable -- signalstats exists, but its metadata goes to stderr
# in a form that does not survive the trip. Capturing frames and analysing them
# locally is both simpler and verifiable.
$exe = Get-ChildItem "$env:USERPROFILE\tools" -Filter ffmpeg.exe -Recurse |
       Select-Object -First 1
$ff = $exe.FullName
$out = "$env:USERPROFILE\camframes"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -Filter *.jpg -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue

# 12 frames, 1 per second, downscaled: enough to see whether anything changes,
# small enough to pull over the network in one fetch.
& $ff -hide_banner -loglevel error -f dshow -i "video=Integrated Webcam" `
      -vf "fps=1,scale=160:120" -t 12 -q:v 5 -y "$out\f%02d.jpg" 2>&1 | Out-Null

$frames = Get-ChildItem $out -Filter *.jpg -EA SilentlyContinue | Sort-Object Name
Write-Output ("frames captured: {0}" -f $frames.Count)
if ($frames.Count -eq 0) {
  Write-Output 'CAPTURE FAILED'
  exit 1
}
foreach ($f in $frames) {
  Write-Output ("  {0}  {1:N0} bytes" -f $f.Name, $f.Length)
}
Write-Output 'pull them with:'
Write-Output '  sftp -P 22 ... ${PC_USER}@${PC_HOST}:camframes/ ./camframes'