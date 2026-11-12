@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\Install-NativeHost.ps1"
if errorlevel 1 (
    pause
    exit /b 1
)
echo.
echo Setup complete. You can now use Classroom without starting Start-Reviewer.cmd.
call "%~dp0Open-Chrome-Setup.cmd"
pause
