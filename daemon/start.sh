#!/data/data/com.termux/files/usr/bin/bash
# Run the unattended scheduler as a background process, logging to daemon/scheduler.log.
#
#   ./daemon/start.sh          start (no-op if already running)
#   ./daemon/start.sh stop     stop
#   ./daemon/start.sh status   report pid + log tail
#
# A resident process dies when Android reclaims Termux. For a scheduler that
# survives that, use install-android-job.sh instead.

set -uo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DAEMON_DIR")"
PIDFILE="$DAEMON_DIR/scheduler.pid"
LOGFILE="$DAEMON_DIR/scheduler.log"
NODE=/data/data/com.termux/files/usr/bin/node

running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

case "${1:-start}" in
  stop)
    if running; then
      pid=$(cat "$PIDFILE")
      kill "$pid" 2>/dev/null
      sleep 0.5
      kill -9 "$pid" 2>/dev/null
      echo "stopped $pid"
    else
      echo "not running"
      rm -f "$PIDFILE"
    fi
    ;;

  status)
    if running; then
      echo "running pid=$(cat "$PIDFILE")"
    else
      echo "not running"
    fi
    [[ -f "$LOGFILE" ]] && { echo "--- log tail ---"; tail -n 15 "$LOGFILE"; }
    ;;

  start)
    if running; then
      echo "already running pid=$(cat "$PIDFILE")"
      exit 0
    fi
    cd "$REPO" || exit 1
    # Credentials live in ~/.secrets.env (see the security audit of 2026-10-01).
    # Termux:Boot invokes this script WITHOUT a login shell, so .bashrc is not
    # read and OPENROUTER_API_KEY would be absent -- the daemon would start
    # cleanly and then fail every llm job at the first model call. Source the
    # file directly so the boot path cannot depend on shell initialisation.
    if [[ -f "$HOME/.secrets.env" ]]; then
      set -a
      # shellcheck disable=SC1091
      . "$HOME/.secrets.env"
      set +a
    fi
    if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
      echo "warning: OPENROUTER_API_KEY is unset; llm and agent jobs will fail." >&2
      echo "         expected it in $HOME/.secrets.env" >&2
    fi
    # termux-wake-lock keeps the CPU awake; without it Android will doze the
    # process between intervals and cron timings become unreliable.
    termux-wake-lock >/dev/null 2>&1
    nohup "$NODE" "$DAEMON_DIR/scheduler.mjs" >>"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1
    if running; then
      echo "started pid=$(cat "$PIDFILE") log=$LOGFILE"
    else
      echo "failed to start; see $LOGFILE"
      tail -n 20 "$LOGFILE"
      exit 1
    fi
    ;;

  *)
    echo "usage: $0 [start|stop|status]"
    exit 1
    ;;
esac
