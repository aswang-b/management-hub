@echo off
rem Started by the "Management Hub" Windows task (see windows-app.ps1).
rem Runs the hub server with its output in data\hub.log; the previous
rem run's log is kept as data\hub.previous.log.
cd /d "%~dp0.."
if not exist data mkdir data
if exist data\hub.log move /y data\hub.log data\hub.previous.log >nul
node --import tsx --no-warnings=ExperimentalWarning server/index.ts > data\hub.log 2>&1
