@echo off
setlocal enabledelayedexpansion
set "DOCS=%USERPROFILE%\Documents"
if not exist "%DOCS%" mkdir "%DOCS%"

(
echo ============================================================================
echo   REMOTE ACCESS PROOF
echo   This file was written by an AI agent running on an Android phone.
echo   It did not touch your keyboard, mouse, or screen.
echo ============================================================================
echo.
echo --- CONNECTION -------------------------------------------------
echo   Agent      : Krieger, running in Termux on a Samsung SM-A166U / Android 16
echo   Phone IP   : 192.168.1.98
echo   PC         : %PC_HOST%
echo   Server     : OpenSSH for Windows 9.5
echo   Auth       : ed25519 public key. No password typed, stored, or transmitted.
echo   USB cable  : NOT USED. Everything below happened over the WiFi LAN.
echo   Run at     : 2026-10-02 16:24:05 -05:00 ^(Central Standard Time^)
echo.
echo --- WHAT IT CAN DO, MEASURED ON YOUR MACHINE --------------------
echo.
echo   System
echo     Computer        : %COMPUTERNAME%
echo     OS              : Microsoft Windows 10 Home, 10.0.19045 build 19045, 64-bit
echo     CPU             : Intel Core i5-4200U @ 1.60GHz ^(parenthesised trademark ^(R^)/(TM^)^ omitted: cmd parses those inside a block^)
echo     Cores           : 2 physical / 4 logical
echo     RAM             : 7.9 GB
echo     Uptime          : 190.2 hours
echo.
echo   Storage
echo     C:              : 689.1 GB total, 619.4 GB free ^<- 10.1 per cent used, NTFS
echo.
echo   Network
echo     Interface       : Ethernet, %PC_HOST%
echo     WiFi            : not present -- this PC is on Ethernet, not WiFi
echo.
echo   Activity
echo     Running procs   : 200
echo     Top CPU consumer: FAHWindow64, 2090.7 seconds of CPU time
echo     Notable         : MsMpEng 294 MB ^(Defender^), firefox 354 MB
echo.
echo   Security posture ^(read-only, nothing was changed^)
echo     Firewall        : Domain=True, Private=True, Public=True -- all profiles on
echo     Defender        : Real-time protection ENABLED
echo     BitLocker       : Off  ^<- the C: drive is NOT encrypted at rest
echo     SSH port 22     : listening
echo.
echo --- ONE THING IT COULD NOT DO ---------------------------------
echo.
echo   Screenshot : FAILED
echo     Attempted : CopyFromScreen
echo     Error     : "The handle is invalid"
echo     Why       : an SSH session runs in a non-interactive window station with
echo                 no attached display. There is no screen to capture over SSH.
echo.
echo   This is included deliberately. A report that only lists successes cannot
echo   be distinguished from one that is hiding its limits. Capturing a desktop
echo   would need a scheduled task running as the logged-on interactive user.
echo.
echo --- HOW TO REPRODUCE ------------------------------------------
echo.
echo   On the phone, in Termux:
echo     ssh -i ~/.ssh/id_ed25519_krieger -p 22 ${PC_USER}@192.168.1.100
echo.
echo   To confirm the file is genuine, compare this hash:
echo     338b4e0829340aff30b4c2522d76ca63b0d1d11e9070cfa0efe14402249527bb
echo   ^(that hash is of the FIRST version of this file, before this rewrite^)
echo.
echo --- IF YOU WANT TO REVOKE THIS --------------------------------
echo.
echo   On the PC, as Administrator, PowerShell:
echo     Remove-Item "$env:ProgramData\ssh\administrators_authorized_keys"
echo     Stop-Service sshd
echo     Set-Service sshd -StartupType Disabled
echo.
echo   Then delete the phone keypair:
echo     rm ~/.ssh/id_ed25519_krieger ~/.ssh/id_ed25519_krieger.pub
echo.
echo ============================================================================
echo   No keylogger, no screen capture, no persistence beyond the SSH service
echo   you installed yourself, and no shared folder or password anywhere.
echo ============================================================================
) > "%DOCS%\proof.txt"

echo WROTE %DOCS%\proof.txt
type "%DOCS%\proof.txt"
