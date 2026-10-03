@echo off
rem Periodic webcam check: capture, judge, log one verdict.
rem
rem Three outcomes, kept distinct because collapsing them is the failure this
rem design exists to prevent:
rem   MOTION     content changed
rem   STILL      picture valid, nothing changed
rem   NO_SIGNAL  too dark to tell an empty room from a covered lens
rem
rem Judging lives in cam-judge.ps1, not here. The batch version needed a
rem variable set inside a FOR block, where cmd expands %VAR% before the block
rem body runs, so the previous-frame path was always empty on the first pass
rem and every field in the log line came out blank -- silently, because an
rem unset variable expands to nothing rather than erroring.

setlocal
cd /d C:\Users\${PC_USER}

set "FF=C:\Users\${PC_USER}\tools\ffmpeg\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe"
set "OUT=C:\Users\${PC_USER}\cammotion"
set "LOG=C:\Users\${PC_USER}\camwatch.log"
if not exist "%OUT%" mkdir "%OUT%"
del /q "%OUT%\*.jpg" >nul 2>&1

rem Capture. ffmpeg exits 0 even when the device yields nothing, so the frame
rem count -- not the exit code -- is what decides whether this check ran.
"%FF%" -hide_banner -loglevel error -f dshow -i "video=Integrated Webcam" ^
  -vf "fps=1,scale=160:120" -t 10 -q:v 5 -y "%OUT%\m%%03d.jpg" 2>nul

set /a COUNT=0
for %%f in ("%OUT%\*.jpg") do set /a COUNT+=1

if %COUNT% LSS 3 (
  echo %DATE% %TIME% VERDICT=NO_FRAMES frames=%COUNT% >> "%LOG%"
  exit /b 0
)

rem Judge. The output is written to a temp FILE and read back line by line,
rem rather than piped through for /f. Piping produced JUDGE_FAILED: the SET
rem lines are emitted on STDOUT while PowerShell's own chatter can land on
rem stderr, and for /f over a mixed stream does not reliably pair them. A file
rem cannot interleave two streams, so this is unambiguous.
set "JOUT=%TEMP%\camjudge.txt"
del /q "%JOUT%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\${PC_USER}\cam-judge.ps1 -Quiet > "%JOUT%" 2>nul

set "VERDICT="
set "MED=?"
set "SPR=?"
for /f "usebackq tokens=1,* delims==" %%a in ("%JOUT%") do (
  if /i "%%a"=="SET VERDICT" set "VERDICT=%%b"
  if /i "%%a"=="SET MED" set "MED=%%b"
  if /i "%%a"=="SET SPR" set "SPR=%%b"
)
del /q "%JOUT%" >nul 2>&1

if "%VERDICT%"=="" set "VERDICT=JUDGE_FAILED"
echo %DATE% %TIME% VERDICT=%VERDICT% frames=%COUNT% median=%MED% spread=%SPR% >> "%LOG%"
exit /b 0