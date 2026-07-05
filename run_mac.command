#!/bin/bash
# NQ Replay Trader — macOS launcher. Double-click to set up (first run) then run.
# Idempotent: creates the venv, downloads the tick data (one-time), builds the
# session index (one-time), then starts the app and opens the browser.
cd "$(dirname "$0")" || exit 1
PORT=5056
CACHE="tick_engine/cache"
DATA_URL="https://github.com/M4LWAREE/nq-replay-software1/releases/download/data-v1/nq_replay_data.zip"

echo "======================================"
echo "   NQ Replay Trader (macOS)"
echo "======================================"

# 1) python3
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install from https://www.python.org/downloads/ (or: brew install python), then re-run."
  read -r -p "Press Return to close..." _; exit 1
fi

# 2) venv + deps (one-time)
if [ ! -x ".venv/bin/python" ]; then
  echo "[setup] creating virtual env + installing flask/numpy/pandas (one-time)..."
  python3 -m venv .venv || { echo "venv failed"; read -r -p "Press Return..." _; exit 1; }
  ./.venv/bin/python -m pip install -q --upgrade pip
  ./.venv/bin/python -m pip install -q -r requirements.txt || { echo "pip install failed"; read -r -p "Press Return..." _; exit 1; }
fi

# 3) tick data (one-time ~730MB from the GitHub Release)
if [ ! -f "$CACHE/nq_ticks_ts.npy" ]; then
  echo "[setup] tick data not found — downloading ~730MB one-time (this can take a while)..."
  mkdir -p "$CACHE"
  if ! curl -L --fail -o "$CACHE/nq_replay_data.zip" "$DATA_URL"; then
    echo ""
    echo "  Download failed. The GitHub Release 'data-v1' with asset 'nq_replay_data.zip'"
    echo "  may not be published yet. Publish it, or drop the 5 files into $CACHE manually:"
    echo "    nq_ticks_ts.npy  nq_ticks_px.npy  nq_ticks_sz.npy  nq_ticks_side.npy  nq_ticks_meta.json"
    read -r -p "Press Return to close..." _; exit 1
  fi
  echo "[setup] unzipping..."
  unzip -o "$CACHE/nq_replay_data.zip" -d "$CACHE" >/dev/null
  # handle a possible nested folder inside the zip
  if [ ! -f "$CACHE/nq_ticks_ts.npy" ] && [ -f "$CACHE/tick_engine/cache/nq_ticks_ts.npy" ]; then
    mv "$CACHE"/tick_engine/cache/* "$CACHE"/ 2>/dev/null || true
  fi
  rm -f "$CACHE/nq_replay_data.zip"
fi

# 4) session index (one-time)
if [ ! -f "replay_trader/session_index.json" ]; then
  echo "[setup] building session index (one-time)..."
  ./.venv/bin/python replay_trader/build_session_index.py
fi

# 5) run
echo "[replay_trader] starting on http://127.0.0.1:$PORT"
( sleep 2; open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 ) &
exec ./.venv/bin/python replay_trader/replay_trader.py --port "$PORT"
