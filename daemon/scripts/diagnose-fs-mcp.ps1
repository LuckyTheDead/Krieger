$ErrorActionPreference = 'SilentlyContinue'
# mcp-server-filesystem@0.6.2 fails to connect on Windows:
#   code invalid_value, path tools[0].inputSchema.type, "expected object"
#
# The package ships tools whose inputSchema uses a zod-to-json-schema shape the
# SDK rejects. Either the package is too old for this SDK, or the two versions
# disagree. Find out which, because the fix differs: upgrade one, or pin the
# other. Read-only.

$node = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\node.exe'
$fs = "$env:USERPROFILE\tools\mcp\node_modules\@modelcontextprotocol\server-filesystem"
$mcp = "$env:USERPROFILE\tools\mcp\node_modules\@modelcontextprotocol\sdk"

Write-Output '=== versions in play ==='
foreach ($p in @($fs, $mcp)) {
  $pj = Join-Path $p 'package.json'
  if (Test-Path $pj) {
    $j = Get-Content $pj -Raw | ConvertFrom-Json
    Write-Output ("  {0}  version={1}" -f $j.name, $j.version)
  } else {
    Write-Output ("  {0}  MISSING" -f $p)
  }
}

Write-Output ''
Write-Output '=== what does tools/list actually return? (the raw shape) ==='
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
$deadline = (Get-Date).AddSeconds(20)
while (-not $task.IsCompleted -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
try { $p.Kill() } catch { }
$out = $task.Result

if ($out -match '"tools"') {
  Write-Output '  tools/list DID answer. The shape it returns:'
  # Show just the first tool's inputSchema, which is where the complaint is.
  $m = [regex]::Match($out, '"inputSchema"\s*:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*?\}')
  if ($m.Success) {
    $s = $m.Value
    if ($s.Length -gt 300) { $s = $s.Substring(0,300) + '...' }
    Write-Output "    $s"
  }
  $types = [regex]::Matches($out, '"inputSchema"\s*:\s*\{\s*"type"\s*:\s*"?([\w]+)"?') |
           ForEach-Object { $_.Groups[1].Value }
  Write-Output ("  inputSchema.type values seen: {0}" -f (($types | Select-Object -Unique) -join ', '))
} else {
  Write-Output '  tools/list did NOT answer'
  $err = $p.StandardError.ReadToEnd()
  if ($err) { Write-Output ("  stderr: {0}" -f $err.Substring(0, [Math]::Min(300, $err.Length))) }
}

Write-Output ''
Write-Output '=== newest version available for server-filesystem ==='
try {
  $r = Invoke-WebRequest -UseBasicParsing 'https://registry.npmjs.org/@modelcontextprotocol/server-filesystem' -TimeoutSec 20
  $j = $r.Content | ConvertFrom-Json
  Write-Output ("  latest: {0}" -f $j.'dist-tags'.latest)
  Write-Output ("  installed: {0}" -f (Get-Content (Join-Path $fs 'package.json') -Raw | ConvertFrom-Json).version)
  Write-Output '  -> if latest > installed, an upgrade is the fix; if equal, the SDK is the problem'
} catch {
  Write-Output ("  could not query npm: {0}" -f $_.Exception.Message)
}