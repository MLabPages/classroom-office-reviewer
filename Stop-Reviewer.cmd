@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\Stop-Reviewer.ps1"
if errorlevel 1 pause
