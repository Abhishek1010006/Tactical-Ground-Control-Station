@echo off
title SwarmGCS — App Terminal
echo ===================================================
echo             SWARM GCS TACTICAL LAUNCHER
echo          (App terminal — npm / Electron / API)
echo ===================================================
echo.
echo Terminal 1: Electron + renderer/map messages.
echo Terminal 2: Python backend/API messages opens separately.
echo.

cd "%~dp0electron"
call npm start

pause
