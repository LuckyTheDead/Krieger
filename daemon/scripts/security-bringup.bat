@echo off
rem One-shot bring-up for the PC side of the security system. Safe to run more
rem than once.
rem
rem Why this exists: TinyAgentBoot uses an AtLogon trigger, and Task Scheduler
rem reports it as "Ready" with LastRunTime 1999-11-30 and result 267011 (0x41303
rem = "task has not yet run"). That looks healthy and means the opposite -- it
rem only fires the next time somebody logs into this PC interactively, which may
rem be never. Everything registered here therefore depends on an event that has
rem not happened yet.
rem
rem This starts the watchers now, proves each produced its artifact, and leaves a
rem record. An unwritten artifact is treated as failure, because "Ready" and
rem "result 0" have already been observed on a task that wrote nothing at all.

setlocal
echo ==== PC security bring-up %DATE% %TIME% ====

echo.
echo [1/4] camera watcher (every 5 min)
schtasks /query /tn KriegerCamWatch >nul 2>&1 && echo     registered || echo     NOT REGISTERED

echo.
echo [2/4] security event watcher (every 2 min)
schtasks /query /tn KriegerLogWatch >nul 2>&1 && echo     registered || echo     NOT REGISTERED

echo.
echo [3/4] run each watcher once and REQUIRE an artifact
del /q C:\Users\${PC_USER}\logwatch.log >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\${PC_USER}\pc-boot.ps1 >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\${PC_USER}\logon-watch.ps1 >> C:\Users\${PC_USER}\logwatch.log 2>&1
if exist C:\Users\${PC_USER}\logwatch.log (
  echo     logwatch.log written:
  type C:\Users\${PC_USER}\logwatch.log
) else (
  echo     FAIL: logwatch.log not produced
)

echo.
echo [4/4] current artifacts
rem Ask PowerShell rather than fighting cmd's loop expansion. Two attempts with
rem "if exist X for %%f in (X) do echo %%~zF" both printed the modifiers
rem literally: cmd expands loop variables at parse time, and the one-line
rem if+for form does not re-expand them. A batch REM is also still expanded, so
rem the comment cannot name the syntax without breaking the script.
powershell -NoProfile -Command "foreach($f in @('camwatch.log','logwatch.log')){ $p=Join-Path 'C:\Users\${PC_USER}' $f; if(Test-Path $p){ $i=Get-Item $p; Write-Output ('     {0} : {1:N0} bytes, modified {2}' -f $f,$i.Length,$i.LastWriteTime.ToString('HH:mm:ss')) } else { Write-Output ('     {0} ABSENT' -f $f) } }"

echo.
echo ==== bring-up complete ====
exit /b 0