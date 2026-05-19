@echo off
setlocal

set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%" || exit /b 1

if exist "%REPO_ROOT%\..\.tools\pnpm.cmd" (
  set "PATH=%REPO_ROOT%\..\.tools;%PATH%"
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo Virtual Office could not find pnpm.
  echo.
  echo Please open PowerShell in this project folder and run:
  echo   pnpm run office:restart
  echo.
  echo If pnpm is installed in a local tools folder, make sure it is on PATH.
  pause
  exit /b 1
)

echo Virtual Office safe start
echo.
echo This keeps HEARTBEAT_SCHEDULER_ENABLED=false and does not wake Hermes.
echo Starting/recovering the preview now...
echo.

call pnpm run office:restart
set "START_EXIT=%ERRORLEVEL%"

echo.
if "%START_EXIT%"=="0" (
  echo Open Virtual Office:
  echo   http://localhost:5173/AI/office
  echo.
  echo Optional full check:
  echo   pnpm run office:verify
) else (
  echo The preview helper reported a problem.
  echo You can paste the output above to Codex and ask for safe preview recovery.
)

echo.
pause
exit /b %START_EXIT%
