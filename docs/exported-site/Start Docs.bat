@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node serve.js
) else (
  echo Error: Node.js is required to view these docs.
  echo Install Node.js from https://nodejs.org
  pause
)
