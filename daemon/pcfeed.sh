#!/data/data/com.termux/files/usr/bin/bash
# A live, readable feed of what is happening on the PC.
#
#   ./daemon/pcfeed.sh            follow (default)
#   ./daemon/pcfeed.sh --once     one snapshot, no following
#   ./daemon/pcfeed.sh --plain    no ANSI, for piping or a dumb terminal
#   ./daemon/pcfeed.sh --help
#
# WHY THIS EXISTS. Everything I do on the PC -- 64 dispatched jobs so far, the
# camera verdict every 5 minutes, the security-event poll every 2 minutes, the
# agent daemon's runs -- happens out of sight. The artifacts exist, but reading
# them means remembering which file and knowing the shape. This renders the state
# of all of it in one place, so "what has that machine been doing" is a glance
# rather than an investigation.
#
# It is also the audit trail I flagged as missing when I said the exposure
# watcher covers configuration but not access. This shows both, side by side,
# with timestamps, so a change is visible when it happens rather than noticed
# later.
#
# PORTABILITY NOTE: no tput, no tmux, nothing that may or may not be installed.
# Terminal size comes from stty, falling back to 80x24, and colour is switched
# off entirely with --plain or when stdout is not a terminal.

set -uo pipefail

REPO="$HOME/tiny-agent"
PC_HOST="${PC_HOST:?set PC_HOST to the address of your machine}"
PC_USER="${PC_USER:?set PC_USER to your ssh user name}"
KEY="$HOME/.ssh/id_ed25519_krieger"
PCPROFILE="${PCPROFILE:-C:\\Users\\$PC_USER}"   # remote Windows user profile
JOBS="$HOME/.cache/pcjobs"
INTERVAL="${PCFEED_INTERVAL:-20}"

MODE=follow
PLAIN=0
for a in "$@"; do
  case "$a" in
    --once) MODE=once ;;
    --plain) PLAIN=1 ;;
    -h|--help)
      echo "usage: pcfeed.sh [--once] [--plain]"
      exit 0 ;;
  esac
done

# Colour only when it will be interpreted. An unset TERM means a pipe or a log
# file, and escape codes there are just noise.
if [[ "$PLAIN" == "1" || ! -t 1 || -z "${TERM:-}" ]]; then
  C_RST=""; C_DIM=""; C_BOLD=""; C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""
else
  C_RST=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_CYN=$'\033[36m'
fi

ssh_pc() { ssh -p 22 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=8 \
                 -o IdentitiesOnly=yes -o LogLevel=ERROR "$PC_USER@$PC_HOST" "$1" 2>/dev/null | tr -d '\r'; }

# Byte-exact fetch of a file to a local temp path.
#
# NOT `ssh host cat file`: that re-encodes text on the way out and corrupts any
# multi-byte UTF-8, which is how runs.jsonl's em-dashes turned into invalid
# bytes and the agent line silently fell back to "no run recorded".
#
# NOT `sftp ... /dev/stdout` either -- tested, and sftp writes to a real file
# rather than stdout, while its own banner and prompts go to stdout, so the
# result was 138 bytes of prompt text and nothing else. So: pull to a temp file,
# cat that.
fetch_file() {
  local remote="$1" dest
  dest="$(mktemp "${TMPDIR:-/data/data/com.termux/files/usr/tmp}/pcfeed.XXXXXX")" || return 1
  if sftp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR \
          "$PC_USER@$PC_HOST" <<< "get $remote $dest" >/dev/null 2>&1 \
     && [[ -s "$dest" ]]; then
    cat "$dest"
    local rc=0
    rm -f "$dest"
    return $rc
  fi
  rm -f "$dest"
  return 1
}
fetch_runs() { fetch_file 'tiny-agent-git/daemon/runs.jsonl'; }

size() {
  local w h
  if [[ -t 1 ]]; then
    w=$(stty size 2>/dev/null | cut -d' ' -f2)
    h=$(stty size 2>/dev/null | cut -d' ' -f1)
  fi
  echo "${w:-80} ${h:-24}"
}

rule() {
  # Build the line by repetition, NOT `printf %*s | tr ' ' CHAR`. tr works on
  # BYTES, so a multibyte UTF-8 box-drawing character got split into its three
  # component bytes and each space became a stray 0xe2 -- the rule rendered as a
  # row of replacement characters. A loop costs nothing at this width.
  local width; width=$(size | cut -d' ' -f1)
  local ch="${1:-$C_DIM}"
  local line=""
  local i=0
  while [[ $i -lt $width ]]; do line+="─"; i=$((i+1)); done
  printf '%s%s%s\n' "$ch" "$line" "$C_RST"
}

