#!/data/data/com.termux/files/usr/bin/bash
# Verify the sftp subsystem is actually usable, and repair it if it is not.
#
#   ./daemon/sftp-check.sh            check, repair if broken, report
#   ./daemon/sftp-check.sh --report   check only, never modify
#
# Why this exists (2026-10-02): sshd_config shipped with
#   Subsystem sftp <prefix>/bin/sftp-server
# but the real binary is <prefix>/libexec/sftp-server. The file transfer
# channel was silently broken -- ssh logins worked, so nothing looked wrong.
# A bad Subsystem path only fails AFTER auth succeeds, which is why a
# key-only test on a fresh key reports nothing at all.
#
# Why a script and not a one-time fix: sshd_config is owned by the openssh
# package (dpkg -S confirms), so `pkg upgrade openssh` restores the broken
# line and file transfer dies again with no obvious cause. This re-checks on
# every boot and repairs the path, so an upgrade cannot silently regress it.

set -uo pipefail

SSHD_CONF=/data/data/com.termux/files/usr/etc/ssh/sshd_config
REPORT_ONLY=0
[[ "${1:-}" == "--report" ]] && REPORT_ONLY=1

status_line() { grep -m1 -i '^Subsystem[[:space:]]*sftp' "$SSHD_CONF" 2>/dev/null; }

configured_path() {
  # Field 3 is the path. Deliberately no awk, so a path with odd spacing or a
  # quoted value still resolves to something checkable.
  local line
  line="$(status_line)"
  [[ -z "$line" ]] && return 1
  set -- $line
  echo "${3:-}"
}

real_server() {
  # Prefer whatever this install actually ships over a hardcoded path, so this
  # keeps working if the layout changes again.
  local p
  for p in /data/data/com.termux/files/usr/libexec/sftp-server \
           /data/data/com.termux/files/usr/bin/sftp-server; do
    [[ -x "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

cur="$(configured_path)" || { echo "FAIL: no Subsystem sftp line in $SSHD_CONF"; exit 1; }
want="$(real_server)"      || { echo "FAIL: no sftp-server binary found under $PREFIX"; exit 1; }

if [[ -x "$cur" && "$cur" == "$want" ]]; then
  echo "ok: sftp subsystem -> $cur"
  exit 0
fi

echo "BROKEN: configured '$cur' (exists=$([ -x "$cur" ] && echo yes || echo no)), actual binary is '$want'"
if [[ "$REPORT_ONLY" == "1" ]]; then
  echo "report-only; not modifying"
  exit 1
fi

python3 - "$SSHD_CONF" "$want" <<'PY'
import re, sys
path, want = sys.argv[1], sys.argv[2]
s = open(path).read()
new, n = re.subn(r'(?im)^(\s*Subsystem\s+sftp)\s+.*$', r'\1 ' + want, s)
if n == 0:
    sys.exit("no Subsystem sftp line to rewrite")
open(path, "w").write(new)
print("repaired %d line(s) -> %s" % (n, want))
PY
[[ $? -eq 0 ]] || { echo "FAIL: repair did not apply"; exit 1; }

grep -m1 -i '^Subsystem' "$SSHD_CONF"
/data/data/com.termux/files/usr/bin/sshd -t -f "$SSHD_CONF" \
  && echo "ok: repaired, sshd config still valid (restart sshd to pick it up)" \
  || { echo "FAIL: sshd -t rejected the repaired config"; exit 1; }
