@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-multibot.ps1" %*
exit /b %ERRORLEVEL%
