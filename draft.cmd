@echo off
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0bin\run.ps1" -Action draft
if errorlevel 1 pause
