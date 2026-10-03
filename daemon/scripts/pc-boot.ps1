[CmdletBinding()]
param(
  # Where the git clone lives on the PC.
  [string]$Repo = 'C:\Users\${PC_USER}\tiny-agent-git',
  # Full path to node; it is not on PATH in a non-interactive session.
  [string]$NodeExe = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\node.exe',
  # Python, for the security scanners. Also not on PATH.
  [string]$Python = 'C:\Users\${PC_USER}\tools\python\python.exe'
)

$ErrorActionPreference = 'Continue'
$log = "$env:USERPROFILE\tiny-agent-boot.log"

function Say($m) {
  $line = "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')] $m"
  Add-Content -Path $log -Value $line
}

Say 'boot hook starting'

# --- prerequisites, reported not assumed ---
foreach ($p in @($NodeExe, $Python, $Repo)) {
  if (-not (Test-Path $p)) { Say "MISSING: $p" }
}

# Make the toolchain visible to child processes. npm scripts and the scheduler
# both shell out to `node`/`npm` by name, which fails without this -- that is
# why `npm test` reported "'npm' is not recognized" on an earlier run.
$env:PATH = "$(Split-Path $NodeExe);$(Split-Path $Python);$env:PATH"
$env:SECURITY_TEST_PYTHON = $Python

# --- resume the long ARC run if it is not already going ---
# The depth-4 combined arm is the expensive one and takes hours. A reboot kills
# it, and nothing restarts it automatically, so check first rather than starting
# a SECOND process writing the same results file -- which is exactly the mistake
# that cost an earlier run.
$arcRunning = (Get-CimInstance Win32_Process -Filter "Name='python.exe'" -EA SilentlyContinue |
               Where-Object { $_.CommandLine -like '*obj_experiment*' })
if ($arcRunning) {
  Say "ARC depth-4 already running as pid $($arcRunning.ProcessId) -- not starting another"
} elseif (Test-Path 'C:\Users\${PC_USER}\arc80\run.bat') {
  Start-Process powershell -WindowStyle Hidden -ArgumentList `
    "-NoProfile -Command `"& 'C:\Users\${PC_USER}\arc80\run.bat'`"" -EA SilentlyContinue
  Say 'ARC depth-4 relaunched'
} else {
  Say 'ARC run.bat absent; nothing to resume'
}

# --- keep sshd up, since that is the only way back in if this all breaks ---
$sshd = Get-Service sshd -EA SilentlyContinue
if ($sshd -and $sshd.Status -ne 'Running') {
  Start-Service sshd -EA SilentlyContinue
  Say 'sshd restarted'
} elseif ($sshd) {
  Say 'sshd already running'
} else {
  Say 'sshd service MISSING'
}

Say 'boot hook done'