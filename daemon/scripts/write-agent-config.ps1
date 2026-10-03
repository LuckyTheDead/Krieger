$ErrorActionPreference = 'Stop'
# Write agent.json on the PC -- model, endpoint and MCP servers, but NO api key.
#
# The key stays where it is: a User-scope environment variable. agent.json is
# gitignored precisely because it used to hold a plaintext key, and this file is
# written without one so that remains true. The scheduler reads the environment
# first, so the key is found there.
#
# The server list is the phone's, minus the two that were never present here, plus
# the two that were installed for exactly this purpose:
#   dropped  mcp-remote, mcp-server-filesystem -- were absent; now installed
#   kept     memory-mcp, session-mcp, termux-mcp
#   dropped  termux-api-mcp -- Android-only, cannot work on Windows
#
# Every entry spawns `node <script>` rather than the file itself. All of these are
# #!/usr/bin/env scripts and Windows has no /usr/bin/env, so the kernel rejects the
# shebang before any code runs -- the same bug already fixed on the phone.

$ErrorActionPreference = 'Stop'

$node = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\node.exe'
$repo = "$env:USERPROFILE\tiny-agent-git"
$store = "$env:USERPROFILE\tools\mcp\node_modules"
$out = Join-Path $repo 'agent.json'

$servers = @(
  @{ type = 'stdio'; command = $node; args = @((Join-Path $repo 'termux-mcp\memory-mcp.js')) },
  @{ type = 'stdio'; command = $node; args = @((Join-Path $repo 'termux-mcp\session-mcp.js')) },
  @{ type = 'stdio'; command = $node; args = @((Join-Path $repo 'termux-mcp\termux-mcp.js')) },
  @{ type = 'stdio'; command = $node; args = @((Join-Path $store 'mcp-remote\dist\proxy.js'), 'https://huggingface.co/mcp') },
  @{ type = 'stdio'; command = $node; args = @((Join-Path $store '@modelcontextprotocol\server-filesystem\dist\index.js'), $repo) }
)

$cfg = [ordered]@{
  model      = 'stealth/space-bunny-alpha'
  endpointUrl = 'https://openrouter.ai/api/v1'
  servers    = $servers
}

# No apiKey field. Deliberate.
$json = $cfg | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Output "wrote $out"
Write-Output ("  model      : {0}" -f $cfg.model)
Write-Output ("  endpoint   : {0}" -f $cfg.endpointUrl)
Write-Output ("  servers    : {0}" -f $cfg.servers.Count)
Write-Output '  apiKey     : absent, by design -- the key is an environment variable'

Write-Output ''
Write-Output 'verify every script path exists before declaring success:'
$allOk = $true
foreach ($s in $cfg.servers) {
  $p = $s.args[0]
  if (Test-Path $p) { Write-Output ("  ok      {0}" -f (Split-Path $p -Leaf)) }
  else { Write-Output ("  MISSING {0}" -f $p); $allOk = $false }
}
if (-not $allOk) { Write-Output 'FAIL: a referenced script is missing'; exit 1 }

Write-Output ''
Write-Output 'all referenced scripts present'