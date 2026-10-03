#!/data/data/com.termux/files/usr/bin/bash
# Check whether this phone can be reached over ADB, and from where.
#
#   ./daemon/adb-probe.sh          full report
#   ./daemon/adb-probe.sh --test   try one sshd round-trip with a given key
#
# Read-only. Makes no changes. Safe to run any time.
#
# Two independent channels are checked, because they fail differently:
#
#   ADB  - `adb connect <ip>:5555`. Needs "Wireless debugging" enabled in
#          Developer Options, which needs a physical tap sequence on the phone.
#          Once enabled it persists and needs no cable.
#   SSH  - sshd on port 8022, already running. Needs only the public key to be
#          in authorized_keys. Works today.

set -uo pipefail

PORT=8022
ADB_PORT=5555

lan_ip() {
  # `ip`, `ifconfig` and /proc/net are all restricted or absent in this Termux
  # sandbox; node's os.networkInterfaces() reads the same data without them.
  # Retried because the helper intermittently returns nothing when node is
  # starting up cold in a very short-lived shell.
  local out
  for _ in 1 2 3; do
    out=$(/data/data/com.termux/files/usr/bin/node -e '
      const os = require("os");
      const found = [];
      for (const list of Object.values(os.networkInterfaces()))
        for (const i of list || [])
          if (i.family === "IPv4" && !i.internal) found.push(i.address);
      console.log(found.join(" "));
    ' 2>/dev/null)
    [[ -n "$out" ]] && { echo "$out"; return 0; }
    sleep 1
  done
  return 1
}

if [[ "${1:-}" == "--test" ]]; then
  KEY="${2:-$HOME/.ssh/id_ed25519_krieger}"
  IP="${3:-$(lan_ip)}"
  echo "trying $IP:$PORT with $KEY"
  ssh -i "$KEY" -p "$PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o BatchMode=yes -o ConnectTimeout=10 \
      "u0_a425@$IP" 'echo CONNECTED; uname -a; node --version' 2>&1
  exit $?
fi

IP="$(lan_ip)"
echo "phone:  $(getprop ro.product.model 2>/dev/null || echo unknown) / android $(getprop ro.build.version.release 2>/dev/null)"
echo "uid:    $(id -u 2>/dev/null)  (Termux login name)"
echo "lan ip: ${IP:-<could not determine>}"
echo

echo "--- sshd (port $PORT) ---"
if pgrep -f "/data/data/com.termux/files/usr/bin/sshd" >/dev/null 2>&1; then
  echo "process: running"
else
  echo "process: NOT running  -> ./daemon/sshd-up.sh start"
fi
if [[ -n "$IP" ]]; then
  # Do NOT use `nc -z` here: it is blocked inside this sandbox and always reports
  # failure, which is a false negative that looks like a real outage. An actual
  # SSH handshake is the honest test -- it completes TCP, kex and auth.
  probe=$(timeout 12 ssh -p "$PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o BatchMode=yes -o ConnectTimeout=8 \
      "u0_a425@$IP" true 2>&1)
  if grep -q 'Permission denied' <<<"$probe"; then
    echo "port:    reachable, key auth rejected (expected until authorized_keys is updated)"
  elif [[ -z "$probe" ]]; then
    echo "port:    reachable and accepted the connection"
  else
    echo "port:    problem -> $(tr '\n' ' ' <<<"$probe" | tail -c 120)"
  fi
fi
KEY="$HOME/.ssh/id_ed25519_krieger"
[[ -f "$KEY" ]] && echo "key:     $KEY.pub present (authorized_keys must contain it)" \
                 || echo "key:     MISSING -- generate one first"
echo

echo "--- adb (port $ADB_PORT, wireless debugging) ---"
if command -v adb >/dev/null 2>&1; then
  echo "adb:     $(adb version 2>/dev/null | head -1)"
  timeout 8 adb connect "$IP:$ADB_PORT" 2>&1 | tail -1
  adb devices 2>/dev/null | tail -n +2
else
  echo "adb:     not installed in Termux. Enable wireless debugging first;"
  echo "         the pairing step only works from a real machine, so install"
  echo "         platform-tools on your PC rather than here."
fi
echo
if timeout 8 termux-battery-status >/dev/null 2>&1; then
  echo "Termux:API bridge: OK"
else
  echo "Termux:API bridge: DEAD (unchanged; ssh is the workaround)"
fi
