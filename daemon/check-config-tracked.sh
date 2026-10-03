#!/data/data/com.termux/files/usr/bin/bash
# Fail loudly when agent.json points at a file this repo does not track.
#
#   ./daemon/check-config-tracked.sh
#
# Why this exists: on 2026-10-02 `termux-api-mcp.js` and its test existed on the
# phone and were referenced by agent.json as one of the six MCP servers, but
# NEITHER was in git. The file was not gitignored -- simply never added -- so no
# status check and no scanner flagged it. Every fresh checkout, including the PC
# clone, was missing a server the agent is configured to load.
#
# Absence and "intentionally excluded" look identical from the outside, so
# nothing noticed. This makes that specific shape of mistake visible.
#
# Read-only. Exits non-zero when a referenced path is untracked, so it can gate a
# commit or a sync.

set -uo pipefail
REPO="${1:-$HOME/tiny-agent}"
cd "$REPO" || { echo "not a repo: $REPO"; exit 2; }

CONFIG="${AGENT_CONFIG:-agent.json}"
[[ -f "$CONFIG" ]] || { echo "no $CONFIG; nothing to check"; exit 0; }

# Collect every path that appears in any command or args field. The values are
# absolute Termux paths, so map them back onto repo-relative form.
paths=$(python3 - "$CONFIG" <<'PY'
import json, sys, re
cfg = json.load(open(sys.argv[1]))
out = set()
for s in cfg.get("servers", []):
    for v in [s.get("command", "")] + list(s.get("args", [])):
        if not isinstance(v, str):
            continue
        for m in re.findall(r"[A-Za-z0-9_./-]+\.(?:js|mjs|json|sh|py)", v):
            out.add(m)
for m in sorted(out):
    print(m)
PY
)

[[ -z "$paths" ]] && { echo "$CONFIG references no repo files"; exit 0; }

fail=0
while read -r p; do
  [[ -z "$p" ]] && continue
  # Skip anything outside the repo (interpreter paths, URLs).
  case "$p" in
    /*|http*|file*) ;;
  esac
  # Strip a leading repo-absolute prefix if present.
  rel="$p"
  rel="${rel#"$REPO"/}"

  if [[ ! -e "$rel" ]]; then
    echo "MISSING  $rel   (referenced by $CONFIG, not on disk)"
    fail=1
  elif git ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
    :
  else
    if git check-ignore -q "$rel" 2>/dev/null; then
      echo "ignored  $rel   (referenced by $CONFIG but gitignored -- deliberate?)"
    else
      echo "UNTRACKED $rel   (referenced by $CONFIG, on disk, NOT in git)"
      fail=1
    fi
  fi
done <<< "$paths"

if [[ "$fail" == "0" ]]; then
  echo "ok: every repo file referenced by $CONFIG is tracked"
else
  echo
  echo "The above files are referenced by $CONFIG but are not in git."
  echo "A fresh checkout -- the PC clone, or any new machine -- would be missing them."
  echo "Either 'git add' them, or note the exclusion in .gitignore on purpose."
fi
exit "$fail"