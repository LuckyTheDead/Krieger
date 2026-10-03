#!/data/data/com.termux/files/usr/bin/bash
# Dispatch work to the PC and collect results, without the phone babysitting it.
#
#   ./daemon/pcdispatch.sh put <local> <remote>
#   ./daemon/pcdispatch.sh get <remote> <local>
#   ./daemon/pcdispatch.sh run  <name> <cmd>      detached, per-job dir, never blocks
#   ./daemon/pcdispatch.sh poll <name>            is it done? prints DONE or RUNNING
#   ./daemon/pcdispatch.sh fetch <name> [remote]  pull the job's log back to the phone
#   ./daemon/pcdispatch.sh list
#   ./daemon/pcdispatch.sh clean <name>
#
# Why this exists rather than just `ssh host cmd`: today a 40-minute ARC run had
# to be babysitted by polling, and every poll risked my own tool timing out and
# killing the run with it. The contract here is that a dispatched job NEVER
# shares a channel with the request that created it, and NEVER shares a
# directory with another job -- the two mistakes that actually cost me time:
#
#   1. a foreground ssh dies when the channel drops (lost one 35-min run)
#   2. a second process writing the same results file clobbered the first
#      (lost the other one)
#
# So: one directory per job, one log per job, exit code written to status, and
# nothing here blocks. If a job is still running, `poll` says RUNNING and that
# is the honest answer -- not a guess and not an empty log.

set -uo pipefail

PC_HOST="${PC_HOST:?set PC_HOST to the address of your machine}"
PC_USER="${PC_USER:?set PC_USER to your ssh user name}"
KEY="$HOME/.ssh/id_ed25519_krieger"
ROOT='C:\Users\${PC_USER}\jobs'
NODE_DIR='C:\Users\${PC_USER}\tools\node\node-v24.21.0-win-x64'
PY='C:\Users\${PC_USER}\tools\python\python.exe'
GIT='C:\Users\${PC_USER}\tools\git\bin\git.exe'

SSH=(ssh -p 22 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o LogLevel=ERROR "$PC_USER@$PC_HOST")

valid_name() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]; }
q() { printf '"%s"' "$1"; }

