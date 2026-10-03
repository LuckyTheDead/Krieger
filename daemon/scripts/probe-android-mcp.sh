#!/data/data/com.termux/files/usr/bin/bash
# Ask each Android-only MCP server for one command and record HOW it fails on a
# host with no Termux. A server that reports a clear "not available here" is
# fine; one that hangs, or returns empty success, is a trap.
set -uo pipefail
R='C:\Users\${PC_USER}\tiny-agent-git'
ND='C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64'
for s in termux-api-mcp termux-mcp; do
  echo "=== $s ==="
  echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    | timeout 15 "$ND\\node.exe" "$R\\termux-mcp\\$s.js" 2>&1 | head -6
  echo "  [exit=$?]"
done
