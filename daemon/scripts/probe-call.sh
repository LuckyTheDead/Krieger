R='C:\Users\${PC_USER}\tiny-agent-git'
ND='C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64'
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shell_exec","arguments":{"command":"echo hello"}}}' \
  | timeout 20 "$ND\\node.exe" "$R\\termux-mcp\\termux-mcp.js" 2>&1 | head -4
