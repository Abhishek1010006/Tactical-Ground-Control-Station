@echo off
setlocal
title SwarmGCS Requirements Installer

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1"

echo.
echo Installer finished. Press any key to close.
pause >nul