# --- colours for a verdict, by meaning rather than by value -------------------
verdict_colour() {
  case "$1" in
    MOTION)     printf '%s' "$C_YEL" ;;
    NO_SIGNAL)  printf '%s' "$C_CYN" ;;
    STILL|QUIET) printf '%s' "$C_GRN" ;;
    *)          printf '%s' "$C_DIM" ;;
  esac
}

stamp() { date '+%H:%M:%S'; }

snapshot() {
  local width; width=$(size | cut -d' ' -f1)

  printf '%s%s PC ACTIVITY %s  %s  %s\n' "$C_BOLD" "${C_CYN}" "$C_RST" "$(stamp)" \
    "$(printf '%*s' $(( width > 40 ? width - 30 : 10 )) '')"
  rule

  # --- 1. reachability ------------------------------------------------------
  local banner
  if [[ -n "${REACHABLE:-}" ]]; then
    printf '  %s● reachable%s  %s%s%s\n' "$C_GRN" "$C_RST" "$C_DIM" "$PC_HOST" "$C_RST"
  else
    printf '  %s○ unreachable%s  %s%s -- is the PC on?%s\n' "$C_YEL" "$C_RST" "$C_DIM" "$PC_HOST" "$C_RST"
    rule
    return
  fi

  # --- 2. what the watchers are recording ------------------------------------
  printf '\n  %sWATCHERS%s\n' "$C_BOLD" "$C_RST"

  local camverdict camdetail logdetail agentline
  camverdict=$(ssh_pc 'powershell -NoProfile -Command "Get-Content $PCPROFILE\camwatch.log -Tail 1 -EA SilentlyContinue"' \
               | sed -n 's/.*VERDICT=\([A-Z_]*\).*/\1/p')
  # Accept either field: older entries carry mean=, current ones median=. Reading
  # only mean= reported "no reading" on a log that had a perfectly good value in
  # it, which looks like a broken sensor rather than a stale grep.
  camdetail=$(ssh_pc 'powershell -NoProfile -Command "Get-Content $PCPROFILE\camwatch.log -Tail 1 -EA SilentlyContinue"' \
               | grep -oE '(mean|median)=[0-9.]*' | head -1)

  printf '    camera    %s%-10s%s %s%s  (5 min cadence)%s\n' \
    "$(verdict_colour "$camverdict")" "${camverdict:-?}" "$C_RST" \
    "$C_DIM" "${camdetail:-no reading}" "$C_RST"

  logdetail=$(ssh_pc 'powershell -NoProfile -Command "Get-Content $PCPROFILE\logwatch.log -Tail 1 -EA SilentlyContinue"' | head -1)
  printf '    security  %s\n' "${logdetail:-no recent line}"

  # Fetch over SFTP, not `ssh ... Get-Content`. PowerShell re-encodes text on the
  # way to a pipe, and runs.jsonl contains UTF-8 em-dashes inside the output
  # field; those arrived as invalid bytes, json.loads threw, and the line silently
  # fell back to "no run recorded" even though the file on disk was perfectly
  # valid. SFTP is byte-exact, and the file is JSONL, so the last non-empty LINE
  # is the most recent record.
  agentline=$(fetch_runs | python3 -c '
import sys, json
last = None
for line in sys.stdin:
    line = line.strip()
    if line:
        last = line
if last is None:
    print("no run recorded")
    raise SystemExit
try:
    d = json.loads(last)
except Exception as e:
    print("run log unparseable: " + type(e).__name__)
    raise SystemExit
tools = d.get("toolsOffered")
extra = ", %s tools" % tools if tools else ""
err = "  ERROR: " + str(d.get("error"))[:60] if d.get("error") else ""
print("%s ok=%s %sms%s%s" % (d.get("job", "?"), d.get("ok"), d.get("durationMs", "?"), extra, err))
' 2>/dev/null)
  printf '    agent     %s\n' "${agentline:-no run recorded}"

  # --- 3. exposure ----------------------------------------------------------
  local exp
  # languard reports a 0.0.0.0 bind as "REACHABLE FROM THE LAN". That is a
  # CONFIGURATION fact and it is technically what languard checks, but the
  # firewall filters inbound independently, and on this PC 445/139/49580 all
  # bind to 0.0.0.0 and are NOT reachable. So show languard's line verbatim and
  # point at languard-reachable.sh rather than restating the stronger claim.
  exp=$(cd "$REPO" && ./daemon/languard.sh diff 2>/dev/null | sed -n '2p')
  if [[ -z "$exp" || "$exp" == *"no change"* ]]; then
    printf '    exposure  %sno change since baseline%s\n' "$C_GRN" "$C_RST"
  else
    printf '    exposure  %s%s%s\n' "$C_YEL" "$exp" "$C_RST"
    printf '              %s(bound to all interfaces; firewall may still block it)%s\n' "$C_DIM" "$C_RST"
    printf '              %sverify with: ./daemon/languard-reachable.sh 445 139 22%s\n' "$C_DIM" "$C_RST"
  fi

  # --- 4. my own dispatched jobs --------------------------------------------
  printf '\n  %sJOBS I DISPATCHED%s  %s(%s total, newest first)%s\n' \
    "$C_BOLD" "$C_RST" "$C_DIM" "$(ls "$JOBS"/*.log 2>/dev/null | wc -l | tr -d ' ')" "$C_RST"

  if ! ls "$JOBS"/*.log >/dev/null 2>&1; then
    printf '    %snone yet%s\n' "$C_DIM" "$C_RST"
  else
    local n=0
    for f in $(ls -t "$JOBS"/*.log 2>/dev/null | head -6); do
      name=$(basename "$f" .log)
      age=$(( $(date +%s) - $(stat -c %Y "$f") ))
      local ago
      if   [[ "$age" -lt 60   ]]; then ago="${age}s"
      elif [[ "$age" -lt 3600 ]]; then ago="$((age/60))m"
      else ago="$((age/3600))h"; fi

      # First meaningful line: the verdict, or the first non-blank output line.
      local headline
      headline=$(grep -am1 -E 'VERDICT=|QUIET|EVENTS |OK:|ERROR|FAIL|PASS|passed:|BUILD_OK|SCRIPT_ERROR' "$f" 2>/dev/null \
                 | cut -c1-72)
      [[ -z "$headline" ]] && headline=$(grep -av '^[[:space:]]*$' "$f" 2>/dev/null | head -1 | cut -c1-72)
      [[ -z "$headline" ]] && headline="${C_DIM}(no output)${C_RST}"

      local colr="$C_DIM"
      case "$headline" in
        *FAIL*|*ERROR*|*Error*|*STILL*) colr="$C_YEL" ;;
        *PASS*|*OK*|*WORKING*|*MOTION*) colr="$C_GRN" ;;
      esac
      printf '    %-14s %6s ago  %s%s%s\n' "$name" "$ago" "$colr" "$headline" "$C_RST"
      n=$((n+1))
      [[ "$n" -ge 6 ]] && break
    done
  fi

  # --- 5. what I am doing right now -----------------------------------------
  printf '\n  %sRIGHT NOW%s\n' "$C_BOLD" "$C_RST"
  printf '    %sagent session on the phone; jobs dispatched over ssh to %s%s\n' \
    "$C_DIM" "$PC_HOST" "$C_RST"
  printf '    %srun a job   : ./daemon/pcdispatch.sh run <name> <cmd>%s\n' "$C_DIM" "$C_RST"
  printf '    %ssnapshot   : ./daemon/pcfeed.sh --once%s\n' "$C_DIM" "$C_RST"
  printf '    %sexposure   : ./daemon/languard.sh diff%s\n' "$C_DIM" "$C_RST"
  printf '    %sreachable? : ./daemon/languard-reachable.sh 22 445 139%s\n' "$C_DIM" "$C_RST"
  printf '    %sbring-up   : security-bringup.bat on the PC%s\n' "$C_DIM" "$C_RST"

  rule
}

# --- reachability, checked once per loop -------------------------------------
check_reachable() {
  if node -e '
    const net=require("net");
    const s=net.connect({host:process.argv[1],port:22});
    s.setTimeout(5000);
    s.on("connect",()=>{s.destroy();process.exit(0);});
    s.on("error",()=>process.exit(1));
    s.on("timeout",()=>{s.destroy();process.exit(1);});
  ' "$PC_HOST" 2>/dev/null; then
    REACHABLE=1
  else
    REACHABLE=""
  fi
}

check_reachable
if [[ "$MODE" == "once" ]]; then
  snapshot
  exit 0
fi

# --- follow loop -------------------------------------------------------------
# Redraw in place when attached to a terminal, append when piped. Piping a
# redrawing display produces a file full of escape codes and repeated frames,
# which is the wrong artefact for a log.
INTERACTIVE=0
[[ -t 1 ]] && INTERACTIVE=1

trap 'echo; exit 0' INT TERM

while true; do
  check_reachable
  if [[ "$INTERACTIVE" == "1" ]]; then
    # Home, then clear to end of screen, so the frame replaces the last one.
    printf '\033[H\033[2J'
    snapshot
    printf '%s  refreshing every %ss -- ctrl-c to stop%s\n' "$C_DIM" "$INTERVAL" "$C_RST"
  else
    snapshot
    echo
  fi
  sleep "$INTERVAL"
done