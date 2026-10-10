@echo off
rem Double-click to install the hub as a Windows app: it starts hidden when you
rem sign in, and "Management Hub" in the Start menu and on the desktop opens it.
rem Safe to run again (e.g. after updating the code).
cd /d "%~dp0"
title Install Management Hub

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed first. Install it from https://nodejs.org, then run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing the hub's packages, this takes a minute...
  call npm install --no-fund --no-audit
  if errorlevel 1 goto failed
)
if not exist .env copy .env.example .env >nul

call npm run app:install --silent
if errorlevel 1 goto failed
echo.
echo Done. Open "Management Hub" from the Start menu or your desktop.
pause
exit /b 0

:failed
echo.
echo Something went wrong (see the messages above).
pause
exit /b 1
