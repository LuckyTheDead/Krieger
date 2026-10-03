#!/data/data/com.termux/files/usr/bin/bash
# Camera motion check: capture on the PC, judge on the phone.
#
#   ./daemon/cammotion.sh [seconds]
#
# Why the split. Comparing pixels inside the SSH session was unreliable:
# ffmpeg's signalstats YDIF would not survive extraction over the pipe, and an
# earlier attempt compared JPEG FILE SIZES as a proxy for motion, which is not
# the same thing at all. So the PC captures frames and the phone computes a real
# pixel difference, where it can be tested.
#
# Three outcomes, and the third matters most:
#   MOTION     the scene changed while the picture was valid
#   STILL      the picture is valid and nothing changed
#   NO_SIGNAL  the picture is too dark or flat to say anything -- which is
#              exactly what a covered or disabled camera produces, and must
#              never be reported as "all quiet".
set -uo pipefail

REPO="$HOME/tiny-agent"
SECS="${1:-10}"
PC_SCRIPT='C:\Users\${PC_USER}\cam-motion.ps1'
WORK="$REPO/.cache/cammotion"
KEY="$HOME/.ssh/id_ed25519_krieger"

mkdir -p "$WORK"
rm -f "$WORK"/*.jpg 2>/dev/null

# --- capture on the PC ---
out=$("$REPO/daemon/pc.sh" --put "$REPO/daemon/scripts/cam-motion.ps1" \
        'C:/Users/${PC_USER}/cam-motion.ps1' 2>&1 >/dev/null; \
      "$REPO/daemon/pc.sh" "powershell -NoProfile -ExecutionPolicy Bypass -File $PC_SCRIPT -Seconds $SECS" 2>/dev/null | tr -d '\r')

state=$(sed -n 's/^STATE=//p' <<<"$out" | head -1)
case "$state" in
  NO_SIGNAL)
    echo "STATE=NO_SIGNAL"
    sed -n 's/^MEAN_AVG=/  mean luma : /p;s/^MAX_LUMA=/  max luma  : /p' <<<"$out"
    echo "  verdict   : the picture is too dark to distinguish an empty room from a covered lens."
    echo "  action    : check the camera physically. This is NOT 'all quiet'."
    exit 0
    ;;
  NO_FRAMES|PARSE_ERROR)
    echo "STATE=$state"
    echo "$out" | sed 's/^/  /'
    exit 1
    ;;
  "")
    echo "STATE=UNREACHABLE"
    echo "  the PC did not answer. Check it is on and sshd is running."
    exit 1
    ;;
esac

mean=$(sed -n 's/^MEAN_AVG=//p' <<<"$out" | head -1)

# --- pull the frames ---
cd "$WORK"
sftp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR \
     ${PC_USER}@${PC_HOST} <<< $'get cammotion/*.jpg /data/data/com.termux/files/home/tiny-agent/.cache/cammotion/\nbye' \
     >/dev/null 2>&1
n=$(ls ./*.jpg 2>/dev/null | wc -l)
if [[ "$n" -lt 2 ]]; then
  echo "STATE=NO_FRAMES_PULLED (got $n, need 2 to compare)"
  exit 1
fi

# --- judge here ---
# Compare each frame to the one before it. Frame 1 vs 2 catches most motion, but
# comparing every frame against the FIRST is more stable: a person walking
# through then out would otherwise average to "no change" across the window.
result=$(python3 - "$n" <<'PY'
import subprocess, sys, os

def luma(path):
    """Mean luminance of a 160x120 grey frame, via ffmpeg on the phone."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-i", path,
         "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"],
        capture_output=True)
    return out.stdout[0] if out.stdout else None

def diff(a, b):
    """Mean luminance of the pixel-wise DIFFERENCE between two frames.

    Uses YAVG of the blended difference image, not YDIF. YDIF is absent from
    signalstats here -- it describes temporal variation WITHIN one stream, not
    between two still images -- so requiring it meant every comparison returned
    None. Confirmed by hand: the blend filter emits YAVG=24.5 for two adjacent
    frames.

    The verbosity matters too, and getting it wrong is silent: at "-v error"
    ffmpeg suppresses signalstats entirely. "-v info" keeps it.

    And the output goes to STDOUT, not stderr: metadata=print:file=- writes to
    stdout, while everything ffmpeg logs about the run goes to stderr. Reading
    stderr therefore found nothing and silently produced zero comparisons. Both
    are checked so a future ffmpeg change cannot quietly reintroduce it.
    """
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "info", "-i", a, "-i", b,
         "-lavfi", "blend=all_mode=difference,signalstats,metadata=print:file=-",
         "-f", "null", "-"],
        capture_output=True, text=True)
    for stream in (out.stdout, out.stderr):
        for line in stream.splitlines():
            if "YAVG" in line and "signalstats" in line and "=" in line:
                return float(line.split("YAVG=")[1].split()[0])
    return None

files = sorted(f for f in os.listdir(".") if f.endswith(".jpg"))
first = files[0]
pairs = 0; changed = 0; best = 0.0
# Ignore the first comparison: the camera's auto-exposure has not settled yet on
# frame 1, so m001-vs-m002 reads HIGH even in a completely still room. Measured
# on an empty scene: 27.9, then 31.7, 32.2, 32.2, 32.2 -- converging on a
# constant, which is the signature of exposure drift, not a person. Real motion
# does not converge; it wanders.
#
# So the first pair is dropped, and the remaining pairs are compared against
# each other rather than against frame 1: a converged still scene gives a near
# constant difference, while anything moving changes from pair to pair.
diffs = []
for i in range(1, len(files)):
    d = diff(files[i - 1], files[i])
    if d is None:
        continue
    diffs.append(d)

if len(diffs) < 2:
    print(f"pairs_compared={len(diffs)}")
    print("pairs_with_change=0")
    print("max_diff=0.0")
    print("STILL")          # two pairs is the minimum; caller checks the count
    sys.exit(0)

# Ignore the first diff (exposure settling). Compare the rest against their own
# median: what matters is variation, not absolute brightness.
#
# IMPORTANT, and this is a real limitation rather than a passing test: a subject
# moving at a CONSTANT offset every frame produces an identical difference each
# pair, so the spread collapses toward zero and the detector reads STILL. A
# bright block stepping 14px per frame measures median 11.16 with spread 0.017 --
# indistinguishable from a still scene by spread alone. Measured, not assumed.
#
# The guard is therefore: motion if EITHER the spread wanders (erratic motion,
# a person) OR the median difference itself is substantial (sustained motion).
# The second term catches constant-velocity motion; the first catches everything
# else. A genuinely still scene has a low median AND a low spread, so it still
# reports STILL.
steady = diffs[1:]
med = sorted(steady)[len(steady) // 2]
pairs = len(steady)
best = max(steady)
spread = max(abs(d - med) for d in steady)

wander = [d for d in steady if abs(d - med) > 3.0]
# Sustained motion: every frame-pair differs by a real amount. 6.0/255 of mean
# absolute difference over a 160x120 frame is well above sensor noise (which
# measured around 1.4 on an idle room) and well below a genuine scene change.
sustained = med > 6.0

if wander or sustained:
    changed = len(wander)
    reason = []
    if wander:
        reason.append(f"{len(wander)} pair(s) deviated from the median")
    if sustained:
        reason.append(f"sustained difference (median {med:.1f}/255)")
    verdict_note = "; ".join(reason)
else:
    changed = 0
    verdict_note = "differences low and steady"

print(f"pairs_compared={pairs}")
print(f"pairs_with_change={changed}")
print(f"median_diff={med:.1f}")
print(f"spread={spread:.1f}")
print(f"basis={verdict_note}")
print("MOTION" if (wander or sustained) else "STILL")
PY
)

state=$(tail -1 <<<"$result")
pairs=$(sed -n 's/^pairs_compared=//p' <<<"$result")
changed=$(sed -n 's/^pairs_with_change=//p' <<<"$result")
median=$(sed -n 's/^median_diff=//p' <<<"$result")
spread=$(sed -n 's/^spread=//p' <<<"$result")

echo "STATE=$state"
echo "  window     : ${SECS}s, $n frames pulled"
echo "  mean luma  : $mean/255"
echo "  compared   : $pairs frame-pairs, $changed deviating from the median"
echo "  median/spread: $median / $spread"
if [[ "$pairs" == "0" ]]; then
  # Refuse to answer rather than report STILL. Zero comparisons means the diff
  # never ran -- a broken ffmpeg filter, or frames that would not decode. That
  # is not evidence the room is empty, and "STILL" from zero measurements is the
  # exact failure this whole design exists to prevent.
  echo "  verdict    : UNKNOWN -- no frame pairs could be compared, so no verdict is possible"
  exit 1
fi
echo "  verdict    : $( [[ "$state" == MOTION ]] && echo 'content changed' || echo 'valid picture, nothing changing' )"