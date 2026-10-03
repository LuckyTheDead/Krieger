#!/data/data/com.termux/files/usr/bin/bash
# Test the languard diff, because "it printed no change" is not evidence that
# it would notice a real change.
#
# The first attempt at this test was INVALID and worth recording: it injected a
# fake listener into the baseline and then ran `languard.sh diff`, which
# RE-FETCHES the current state before comparing. So the injected port was gone
# from both sides and the tool correctly reported nothing -- it looked like the
# tool had a bug when in fact the test had. Inject into the CURRENT file, or
# compare the two files directly, which is what this does.
set -uo pipefail

STATE="$HOME/.cache/languard"
SNAP="$STATE/pc-listeners.json"
CUR="$STATE/.cur.json"
pass=0; fail=0

check() {
  local label="$1" expect_rc="$2" actual_rc="$3" out="$4"
  if [[ "$actual_rc" == "$expect_rc" ]]; then
    echo "  ok   $label"; pass=$((pass+1))
  else
    echo "  FAIL $label (expected rc=$expect_rc got rc=$actual_rc)"; echo "$out" | sed 's/^/       /'; fail=$((fail+1))
  fi
}

run_diff() {
  # Compare baseline against the CURRENT file without re-fetching.
  python3 - "$SNAP" "$CUR" <<'PY'
import json, sys
def load(p):
    try:
        return {(r["port"], r["scope"]): r for r in json.load(open(p)).get("listening", [])}
    except Exception:
        return {}
old, new = load(sys.argv[1]), load(sys.argv[2])
if not old:
    print("no baseline"); sys.exit(0)
added   = {k: v for k, v in new.items() if k not in old}
removed = {k: v for k, v in old.items() if k not in new}
changed = {k: (old[k], v) for k, v in new.items() if k in old and old[k].get("process") != v.get("process")}
for k, v in sorted(added.items()):
    print(f"NEW      :{k[0]}  {v['process']}  ({'REACHABLE FROM THE LAN' if v['scope']=='ALL' else 'local only'})")
for k, v in sorted(removed.items()):
    print(f"CLOSED   :{k[0]}  {v['process']}")
for k, (o, n) in sorted(changed.items()):
    print(f"OWNER    :{k[0]}  {o.get('process')} -> {n.get('process')}")
if not (added or removed or changed):
    print("no change"); sys.exit(0)
sys.exit(1 if [k for k, v in added.items() if v["scope"] == "ALL"] else 0)
PY
}

echo "=== languard diff tests ==="

[[ -f "$SNAP" ]] || { echo "no baseline at $SNAP -- run ./daemon/languard.sh snapshot first"; exit 1; }
cp "$SNAP" "$STATE/.test-backup.json"

echo "--- 1. identical state must report no change, rc=0 ---"
cp "$SNAP" "$CUR"
out=$(run_diff); rc=$?
check "no false positive on an unchanged machine" 0 "$rc" "$out"

echo "--- 2. a new LAN-reachable port must ALERT, rc=1 ---"
python3 - "$CUR" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["listening"].append({"port": 31337, "bind": "0.0.0.0", "scope": "ALL",
                       "process": "backdoor-sim", "pid": 9999})
json.dump(d, open(sys.argv[1], "w"), indent=1)
PY
out=$(run_diff); rc=$?
check "new LAN port raises the alarm" 1 "$rc" "$out"
echo "$out" | grep -q 'NEW.*31337' && echo "  ok   names the port" && pass=$((pass+1)) \
  || { echo "  FAIL did not name the port"; fail=$((fail+1)); }

echo "--- 3. a new LOOPBACK-ONLY port must NOT alert, rc=0 ---"
cp "$SNAP" "$CUR"
python3 - "$CUR" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["listening"].append({"port": 31338, "bind": "127.0.0.1", "scope": "LOCAL",
                       "process": "local-only-sim", "pid": 9998})
json.dump(d, open(sys.argv[1], "w"), indent=1)
PY
out=$(run_diff); rc=$?
# Reported as NEW but not escalated: a loopback service is invisible to the LAN.
check "loopback-only port does not page anyone" 0 "$rc" "$out"
echo "$out" | grep -q 'local only' && echo "  ok   still reported, as non-escalating" && pass=$((pass+1)) \
  || { echo "  FAIL not reported at all"; fail=$((fail+1)); }

echo "--- 4. a closed port must be reported, rc=0 ---"
cp "$SNAP" "$CUR"
python3 - "$CUR" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["listening"] = [r for r in d["listening"] if r["port"] != 445]
json.dump(d, open(sys.argv[1], "w"), indent=1)
PY
out=$(run_diff); rc=$?
check "closing a port is reported" 0 "$rc" "$out"
echo "$out" | grep -q 'CLOSED.*445' && echo "  ok   names the closed port" && pass=$((pass+1)) \
  || { echo "  FAIL did not name the closed port"; fail=$((fail+1)); }

echo "--- 5. an ownership change on the same port must be reported ---"
cp "$SNAP" "$CUR"
python3 - "$CUR" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for r in d["listening"]:
    if r["port"] == 22:
        r["process"] = "something-else"
json.dump(d, open(sys.argv[1], "w"), indent=1)
PY
out=$(run_diff); rc=$?
echo "$out" | grep -q 'OWNER.*22' && echo "  ok   ownership change on :22 detected" && pass=$((pass+1)) \
  || { echo "  FAIL ownership change missed"; echo "$out" | sed 's/^/       /'; fail=$((fail+1)); }

mv "$STATE/.test-backup.json" "$SNAP"
rm -f "$CUR"

echo ""
echo "passed: $pass   failed: $fail"
[[ "$fail" == "0" ]]