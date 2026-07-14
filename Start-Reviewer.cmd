@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\Start-Reviewer.ps1"
if errorlevel 1 pause
