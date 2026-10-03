@echo off
rem List python processes with their command lines. Written as a .bat because
rem nested quoting through ssh -> cmd -> powershell mangles the WMI filter.
echo ===PYTHON PROCESSES===
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq python.exe" /nh 2^>nul ^| findstr /i python') do (
  echo PID %%p
  wmic process where "ProcessId=%%p" get CommandLine /format:list 2>nul | findstr /i "CommandLine" | findstr /v "^CommandLine=$"
)
echo ===LOG===
powershell -NoProfile -Command "Get-Item C:\Users\${PC_USER}\arc80\d4.log | Select-Object Length,LastWriteTime | Format-List"
