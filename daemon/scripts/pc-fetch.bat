@echo off
rem Fetch the phone's bundle into the existing clone.
rem A .bat because chaining `cd /d X && cmd` through ssh -> cmd does not
rem reliably stay in X: the fetch ran in the wrong directory and reported
rem "not a git repository" while the clone's .git existed and was fine.
setlocal
cd /d C:\Users\${PC_USER}\tiny-agent-git || exit /b 1
rem Fetch into a TEMP ref, then move the checked-out branch onto it. Fetching
rem straight into refs/heads/master is refused while master is checked out:
rem "refusing to fetch into branch 'refs/heads/master' checked out at ...".
rem That is a safety property worth keeping, so fetch elsewhere and update.
C:\Users\${PC_USER}\tools\git\bin\git.exe fetch C:\Users\${PC_USER}\tiny-agent.bundle "+refs/heads/*:refs/remotes/phone/*"
if errorlevel 1 (
  echo FETCH_FAILED
  exit /b 1
)
for /f "tokens=*" %%b in ('C:\Users\${PC_USER}\tools\git\bin\git.exe for-each-ref --format="%%(refname:short)" refs/remotes/phone/') do (
  echo fetched ref %%b
)
rem -f is needed because the working tree has local files the commit does not
rem track (node_modules, job rc.txt); those are build debris, not source.
C:\Users\${PC_USER}\tools\git\bin\git.exe reset --hard refs/remotes/phone/master
if errorlevel 1 (
  echo RESET_FAILED
  exit /b 1
)
echo FETCH_OK
C:\Users\${PC_USER}\tools\git\bin\git.exe rev-parse HEAD
C:\Users\${PC_USER}\tools\git\bin\git.exe log --oneline -1