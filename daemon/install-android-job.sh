#!/data/data/com.termux/files/usr/bin/bash
# Register a periodic Android job that re-fires the scheduler.
#
# Why this exists: a resident `node scheduler.mjs` dies when Android kills the
# Termux process (battery reclaim, reboot, app swipe-away). termux-job-scheduler
# hands the job back to Android, which re-launches Termux in the background even
# after the session is gone.
#
# The Android minimum period is 900000 ms (15 min) and cannot be changed, so
# cron expressions finer than */15 are ignored by Android. Use the resident
# scheduler for finer intervals; use this as the safety net for the coarse ones.
#
#   ./daemon/install-android-job.sh              # every 15 min, persisted
#   PERIOD_MS=3600000 ./daemon/install-android-job.sh
#   ./daemon/install-android-job.sh --remove

set -euo pipefail

DAEMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEDULER="$DAEMON_DIR/scheduler.mjs"
JOB_ID="${JOB_ID:-4242}"
PERIOD_MS="${PERIOD_MS:-900000}"

if [[ "${1:-}" == "--remove" ]]; then
  termux-job-scheduler --cancel "$JOB_ID"
  echo "cancelled job $JOB_ID"
  exit 0
fi

command -v termux-job-scheduler >/dev/null || {
  echo "termux-job-scheduler not found. Install Termux:API." >&2
  exit 1
}

[[ -f "$SCHEDULER" ]] || { echo "missing $SCHEDULER" >&2; exit 1; }

cat > "$DAEMON_DIR/android-job.sh" <<EOF
#!/usr/bin/env bash
# Fired by Android on an interval. Re-checks what is due and exits.
cd "$DAEMON_DIR/.." || exit 1
exec /data/data/com.termux/files/usr/bin/node "$SCHEDULER" --once
EOF
chmod +x "$DAEMON_DIR/android-job.sh"

termux-job-scheduler \
  --job-id "$JOB_ID" \
  --script "$DAEMON_DIR/android-job.sh" \
  --period-ms "$PERIOD_MS" \
  --persisted true \
  --battery-not-low true \
  --storage-not-low true \
  --network any

echo "registered job $JOB_ID every $((PERIOD_MS / 60000)) min (persisted)"
echo "list:    termux-job-scheduler -p"
echo "remove:  $0 --remove"
