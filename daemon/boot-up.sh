# Termux:Boot — bring the phone's services back after a restart.
#
# Enable once:  termux-boot  (or the Termux:Boot app) must be installed, and this
# file linked into ~/.termux/boot/ as e.g. 01-krieger-up. Symlink, don't copy:
# a copy goes stale and you will be debugging a script you already fixed.
#
#   ln -s ~/tiny-agent/daemon/boot-up.sh ~/.termux/boot/01-krieger-up
#
# What runs, and why each is here:
#   sftp-check    the file transfer channel. The Termux openssh package ships an
#                 sshd_config whose Subsystem line points at bin/sftp-server, but the
#                 binary lives in libexec. SSH logins work regardless, so the breakage
#                 is invisible until someone tries to copy a file. That config is
#                 package-owned, so an upgrade can restore the bad path; this rechecks
#                 and repairs on every boot.
#   sshd          remote access. Without it there is no way in once the session
#                 is gone, so this is the recovery path for everything else.
#   scheduler     the unattended daemon (self-review every 2h). start.sh is
#                 idempotent, so calling it when already running is a no-op.
#   ircbot        the IRC presence. Non-fatal: if the network is unreachable the
#                 boot continues, because a presence that cannot connect should
#                 not turn into a boot error.
#
# What this deliberately does NOT do:
#   Fix the Termux:API bridge. It is still dead, so install-android-job.sh cannot
#   register an Android JobScheduler job, and nothing here changes that. Until
#   ADB is available this is a convenience, not a survival mechanism.

set -uo pipefail

REPO="$HOME/tiny-agent"
LOG="$HOME/.termux/boot/krieger-boot.log"

mkdir -p "$(dirname "$LOG")" 2>/dev/null

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >>"$LOG" 2>/dev/null; }

log "boot hook starting"

if [[ -x "$REPO/daemon/sftp-check.sh" ]]; then
  # Before sshd: a repair rewrites sshd_config, and sshd must then be started
  # (or restarted) to pick the change up.
  "$REPO/daemon/sftp-check.sh" >>"$LOG" 2>&1 && log "sftp subsystem ok" \
    || log "sftp subsystem BROKEN (file transfer will fail)"
else
  log "sftp-check.sh missing or not executable"
fi

# Exposure watcher. Records a baseline on first run and reports any change
# thereafter. Read-only: it enumerates, and never modifies the PC.
if [[ -x "$REPO/daemon/languard.sh" ]]; then
  if [[ ! -f "$HOME/.cache/languard/pc-listeners.json" ]]; then
    "$REPO/daemon/languard.sh" snapshot >>"$LOG" 2>&1 && log "languard baseline recorded" || log "languard baseline FAILED"
  else
    out=$("$REPO/daemon/languard.sh" diff 2>&1)
    rc=$?
    if [[ "$rc" != "0" ]]; then
      # rc=1 means a new LAN-reachable port appeared. That is the one change
      # worth a human, so it goes to the log with an explicit marker.
      log "languard ALERT: new LAN-reachable port"
      echo "$out" >>"$LOG" 2>/dev/null
    elif [[ "$out" != *"no change"* ]]; then
      log "languard: minor change"
      echo "$out" >>"$LOG" 2>/dev/null
    fi
  fi
fi

if [[ -x "$REPO/daemon/sshd-up.sh" ]]; then
  "$REPO/daemon/sshd-up.sh" start >>"$LOG" 2>&1 && log "sshd ok" || log "sshd FAILED"
else
  log "sshd-up.sh missing or not executable"
fi

if [[ -x "$REPO/daemon/start.sh" ]]; then
  "$REPO/daemon/start.sh" start >>"$LOG" 2>&1 && log "scheduler ok" || log "scheduler FAILED"
else
  log "start.sh missing or not executable"
fi

# IRC presence. Optional: a failure here must not be reported as a boot failure,
# since the bot's whole policy is to stay quiet, and a bot that cannot reach the
# network should not be retried loudly on every boot.
if [[ -x "$REPO/daemon/irc-up.sh" ]]; then
  "$REPO/daemon/irc-up.sh" start >>"$LOG" 2>&1 && log "ircbot ok" || log "ircbot unavailable (non-fatal)"
else
  log "irc-up.sh missing; skipping IRC presence"
fi

log "boot hook done"