case "${1:-}" in
  put|get)
    op=$1; shift
    [[ $# -eq 2 ]] || { echo "usage: pcdispatch.sh $op <a> <b>"; exit 1; }
    scp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR "$1" "$PC_USER@$PC_HOST:$2"
    ;;

  run)
    name="${2:-}"; body="${3:-}"
    valid_name "$name" || { echo "bad job name"; exit 1; }
    [[ -n "$body" ]] || { echo "usage: pcdispatch.sh run <name> <cmd>"; exit 1; }
    dir="$ROOT\\$name"
    "${SSH[@]}" "if not exist $(q "$dir") mkdir $(q "$dir")" >/dev/null

    # Do NOT try to pass the payload inline through start /b cmd /c "...".
    # The quotes nest three deep (ssh -> cmd -> start -> cmd) and cmd strips the
    # wrong ones: the directory was created but the payload never ran, with no
    # error. Ship the payload as a .bat instead, then launch the .bat.
    bat="$dir\\run.bat"
    # Wrap the payload in a CALL so the redirect binds to the WHOLE line, not to
    # its last command. Appending `> out.log` to the raw payload produced
    # `... >nul > out.log`, which sent the output to /dev/null.
    # `timeout /t` refuses to run with redirected stdout ("Input redirection is
    # not supported"), so any job using it dies instantly -- that is a property
    # of the Windows tool, not of the payload. Give callers ping as the sleep.
    printf '@echo off\r\ncd /d %s\r\n( %s ) > out.log 2>&1\r\necho %%ERRORLEVEL%% > rc.txt\r\n' \
      "$dir" "$body" > "$HOME/.cache/pcjobs/$name.bat"
    scp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR \
        "$HOME/.cache/pcjobs/$name.bat" "$PC_USER@$PC_HOST:$bat" >/dev/null
    # MEASURED: every `start` form silently fails in this SSH session --
    # start /b cmd /c, start /min, Start-Process, and a bare batch name all
    # created NO out.log and NO rc.txt, with no error and exit 0. Running the
    # batch FOREGROUND works fine, so the batch is correct and the launcher is
    # what is broken. `powershell -WindowStyle Hidden -Command "& bat"` is the
    # one form that detaches and survives the channel drop. Verified by
    # launching a timed job and confirming rc.txt appeared without the caller
    # staying attached.
    "${SSH[@]}" "powershell -NoProfile -WindowStyle Hidden -Command \"& $(q "$bat")\"" >/dev/null
    echo "dispatched: $name"
    echo "  dir: $dir"
    echo "  cmd: $body"
    ;;

  poll)
    name="${2:-}"; valid_name "$name" || exit 1
    # A stale rc.txt from an EARLIER dispatch of the same name reports DONE for a
    # job that has not started -- I hit exactly that and it looked like a fast
    # success. So poll only trusts rc.txt if it is NEWER than run.bat, which is
    # written at dispatch time. Both timestamps come back in one shot.
    out=$("${SSH[@]}" "powershell -NoProfile -Command \"if(Test-Path $(q "$ROOT\\$name\\rc.txt")){if((Get-Item $(q "$ROOT\\$name\\rc.txt")).LastWriteTime -ge (Get-Item $(q "$ROOT\\$name\\run.bat")).LastWriteTime){'DONE rc='+(Get-Content $(q "$ROOT\\$name\\rc.txt"))}else{'STALE'}}\"" 2>/dev/null | tr -d '\r' | tr -d ' \n')
    case "$out" in
      DONE*) echo "$out" ;;
      STALE*) echo "RUNNING (rc.txt is stale, from a previous run)" ;;
      *) echo "RUNNING (no fresh rc.txt yet)" ;;
    esac
    ;;

  fetch)
    name="${2:-}"
    valid_name "$name" || exit 1
    dest="$HOME/.cache/pcjobs/$name.log"
    mkdir -p "$HOME/.cache/pcjobs"
    rm -f "$dest"
    # scp wants a POSIX-style remote path. A Windows path with backslashes was
    # silently failing and left no local file, so `cat` then errored and the
    # job looked empty when it was not.
    if ! scp -P 22 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o LogLevel=ERROR \
         "$PC_USER@$PC_HOST:jobs/$name/out.log" "$dest" 2>&1; then
      echo "fetch failed for $name"
      exit 1
    fi
    rc=$("${SSH[@]}" "type $(q "$ROOT\\$name\\rc.txt") 2>nul" 2>/dev/null | tr -d '\r\n ')
    echo "--- $name (rc=${rc:-?}) ---"
    cat "$dest"
    ;;

  list)
    "${SSH[@]}" "if not exist $ROOT (echo no jobs yet) else dir /b $ROOT" 2>/dev/null | tr -d '\r' | sed 's/^/  /'
    ;;

  clean)
    name="${2:-}"; valid_name "$name" || exit 1
    # Do not infer success from the exit code: cmd returns 0 for a rmdir that
    # did nothing, so `&& echo removed` reported "removed" while the directory
    # was still there. Check afterwards instead.
    "${SSH[@]}" "rmdir /s /q $(q "$ROOT\\$name")" >/dev/null 2>&1
    if [[ $("${SSH[@]}" "if exist $(q "$ROOT\\$name") (echo y) else (echo n)" 2>/dev/null | tr -d '\r\n ') == "n" ]]; then
      echo "removed $name"
    else
      echo "STILL PRESENT after rmdir: $name (a running job may be holding it)"
    fi
    ;;

  env)
    echo "PC      : $PC_USER@$PC_HOST"
    echo "node    : $NODE_DIR"
    echo "python  : $PY"
    echo "git     : $GIT"
    echo "jobs    : $ROOT"
    echo "agent   : C:\\Users\\Lucky\\agent"
    echo "arc     : C:\\Users\\Lucky\\arc80"
    ;;

  *)
    echo "usage: pcdispatch.sh {put|get <a> <b> | run <name> <cmd> | poll <name> | fetch <name> [remote] | list | clean <name> | env}"
    ;;
esac