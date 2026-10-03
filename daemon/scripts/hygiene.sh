#!/data/data/com.termux/files/usr/bin/bash
# Disk and log growth. Cheap, no network, no model call.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

used=$(df -P . | tail -1 | awk '{print $5}' | tr -d '%')
avail=$(df -Ph . | tail -1 | awk '{print $4}')
mem=$(wc -l < memory/memories.jsonl 2>/dev/null || echo 0)
runs=$(wc -l < daemon/runs.jsonl 2>/dev/null || echo 0)
runbytes=$(du -h daemon/runs.jsonl 2>/dev/null | awk '{print $1}' || echo "-")

echo "disk ${used}% used, ${avail} free"
echo "memories: ${mem} lines"
echo "runlog:   ${runs} entries (${runbytes})"

if [[ "$used" -ge 90 ]]; then
  termux-notification -t "krieger: disk ${used}%" -c "workspace over 90% full" -p do-not-disturb 2>/dev/null || true
  exit 1
fi
exit 0
