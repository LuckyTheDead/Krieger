#!/data/data/com.termux/files/usr/bin/bash
# Watch what the PC exposes to the network, and notice when it changes.
#
#   ./daemon/languard.sh snapshot    record the current state
#   ./daemon/languard.sh diff         compare against the last snapshot
#   ./daemon/languard.sh watch        poll every N seconds, alert on change
#   ./daemon/languard.sh status       what is exposed right now, human-readable
#
# Why this is the first piece of the security system rather than the camera:
# this machine currently has BitLocker OFF and answers on 445 (SMB) and 139
# (NetBIOS) on every interface, and nothing notices if that changes. A detector
# that only fires when someone already breaks in is too late; the useful signal
# is a configuration change, which usually happens before an intrusion and while
# somebody is watching.
#
# Read-only: it enumerates and records, and never changes the PC. The one thing
# it does write is its own snapshot, under ~/.cache.
#
# Design notes:
#   - state lives on the PHONE, so it survives the PC rebooting and works even
#     when the PC is the thing that has gone wrong
#   - a diff of listeners catches a new port, a closed port, and a changed bind
#     address, which is the difference between "listening on 127.0.0.1" and
#     "listening on everything" -- a one-character change with real consequences
#   - it does NOT alert on every scan result, only on a diff from the recorded
#     baseline, so it stays quiet until something actually changes

set -uo pipefail

STATE_DIR="$HOME/.cache/languard"
SNAP="$STATE_DIR/pc-listeners.json"
SCRIPT='C:\Users\${PC_USER}\languard-listeners.ps1'
INTERVAL="${LAGUARD_INTERVAL:-300}"

mkdir -p "$STATE_DIR"

listeners() {
  # The .ps1 lives on the PC; scp it on first use so this script and the PC
  # never drift out of sync.
  local here="$REPO_ROOT/daemon/scripts/languard-listeners.ps1"
  [[ -f "$here" ]] || { echo "languard-listeners.ps1 not found"; return 1; }
  ./daemon/pc.sh --put "$here" 'C:/Users/${PC_USER}/languard-listeners.ps1' >/dev/null 2>&1
  ./daemon/pc.sh "powershell -NoProfile -ExecutionPolicy Bypass -File $SCRIPT" 2>/dev/null | tr -d '\r'
}

summarise() {
  python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"  (unreadable snapshot: {e})")
    sys.exit(0)
rows = d.get("listening", [])
# Anything bound to every interface is reachable from the LAN. That is the
# distinction that matters; 127.0.0.1 or ::1 is not exposed.
lan = [r for r in rows if r.get("scope") == "ALL"]
lan.sort(key=lambda r: r["port"])
print(f"  {len(rows)} listening total, {len(lan)} reachable from the LAN:")
for r in lan:
    flag = "  <-- ssh, ours" if r["port"] == 22 else ""
    print(f"    {r['port']:>6}  {r['process']}{flag}")
PY
}

diff_snapshots() {
  python3 - "$SNAP" "$1" <<'PY'
import json, sys

def load(p):
    try:
        return {(r["port"], r["scope"]): r for r in json.load(open(p)).get("listening", [])}
    except Exception:
        return {}

old, new = load(sys.argv[1]), load(sys.argv[2])
if not old:
    print("  no baseline yet -- recording this as the baseline")
    sys.exit(0)

added   = {k: v for k, v in new.items() if k not in old}
removed = {k: v for k, v in old.items() if k not in new}
changed = {k: (old[k], v) for k, v in new.items()
           if k in old and old[k].get("process") != v.get("process")}

if not (added or removed or changed):
    print("  no change")
    sys.exit(0)

for k, v in sorted(added.items()):
    reach = "REACHABLE FROM THE LAN" if v["scope"] == "ALL" else "local only"
    print(f"  NEW      :{k[0]}  {v['process']}  ({reach})")
for k, v in sorted(removed.items()):
    print(f"  CLOSED   :{k[0]}  {v['process']}")
for k, (o, n) in sorted(changed.items()):
    print(f"  OWNER    :{k[0]}  {o.get('process')} -> {n.get('process')}")

# A new LAN-reachable port is the only change worth waking someone for.
noisy = [k for k, v in added.items() if v["scope"] == "ALL"]
sys.exit(1 if noisy else 0)
PY
}

REPO_ROOT="$HOME/tiny-agent"

case "${1:-status}" in
  snapshot)
    tmp="$STATE_DIR/.new.json"
    if listeners > "$tmp"; then
      if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$tmp" 2>/dev/null; then
        mv "$tmp" "$SNAP"
        echo "snapshot recorded: $SNAP"
      else
        echo "snapshot was not valid JSON -- not overwriting the baseline"
        rm -f "$tmp"
        exit 1
      fi
    else
      echo "could not read listeners from the PC"
      exit 1
    fi
    ;;

  status)
    echo "PC exposure right now ($(date '+%H:%M:%S')):"
    listeners > "$STATE_DIR/.cur.json" 2>/dev/null
    summarise "$STATE_DIR/.cur.json"
    ;;

  diff)
    tmp="$STATE_DIR/.cur.json"
    listeners > "$tmp" || { echo "could not reach the PC"; exit 1; }
    echo "changes since the baseline:"
    diff_snapshots "$tmp"
    ;;

  watch)
    echo "watching every ${INTERVAL}s; ctrl-c to stop"
    last_alert=0
    while true; do
      tmp="$STATE_DIR/.cur.json"
      if listeners > "$tmp"; then
        out=$(diff_snapshots "$tmp"); rc=$?
        if [[ "$out" != *"no change"* && "$out" != *"no baseline"* ]]; then
          echo "[$(date '+%H:%M:%S')] CHANGE"
          echo "$out" | sed 's/^/  /'
          # Cooldown so a flapping service cannot turn this into a log flood.
          if (( $(date +%s) - last_alert > 60 )); then
            echo "  (a new LAN-reachable port appeared -- this is the one that matters)"
            last_alert=$(date +%s)
          fi
        fi
      else
        echo "[$(date '+%H:%M:%S')] PC unreachable -- cannot check"
      fi
      sleep "$INTERVAL"
    done
    ;;

  *)
    echo "usage: languard.sh {snapshot|diff|watch|status}"
    exit 1
    ;;
esac