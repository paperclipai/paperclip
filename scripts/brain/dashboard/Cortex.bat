@echo off
REM ─────────────────────────────────────────────────────────────────────
REM  Cortex — lanceur serveur dashboard avec auto-restart sur crash.
REM  À déposer sur le bureau ou via raccourci .lnk.
REM ─────────────────────────────────────────────────────────────────────
title Cortex serveur (auto-restart)
color 0A

cd /d h:\Code\Paperclip

REM LM Studio policy for Cortex auto tasks
set LMSTUDIO_BASE_URL=http://127.0.0.1:1234
set LMSTUDIO_FAST_MODEL=qwen2.5-7b-instruct
set LMSTUDIO_DEEP_MODEL=qwen3.6-35b-a3b
set LMSTUDIO_EMBED_MODEL=text-embedding-nomic-embed-text-v1.5
set LMSTUDIO_TTL=300
set LMSTUDIO_ALLOW_DEEP_AUTO=0
set LMSTUDIO_USE_NATIVE_API=0
set LMSTUDIO_JIT_ENABLED=0
set LM_STUDIO_EXE=G:\Lmstudio\LM Studio\LM Studio.exe
set LM_STUDIO_MODELS_URL=http://127.0.0.1:1234/v1/models
set CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
set CORTEX_CHROME_PROFILE=%USERPROFILE%\.paperclip\chrome-cortex
set CORTEX_URL=http://127.0.0.1:8765/
set CORTEX_GPU_URL=http://127.0.0.1:8765/gpu

echo Verification LM Studio...
curl.exe %LM_STUDIO_MODELS_URL% --max-time 2 >nul 2>&1
if errorlevel 1 (
  echo LM Studio non detecte - lancement...
  if exist "%LM_STUDIO_EXE%" (
    start "" "%LM_STUDIO_EXE%"
    timeout /t 8 /nobreak >nul
  ) else (
    echo ATTENTION: LM Studio.exe introuvable: %LM_STUDIO_EXE%
  )
)

REM Tue les listeners port 8765 résiduels avant de démarrer (évite "port busy")
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8765 "') do (
  echo Cleanup ancien listener pid %%P...
  taskkill /F /PID %%P >nul 2>&1
)

set RESTART_COUNT=0

:loop
echo.
echo [%date% %time%] Cortex demarre (run #%RESTART_COUNT%)...
echo URL : http://localhost:8765/gpu
echo.
if "%RESTART_COUNT%"=="0" (
  if exist "%CHROME_EXE%" (
    echo Preparation Chrome...
    if not exist "%CORTEX_CHROME_PROFILE%" mkdir "%CORTEX_CHROME_PROFILE%" >nul 2>&1
    start "" cmd /c "timeout /t 6 /nobreak >nul && \"%CHROME_EXE%\" --user-data-dir=\"%CORTEX_CHROME_PROFILE%\" --new-window \"%CORTEX_URL%\" \"%CORTEX_GPU_URL%\""
  ) else (
    echo Chrome introuvable: %CHROME_EXE%
  )
)
python scripts\brain\dashboard\serve.py
set EXITCODE=%errorlevel%

set /a RESTART_COUNT+=1
echo.
echo [%date% %time%] Cortex termine (code %EXITCODE%) - relance dans 3s...
echo (Ctrl+C dans les 3 secondes pour stopper definitivement)
echo.
timeout /t 3 /nobreak >nul
goto loop
