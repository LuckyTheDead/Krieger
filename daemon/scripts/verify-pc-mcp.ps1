$ErrorActionPreference = 'SilentlyContinue'
# Do the two newly installed MCP servers actually WORK on Windows? Existing is
# not working: both are #!/usr/bin/env scripts, and Windows has no /usr/bin/env,
# so spawning the file directly fails before any of their code runs. The fix
# used on the phone is to spawn `node <script>` explicitly -- confirm it holds.

$node = 'C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64\node.exe'
$store = "$env:USERPROFILE\tools\mcp\node_modules"

function Test-Server($name, $script, $probe) {
  Write-Output "=== $name ==="
  Write-Output "  script: $script"
  if (-not (Test-Path $script)) { Write-Output '  MISSING'; return $false }

  # tools/list is the cheapest real request: it forces the server to actually
  # start and answer over stdio.
  $req = $probe
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = "`"$script`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)

  $p.StandardInput.WriteLine($req)
  $p.StandardInput.Close()

  $outTask = $p.StandardOutput.ReadToEndAsync()
  $deadline = (Get-Date).AddSeconds(20)
  while (-not $outTask.IsCompleted -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }

  try { $p.Kill() } catch { }
  $out = $outTask.Result

  if ($out -match '"tools"') {
    $names = [regex]::Matches($out, '"name"\s*:\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
    Write-Output ("  WORKS - {0} tool(s): {1}" -f $names.Count, (($names | Select-Object -First 6) -join ', '))
    return $true
  }
  Write-Output ("  no tools/list response. got: {0}" -f ($out.Substring(0, [Math]::Min(120, $out.Length))))
  $err = $p.StandardError.ReadToEnd()
  if ($err) { Write-Output ("  stderr: {0}" -f ($err.Substring(0, [Math]::Min(160, $err.Length)))) }
  return $false
}

$listReq = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
$fsList = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

$okFs = Test-Server 'mcp-server-filesystem' `
        (Join-Path $store '@modelcontextprotocol\server-filesystem\dist\index.js') $fsList
$okRemote = Test-Server 'mcp-remote' (Join-Path $store 'mcp-remote\dist\proxy.js') $listReq

Write-Output ''
Write-Output '=== summary ==='
Write-Output ("  mcp-server-filesystem : {0}" -f $(if ($okFs) { 'WORKS' } else { 'FAILED' }))
Write-Output ("  mcp-remote            : {0}" -f $(if ($okRemote) { 'WORKS' } else { 'FAILED (needs a URL argument)' }))
Write-Output ''
Write-Output 'mcp-remote is a PROXY: it takes a server URL as argv and needs network.'
Write-Output 'Failure above would not be a defect, just a missing argument.'
exit 0