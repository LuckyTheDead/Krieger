@echo off
rem Depth-4 combined-DSL ARC search, detached, unbuffered so progress is visible.
cd /d C:\Users\${PC_USER}\arc80
C:\Users\${PC_USER}\tools\python\python.exe -u obj_experiment.py 4 2000000 80 > d4.log 2>&1
echo EXITCODE=%ERRORLEVEL% >> d4.log
