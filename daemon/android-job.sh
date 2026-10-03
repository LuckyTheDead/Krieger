#!/usr/bin/env bash
# Fired by Android on an interval. Re-checks what is due and exits.
cd "/data/data/com.termux/files/home/tiny-agent/daemon/.." || exit 1
exec /data/data/com.termux/files/usr/bin/node "/data/data/com.termux/files/home/tiny-agent/daemon/scheduler.mjs" --once
