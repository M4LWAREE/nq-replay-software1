# NQ Replay Trader

Local tick-replay trading simulator for NQ futures. Replays a real 6-month NQ
tick stream (44.8M prints, Oct 30 2025 - Apr 29 2026) live, bar by bar, tick by
tick - blinded (random session, hidden date, random price offset) with honest
fills (next-print + 1 tick slip, gap-through stops, real round-turn commission).

The UI is themed to match a live DeepCharts (Volumetrica) workspace: same dark
palette (sampled from `reference/deepcharts_ui_reference.png`), green/red
candles with an optional green/purple **delta-candle** mode, left-edge blue
volume profile with gold POC, magenta footprint POC, dotted VWAP σ-bands, and a
Volumetrica-style T.Panel (qty in micros by default).

## Setup

1. Install Python 3.10+ (check "Add to PATH" on Windows).
2. Make sure `tick_engine/cache/` contains the 5 data files
   (`nq_ticks_ts.npy`, `nq_ticks_px.npy`, `nq_ticks_sz.npy`,
   `nq_ticks_side.npy`, `nq_ticks_meta.json`) - ~730 MB total. If you got this
   from GitHub, download the data zip from the repo's Releases page and unzip
   it into `tick_engine/cache/`.
3. Double-click `run_replay_trader.bat`. First run creates a venv, installs
   flask/numpy/pandas, and builds the session index (~1 min). Browser opens at
   http://127.0.0.1:5056.

## How to use

- **New Session** picks a random RTH day you can't identify. Price shown with a
  random offset, date hidden - no way to cheat.
- **Speed / Pause / Space** control replay. **+5m** jumps 5 minutes;
  **9** (or the arrow button) jumps to :59 of the current 1-min bar.
- **B / S** buy/sell at market, **F** flatten. Qty (micros by default), Stop
  (tk), Target (tk) set the bracket in ticks (persisted). Presets include the
  validated baseline (stop 20 / trail 6 / arm +25) plus 5/40, 10/20, 40/5.
- **Trail (tk)** = trailing-stop ratchet distance (blank/0 = off).
  **Arm at +X (tk)** = trail activates once you are +X ticks in profit
  (0 = from entry). Adjustable mid-trade; never loosens once ratcheted.
- **▯▯ Dual** toggles a second chart pane (defaults: 15m footprint on the left,
  your main chart on the right). Both panes replay the SAME tape and co-scroll
  in TIME: scroll either one and the other follows to the same moment, and the
  crosshair mirrors across panes. Each pane keeps its OWN zoom — interacting
  with one pane never changes the other's bar spacing, and each pane's zoom is
  persisted across reloads. Each pane has its own timeframe (5s/30s/1m/5m/15m)
  and its own Studies menu.
- **Studies (per pane)**: **Footprint** (buy/sell heat cells by price, magenta
  POC, gold imbalance numbers, thin skeleton candles), **Vol Profile**
  (Volumetrica-style left-edge profile; visible / rolling-30min /
  whole-session range; gold POC line), **Bid/Ask** ladder, **VWAP + bands**
  (session VWAP from 09:30 with dotted ±1σ/±2σ bands), **Delta candles**
  (green = positive bar delta, purple = negative), **Delta 1m** (1-minute
  volume-delta histogram panel). All off-states are zero-overhead.
- Footprint and Bid/Ask render **zoom-adaptive level numbers** next to the
  bid (left, red) / ask (right, green) bars: fully zoomed in shows native
  0.25-tick levels with exact data; zooming out merges adjacent levels into
  clean buckets (0.5 → 1pt → 2.5pt → 5pt …) whose numbers are the true sums
  of the merged levels. Bars, numbers, POC and 3:1 imbalance highlighting all
  use the same active bucket resolution; thousands abbreviate (1.2k).
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
