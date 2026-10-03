#!/data/data/com.termux/files/usr/bin/bash
# Start Termux's sshd on port 8022, idempotently.
#
#   ./daemon/sshd-up.sh                 start, loopback only (default)
#   ./daemon/sshd-up.sh start --lan     start and expose to the network
#   ./daemon/sshd-up.sh stop-lan        withdraw network exposure, keep loopback
#   ./daemon/sshd-up.sh stop            kill it
#
# Why loopback is the default: on 2026-10-01 a network assessment found sshd
# bound to 0.0.0.0:8022, reachable by every device on whatever Wi-Fi the phone
# had joined -- including a workplace network whose authorisation was never
# established. Exposure is now opt-in so the safe state is the resting state.
# Remote access is not lost: add --lan when you actually want it.
#
# Why this exists: remote access is the fallback for driving the daemon when the
# Termux:API bridge is unusable (it is, since 2026-09-30 -- the broadcast is
# delivered and the reply never arrives). sshd needs no Termux:API, so it works.
#
# It still dies when Android kills Termux. Nothing here fixes that; the wake lock
# in start.sh only reduces the odds.

set -uo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
SSHD_BIN=/data/data/com.termux/files/usr/bin/sshd
SSHD_CONF=/data/data/com.termux/files/usr/etc/ssh/sshd_config
LOG="$HOME/.sshd.log"
PORT=8022
# Records that the user explicitly asked for network exposure. The bind address
# lives in sshd_config, which the boot hook also rewrites, so without this the
# exposure would silently revert to loopback on the next restart.
LAN_MARKER="$HOME/.sshd-lan"

running() {
  # Match the binary path ONLY, not "sshd -f <conf>". On this device `ps` shows
  # a truncated argv (just ".../sshd", no flags), so any pattern naming the
  # config file fails to match and the script reports "not running" while sshd is
  # live -- then a start attempt double-binds the port. Matching the binary path
  # is the widest pattern that still cannot match this script's own text.
  pgrep -f "$SSHD_BIN" >/dev/null 2>&1
}

lan_ip() {
  # `ip` and /proc/net are both restricted in some Termux sandboxes; node is not.
  # The `break` (not `return`) is load-bearing: a top-level `return` is an illegal
  # return statement in `node -e`, so the script dies with a SyntaxError before
  # ever printing. `break` leaves only the inner loop, which is what is wanted
  # because wlan0 is the only non-internal IPv4 interface on this device.
  /data/data/com.termux/files/usr/bin/node -e '
    const os = require("os");
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === "IPv4" && !i.internal) { console.log(i.address); break; }
    }
  ' 2>/dev/null
}

set_verb() {
  # Rewrite the single ListenAddress line in place. Idempotent either way, so
  # this can run on every boot regardless of the previous mode.
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const val = process.argv[2];
    let s = fs.readFileSync(p, "utf8");
    const re = /^ListenAddress .*$/m;
    if (!re.test(s)) { console.error("no ListenAddress line found"); process.exit(1); }
    s = s.replace(re, "ListenAddress " + val);
    fs.writeFileSync(p, s);
  ' "$SSHD_CONF" "$1"
}

restart() {
  pkill -f "$SSHD_BIN" >/dev/null 2>&1
  sleep 1
  nohup "$SSHD_BIN" -f "$SSHD_CONF" >>"$LOG" 2>&1
  sleep 2
}

bind_mode() {
  grep -m1 '^ListenAddress' "$SSHD_CONF" 2>/dev/null | awk '{print $2}'
}

case "${1:-start}" in
  start)
    LAN=0
    [[ "${2:-}" == "--lan" ]] && LAN=1
    # No explicit argument: honour a previous --lan so a restart does not
    # quietly withdraw an exposure the user asked for.
    if [[ -z "${2:-}" && -f "$LAN_MARKER" ]]; then
      LAN=1
      echo "resuming LAN exposure recorded in $LAN_MARKER"
    fi
    if [[ "$LAN" == "1" ]]; then
      touch "$LAN_MARKER" 2>/dev/null
    else
      rm -f "$LAN_MARKER" 2>/dev/null
    fi
    if [[ "$LAN" == "1" ]]; then
      set_verb 0.0.0.0 || exit 1
    else
      set_verb 127.0.0.1 || exit 1
    fi
    [[ -f "$SSHD_CONF" ]] || { echo "missing $SSHD_CONF" >&2; exit 1; }
    "$SSHD_BIN" -t -f "$SSHD_CONF" || { echo "config test failed" >&2; exit 1; }
    if running; then
      restart || { echo "restart failed" >&2; exit 1; }
    else
      nohup "$SSHD_BIN" -f "$SSHD_CONF" >>"$LOG" 2>&1
      sleep 2
    fi
    if running; then
      if [[ "$LAN" == "1" ]]; then
        ip=$(lan_ip)
        if [[ -n "$ip" ]]; then
          echo "sshd up, exposed on $ip:$PORT  (stop-lan to withdraw)"
        else
          echo "sshd up, exposed on all interfaces:$PORT (could not resolve this host's IP)  (stop-lan to withdraw)"
        fi
      else
        echo "sshd up, loopback only on $PORT  (add --lan to expose)"
      fi
    else
      echo "failed to start; see $LOG"; tail -n 10 "$LOG"; exit 1
    fi
    ;;

  stop-lan)
    rm -f "$LAN_MARKER" 2>/dev/null
    set_verb 127.0.0.1 || exit 1
    if running; then restart || exit 1; fi
    echo "network exposure withdrawn; loopback only on $PORT"
    ;;

  status)
    if running; then
      ip=$(lan_ip)
      echo "running on port $PORT, bound to $(bind_mode)"
      if [[ "$(bind_mode)" != "127.0.0.1" ]]; then
        echo "  NOTE: reachable from the network${ip:+ at $ip}"
        [[ -f "$LAN_MARKER" ]] || echo "  WARNING: exposed, but not recorded -- a restart will revert to loopback"
      fi
    else
      echo "not running"
    fi
    [[ -f "$LOG" ]] && { echo "--- log tail ---"; tail -n 8 "$LOG"; }
    ;;

  stop)
    pkill -f "$SSHD_BIN" && echo "stopped" || echo "not running"
    ;;

  *)
    echo "usage: $0 [start [--lan]|status|stop-lan|stop]"
    exit 1
    ;;
esac
