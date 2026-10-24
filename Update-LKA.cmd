@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-lka.ps1"
set "LKA_UPDATE_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %LKA_UPDATE_EXIT%
