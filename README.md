# NQ Replay Trader

Local tick-replay trading simulator for NQ futures. Replays a real 6-month NQ
tick stream (44.8M prints, Oct 30 2025 - Apr 29 2026) live, bar by bar, tick by
tick - blinded (random session, hidden date, random price offset) with honest
fills (next-print + 1 tick slip, gap-through stops, $4.20 round-turn commission).

## Setup

1. Install Python 3.10+ (check "Add to PATH" on Windows).
2. Make sure `tick_engine/cache/` contains the 5 data files
   (`nq_ticks_ts.npy`, `nq_ticks_px.npy`, `nq_ticks_sz.npy`,
   `nq_ticks_side.npy`, `nq_ticks_meta.json`) - ~730 MB total. If you got this
   from GitHub, download the data zip from the repo's Releases page and unzip
   it into `tick_engine/cache/`.
3. Double-click `run_replay_trader.bat`. First run creates a venv, installs
   flask/numpy/pandas, and builds the session index (~1 min). Browser opens at
   http://127.0.0.1:5056. Every later run launches instantly.

### Windows (one-click shortcut)

Run **`Create Desktop Shortcut.bat`** once — it drops an **"NQ Replay Trader"**
icon on your Desktop pointing at the launcher. From then on, one click on that
icon boots the server and pops open http://127.0.0.1:5056 automatically.

### macOS (one-file setup)

1. Install Python 3.10+ (`brew install python`, or python.org).
2. Clone this repo:
   `git clone https://github.com/M4LWAREE/nq-replay-software1.git`
3. Double-click **`NQ Replay Trader.app`** (or `run_mac.command`). The first run
   auto-creates the venv, **downloads the ~730 MB tick data** from the repo's
   `data-v1` Release, builds the session index, then launches and opens
   http://127.0.0.1:5056. Every later run just launches instantly.
   - First launch only: if macOS says the app is from an unidentified developer,
     right-click the app → **Open** → **Open** (one time), or run
     `xattr -dr com.apple.quarantine "NQ Replay Trader.app"`.
   - No data Release yet? Drop the 5 `nq_ticks_*` files into `tick_engine/cache/`
     manually and it skips the download.

## How to use

- **New Session** picks a random RTH day you can't identify. Price shown with a
  random offset, date hidden - no way to cheat.
- **Speed / Pause / Space** control replay. **+5m** jumps 5 minutes;
  **9** (or the arrow button) jumps to :59 of the current 1-min bar.
- **B / S** buy/sell at market, **F** flatten. Lots, Stop (tk), Target (tk)
  set the bracket in ticks (persisted). Presets: 5/40, 10/20, 40/5.
- **Trail (tk)** = trailing-stop ratchet distance (blank/0 = off).
  **Arm at +X (tk)** = trail activates once you are +X ticks in profit
  (0 = from entry). Adjustable mid-trade; never loosens once ratcheted.
- **Footprint** toggle: per-bar buy/sell volume by price level from real tick
  aggressor sides - POC highlight, per-bar delta, imbalance tints. Zoom in for
  full cells; zoomed out shows POC dashes. Off by default (zero overhead).
- Every trade is logged to `replay_trader/sessions/session_*.csv` with honest
  P&L plus two controls per trade: `coinflip_ev_net` (a coin-flip at your
  moment) and `random_time_ev_net` (your bracket at random times). The JSON
  shows a 3-layer decomposition: expectancy = day baseline + timing skill +
  direction skill - so you can tell luck from edge.

## Honesty guarantees

- No lookahead: the client can only ever see ticks that have already replayed
  (enforced server-side).
- Stops fill gap-through at the breaching print, not at your stop price.
- Trailing stops ratchet on real ticks (no bar-based trail inflation).
- Controls use the exact same fill engine as your trades.

## Data note

The tick data files are too large for a normal git push (GitHub blocks files
over 100 MB). Publish the code repo without `tick_engine/cache/*.npy` (the
.gitignore already excludes them) and attach `nq-replay-data.zip` as a GitHub
Release asset, or share it via a file link.
