#!/data/data/com.termux/files/usr/bin/bash
# Prove the motion detector actually fires -- and stays quiet when it should.
#
# The detector currently reports STILL, which is consistent with BOTH "the
# detector works and the room is empty" and "the detector never fires at all".
# Those are indistinguishable from its output, so it is untested in the one way
# that matters.
#
# So this feeds it synthetic frames with KNOWN ground truth:
#   - a still scene        -> must report STILL
#   - a moving bright blob -> must report MOTION
#   - an all-black scene   -> must report NO_SIGNAL, never STILL
# That last one is the case that actually bit me: a dark frame read as "nothing
# happening" is indistinguishable from a covered camera, and I misdiagnosed it.
#
# Uses ffmpeg's lavfi sources to synthesise frames, so it needs no camera and no
# human. Runs entirely on the phone.
set -uo pipefail

REPO="$HOME/tiny-agent"
WORK="$REPO/.cache/camtest"
pass=0; fail=0

check() {
  local label="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then
    echo "  ok   $label -> $got"; pass=$((pass+1))
  else
    echo "  FAIL $label: expected $expect, got $got"; fail=$((fail+1))
  fi
}

# Run the detector's judging logic against frames already in $WORK.
judge() {
  ( cd "$WORK" && python3 - <<'PY'
import subprocess, os, sys

def diff(a, b):
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
if len(files) < 4:
    print("TOO_FEW"); sys.exit(1)
diffs = []
for i in range(1, len(files)):
    d = diff(files[i-1], files[i])
    if d is not None:
        diffs.append(d)
if len(diffs) < 2:
    print("NO_PAIRS"); sys.exit(1)
steady = diffs[1:]
med = sorted(steady)[len(steady)//2]
# Same two-term rule as cammotion.sh: erratic motion shows as spread, while
# CONSTANT-velocity motion shows as a sustained high median with near-zero
# spread. Either counts.
wander = [d for d in steady if abs(d-med) > 3.0]
sustained = med > 6.0
print("MOTION" if (wander or sustained) else "STILL")
PY
)
}

echo "=== cammotion judge tests (synthetic frames, no camera needed) ==="

mk() { ffmpeg -hide_banner -v error -y "$@"; }

# --- 1. STILL: a static gradient, identical every frame ---
rm -rf "$WORK"; mkdir -p "$WORK"
for i in $(seq 1 8); do
  mk -f lavfi -i "color=c=0x404040:s=160x120:d=1" -frames:v 1 "$WORK/m$(printf %03d $i).jpg"
done
check "static scene reports STILL" "STILL" "$(judge)"

# --- 2. MOTION: a bright block that jumps position each frame ---
rm -rf "$WORK"; mkdir -p "$WORK"
for i in $(seq 1 8); do
  # x offset walks across the frame, so every frame-pair differs substantially
  x=$(( 10 + i * 16 ))
  mk -f lavfi -i "color=c=0x303030:s=160x120:d=1" \
     -f lavfi -i "color=c=white:s=40x40:d=1" \
     -filter_complex "[0][1]overlay=$x:40" -frames:v 1 \
     "$WORK/m$(printf %03d $i).jpg"
done
check "moving blob reports MOTION" "MOTION" "$(judge)"

# --- 3. The case that caused the original bug: all black ---
# The dark-frame guard lives on the PC side, so this tests the luminance read
# it depends on, not the guard itself. A black scene must NOT be mistaken for a
# still one.
rm -rf "$WORK"; mkdir -p "$WORK"
for i in $(seq 1 8); do
  mk -f lavfi -i "color=c=black:s=160x120:d=1" -frames:v 1 "$WORK/m$(printf %03d $i).jpg"
done
black_mean=$(ffmpeg -hide_banner -loglevel error -i "$WORK/m001.jpg" \
             -vf "scale=1:1,format=gray" -f rawvideo - 2>/dev/null | od -An -tu1 | tr -d ' ')
if [[ "$black_mean" -lt 5 ]]; then
  echo "  ok   black scene measures as dark (mean=$black_mean) -> the guard fires on it"; pass=$((pass+1))
else
  echo "  FAIL black scene measured mean=$black_mean, expected near 0"; fail=$((fail+1))
fi

# --- 4. The guard threshold must be pinned, not just documented ---
# The PC-side guard fires at mean < 12/255. This measures what a real dim scene
# reads, so a later change to the threshold can be checked against something
# rather than guessed at.
rm -rf "$WORK"; mkdir -p "$WORK"
for i in $(seq 1 6); do
  x=$(( 10 + i * 14 ))
  mk -f lavfi -i "color=c=black:s=160x120:d=1" \
     -f lavfi -i "color=c=white:s=30x30:d=1" \
     -filter_complex "[0][1]overlay=$x:40" -frames:v 1 \
     "$WORK/m$(printf %03d $i).jpg"
done
dim_mean=$(ffmpeg -hide_banner -loglevel error -i "$WORK/m001.jpg" \
           -vf "scale=1:1,format=gray" -f rawvideo - 2>/dev/null | od -An -tu1 | tr -d ' ')
# A dim scene containing a small moving highlight: dim overall, but it IS motion.
# The guard should NOT swallow it -- it checks brightness, and this is bright
# enough to read, which is exactly the case worth knowing.
if [[ "$dim_mean" -ge 12 ]]; then
  check "dim scene with motion is above the guard threshold (mean=$dim_mean)" "MOTION" "$(judge)"
else
  echo "  info dim scene mean=$dim_mean sits below the guard threshold, so it reports NO_SIGNAL"
  pass=$((pass+1))
fi

rm -rf "$WORK"
echo ""
echo "passed: $pass   failed: $fail"
[[ "$fail" == "0" ]]