$ErrorActionPreference = 'Continue'
# Install the two MCP servers that are missing on the PC.
#
# They were never shipped with the repo bundle because they are npm-installed
# binaries on the phone, not tracked source. Rather than copy files across (which
# would be unversioned and platform-blind), install the same packages from npm on
# the PC. Both are plain JS, so they run on Windows; neither has a native binary.
#
# This is what an agent job on the PC is missing:
#   mcp-remote             -> reach the HuggingFace MCP server
#   mcp-server-filesystem  -> a real filesystem tool, instead of shelling out
#
# Read-only with respect to the repo: installs into the tools directory, touches
# nothing in the clone.

$npm = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\npm.cmd'
$root = "$env:USERPROFILE\tools\mcp"
$store = "$root\node_modules"
$bin = "$root\bin"

Write-Host '=== installing the missing MCP servers ==='
if (-not (Test-Path $npm)) { Write-Host "FAIL: npm not found at $npm"; exit 1 }
New-Item -ItemType Directory -Force -Path $root | Out-Null

# A minimal package.json so npm installs into a known place rather than wherever
# the current directory happens to be.
@'
{
  "name": "pc-mcp-servers",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "mcp-remote": "^0.1.31",
    "@modelcontextprotocol/server-filesystem": "^0.6.2"
  }
}
'@ | Set-Content -Path "$root\package.json" -Encoding UTF8

Write-Host "  installing into $store"
Push-Location $root
try {
  & $npm install --no-audit --no-fund --prefix $root 2>&1 |
    Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '  what landed:'
foreach ($pkg in @('mcp-remote', '@modelcontextprotocol\server-filesystem')) {
  $p = Join-Path $store "$pkg\package.json"
  if (Test-Path $p) {
    $v = (Get-Content $p -Raw | ConvertFrom-Json).version
    Write-Host ("    ok      {0}@{1}" -f $pkg, $v)
  } else {
    Write-Host ("    MISSING {0}" -f $pkg)
  }
}

Write-Host ''
Write-Host '  do they actually start on Windows? (both have #!/usr/bin/env shebangs,'
Write-Host '   which Windows does not use -- so spawn them as `node <script>`, the same'
Write-Host '   fix already applied to agent.json on the phone)'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$scripts = @{
  'mcp-remote'            = Join-Path $store 'mcp-remote\dist\proxy.js'
  'mcp-server-filesystem' = Join-Path $store '@modelcontextprotocol\server-filesystem\dist\index.js'
}
foreach ($k in $scripts.Keys) {
  $s = $scripts[$k]
  if (Test-Path $s) {
    Write-Host ("    ok      {0} -> {1}" -f $k, $s)
  } else {
    Write-Host ("    MISSING {0} script at {1}" -f $k, $s)
  }
}

Write-Host ''
Write-Host 'NOTE: these are for MANUAL use and for wiring agent.json on the PC.'
Write-Host 'The PC has no agent.json (it holds a live API key and is gitignored), so'
Write-Host 'nothing is configured automatically. That is deliberate.'
exit 0