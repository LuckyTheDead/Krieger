#!/data/data/com.termux/files/usr/bin/bash
# Run a command on the PC over SSH. The PC is a second worker, not a faster one.
#
#   ./daemon/pc.sh <command>
#   ./daemon/pc.sh --put <local> <remote>
#   ./daemon/pc.sh --get <remote> <local>
#   ./daemon/pc.sh --status
#
# Why this exists: the second machine has far more RAM and free disk than the phone,
# but its i5-4200U is SLOWER than this phone's 8-core A166U. Benchmarked
# 2026-10-02: PC wins float-free integer sieve by ~5%, loses 220x220 matmul by
# ~28%, wins a 768 MB commit test by 2.3x. So it is NOT a speed upgrade.
#
# What it actually buys:
#   - memory headroom (7.9 GB vs ~718 MB available here)
#   - a filesystem that does not vanish when Android kills Termux
#   - it keeps working when the phone sleeps, which matters for long searches
#   - Windows tooling, if a task ever needs it
#
# The phone's sshd on 8022 and the PC's on 22 are independent; losing either
# does not affect the other.

set -uo pipefail

PC_HOST="${PC_HOST:?set PC_HOST to the address of your machine}"
PC_USER="${PC_USER:?set PC_USER to your ssh user name}"
KEY="$HOME/.ssh/id_ed25519_krieger"
NODE_DIR='C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64'

ssh_opts=(-p 22 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o LogLevel=ERROR)

case "${1:-}" in
  --put)
    [[ -n "${2:-}" && -n "${3:-}" ]] || { echo "usage: pc.sh --put <local> <remote>"; exit 1; }
    scp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR "$2" "$PC_USER@$PC_HOST:$3"
    ;;
  --get)
    [[ -n "${2:-}" && -n "${3:-}" ]] || { echo "usage: pc.sh --get <remote> <local>"; exit 1; }
    scp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR "$PC_USER@$PC_HOST:$2" "$3"
    ;;
  --status)
    if ssh "${ssh_opts[@]}" "$PC_USER@$PC_HOST" 'echo reachable' >/dev/null 2>&1; then
      echo "PC reachable at $PC_HOST"
      ssh "${ssh_opts[@]}" "$PC_USER@$PC_HOST" \
        'hostname & wmic cpu get Name /format:list 2>nul | findstr /v "^" & echo free C: GB: & wmic logicaldisk where "DeviceID=''C:''" get FreeSpace /format:list 2>nul | findstr /v "^"' 2>/dev/null \
        | tr -d '\r' | sed 's/^/  /'
      # node is not on PATH in an SSH session; report the real path
      ssh "${ssh_opts[@]}" "$PC_USER@$PC_HOST" "$NODE_DIR\\node.exe --version" 2>/dev/null | tr -d '\r' | sed 's/^/  node: /'
    else
      echo "PC NOT reachable at $PC_HOST -- is the PC on, sshd running, same network?"
    fi
    ;;
  --node)
    # Convenience: run node on the PC with its full path.
    shift
    exec ssh "${ssh_opts[@]}" "$PC_USER@$PC_HOST" "$NODE_DIR\\node.exe $*"
    ;;
  ""|-h|--help)
    echo "usage: pc.sh <command> | --put L R | --get R L | --status | --node <args>"
    ;;
  *)
    exec ssh "${ssh_opts[@]}" "$PC_USER@$PC_HOST" "$*"
    ;;
esac