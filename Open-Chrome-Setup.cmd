@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\Open-Chrome-Setup.ps1"
if errorlevel 1 pause
