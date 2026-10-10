@echo off
rem Double-click to stop the hub starting at sign-in and remove its shortcuts.
rem Your projects and tokens (data\hub.db, .env) are kept.
cd /d "%~dp0"
title Uninstall Management Hub
call npm run app:uninstall --silent
pause
