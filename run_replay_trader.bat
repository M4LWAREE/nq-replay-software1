@echo off
REM NQ Replay Trader - one-click launcher
setlocal
set PORT=5056
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [error] Python 3.10+ not found on PATH. Install from python.org ^(check "Add to PATH"^).
  pause & exit /b 1
)

REM rebuild tick data from the bundled parts on first run (stdlib only, no download)
python restore_data.py || (echo [error] data restore failed & pause & exit /b 1)

if not exist ".venv\Scripts\python.exe" (
  echo [setup] Creating environment + installing requirements ^(one-time, ~1 min^)...
  python -m venv .venv || (echo [error] venv creation failed & pause & exit /b 1)
  ".venv\Scripts\python.exe" -m pip install -q --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || (echo [error] pip install failed & pause & exit /b 1)
)

if not exist "replay_trader\session_index.json" (
  echo [setup] Building session index ^(one-time^)...
  ".venv\Scripts\python.exe" "replay_trader\build_session_index.py"
)

echo [replay_trader] Starting on http://127.0.0.1:%PORT%  - opening your browser...
start "" "http://127.0.0.1:%PORT%/"
".venv\Scripts\python.exe" "replay_trader\replay_trader.py" --port %PORT%
echo.
echo [replay_trader] Server stopped. Press any key to close.
pause >nul
endlocal
