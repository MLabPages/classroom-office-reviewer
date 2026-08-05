@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\Install-NativeHost.ps1"
if errorlevel 1 pause
