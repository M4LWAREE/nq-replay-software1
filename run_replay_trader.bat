@echo off
REM NQ Replay Trader launcher (portable)
setlocal
set PORT=5056
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [setup] creating virtual env + installing requirements (one-time^)...
  python -m venv .venv || (echo Python 3.10+ required on PATH & pause & exit /b 1)
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
)

if not exist "replay_trader\session_index.json" (
  echo [setup] building session index (one-time^)...
  ".venv\Scripts\python.exe" "replay_trader\build_session_index.py"
)

echo [replay_trader] starting on http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%/"
".venv\Scripts\python.exe" "replay_trader\replay_trader.py" --port %PORT%
endlocal
