#!/data/data/com.termux/files/usr/bin/bash
# Ship the phone's git history to the PC clone and keep it current.
#
#   ./daemon/pcsync.sh          push new commits, run the fast tests on the PC
#   ./daemon/pcsync.sh --check  report what would be pushed, change nothing
#
# Why a bundle rather than a file copy: the phone repo has no remote, and the
# PC needed real history, not a tarball. `git bundle create --all` produces a
# self-contained archive of every commit, and `git bundle verify` confirms it
# is complete BEFORE anything is pushed -- an unverified bundle is how you
# discover the loss only after overwriting a working checkout.
#
# The PC side is a real clone at C:\Users\${PC_USER}\tiny-agent-git, so it can diff,
# bisect and run git properly. Before this it was a loose tarball with no
# history, which is not a working copy.

set -uo pipefail

PC_HOST="${PC_HOST:?set PC_HOST to the address of your machine}"
PC_USER="${PC_USER:?set PC_USER to your ssh user name}"
KEY="$HOME/.ssh/id_ed25519_krieger"
CLONE='C:/Users/${PC_USER}/tiny-agent-git'
REMOTE_BUNDLE='C:/Users/${PC_USER}/tiny-agent.bundle'
GIT='C:\Users\${PC_USER}\tools\git\bin\git.exe'
ND='C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64'
PY='C:\Users\${PC_USER}\tools\python\python.exe'

REPO="$HOME/tiny-agent"
WORK="$HOME/.cache/pcwork"
BUNDLE="$WORK/tiny-agent.bundle"

SSH=(ssh -p 22 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o LogLevel=ERROR "$PC_USER@$PC_HOST")

mkdir -p "$WORK"
cd "$REPO" || { echo "not in the repo"; exit 1; }

# Gate on config-referenced files actually being tracked. Found the hard way:
# termux-api-mcp.js was listed in agent.json, existed on disk, and was in no
# commit -- so every fresh checkout was missing a configured MCP server. A sync
# would faithfully ship that gap, so check BEFORE shipping anything.
if ! "$REPO/daemon/check-config-tracked.sh" >/dev/null 2>&1; then
  echo "REFUSING TO SYNC: $CONFIG references files that are not in git"
  "$REPO/daemon/check-config-tracked.sh"
  exit 1
fi

local_head=$(git rev-parse HEAD)
remote_head=$("${SSH[@]}" "cd /d C:\\Users\\Lucky\\tiny-agent-git && $GIT rev-parse HEAD 2>nul" 2>/dev/null | tr -d '\r\n ')

echo "local : $local_head"
echo "remote: ${remote_head:-<no clone>}"

if [[ "${1:-}" == "--check" ]]; then
  if [[ "$local_head" == "$remote_head" ]]; then
    echo "in sync"
  else
    n=$(git rev-list --count "$remote_head..$local_head" 2>/dev/null || echo '?')
    echo "$n commit(s) to push"
  fi
  exit 0
fi

[[ "$local_head" == "$remote_head" ]] && { echo "already in sync"; exit 0; }

# Build and VERIFY before shipping. An incomplete bundle would still clone, and
# the missing commits would only surface later.
git bundle create "$BUNDLE" --all >/dev/null 2>&1 || { echo "bundle create failed"; exit 1; }
if ! git bundle verify "$BUNDLE" >/dev/null 2>&1; then
  echo "bundle FAILED verification -- refusing to ship it"
  exit 1
fi
echo "bundle ok: $(du -h "$BUNDLE" | cut -f1)"

scp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR \
    "$BUNDLE" "$PC_USER@$PC_HOST:$REMOTE_BUNDLE" >/dev/null || { echo "upload failed"; exit 1; }

# Delegate to a .bat on the PC. Two reasons, both measured:
#   - `cd /d X && cmd` chained through ssh -> cmd does not reliably stay in X;
#     the fetch ran one directory up and reported "not a git repository" while
#     the clone's .git was present and healthy.
#   - fetching straight into refs/heads/master is refused while master is
#     checked out ("refusing to fetch into branch..."). The .bat fetches into
#     refs/remotes/phone/* then resets --hard onto it.
scp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR \
    "$REPO/daemon/scripts/pc-fetch.bat" "$PC_USER@$PC_HOST:C:/Users/${PC_USER}/pc-fetch.bat" >/dev/null
"${SSH[@]}" 'C:\Users\${PC_USER}\pc-fetch.bat' 2>/dev/null | tr -d '\r' | tail -4

now=$("${SSH[@]}" "cd /d $CLONE && $GIT rev-parse HEAD" 2>/dev/null | tr -d '\r\n ')
if [[ "$now" == "$local_head" ]]; then
  echo "PC clone now at $now"
else
  echo "MISMATCH: expected $local_head, PC has ${now:-unknown}"
  exit 1
fi

# Prove the pushed state actually builds there, rather than trusting the hash.
echo '--- fast tests on the PC ---'
"${SSH[@]}" "cd /d $CLONE && set PATH=$ND;%PATH% && set SECURITY_TEST_PYTHON=$PY && node --test prompt-sync.test.mjs daemon/daemon.test.mjs security/security.test.mjs" 2>/dev/null \
  | tr -d '\r' | grep -aE '^. (tests|pass|fail) ' || echo '  (no summary -- run it manually)'