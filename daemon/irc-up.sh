#!/data/data/com.termux/files/usr/bin/bash
# Run the IRC presence in the background, idempotently.
#
#   ./daemon/irc-up.sh            start (joins the configured channels)
#   ./daemon/irc-up.sh status
#   ./daemon/irc-up.sh stop
#
# Channels and network come from the CHANNEL/NETWORK env vars, defaulting to
# #debian on OFTC. The bot itself refuses any channel outside its allow-list, so
# a typo here cannot put it somewhere unintended.

set -uo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$DAEMON_DIR/irc"
PIDFILE="$STATE_DIR/ircbot.pid"
LOGFILE="$STATE_DIR/supervisor.log"
NODE=/data/data/com.termux/files/usr/bin/node

NETWORK="${NETWORK:-oftc}"
CHANNEL="${CHANNEL:-#debian}"

mkdir -p "$STATE_DIR"

running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid; pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

case "${1:-start}" in
  start)
    if running; then echo "already running pid=$(cat "$PIDFILE")"; exit 0; fi
    cd "$DAEMON_DIR/.." || exit 1
    nohup "$NODE" "$DAEMON_DIR/ircbot.mjs" run "$CHANNEL" "$NETWORK" >>"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 4
    if running; then
      echo "ircbot up pid=$(cat "$PIDFILE") channel=$CHANNEL network=$NETWORK"
    else
      echo "failed to start; see $LOGFILE"
      tail -n 10 "$LOGFILE" 2>/dev/null
      rm -f "$PIDFILE"
      exit 1
    fi
    ;;
  status)
    if running; then echo "running pid=$(cat "$PIDFILE")"; else echo "not running"; fi
    [[ -f "$STATE_DIR/ircbot.log" ]] && { echo "--- last events ---"; tail -n 6 "$STATE_DIR/ircbot.log"; }
    ;;
  stop)
    # pkill matches on the interpreter path, not on "sshd"/"ircbot", because ps
    # truncates argv here -- the same trap that hit sshd-up.sh.
    if running; then
      kill "$(cat "$PIDFILE")" 2>/dev/null
      sleep 1
      rm -f "$PIDFILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 [start|status|stop]"
    exit 1
    ;;
esac