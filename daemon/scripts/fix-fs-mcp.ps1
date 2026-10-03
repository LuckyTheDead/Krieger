$ErrorActionPreference = 'Continue'
# Fix the filesystem MCP server failing to connect.
#
# Cause, measured: @modelcontextprotocol/sdk is 1.0.1 while
# server-filesystem is pinned at 0.6.2, which was published against the 0.x SDK
# and emits an inputSchema with no top-level "type". The 1.x client rejects that:
#   code invalid_value, path tools[0].inputSchema.type, "expected object"
#
# The two are not interchangeable majors, so pinning the SDK down would risk
# breaking the servers that currently work. Upgrade the server instead.
#
# Safe to re-run: it installs, verifies by requiring a real tools/list response,
# and leaves the working servers alone.

$npm = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\npm.cmd'
$root = "$env:USERPROFILE\tools\mcp"
$fs = "$root\node_modules\@modelcontextprotocol\server-filesystem"
$node = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\node.exe'

Write-Host '=== upgrading server-filesystem ==='
Write-Host ''
Push-Location $root
try {
  & $npm install @modelcontextprotocol/server-filesystem@latest --no-audit --no-fund --prefix $root 2>&1 |
    Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
} finally {
  Pop-Location
}

$v = (Get-Content (Join-Path $fs 'package.json') -Raw | ConvertFrom-Json).version
Write-Host ''
Write-Host ("  installed version now: {0}" -f $v)

Write-Host ''
Write-Host '=== verify by requiring a real tools/list response ==='
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "`"$fs\dist\index.js`" `"$env:USERPROFILE\tiny-agent-git`""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
$p.StandardInput.Close()
$task = $p.StandardOutput.ReadToEndAsync()
$deadline = (Get-Date).AddSeconds(25)
while (-not $task.IsCompleted -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
try { $p.Kill() } catch { }
$out = $task.Result

if ($out -match '"tools"') {
  $names = [regex]::Matches($out, '"name"\s*:\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
  Write-Host ("  ANSWERED: {0} tool(s)" -f $names.Count)
  $names | ForEach-Object { Write-Host "    $_" }
  # The complaint was a missing inputSchema.type, so check it is now present.
  if ($out -match '"inputSchema"\s*:\s*\{\s*"type"\s*:\s*"object"') {
    Write-Host '  inputSchema.type is present and is "object" -- the original complaint is resolved'
  } elseif ($out -match '"inputSchema"\s*:\s*\{[^}]*"type"\s*:\s*"object"') {
    Write-Host '  inputSchema.type present (ordered differently)'
  } else {
    Write-Host '  NOTE: no inputSchema.type found in the response; the SDK may still object'
  }
} else {
  Write-Host '  no tools/list response'
  $err = $p.StandardError.ReadToEnd()
  if ($err) { Write-Host ("  stderr: {0}" -f $err.Substring(0, [Math]::Min(240, $err.Length))) }
}