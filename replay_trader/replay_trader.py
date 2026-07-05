#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""replay_trader.py — LOCAL live tick-replay trading simulator on real NQ ticks.

Goal: measure Parag's *discretionary* edge by letting him trade a blinded,
real-time replay of the 6-month NQ tick stream — bars form tick-by-tick in front
of him, the date is hidden, prices are offset, and an honest fill engine + a
random-direction (coin-flip) control are scored side-by-side.

READ-ONLY on all data. Touches no live-bot files. Reuses tick_engine/cache
(nq_ticks_ts/px/sz/side .npy memmaps) and the no-lookahead discipline from the
blinded harnesses.

ABSOLUTE RULE — NO LOOKAHEAD: the client is only ever shown ticks/bars in
[session_start, cursor). `cursor` is the first UNSEEN tick. Every endpoint that
returns market data derives it from ticks[start:cursor] only. The random-control
counterfactual reads ticks beyond a trade's entry, but only up to that trade's
already-realized exit index (<= cursor), and only after the trade has closed.

Run:  .venv\\Scripts\\python.exe replay_trader\\replay_trader.py  [--port 5056]
"""
from __future__ import annotations

import argparse
import bisect
import csv
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover
    from datetime import timezone as _tz
    ET = _tz.utc  # type: ignore

from flask import Flask, jsonify, request, send_from_directory

import ict_engine   # causal ICT/TJR structure detection (centralized, tunable params)

# ── paths / constants ────────────────────────────────────────────────────────
HERE = Path(__file__).resolve().parent
CACHE = HERE.parent / "tick_engine" / "cache"
STATIC = HERE / "static"
SESSIONS_DIR = HERE / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)
INDEX_FILE = HERE / "session_index.json"

TICK_SIZE = 0.25
TICK_VALUE = 5.0           # $ per tick per contract (NQ mini)
COMMISSION_RT = 4.20       # $ round-trip per contract (NQ mini)
MICRO_COMM_RT = 1.30       # $ round-trip per contract (MNQ micro — NOT COMMISSION_RT*0.1)
DEFAULT_SLIP_TK = 1        # adverse slip ticks on market / stop fills

# LIQUIDITY POOLS — a "touch" is price coming within LIQ_TOUCH_TK ticks of a MAIN pool
# (PDH/PDL/ONH/ONL/ORH/ORL/PWH/PWL/HOD/LOD). Crossing a level passes through the zone so
# it is captured too. The touch-nav seeks to the EXACT moment of the touch.
LIQ_TOUCH_TK = 2                                   # within this many ticks of a pool = touch
LIQ_TOUCH_COOLDOWN_NS = 5 * 60 * 1_000_000_000     # collapse repeat touches of the SAME pool
                                                   # within this window (chop along a level = 1)
# RSI CONFLUENCE — a touch is only surfaced if RSI(14) is at an extreme near the touch:
# it must have hit overbought (>=70) or oversold (<=30) within ±LIQ_RSI_WINDOW_NS of the
# touch (i.e. RSI already there at the touch, or reaches it within 5 min after). RSI is
# computed on the SAME timeframe the chart shows (the client passes tf). RSI is invariant
# to the display offset, so it is computed on the raw tick prices.
LIQ_RSI_PERIOD = 14
LIQ_RSI_OB = 70.0
LIQ_RSI_OS = 30.0
LIQ_RSI_WINDOW_NS = 5 * 60 * 1_000_000_000         # RSI extreme must fall within ±this of touch

# ── ZIGZAG++ (MT4-style, Dev Lucem "ZigZag++ [LD]") ─────────────────────────────
# Defaults for the alternating swing-high/low zigzag. Depth = lookback bars for the
# pivot scan; Deviation = min move (in TICKS, ≈ MT4's ExtDeviation×Point) to register a
# new leg; Backstep = min bars between pivots. Computed on the displayed-TF bars up to
# the cursor (causal); the last leg repaints as price extends (expected for a zigzag).
ZZ_DEPTH = 12
ZZ_DEVIATION_TK = 5        # ticks (MT4 Deviation in mintick units; 5tk = 1.25 NQ points)
ZZ_BACKSTEP = 2

# DATE-REVEAL — when ON, the session's real calendar date is exposed in the snapshot
# (field "session_date") so the user can look up that day's economic releases for news
# trading. OFF by default -> blinding intact, no date leaks anywhere. Enabled by env
# REVEAL_DATE=1 or the --reveal-date CLI flag (main() may flip this global on at boot).
REVEAL_DATE = os.getenv("REVEAL_DATE", "").strip().lower() in ("1", "true", "yes", "on")

# PRE-OPEN CONTEXT — bars are rendered back to this ET time the PRIOR evening (Globex
# open) so the overnight/pre-market lead-up is visible BEFORE playback. Playback still
# starts paused at the 09:30 RTH open (start_idx/cursor unchanged); these bars are all
# BEFORE the cursor, so no-lookahead is preserved. Clamped to the session's own data
# (full_start, ~00:00 ET in this cache), so it shows all available overnight.
PRE_OPEN_FROM_ET = (18, 0)        # (hour, minute) ET the prior evening; easy to change


def _instr_econ(instrument):
    """Per-contract economics for an instrument label.
    Returns (cmult, commission_round_turn): micro = MNQ ($0.50/tk, $1.30 RT);
    mini = NQ ($5/tk, $4.20 RT). cmult scales TICK_VALUE; commission does NOT scale
    (real MNQ RT is ~$1.30, not a tenth of the mini's $4.20)."""
    if instrument == "micro":
        return 0.1, MICRO_COMM_RT
    return 1.0, COMMISSION_RT

# FLOW LIGHT — trailing-60s signed order-flow delta (sum of side*size over the
# last 60s of SEEN replay ticks). A permission read for Parag's discretion, NOT a
# signal. |delta| >= FLOW_THRESH contracts tints the pill GREEN (long flow) /
# RED (short flow); within the band it is GREY (neutral). One source of truth —
# sent to the client in the snapshot so the threshold lives in exactly one place.
FLOW_WINDOW_NS = 60_000_000_000   # 60s in nanoseconds
FLOW_THRESH = 50                  # contracts; |delta| >= this -> colored pill

# OPEN HEAT — width (ticks) of the 5-min opening range, max(PX)-min(PX) over the
# 09:30:00-09:35:00 ET window. Parag's P&L correlates -0.68 with this; quiet opens
# are his best, opens > OPEN_HEAT_HOT have all ended negative. A risk-protocol read
# for his discretion, NOT a signal. It live-accumulates until the replay clock
# passes 09:35, then FREEZES for the session. One source of truth — thresholds are
# sent to the client in the snapshot so they live in exactly one place.
OPEN_HEAT_QUIET = 250             # < this tk -> GREEN "quiet — your tape"
OPEN_HEAT_HOT = 400               # > this tk -> RED "heat protocol"; 250-400 AMBER

# TAPE REGIME — rolling variance ratio over the trailing 30 min: VR = var(5-min
# returns) / (5 × var(1-min returns)) on 1-min closes. <1 = mean-reverting (Parag's
# VA-fade habitat), ~1 = random walk, >1 = trending/extending (his method dies).
# A regime read for his discretion, NOT a signal. Needs ≥ TAPE_MIN_CLOSES one-min
# closes; before that it is "warming". One source of truth — thresholds sent in the
# snapshot.
TAPE_WINDOW_NS = 30 * 60 * 1_000_000_000   # 30 min in nanoseconds
TAPE_MIN_CLOSES = 15              # one-min closes needed before VR is reported
TAPE_VR_FADE = 0.9               # VR < this -> GREEN "FADE-ABLE" (mean-reverting)
TAPE_VR_TREND = 1.1              # VR > this -> RED "EXTENDING"; 0.9-1.1 GREY NEUTRAL

# Neutral synthetic date so the x-axis shows real ET time-of-day but NO real date.
SYNTH_BASE = 1577836800    # 2020-01-01 00:00:00 UTC (epoch seconds)

CSV_HEADER = ["order_id", "side", "size", "entry_et", "exit_et",
              "entry_px_disp", "exit_px_disp", "exit_reason",
              "pnl_ticks", "pnl_net", "mfe_ticks", "mae_ticks",
              "hold_s", "stop_tk", "target_tk", "trail_tk", "arm_tk",
              "coinflip_ev_net", "random_time_ev_net", "instrument",
              "flow_delta_entry", "tape_vr_entry"]

# ── load tick cache (memmap — read only) ─────────────────────────────────────
print("[replay_trader] loading tick cache (mmap)...")
TS = np.load(CACHE / "nq_ticks_ts.npy", mmap_mode="r")    # int64 ns UTC
PX = np.load(CACHE / "nq_ticks_px.npy", mmap_mode="r")    # int32 integer ticks
SZ = np.load(CACHE / "nq_ticks_sz.npy", mmap_mode="r")    # int32 size
try:
    SIDE = np.load(CACHE / "nq_ticks_side.npy", mmap_mode="r")  # int8 +1/-1
except Exception:
    SIDE = None
N_TICKS = len(TS)
print(f"[replay_trader] {N_TICKS:,} ticks ready")

with open(INDEX_FILE) as f:
    _idx = json.load(f)
ALL_SESSIONS = _idx["sessions"]
GOOD_SESSIONS = [s for s in ALL_SESSIONS if s["rth_ticks"] >= 5000]
print(f"[replay_trader] {len(GOOD_SESSIONS)} replayable sessions")

N_RESAMPLE = 128           # random-time control draws per trade

# date -> position in ALL_SESSIONS (date-sorted). Used to find a chosen session's
# prior trading days (PDH/PDL, recent dailies) and prior week (PWH/PWL) — all of
# which are formed BEFORE the session and so are causal from the first RTH tick.
_SESS_BY_DATE = {s["date"]: i for i, s in enumerate(ALL_SESSIONS)}


def _prior_rth_sessions(date, k):
    """The up-to-`k` most recent trading days (with real RTH) strictly before `date`,
    most-recent first. Their RTH high/low give PDH/PDL and the recent dailies."""
    pos = _SESS_BY_DATE.get(date)
    if pos is None:
        return []
    out = []
    j = pos - 1
    while j >= 0 and len(out) < k:
        if ALL_SESSIONS[j].get("rth_ticks", 0) > 0:
            out.append(ALL_SESSIONS[j])
        j -= 1
    return out


def _prior_week_range(date):
    """(high, low) integer real ticks of the immediately-PRIOR ISO week's RTH range
    across all trading days in that week, or None if none are in the cache."""
    d = pd.Timestamp(date)
    pw = (d - pd.Timedelta(days=7)).isocalendar()
    highs = []
    lows = []
    for s in ALL_SESSIONS:
        if s.get("rth_ticks", 0) <= 0:
            continue
        ic = pd.Timestamp(s["date"]).isocalendar()
        if (ic[0], ic[1]) == (pw[0], pw[1]):
            seg = np.asarray(PX[int(s["rth_start"]):int(s["rth_end"])], dtype=np.int64)
            if len(seg):
                highs.append(int(seg.max()))
                lows.append(int(seg.min()))
    if highs:
        return max(highs), min(lows)
    return None

# Supported chart timeframes -> bucket seconds. Single source of truth for tf
# parsing across /api/bars, /api/footprint, /api/volprofile. The incremental
# bar/footprint caches are keyed by these tf_sec values, so adding a row here is
# all it takes to support a new TF. Unknown labels fall back to 5s.
TF_SECONDS = {"5s": 5, "30s": 30, "1m": 60, "15m": 900}


def _tf_sec(tf):
    """Map a TF label (e.g. '30s', '15m') to bucket seconds; unknown -> 5s."""
    return TF_SECONDS.get(tf, 5)


# ── Discord scoreboard webhook ───────────────────────────────────────────────
# When a session finishes (End) or is abandoned (a new session starts), the just-
# completed session's scoreboard card is POSTed to Discord — IFF it had >=1 trade.
# The URL lives in discord_webhook.txt (single line, gitignored secret); missing or
# empty -> the feature is silently inert. Posting is fire-and-forget on a daemon
# thread (never blocks the replay loop / HTTP handler), 5s timeout, errors logged
# once. CRITICAL: session id + stats ONLY — never the hidden replay date, so future
# sessions stay blind.
DISCORD_WEBHOOK_FILE = HERE / "discord_webhook.txt"


def _discord_webhook_url():
    """Webhook URL from discord_webhook.txt (read fresh each post so dropping the URL
    in needs no restart). None if the file is missing/empty -> feature inert."""
    try:
        if DISCORD_WEBHOOK_FILE.exists():
            url = DISCORD_WEBHOOK_FILE.read_text(encoding="utf-8").strip()
            return url or None
    except Exception:
        return None
    return None


def _fmt_money(v):
    return "—" if v is None else f"${v:,.2f}"


def build_discord_embed(session_id, stats):
    """Discord embed dict mirroring the scoreboard card. SESSION ID + STATS ONLY —
    no hidden date (blinding must hold for future sessions). Color green if net>0."""
    net = stats.get("net") or 0
    pf = stats.get("pf")
    fields = [
        {"name": "Trades", "value": str(stats.get("n", 0)), "inline": True},
        {"name": "Net P&L", "value": _fmt_money(stats.get("net")), "inline": True},
        {"name": "Win rate", "value": f"{stats.get('wr', 0)}%", "inline": True},
        {"name": "Expectancy/trade", "value": _fmt_money(stats.get("expectancy")), "inline": True},
        {"name": "Profit factor", "value": "—" if pf is None else f"{pf}", "inline": True},
        {"name": "Max DD", "value": _fmt_money(stats.get("max_dd")), "inline": True},
        {"name": "Avg win", "value": _fmt_money(stats.get("avg_win")), "inline": True},
        {"name": "Avg loss", "value": _fmt_money(stats.get("avg_loss")), "inline": True},
        {"name": "​", "value": "​", "inline": True},   # spacer -> decomp on its own row
        {"name": "Day baseline", "value": _fmt_money(stats.get("day_baseline")), "inline": True},
        {"name": "Timing skill", "value": _fmt_money(stats.get("selection_skill")), "inline": True},
        {"name": "Direction skill", "value": _fmt_money(stats.get("direction_skill")), "inline": True},
    ]
    return {
        "title": f"Replay Session {session_id}",
        "color": 0x26A69A if net > 0 else 0xEF5350,
        "fields": fields,
    }


# Discord sits behind Cloudflare, which returns 403 Forbidden to the DEFAULT
# "Python-urllib/x.y" User-Agent. Without a real UA every webhook post is silently
# rejected — so this header is load-bearing, not cosmetic.
DISCORD_UA = "Mozilla/5.0 (replay-trader scoreboard webhook)"


def _post_discord_async(session_id, stats):
    """Fire-and-forget POST of the scoreboard embed. Inert if no webhook configured.
    Never raises; runs on a daemon thread so it can't block the caller. Logs the
    outcome of EVERY attempt with flush=True so failures are visible immediately
    (the server's stdout is block-buffered to its log file otherwise)."""
    url = _discord_webhook_url()
    if not url:
        return   # silently inert — no network attempt
    embed = build_discord_embed(session_id, stats)

    def _worker():
        try:
            data = json.dumps({"embeds": [embed]}).encode("utf-8")
            req = urllib.request.Request(
                url, data=data,
                headers={"Content-Type": "application/json", "User-Agent": DISCORD_UA},
                method="POST")
            resp = urllib.request.urlopen(req, timeout=5)
            print(f"[replay_trader] discord post OK ({resp.status}) for {session_id}", flush=True)
        except Exception as e:   # noqa: BLE001 — never let a post crash anything
            print(f"[replay_trader] discord webhook post FAILED for {session_id}: {e!r}", flush=True)

    threading.Thread(target=_worker, daemon=True).start()


def _resolve_dir(path, entry_tick, d, tdist, sdist, trail_tk, arm_tk, slip):
    """Resolve ONE direction `d` (+1 long / -1 short) over a FIXED integer-tick
    `path` (entry-print .. window-end) under target / fixed-stop / TRAILING-stop
    rules, returning the exit price (int ticks).

    This is the single source of truth for fill resolution: it mirrors the live
    streaming engine (_check_exit / trail update / effective-stop) print-for-print
    so the real trade and the coin-flip / random-time counterfactuals resolve
    identically. Rules:
      • entry fill = entry_tick + d*slip; target/fixed-stop are tick offsets off it.
      • the trailing stop ARMS once favorable excursion reaches arm_tk (0 = arm
        from entry) and then RATCHETS monotonically (peak − trail_tk), never
        loosening.
      • the effective stop is the TIGHTEST of fixed and (armed) trail.
      • target is checked BEFORE any stop at the same print.
      • if nothing fires, forced market exit at the last print (adverse slip)."""
    after = path[1:]
    entry = entry_tick + d * slip
    tgt = None if tdist is None else entry + d * tdist
    fixed_stp = None if sdist is None else entry - d * sdist
    trail_stop = None
    armed = False
    peak_fav = 0
    exit_px = int(path[-1]) + d * slip            # forced market exit at path end
    for p in after:
        p = int(p)
        fav = (p - entry) * d
        if fav > peak_fav:
            peak_fav = fav
        if trail_tk:
            if not armed and (arm_tk <= 0 or peak_fav >= arm_tk):
                armed = True
            if armed:
                cand = entry + d * (peak_fav - trail_tk)
                if trail_stop is None or (cand - trail_stop) * d > 0:
                    trail_stop = cand
        if fixed_stp is not None and trail_stop is not None:
            eff = trail_stop if (trail_stop - fixed_stp) * d >= 0 else fixed_stp
        elif trail_stop is not None:
            eff = trail_stop
        else:
            eff = fixed_stp
        if tgt is not None and (p - tgt) * d >= 0:
            exit_px = tgt; break
        if eff is not None and (eff - p) * d >= 0:
            exit_px = p - d * slip; break
    return exit_px


def coin_ev_path(path, entry_tick, tdist, sdist, size, slip, trail_tk=None, arm_tk=0,
                 tick_value=TICK_VALUE, commission=COMMISSION_RT):
    """Both-direction-averaged net coin-flip EV over a FIXED tick path.

    Resolves each direction via `_resolve_dir` (target-before-stop, trailing-stop
    arm+ratchet, forced market exit at path end). `path` is integer-tick prices
    [entry .. window_end]; the entry fill is entry_tick + d*slip. Used by both the
    random-time control and the legacy backfill (which call it with no trail args,
    leaving trailing off) so they stay byte-for-byte consistent with the live
    engine and the actual trade's trailing rules."""
    outs = []
    for d in (1, -1):
        entry = entry_tick + d * slip
        ex_px = _resolve_dir(path, entry_tick, d, tdist, sdist, trail_tk, arm_tk, slip)
        outs.append((ex_px - entry) * d * tick_value * size - commission * size)
    return 0.5 * (outs[0] + outs[1])


def _wilder_rsi(closes, period=14):
    """Wilder's RSI over a close array → array same length (NaN before the first value).
    Matches the client's incremental RSI: seed = simple average of the first `period`
    changes, then smoothed. `gain[i-1]`/`loss[i-1]` is the change INTO bar i."""
    n = len(closes)
    rsi = np.full(n, np.nan)
    if n <= period:
        return rsi
    delta = np.diff(closes)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    ag = float(gain[:period].mean())
    al = float(loss[:period].mean())
    rsi[period] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    for i in range(period + 1, n):
        ag = (ag * (period - 1) + gain[i - 1]) / period
        al = (al * (period - 1) + loss[i - 1]) / period
        rsi[i] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    return rsi


def _mt4_zigzag(highs, lows, depth, deviation, backstep):
    """Faithful forward-orientation port of the MT4 ZigZag (the algorithm the Dev Lucem
    'ZigZag++ [LD]' Pine v5 reproduces). `highs`/`lows` are bar arrays oldest→newest;
    `deviation` is in the SAME price units as highs/lows. Two stages: (1) map candidate
    local highs/lows over a `depth`-bar window with a `deviation` gate + `backstep`
    pruning; (2) walk forward keeping ALTERNATING H/L pivots (extending a leg if a more
    extreme point appears). Returns [(idx, price, 'H'|'L'), …] in time order — the last
    leg can still move as later bars arrive (repaint, expected for a zigzag)."""
    n = len(highs)
    if n < depth + 1:
        return []
    hi_map = [0.0] * n          # candidate high price at i (0 = none)
    lo_map = [0.0] * n          # candidate low price at i
    zz = [0.0] * n              # final pivot price at i (0 = none)
    # ---- stage 1: candidate extremes ----
    last_low = 0.0
    last_high = 0.0
    for i in range(n):
        w = max(0, i - depth + 1)
        # low candidate
        val = min(lows[w:i + 1])
        if val == last_low:
            val = 0.0
        else:
            last_low = val
            if (lows[i] - val) > deviation:
                val = 0.0
            else:
                for back in range(1, backstep + 1):
                    j = i - back
                    if j >= 0 and lo_map[j] != 0.0 and lo_map[j] > val:
                        lo_map[j] = 0.0
        lo_map[i] = val if lows[i] == val else 0.0
        # high candidate (mirror)
        val = max(highs[w:i + 1])
        if val == last_high:
            val = 0.0
        else:
            last_high = val
            if (val - highs[i]) > deviation:
                val = 0.0
            else:
                for back in range(1, backstep + 1):
                    j = i - back
                    if j >= 0 and hi_map[j] != 0.0 and hi_map[j] < val:
                        hi_map[j] = 0.0
        hi_map[i] = val if highs[i] == val else 0.0
    # ---- stage 2: alternating selection ----
    look = 0                    # 0 = init, 1 = in down-leg (last pivot LOW), -1 = up-leg
    last_high = -1.0; last_low = -1.0; last_high_pos = -1; last_low_pos = -1
    ztype = {}
    for i in range(n):
        if look == 0:
            if last_low < 0 and last_high < 0:
                if hi_map[i] != 0.0:
                    last_high = highs[i]; last_high_pos = i; look = -1
                    zz[i] = last_high; ztype[i] = "H"
                if lo_map[i] != 0.0:
                    last_low = lows[i]; last_low_pos = i; look = 1
                    zz[i] = last_low; ztype[i] = "L"
        elif look == 1:         # last pivot was a LOW
            if lo_map[i] != 0.0 and lo_map[i] < last_low and hi_map[i] == 0.0:
                zz[last_low_pos] = 0.0; ztype.pop(last_low_pos, None)
                last_low_pos = i; last_low = lo_map[i]
                zz[i] = last_low; ztype[i] = "L"
            if hi_map[i] != 0.0 and lo_map[i] == 0.0:
                last_high = hi_map[i]; last_high_pos = i
                zz[i] = last_high; ztype[i] = "H"; look = -1
        elif look == -1:        # last pivot was a HIGH
            if hi_map[i] != 0.0 and hi_map[i] > last_high and lo_map[i] == 0.0:
                zz[last_high_pos] = 0.0; ztype.pop(last_high_pos, None)
                last_high_pos = i; last_high = hi_map[i]
                zz[i] = last_high; ztype[i] = "H"
            if lo_map[i] != 0.0 and hi_map[i] == 0.0:
                last_low = lo_map[i]; last_low_pos = i
                zz[i] = last_low; ztype[i] = "L"; look = 1
    return [(i, zz[i], ztype[i]) for i in range(n) if zz[i] != 0.0 and i in ztype]


# ── the replay session ───────────────────────────────────────────────────────
class ReplaySession:
    """Server-authoritative replay state. One active session at a time.

    The replay clock advances lazily: each time _advance() runs it moves
    replay_now_ns forward by (wall_elapsed * speed), then walks ticks up to the
    new clock. While flat the cursor jumps directly (cheap); while a position or
    pending order exists the engine walks tick-by-tick so stops/targets resolve
    in true print order (honest fills).
    """

    def __init__(self, mode="rth", slip_tk=DEFAULT_SLIP_TK, date=None):
        self.lock = threading.RLock()
        self.id = datetime.now().strftime("%Y%m%d_%H%M%S_") + secrets.token_hex(3)
        self.mode = mode
        self.slip_tk = int(slip_tk)
        self.instrument = "mini"   # "mini" (NQ) or "micro" (MNQ); new_session may carry over
        self.cmult, self.comm_rt = _instr_econ("mini")

        # REVIEW MODE (date given) — load a SPECIFIC day (e.g. the RSI+BB loser navigator)
        # instead of a random blinded one; prices are shown UNBLINDED (offset 0) so the
        # tape matches reality. Random sessions stay blinded as before.
        self._review = date is not None
        if self._review:
            pos = _SESS_BY_DATE.get(date)
            sess = ALL_SESSIONS[pos] if pos is not None else secrets.choice(GOOD_SESSIONS)
        else:
            sess = secrets.choice(GOOD_SESSIONS)
        self._hidden_date = sess["date"]  # NEVER sent to client (unless REVEAL_DATE)
        if mode == "full":
            self.start_idx = int(sess["full_start"]); self.end_idx = int(sess["full_end"])
            self.view_start_idx = self.start_idx     # already starts at the Globex open
        else:
            self.start_idx = int(sess["rth_start"]); self.end_idx = int(sess["rth_end"])
            # PRE-OPEN CONTEXT: render bars back to the overnight open while playback
            # still starts at 09:30 (start_idx). Bars build from view_start_idx; the
            # cursor / counterfactuals / VWAP / open-heat all stay anchored at 09:30.
            self.view_start_idx = self._compute_view_start(sess)

        # blinding price offset (integer ticks). Keeps prices positive & plausible.
        # Review (date-loaded) sessions use offset 0 -> real prices for honest replay.
        self.px_offset = 0 if self._review else int(secrets.randbelow(16001) - 8000)  # +-2000 points

        self.cursor = self.start_idx + 1        # first tick is "seen" to seed a price
        self.replay_now_ns = int(TS[self.start_idx])
        self.session_start_ns = int(TS[self.start_idx])
        self._open_win = None       # cached (09:30,09:35) ET window in UTC-ns
        # session-VWAP running sums (Σpx·sz / Σsz from the 09:30 RTH open). Anchor
        # is lazily resolved to the first tick >= 09:30 ET; accumulated incrementally
        # as the cursor advances (never rescans). No-lookahead: only ticks < cursor.
        self._vwap_anchor = None
        self._vwap_built_to = self.start_idx
        self._vwap_pv = 0.0
        self._vwap_v = 0.0
        self.speed = 1.0
        self.paused = True
        self.ended = False
        self.posted = False         # Discord scoreboard posted? (prevents double-post)
        self.last_wall = time.time()

        # trading state
        self.position = None        # dict or None
        self.pending = None         # market order awaiting next-print fill
        self.next_order_id = 1
        self.trades = []            # closed trades (each a dict)
        self.events = []            # raw order/fill log rows
        self.play_pause_events = [] # play/pause toggles + instant microstructure (catcher)

        # incremental bar cache, keyed by tf_sec. Each entry keeps the committed
        # (sealed) bars + the forming accumulator so each poll only processes
        # ticks [built_to:cursor] instead of re-bucketing the whole session.
        # Fresh per ReplaySession -> no cross-session contamination.
        self._bar_cache = {}

        # incremental FOOTPRINT cache, keyed by tf_sec. Same no-lookahead /
        # incremental discipline as _bar_cache: each committed bucket holds a
        # {price_tick -> [buy_vol, sell_vol]} map built from SIDE/PX/SZ on ticks
        # [start:cursor] only. Only ever populated when the client has the
        # footprint toggle ON and hits /api/footprint -> zero overhead when OFF.
        self._fp_cache = {}

        # ICT/TJR — lazily-computed full-session setup table (jump-to-setup) + the
        # "only allow entry near a setup" gate. Setups are a navigation index over
        # the whole RTH session; the LIVE structure overlay is computed causally
        # (bars up to the cursor) in active_structures().
        self._setups_cache = None
        self._detect_cache = None        # incremental 1-min bars (with ns/idx/mod) for live overlay
        # LIQUIDITY POOLS — the date-anchored fixed pools (PDH/PDL, recent dailies,
        # PWH/PWL) and the full-session touch index are both cursor-independent, so
        # they are computed once and cached per session. `rth_start_idx` is the 09:30
        # RTH open tick (== start_idx in rth mode; the inner open in full mode); the
        # 10:00 ET opening-range close index is resolved lazily into `_or_end`.
        self.rth_start_idx = int(sess["rth_start"]) if int(sess.get("rth_ticks", 0)) > 0 else self.start_idx
        self._or_end = None
        self._pools_static_cache = None
        self._raw_touches_cache = None   # TF-independent touch events (price proximity)
        self._touches_cache = {}         # RSI-filtered touch list, keyed by tf_sec
        self._rsi_cache = {}             # (end_ns, rsi) full-session RSI, keyed by tf_sec
        self.setup_only = False
        self._setup_gate_sec = 12 * 60   # entry allowed within ±this of a setup time

        # cumulative stats helpers
        self._csv_path = SESSIONS_DIR / f"session_{self.id}.csv"
        self._json_path = SESSIONS_DIR / f"session_{self.id}.json"
        self._write_csv_header()

    # ---- price/time display helpers (offset + synthetic date) ----
    def disp_px(self, real_ticks):
        """integer real ticks -> displayed POINTS (offset applied)."""
        return (real_ticks + self.px_offset) * TICK_SIZE

    def real_from_disp(self, disp_points):
        """displayed POINTS -> integer real ticks (inverse of disp_px)."""
        return int(round(disp_points / TICK_SIZE)) - self.px_offset

    def synth_time(self, ns):
        """UTC ns -> synthetic epoch seconds: real ET time-of-day, neutral date."""
        et = pd.Timestamp(ns, tz="UTC").tz_convert(ET)
        sec = et.hour * 3600 + et.minute * 60 + et.second
        # day-rollover offset so overnight 'full' sessions stay monotonic
        day_off = (et.normalize() - pd.Timestamp(self.session_start_ns, tz="UTC")
                   .tz_convert(ET).normalize()).days
        return SYNTH_BASE + sec + day_off * 86400

    def et_clock(self, ns):
        et = pd.Timestamp(ns, tz="UTC").tz_convert(ET)
        return et.strftime("%H:%M:%S")

    def _compute_view_start(self, sess):
        """Index of ~PRE_OPEN_FROM_ET (default 18:00 ET) the evening BEFORE the RTH
        date — the overnight lead-in shown as context. CLAMPED to the session's own
        data [full_start, rth_start], so it never crosses into another day and falls
        back to the earliest available overnight tick (~00:00 ET in this cache)."""
        full_start = int(sess["full_start"]); rth_start = int(sess["rth_start"])
        d = pd.Timestamp(self._hidden_date)            # RTH calendar date
        eve = (pd.Timestamp(year=d.year, month=d.month, day=d.day,
                            hour=PRE_OPEN_FROM_ET[0], minute=PRE_OPEN_FROM_ET[1], tz=ET)
               - pd.Timedelta(days=1))                 # prior evening
        idx = int(np.searchsorted(TS, int(eve.value), side="left"))
        return max(full_start, min(idx, rth_start))

    # ---- advancement / honest fill engine ----
    def _cur_price(self):
        """last seen real price in integer ticks (cursor-1 is last seen tick)."""
        i = max(self.start_idx, self.cursor - 1)
        return int(PX[i])

    def _flow_delta(self, hi_idx, now_ns):
        """Signed order-flow delta = sum(side*size) over SEEN ticks in the last
        60s of replay time. NO LOOKAHEAD: bounded strictly to indices in
        [start_idx, hi_idx) (hi_idx exclusive) and TS >= now_ns - 60s.
        Returns int contracts (+buy / -sell), or None if no aggressor-side data.
        Cheap: one searchsorted + one vectorized dot over ~60s of ticks."""
        if SIDE is None:
            return None
        if hi_idx <= self.start_idx:
            return 0
        lo_ns = now_ns - FLOW_WINDOW_NS
        # first SEEN tick with TS >= lo_ns, clamped to the session start
        lo = int(np.searchsorted(TS[self.start_idx:hi_idx], lo_ns, side="left")) + self.start_idx
        if lo >= hi_idx:
            return 0
        seg_side = np.asarray(SIDE[lo:hi_idx], dtype=np.int64)
        seg_sz = np.asarray(SZ[lo:hi_idx], dtype=np.int64)
        return int(np.dot(seg_side, seg_sz))

    def _open_window_ns(self):
        """(start_ns, end_ns) UTC-ns bounds of the 09:30:00-09:35:00 ET opening
        window for this session's RTH date. Cached (date never changes)."""
        if self._open_win is None:
            s = pd.Timestamp(f"{self._hidden_date} 09:30:00", tz=ET)
            e = pd.Timestamp(f"{self._hidden_date} 09:35:00", tz=ET)
            self._open_win = (int(s.value), int(e.value))   # .value = UTC epoch ns
        return self._open_win

    def _open5m_range(self, hi_idx, now_ns):
        """OPEN HEAT — 5-min opening-range width in ticks = max(PX)-min(PX) over
        SEEN ticks in [09:30:00, 09:35:00) ET. Live-accumulates while the replay
        clock is inside the window; FREEZES once it passes 09:35. NO LOOKAHEAD:
        the upper index bound is the seen frontier `hi_idx`, additionally capped at
        the first tick >= 09:35, so the value can never depend on a tick at/after
        the cursor nor on anything past the 5-min window. Returns int ticks, or
        None until the replay clock reaches 09:30 (or if the window has no ticks).
        Cheap: two searchsorted + one vectorized min/max over ~5 min of ticks."""
        win_s, win_e = self._open_window_ns()
        if now_ns < win_s or hi_idx <= self.start_idx:
            return None
        # cap the upper bound at the first tick >= 09:35 (freeze), but never above
        # the seen frontier hi_idx (no lookahead while still inside the window).
        cap = int(np.searchsorted(TS[self.start_idx:hi_idx], win_e, side="left")) + self.start_idx
        hi = min(hi_idx, cap)
        lo = int(np.searchsorted(TS[self.start_idx:hi], win_s, side="left")) + self.start_idx
        if hi <= lo:
            return None
        seg = np.asarray(PX[lo:hi], dtype=np.int64)
        return int(seg.max() - seg.min())

    def _vwap(self, hi_idx):
        """Session VWAP = Σ(px·sz)/Σ(sz) over SEEN ticks in [anchor, hi_idx), where
        anchor = first tick >= 09:30 ET (the RTH open). INCREMENTAL: running sums are
        carried in self._vwap_pv / _vwap_v and only NEW ticks [built_to, hi_idx) are
        added each call — never a rescan. NO LOOKAHEAD: hi_idx is the cursor, so only
        ticks strictly before it contribute. Returns the VWAP in DISPLAY points
        (offset applied), or None before the anchor / with no volume.
        Cheap: one dot + one sum over the newly-seen ticks per call."""
        if self._vwap_anchor is None:
            win_s, _ = self._open_window_ns()
            a = int(np.searchsorted(TS[self.start_idx:self.end_idx], win_s, side="left")) + self.start_idx
            self._vwap_anchor = max(a, self.start_idx)
            self._vwap_built_to = self._vwap_anchor
        anchor = self._vwap_anchor
        if hi_idx <= anchor:
            return None
        bt = self._vwap_built_to
        # cursor went backwards (shouldn't in normal flow) -> restart from anchor
        if hi_idx < bt:
            self._vwap_pv = 0.0; self._vwap_v = 0.0; bt = anchor
        if bt < anchor:
            bt = anchor
        if hi_idx > bt:
            seg_px = np.asarray(PX[bt:hi_idx], dtype=np.float64)
            seg_sz = np.asarray(SZ[bt:hi_idx], dtype=np.float64)
            self._vwap_pv += float(np.dot(seg_px, seg_sz))
            self._vwap_v += float(seg_sz.sum())
            bt = hi_idx
        self._vwap_built_to = bt
        if self._vwap_v <= 0:
            return None
        return round(self.disp_px(self._vwap_pv / self._vwap_v), 2)

    # ---- play/pause catcher: instant microstructure + event logging ----
    def _rsi_at_cursor(self, now_ns):
        """RSI(14) on 1-min closes at the last bar that closed at/before the cursor —
        causal (RSI[i] depends only on closes up to i). Reuses the cached full-session
        RSI series. None until 14 bars exist."""
        try:
            end_ns, rsi = self._rsi_series(60)
            if len(end_ns) == 0:
                return None
            k = int(np.searchsorted(end_ns, now_ns, side="right")) - 1
            if k < 0:
                return None
            v = float(rsi[k])
            return None if v != v else round(v, 1)   # NaN-safe
        except Exception:
            return None

    def _micro_features(self, hi_idx, now_ns):
        """Instant CAUSAL microstructure at the cursor — sub-second Δprice / tick velocity
        / micro-volatility, last-move direction, VWAP distance, RSI(14). Reads only ticks
        in [start_idx, hi_idx) (≤ cursor). All price deltas/ranges in signed integer TICKS
        (offset-invariant); std in ticks; vwap distance in ticks."""
        lo = self.start_idx
        cur = int(PX[hi_idx - 1])
        seg_ts = np.asarray(TS[lo:hi_idx], dtype=np.int64)
        n_seen = hi_idx - lo
        NS = 1_000_000   # ns per ms

        def px_ago(ms):   # price at the last seen tick with TS <= now-ms (None if pre-start)
            k = int(np.searchsorted(seg_ts, now_ns - ms * NS, side="right")) - 1
            return None if k < 0 else int(PX[lo + k])

        def count_since(ms):   # number of prints in the last `ms`
            k = int(np.searchsorted(seg_ts, now_ns - ms * NS, side="left"))
            return int(n_seen - k)

        def win_px(ms):        # seen prices over the last `ms`
            k = int(np.searchsorted(seg_ts, now_ns - ms * NS, side="left"))
            return np.asarray(PX[lo + k:hi_idx], dtype=np.float64)

        f = {}
        for ms, key in ((100, "dpx_100ms"), (250, "dpx_250ms"), (500, "dpx_500ms"),
                        (1000, "dpx_1s"), (2000, "dpx_2s")):
            p = px_ago(ms)
            f[key] = None if p is None else int(cur - p)            # signed ticks
        f["prints_250ms"] = count_since(250)
        f["prints_1s"] = count_since(1000)
        f["ticks_per_sec"] = f["dpx_1s"]                           # net ticks moved over last 1s
        for ms, rkey, skey in ((500, "range_500ms", "std_500ms"),
                               (1000, "range_1s", "std_1s"),
                               (2000, "range_2s", "std_2s")):
            seg = win_px(ms)
            if len(seg) >= 1:
                f[rkey] = int(seg.max() - seg.min())
                f[skey] = round(float(seg.std()), 2) if len(seg) >= 2 else 0.0
            else:
                f[rkey] = None
                f[skey] = None
        d = f["dpx_250ms"] if f["dpx_250ms"] else (f["dpx_1s"] or 0)   # last micro-move sign
        f["last_move_dir"] = 1 if d > 0 else (-1 if d < 0 else 0)
        vwap = self._vwap(hi_idx)
        f["vwap_dist_tk"] = None if vwap is None else round((self.disp_px(cur) - vwap) / TICK_SIZE, 1)
        f["rsi14"] = self._rsi_at_cursor(now_ns)
        return f

    def _log_play_pause(self, kind):
        """Append a play/pause toggle event (kind in {play,pause}) with the cursor tick
        index + replay ET + display price + instant causal microstructure, then persist
        so it survives autosave / End. Causal + blinded (no date)."""
        hi = self.cursor
        if hi <= self.start_idx:
            return
        now_ns = self.replay_now_ns
        cur = int(PX[hi - 1])
        ev = {
            "kind": kind,
            "wall": round(time.time(), 3),
            "cursor_idx": int(hi),
            "et": self.et_clock(now_ns),
            "synth_t": int(self.synth_time(now_ns)),
            "price": round(self.disp_px(cur), 2),
            "pre_entry": False,
            "order_id": None,
        }
        ev.update(self._micro_features(hi, now_ns))
        self.play_pause_events.append(ev)
        self._persist_json()

    def _tag_pre_entry(self, oid, window_s=10.0):
        """If an order entry follows a PAUSE within `window_s` WALL seconds, tag that
        pause `pre_entry=True` + store the order_id — isolating the pause-before-entry
        moments. Tags the most recent qualifying pause only."""
        now = time.time()
        for ev in reversed(self.play_pause_events):
            if (now - ev["wall"]) > window_s:
                break
            if ev["kind"] == "pause":
                ev["pre_entry"] = True
                ev["order_id"] = oid
                self._persist_json()
                return

    def _tape_vr(self, hi_idx, now_ns):
        """TAPE REGIME variance ratio over the trailing 30 min of SEEN ticks:
        VR = var(5-min returns) / (5 · var(1-min returns)), on 1-min closes built
        from ticks in [now-30min, now). <1 mean-reverts, ~1 random walk, >1 trends.
        NO LOOKAHEAD: bounded strictly to indices [start_idx, hi_idx) (hi_idx = the
        cursor) and TS >= now-30min. Returns None while WARMING (< TAPE_MIN_CLOSES
        one-min closes) or if the tape is flat (zero 1-min variance). Cheap: one
        searchsorted + a couple vectorized passes over ~30 min of ticks."""
        if hi_idx <= self.start_idx:
            return None
        lo_ns = now_ns - TAPE_WINDOW_NS
        lo = int(np.searchsorted(TS[self.start_idx:hi_idx], lo_ns, side="left")) + self.start_idx
        if lo >= hi_idx:
            return None
        ts = np.asarray(TS[lo:hi_idx], dtype=np.int64)
        px = np.asarray(PX[lo:hi_idx], dtype=np.float64)
        minute = ts // 60_000_000_000                      # integer 1-min bucket
        # close of each 1-min bucket = price at the LAST tick of each run (ts sorted)
        last_of_run = np.append(np.nonzero(np.diff(minute))[0], len(minute) - 1)
        closes = px[last_of_run]
        if len(closes) < TAPE_MIN_CLOSES:
            return None                                    # warming
        r1 = np.diff(closes)                               # 1-min returns
        r5 = closes[5:] - closes[:-5]                      # overlapping 5-min returns
        if len(r1) < 2 or len(r5) < 2:
            return None
        v1 = float(np.var(r1, ddof=1))
        v5 = float(np.var(r5, ddof=1))
        if v1 <= 0.0:
            return None                                    # flat tape -> undefined
        return round(v5 / (5.0 * v1), 3)

    def advance(self):
        """Advance the replay clock to wall-now and process ticks honestly."""
        with self.lock:
            now = time.time()
            if self.ended:
                self.last_wall = now
                return
            if self.paused:
                self.last_wall = now
                return
            dt = now - self.last_wall
            self.last_wall = now
            if dt <= 0:
                return
            self.replay_now_ns += int(dt * self.speed * 1e9)
            last_ns = int(TS[self.end_idx - 1])
            if self.replay_now_ns >= last_ns:
                self.replay_now_ns = last_ns
            # target cursor = first tick with ts > replay_now (strictly after)
            target = int(np.searchsorted(TS[self.start_idx:self.end_idx],
                                         self.replay_now_ns, side="right")) + self.start_idx
            target = min(target, self.end_idx)
            if target <= self.cursor:
                return
            if self.position is None and self.pending is None:
                # nothing to resolve — jump
                self.cursor = target
            else:
                self._walk(target)
            if self.cursor >= self.end_idx:
                self._end_session()

    def _walk(self, target):
        """Walk ticks [cursor, target) one at a time, resolving fills/exits."""
        i = self.cursor
        while i < target:
            px = int(PX[i]); ns = int(TS[i])
            # 1) pending market order fills at THIS print (first strictly-after)
            if self.pending is not None:
                self._fill_market(i, px, ns)
            # 2) check open-position protective exits on this print
            if self.position is not None:
                self._check_exit(i, px, ns)
            i += 1
        self.cursor = target

    def _fill_market(self, i, px, ns):
        o = self.pending; self.pending = None
        side = o["side"]
        fill = px + side * self.slip_tk            # adverse slip
        # Resolve tick-offset brackets RELATIVE TO THE ACTUAL FILL price:
        # long  -> stop = fill - N, target = fill + M ; short mirrored.
        stop_tk = o.get("stop_tk"); target_tk = o.get("target_tk")
        stop = None if not stop_tk else fill - side * stop_tk
        target = None if not target_tk else fill + side * target_tk
        pos = {
            "order_id": o["order_id"], "side": side, "size": o["size"],
            "entry_idx": i, "entry_ns": ns, "entry_px": fill,
            "stop": stop, "target": target,
            "stop_tk": stop_tk, "target_tk": target_tk,
            "trail_tk": o.get("trail_tk"), "arm_tk": o.get("arm_tk") or 0,
            "trail_armed": False, "trail_stop": None,
            "mfe": 0, "mae": 0,
            # LOCK economics at ENTRY: instrument/cmult/commission are snapshotted at
            # fill so switching instrument mid-position can't retroactively rebill it.
            "instrument": self.instrument, "cmult": self.cmult, "comm_rt": self.comm_rt,
            # FLOW LIGHT: trailing-60s signed delta AS OF the fill (tick i is
            # seen at fill -> hi-bound i+1). Logged ALWAYS, independent of the
            # client Flow toggle, since it is part of the science record.
            "flow_delta_entry": self._flow_delta(i + 1, ns),
            # TAPE REGIME: variance ratio AS OF the fill (always logged, toggle-
            # independent) so the regime gate can be forward-validated per trade.
            "tape_vr_entry": self._tape_vr(i + 1, ns),
        }
        self.position = pos
        self._log_event("FILL_ENTRY", side=side, size=o["size"], px=fill, ns=ns, idx=i)

    def _check_exit(self, i, px, ns):
        pos = self.position; side = pos["side"]
        # MFE/MAE in ticks (favorable/adverse excursion of price vs entry)
        exc = (px - pos["entry_px"]) * side
        if exc > pos["mfe"]:
            pos["mfe"] = exc
        if exc < pos["mae"]:
            pos["mae"] = exc
        # ---- trailing stop: arm once favorable excursion reaches arm_tk, then
        #      ratchet (peak - trail_tk) monotonically; never loosen. Mid-trade
        #      edits to trail_tk/arm_tk are honored here since we read them live. ----
        tk = pos.get("trail_tk")
        trail = None
        if tk:
            arm = pos.get("arm_tk") or 0
            if not pos.get("trail_armed") and (arm <= 0 or pos["mfe"] >= arm):
                pos["trail_armed"] = True
            if pos.get("trail_armed"):
                cand = pos["entry_px"] + side * (pos["mfe"] - tk)
                cur = pos.get("trail_stop")
                if cur is None or (cand - cur) * side > 0:
                    pos["trail_stop"] = cand
                trail = pos["trail_stop"]
        else:
            # trail cleared mid-trade -> revert to fixed stop
            pos["trail_armed"] = False
            pos["trail_stop"] = None
        # effective stop = TIGHTEST of fixed stop and (armed) trail
        fixed = pos["stop"]
        if trail is not None and fixed is not None:
            eff = trail if (trail - fixed) * side >= 0 else fixed
            eff_is_trail = eff is trail
        elif trail is not None:
            eff = trail; eff_is_trail = True
        else:
            eff = fixed; eff_is_trail = False
        # protective exits (target checked BEFORE stop at the same print)
        if side == 1:
            if pos["target"] is not None and px >= pos["target"]:
                self._close(i, pos["target"], ns, "TARGET"); return
            if eff is not None and px <= eff:
                self._close(i, px - self.slip_tk, ns,
                            "TRAIL" if eff_is_trail else "STOP"); return
        else:
            if pos["target"] is not None and px <= pos["target"]:
                self._close(i, pos["target"], ns, "TARGET"); return
            if eff is not None and px >= eff:
                self._close(i, px + self.slip_tk, ns,
                            "TRAIL" if eff_is_trail else "STOP"); return

    def set_instrument(self, name):
        name = "micro" if str(name).lower().startswith("micro") else "mini"
        with self.lock:
            self.instrument = name
            self.cmult, self.comm_rt = _instr_econ(name)
        return {"instrument": self.instrument}

    def _close(self, i, exit_px, ns, reason):
        pos = self.position; self.position = None
        side = pos["side"]; size = pos["size"]
        # economics locked at entry (fall back to live values for legacy positions)
        cm = pos.get("cmult", self.cmult)
        comm = pos.get("comm_rt", self.comm_rt)
        instr = pos.get("instrument", self.instrument)
        pnl_ticks = (exit_px - pos["entry_px"]) * side
        gross = pnl_ticks * TICK_VALUE * cm * size
        net = gross - comm * size
        hold_s = (ns - pos["entry_ns"]) / 1e9
        coin = self._coinflip_ev(pos, i)
        # random-time DAY baseline: same bracket at random RTH times, held the
        # same duration, bounded to the realized frontier (no lookahead).
        pos["exit_ns"] = ns
        rt = self._random_time_ev(pos, max(i + 1, self.cursor))
        tr = {
            "order_id": pos["order_id"], "side": "LONG" if side == 1 else "SHORT",
            "size": size, "entry_idx": pos["entry_idx"], "exit_idx": i,
            "entry_ns": pos["entry_ns"], "exit_ns": ns,
            "entry_et": self.et_clock(pos["entry_ns"]), "exit_et": self.et_clock(ns),
            "entry_px_disp": round(self.disp_px(pos["entry_px"]), 2),
            "exit_px_disp": round(self.disp_px(exit_px), 2),
            "exit_reason": reason, "pnl_ticks": round(pnl_ticks, 2),
            "pnl_net": round(net, 2), "mfe_ticks": round(pos["mfe"], 2),
            "mae_ticks": round(pos["mae"], 2), "hold_s": round(hold_s, 1),
            "stop_tk": pos.get("stop_tk"), "target_tk": pos.get("target_tk"),
            "trail_tk": pos.get("trail_tk"), "arm_tk": pos.get("arm_tk"),
            "coinflip_ev_net": round(coin, 2),
            "random_time_ev_net": round(rt, 2),
            "instrument": instr,
            "flow_delta_entry": pos.get("flow_delta_entry"),
            "tape_vr_entry": pos.get("tape_vr_entry"),
        }
        self.trades.append(tr)
        self._log_event("FILL_EXIT", side=side, size=size, px=exit_px, ns=ns, idx=i,
                        reason=reason, pnl_net=net)
        self._append_trade_csv(tr)
        self._persist_json()

    def _coinflip_ev(self, pos, exit_idx):
        """Coin-flip control: same entry instant, same bracket DISTANCES *and the
        SAME trailing-stop rules*, forced exit at this trade's realized exit index,
        averaged over BOTH directions. Resolved honestly on the SAME ticks
        [entry_idx, exit_idx] via the shared `coin_ev_path`/`_resolve_dir` engine so
        it stays apples-to-apples with the actual trade. Reads only already-realized
        ticks (<= cursor)."""
        ei = pos["entry_idx"]
        path = np.asarray(PX[ei:exit_idx + 1], dtype=np.int64)
        return coin_ev_path(path, int(PX[ei]), pos.get("target_tk"),
                            pos.get("stop_tk"), pos["size"], self.slip_tk,
                            trail_tk=pos.get("trail_tk"),
                            arm_tk=pos.get("arm_tk") or 0,
                            tick_value=TICK_VALUE * pos.get("cmult", self.cmult),
                            commission=pos.get("comm_rt", self.comm_rt))

    def _random_time_ev(self, pos, hi_idx):
        """Random-time DAY baseline: the SAME bracket (this trade's tdist/sdist/
        size, coin-flip = both-direction average) evaluated at N_RESAMPLE
        uniformly-random RTH entry TIMES on this session day, each held for the
        SAME wall duration as the real trade. Seeded per trade for
        reproducibility. NO-LOOKAHEAD: draws are bounded to the already-realized
        tick window [start_idx, hi_idx) (live: the realized frontier; completed
        backfill: the full session), and each draw's resolution window is clamped
        to that same frontier."""
        tdist = pos.get("target_tk")
        sdist = pos.get("stop_tk")
        trail_tk = pos.get("trail_tk"); arm_tk = pos.get("arm_tk") or 0
        size = pos["size"]; slip = self.slip_tk
        hold_ns = pos["exit_ns"] - pos["entry_ns"]
        lo = self.start_idx
        hi = max(int(hi_idx), lo + 2)
        if hi - lo < 3:
            return 0.0
        seed = int.from_bytes(
            hashlib.sha256(f"{self.id}:{pos['order_id']}".encode()).digest()[:8],
            "big")
        rng = np.random.default_rng(seed)
        ts_lo = int(TS[lo]); ts_hi = int(TS[hi - 1])
        latest = ts_hi - hold_ns
        if latest <= ts_lo:
            latest = ts_lo
        win = np.asarray(TS[lo:hi], dtype=np.int64)
        evs = []
        for _ in range(N_RESAMPLE):
            r_ns = int(rng.integers(ts_lo, latest + 1))
            ridx = min(int(np.searchsorted(win, r_ns, side="left")) + lo, hi - 2)
            wend = int(np.searchsorted(win, int(TS[ridx]) + hold_ns, side="right")) + lo
            wend = min(max(wend, ridx + 1), hi - 1)
            path = np.asarray(PX[ridx:wend + 1], dtype=np.int64)
            evs.append(coin_ev_path(path, int(PX[ridx]), tdist, sdist, size, slip,
                                    trail_tk=trail_tk, arm_tk=arm_tk,
                                    tick_value=TICK_VALUE * pos.get("cmult", self.cmult),
                                    commission=pos.get("comm_rt", self.comm_rt)))
        return float(np.mean(evs))

    def _end_session(self):
        if self.ended:
            return
        # auto-flatten any open position at the last tick (market)
        if self.position is not None:
            i = self.end_idx - 1
            self._close(i, int(PX[i]), int(TS[i]), "EOD")
        self.pending = None
        self.ended = True
        self.paused = True
        self._persist_json()
        self._maybe_post_discord()

    # ---- order entry API ----
    @staticmethod
    def _norm_tk(v):
        """Normalize a tick-offset input -> positive int, or None (no bracket)."""
        if v in (None, "", "0", 0):
            return None
        try:
            n = int(round(float(v)))
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None

    @staticmethod
    def _norm_arm(v):
        """Normalize the trail ARM threshold -> non-negative int (0 = arm from
        entry). blank/None/'__keep__'/invalid -> 0."""
        if v in (None, "", "__keep__"):
            return 0
        try:
            n = int(round(float(v)))
        except (TypeError, ValueError):
            return 0
        return n if n > 0 else 0

    def place_market(self, side, size, stop_tk=None, target_tk=None,
                     trail_tk=None, arm_tk=None):
        with self.lock:
            if self.ended:
                return {"ok": False, "err": "session ended"}
            if self.position is not None or self.pending is not None:
                return {"ok": False, "err": "one position at a time"}
            if self.setup_only and not self._near_setup():
                return {"ok": False, "err": "setup-only: no TJR setup near this time"}
            size = max(1, int(size))
            # Brackets are TICK OFFSETS from the actual fill price; the absolute
            # stop/target prices are computed in _fill_market once we know the fill.
            stop_tk = self._norm_tk(stop_tk)
            target_tk = self._norm_tk(target_tk)
            trail_tk = self._norm_tk(trail_tk)        # 0/blank -> None (off)
            arm_tk = self._norm_arm(arm_tk)           # 0 = arm from entry
            oid = self.next_order_id; self.next_order_id += 1
            self.pending = {"order_id": oid, "side": side, "size": size,
                            "stop_tk": stop_tk, "target_tk": target_tk,
                            "trail_tk": trail_tk, "arm_tk": arm_tk,
                            "stop": None, "target": None}
            self._log_event("ORDER", side=side, size=size, ns=self.replay_now_ns,
                            idx=self.cursor)
            self._tag_pre_entry(oid)   # link a recent pause to this entry (pre-entry tag)
            return {"ok": True, "order_id": oid}

    def modify(self, stop_tk="__keep__", target_tk="__keep__",
               trail_tk="__keep__", arm_tk="__keep__"):
        """Edit bracket TICK OFFSETS on an open position; recompute the absolute
        stop/target from the ORIGINAL fill price (not the current price). Trail/arm
        edits take effect immediately on the next print — the ratchet recomputes
        from the running peak and never loosens below the current level; clearing
        trail_tk reverts to the fixed stop."""
        with self.lock:
            if self.position is None:
                return {"ok": False, "err": "no open position"}
            pos = self.position; side = pos["side"]; fill = pos["entry_px"]
            if stop_tk != "__keep__":
                n = self._norm_tk(stop_tk)
                pos["stop_tk"] = n
                pos["stop"] = None if n is None else fill - side * n
            if target_tk != "__keep__":
                n = self._norm_tk(target_tk)
                pos["target_tk"] = n
                pos["target"] = None if n is None else fill + side * n
            if trail_tk != "__keep__":
                n = self._norm_tk(trail_tk)
                pos["trail_tk"] = n
                if n is None:                      # cleared -> revert to fixed stop
                    pos["trail_armed"] = False
                    pos["trail_stop"] = None
            if arm_tk != "__keep__":
                pos["arm_tk"] = self._norm_arm(arm_tk)
            # Re-arm + recompute the trail level from the running peak IMMEDIATELY
            # (same logic as _check_exit) so the displayed line is correct even on a
            # paused replay. Tighten-only: never loosen below the current ratchet.
            tk = pos.get("trail_tk")
            if tk:
                arm = pos.get("arm_tk") or 0
                if not pos.get("trail_armed") and (arm <= 0 or pos["mfe"] >= arm):
                    pos["trail_armed"] = True
                if pos.get("trail_armed"):
                    cand = pos["entry_px"] + side * (pos["mfe"] - tk)
                    cur = pos.get("trail_stop")
                    if cur is None or (cand - cur) * side > 0:
                        pos["trail_stop"] = cand
            self._log_event("MODIFY", ns=self.replay_now_ns, idx=self.cursor)
            return {"ok": True}

    def flatten(self):
        with self.lock:
            if self.pending is not None:
                self.pending = None
                return {"ok": True, "note": "cancelled pending"}
            if self.position is None:
                return {"ok": False, "err": "flat"}
            i = max(self.start_idx, self.cursor - 1)
            px = int(PX[i]); side = self.position["side"]
            # market flatten at last seen price + adverse slip
            self._close(i, px - side * self.slip_tk, int(TS[i]), "MANUAL")
            return {"ok": True}

    # ---- controls ----
    def set_speed(self, sp):
        with self.lock:
            self.advance()
            self.speed = float(sp)

    def set_paused(self, p):
        with self.lock:
            p = bool(p)
            changed = (p != self.paused)
            if not p and self.paused:
                self.last_wall = time.time()  # reset so paused time doesn't accrue
            else:
                self.advance()
            self.paused = p
            # PLAY/PAUSE CATCHER — log the toggle + instant causal microstructure at the
            # cursor. Only on a real state change (button + spacebar both route here via
            # /api/control), so we capture every user toggle exactly once.
            if changed:
                self._log_play_pause("pause" if p else "play")

    def jump(self, seconds):
        """Fast-forward replay clock by `seconds` (replay time)."""
        with self.lock:
            if self.ended:
                return
            self.advance()
            self.replay_now_ns += int(seconds * 1e9)
            last_ns = int(TS[self.end_idx - 1])
            if self.replay_now_ns >= last_ns:
                self.replay_now_ns = last_ns
            target = int(np.searchsorted(TS[self.start_idx:self.end_idx],
                                         self.replay_now_ns, side="right")) + self.start_idx
            target = min(target, self.end_idx)
            if target > self.cursor:
                if self.position is None and self.pending is None:
                    self.cursor = target
                else:
                    self._walk(target)
            if self.cursor >= self.end_idx:
                self._end_session()

    def jump_to_close(self):
        """Advance the replay clock to second :59.000 of the CURRENT forming
        1-minute bar (or the NEXT minute's :59 if already at/past :59), then
        pause so the trader lands right at the decision moment. Pending orders
        and open positions resolve honestly through the skipped ticks (same
        engine as jump). No-lookahead preserved: the cursor only moves up to
        the new replay_now (first tick strictly after :59)."""
        with self.lock:
            if self.ended:
                return
            self.advance()
            # Minute/second boundaries align between UTC and ET (ET offset is a
            # whole number of hours), so we can floor in UTC ns directly.
            NS_MIN = 60_000_000_000
            NS_SEC = 1_000_000_000
            minute_start = (self.replay_now_ns // NS_MIN) * NS_MIN
            target_ns = minute_start + 59 * NS_SEC
            if target_ns <= self.replay_now_ns:
                target_ns += NS_MIN  # already at/past :59 → next minute's :59
            last_ns = int(TS[self.end_idx - 1])
            ended_at_target = target_ns >= last_ns
            if ended_at_target:
                target_ns = last_ns
            self.replay_now_ns = target_ns
            target = int(np.searchsorted(TS[self.start_idx:self.end_idx],
                                         self.replay_now_ns, side="right")) + self.start_idx
            target = min(target, self.end_idx)
            if target > self.cursor:
                if self.position is None and self.pending is None:
                    self.cursor = target
                else:
                    self._walk(target)
            if self.cursor >= self.end_idx:
                self._end_session()
                return
            # Pause on arrival; reset the wall clock so the paused gap doesn't
            # accrue and snap the tape forward on the next play.
            self.paused = True
            self.last_wall = time.time()

    def _commit_bar(self, c, bucket, acc):
        """Seal one accumulator into a committed bar (disp prices, round 2dp)."""
        o = round(self.disp_px(acc["o"]), 2); cl = round(self.disp_px(acc["c"]), 2)
        h = round(self.disp_px(acc["h"]), 2); l = round(self.disp_px(acc["l"]), 2)
        vol = int(acc["vol"])
        c["bars"].append({"time": int(bucket), "open": o, "high": h, "low": l,
                          "close": cl, "volume": vol})
        c["times"].append(int(bucket))

    def _ensure_bars(self, tf_sec):
        """Bring the tf cache up to `cursor`, processing only NEW ticks. Bars build
        from view_start_idx (the overnight open) so the pre-09:30 context is visible;
        the upper bound is the cursor, so no post-cursor tick is ever shown."""
        c = self._bar_cache.get(tf_sec)
        if c is None or c["built_to"] > self.cursor:
            c = {"built_to": self.view_start_idx, "bars": [], "times": [],
                 "cur_bucket": None, "cur": None}
            self._bar_cache[tf_sec] = c
        lo = c["built_to"]; hi = self.cursor
        if hi <= lo:
            return c
        ts = np.asarray(TS[lo:hi], dtype=np.int64)
        px = np.asarray(PX[lo:hi], dtype=np.int64)
        sz = np.asarray(SZ[lo:hi], dtype=np.int64)
        et = pd.DatetimeIndex(pd.to_datetime(ts, utc=True)).tz_convert(ET)
        sec = (et.hour * 3600 + et.minute * 60 + et.second).to_numpy().astype(np.int64)
        base_norm = pd.Timestamp(self.session_start_ns, tz="UTC").tz_convert(ET).normalize()
        day_off = (et.normalize() - base_norm).days.to_numpy().astype(np.int64)
        synth = SYNTH_BASE + sec + day_off * 86400
        bucket = ((synth // tf_sec) * tf_sec).astype(np.int64)
        cur_bucket = c["cur_bucket"]; cur = c["cur"]
        bk_l = bucket.tolist(); px_l = px.tolist(); sz_l = sz.tolist()
        for i in range(len(bk_l)):
            b = bk_l[i]; p = px_l[i]; z = sz_l[i]
            if cur_bucket is None:
                cur_bucket = b; cur = {"o": p, "h": p, "l": p, "c": p, "vol": z}
            elif b == cur_bucket:
                if p > cur["h"]: cur["h"] = p
                if p < cur["l"]: cur["l"] = p
                cur["c"] = p; cur["vol"] += z
            else:
                self._commit_bar(c, cur_bucket, cur)
                cur_bucket = b; cur = {"o": p, "h": p, "l": p, "c": p, "vol": z}
        c["cur_bucket"] = cur_bucket; c["cur"] = cur
        c["built_to"] = hi
        return c

    # ---- bar building (no lookahead: ticks[start:cursor] only) ----
    def build_bars(self, tf_sec, since_synth=None):
        with self.lock:
            c = self._ensure_bars(tf_sec)
            committed_times = c["times"]
            forming_bar = None
            if c["cur"] is not None:
                acc = c["cur"]; bk = int(c["cur_bucket"])
                o = round(self.disp_px(acc["o"]), 2); cl = round(self.disp_px(acc["c"]), 2)
                h = round(self.disp_px(acc["h"]), 2); l = round(self.disp_px(acc["l"]), 2)
                forming_bar = {"time": bk, "open": o, "high": h, "low": l,
                               "close": cl, "volume": int(acc["vol"])}
            lo_i = 0 if since_synth is None else bisect.bisect_left(committed_times, since_synth)
            bars = c["bars"][lo_i:]
            if forming_bar is not None and (since_synth is None or forming_bar["time"] >= since_synth):
                bars = bars + [forming_bar]
            return bars

    # ---- ZigZag++ (MT4-style alternating swings) ----
    def zigzag(self, tf_sec, depth, deviation_tk, backstep):
        """MT4-style ZigZag++ pivots over the DISPLAYED-TF bars up to the cursor —
        CAUSAL (only bars before the cursor) and blinded (display-offset prices). Each
        pivot is labeled HH/HL/LH/LL vs the prior SAME-type pivot (the Pine nowPoint
        logic). The last leg repaints as price extends (expected). Reuses build_bars,
        so it respects the 5s/1m TF toggle and the incremental bar cache."""
        bars = self.build_bars(tf_sec)
        if len(bars) < int(depth) + 1:
            return []
        highs = [b["high"] for b in bars]
        lows = [b["low"] for b in bars]
        times = [b["time"] for b in bars]
        dev_pts = max(0.0, float(deviation_tk)) * TICK_SIZE   # Deviation: ticks -> points
        piv = _mt4_zigzag(highs, lows, int(depth), dev_pts, int(backstep))
        out = []
        last_h = None
        last_l = None
        for (i, price, typ) in piv:
            if typ == "H":
                label = "HH" if (last_h is None or price > last_h) else "LH"
                last_h = price
                side = "high"
            else:
                label = "LL" if (last_l is None or price < last_l) else "HL"
                last_l = price
                side = "low"
            out.append({"t": int(times[i]), "price": round(price, 2),
                        "type": side, "label": label})
        return out

    # ---- ICT/TJR detection bars + structure/setup engine ----
    def _detect_bars(self, lo_idx, hi_idx, tf_sec):
        """OHLC bars (DISPLAY points, so overlays align with the chart) over ticks
        [lo_idx, hi_idx) for the ICT engine. Each bar carries its last print's real
        ns + tick index (so a setup maps back to a cursor position) and ET minute-of-
        day (killzone gating). Vectorized groupby — fast enough for a full-session
        scan. NO-LOOKAHEAD is the caller's responsibility (pass hi_idx = cursor for
        the live overlay, end_idx only for the jump-to-setup index)."""
        if hi_idx <= lo_idx:
            return []
        ts = np.asarray(TS[lo_idx:hi_idx], dtype=np.int64)
        px = np.asarray(PX[lo_idx:hi_idx], dtype=np.int64)
        et = pd.DatetimeIndex(pd.to_datetime(ts, utc=True)).tz_convert(ET)
        sec = (et.hour * 3600 + et.minute * 60 + et.second).to_numpy().astype(np.int64)
        base_norm = pd.Timestamp(self.session_start_ns, tz="UTC").tz_convert(ET).normalize()
        day_off = (et.normalize() - base_norm).days.to_numpy().astype(np.int64)
        synth = SYNTH_BASE + sec + day_off * 86400
        bucket = (synth // tf_sec) * tf_sec
        df = pd.DataFrame({"bk": bucket, "px": px, "ts": ts, "mod": sec // 60,
                           "idx": np.arange(lo_idx, hi_idx, dtype=np.int64)})
        g = df.groupby("bk", sort=True)
        o = g["px"].first(); h = g["px"].max(); l = g["px"].min(); c = g["px"].last()
        lastns = g["ts"].last(); lastidx = g["idx"].last(); firstmod = g["mod"].first()
        out = []
        for bk in o.index:
            out.append({"t": int(bk),
                        "o": round(self.disp_px(int(o[bk])), 2),
                        "h": round(self.disp_px(int(h[bk])), 2),
                        "l": round(self.disp_px(int(l[bk])), 2),
                        "c": round(self.disp_px(int(c[bk])), 2),
                        "ns": int(lastns[bk]), "idx": int(lastidx[bk]),
                        "mod": int(firstmod[bk])})
        return out

    def setups(self):
        """Full-session TJR setup table (cached). Intentionally scans the whole RTH
        session — this is a jump-to-setup navigation index, not a live signal. The
        heavy scan runs WITHOUT the session lock (it only reads immutable session
        bounds / offset) so it can't stall the tape; only the cache write is locked."""
        if self._setups_cache is not None:
            return self._setups_cache
        tf = ict_engine.ICT_PARAMS["detection_tf_sec"]
        bars = self._detect_bars(self.start_idx, self.end_idx, tf)
        res = ict_engine.find_setups(bars)
        with self.lock:
            if self._setups_cache is None:
                self._setups_cache = res
            return self._setups_cache

    # ---- liquidity pools (labeled levels + touch navigation) ----
    def _range_hl(self, lo, hi):
        """(high, low) integer real ticks of PX over [lo, hi), or None if empty.
        Caller guarantees no-lookahead by passing hi <= cursor (overlay) or a fixed
        past frontier (frozen pools / touch index)."""
        lo = max(0, int(lo)); hi = int(hi)
        if hi <= lo:
            return None
        seg = np.asarray(PX[lo:hi], dtype=np.int64)
        return int(seg.max()), int(seg.min())

    def _or_end_idx(self):
        """Tick index of the 10:00 ET opening-range close for this session (cached).
        Minute boundaries align UTC↔ET so a direct searchsorted on TS is exact."""
        if self._or_end is None:
            e = pd.Timestamp(f"{self._hidden_date} 10:00:00", tz=ET)
            self._or_end = int(np.searchsorted(TS, int(e.value), side="left"))
        return self._or_end

    def _static_pools(self):
        """Date-anchored fixed pools — prior-day high/low (PDH/PDL), two more recent
        dailies, and prior-week high/low (PWH/PWL). All formed BEFORE the session, so
        they are valid (causal) from the first RTH tick. Cached; integer real ticks +
        formed_idx = rth open. Empty list if this session has no prior data in cache."""
        if self._pools_static_cache is not None:
            return self._pools_static_cache
        pools = []
        names = [("PDH", "PDL"), ("2D H", "2D L"), ("3D H", "3D L")]
        for k, ps in enumerate(_prior_rth_sessions(self._hidden_date, 3)):
            hl = self._range_hl(int(ps["rth_start"]), int(ps["rth_end"]))
            if hl is None:
                continue
            hi, lo = hl
            hn, ln = names[k] if k < len(names) else (f"{k + 1}D H", f"{k + 1}D L")
            pools.append({"px_real": hi, "label": hn, "cat": "daily", "side": "high", "prio": 1})
            pools.append({"px_real": lo, "label": ln, "cat": "daily", "side": "low", "prio": 1})
        pw = _prior_week_range(self._hidden_date)
        if pw is not None:
            pools.append({"px_real": pw[0], "label": "PWH", "cat": "weekly", "side": "high", "prio": 2})
            pools.append({"px_real": pw[1], "label": "PWL", "cat": "weekly", "side": "low", "prio": 2})
        for p in pools:
            p["formed_idx"] = self.rth_start_idx
        self._pools_static_cache = pools
        return pools

    @staticmethod
    def _merge_levels(raw):
        """Collapse near-coincident levels (within ~2 ticks) into ONE labeled level,
        keeping the most-significant (lowest-prio) category/side and joining the tags
        with '·' (e.g. ORH·HOD when the opening-range high == the session high). Keeps
        the level list short and the labels non-overlapping. `raw` rows are
        [disp_price, label, cat, side, prio]."""
        raw.sort(key=lambda r: (r[4], r[0]))     # most-significant first, then price
        tol = 2 * TICK_SIZE
        groups = []
        for price, label, cat, side, prio in raw:
            g = next((x for x in groups if abs(price - x["price"]) <= tol), None)
            if g is None:
                groups.append({"price": price, "labels": [label], "cat": cat, "side": side})
            elif label not in g["labels"]:
                g["labels"].append(label)               # major label stays first (prio-sorted)
        return [{"price": g["price"], "label": "·".join(g["labels"]),
                 "cat": g["cat"], "side": g["side"]} for g in groups]

    def liquidity_levels(self):
        """MAIN labeled liquidity pools as of the cursor — CAUSAL (formed only from
        ticks at/before the cursor). The major structural/session levels traders watch:
        PDH/PDL (+ recent dailies), PWH/PWL, overnight ONH/ONL (frozen at the 09:30
        open), opening-range ORH/ORL (running until 10:00), and the running session
        HOD/LOD. Minor per-swing-pivot / equal-high-low pools are intentionally NOT
        included (too noisy). Prices are DISPLAY points; near-coincident levels merge."""
        with self.lock:
            cur = self.cursor
            ro = self.rth_start_idx
            raw = []

            def add(px_real, label, cat, side, prio):
                raw.append([round(self.disp_px(px_real), 2), label, cat, side, prio])

            for p in self._static_pools():
                add(p["px_real"], p["label"], p["cat"], p["side"], p["prio"])
            # overnight (Globex lead-in .. 09:30) — frozen at the open once reached
            hl = self._range_hl(self.view_start_idx, min(cur, ro))
            if hl:
                add(hl[0], "ONH", "overnight", "high", 3); add(hl[1], "ONL", "overnight", "low", 3)
            if cur > ro:
                # opening range 09:30–10:00 (running until 10:00, then frozen)
                hl = self._range_hl(ro, min(cur, self._or_end_idx()))
                if hl:
                    add(hl[0], "ORH", "or", "high", 4); add(hl[1], "ORL", "or", "low", 4)
                # running session high/low of day
                hl = self._range_hl(ro, cur)
                if hl:
                    add(hl[0], "HOD", "rth", "high", 7); add(hl[1], "LOD", "rth", "low", 7)
            return self._merge_levels(raw)

    def _all_pools_for_touch(self):
        """The MAIN pools for the full-session touch index, in integer real ticks with
        a `formed_idx` (first tick the level is real). Fixed dailies/weekly + overnight
        + opening-range only — the same reduced set as the chart overlay, so ◀/▶ Touch
        steps through ~10-40 meaningful touches, not the ~1,800 swing/EQ noise. Running
        session HOD/LOD is excluded (price is always at its own running extreme)."""
        pools = list(self._static_pools())
        ro = self.rth_start_idx
        hl = self._range_hl(self.view_start_idx, ro)   # overnight frozen at the open
        if hl:
            pools.append({"px_real": hl[0], "label": "ONH", "cat": "overnight", "side": "high", "prio": 3, "formed_idx": ro})
            pools.append({"px_real": hl[1], "label": "ONL", "cat": "overnight", "side": "low", "prio": 3, "formed_idx": ro})
        oe = min(self._or_end_idx(), self.end_idx)      # opening range frozen at 10:00
        hl = self._range_hl(ro, oe)
        if hl and oe > ro:
            pools.append({"px_real": hl[0], "label": "ORH", "cat": "or", "side": "high", "prio": 4, "formed_idx": oe})
            pools.append({"px_real": hl[1], "label": "ORL", "cat": "or", "side": "low", "prio": 4, "formed_idx": oe})
        for p in pools:
            p.setdefault("formed_idx", self.rth_start_idx)
        return pools

    def _raw_touches(self):
        """TF-independent chronological index of every MAIN-pool touch (cached). A touch
        = a maximal run of ticks within LIQ_TOUCH_TK of a pool (each distinct approach is
        one touch; a pool only generates touches at/after its formation tick, so it is
        causal); repeat touches of the same pool within LIQ_TOUCH_COOLDOWN_NS collapse,
        and near-coincident touches of different pools merge (keeping the major label).
        `seek_ns` is the EXACT touch moment. RSI confluence is applied later, per TF."""
        if self._raw_touches_cache is not None:
            return self._raw_touches_cache
        a0 = self.rth_start_idx
        end = self.end_idx
        events = []
        for p in self._all_pools_for_touch():
            lo = max(int(p["formed_idx"]), a0)
            if lo >= end:
                continue
            seg = np.asarray(PX[lo:end], dtype=np.int64)
            inz = np.abs(seg - p["px_real"]) <= LIQ_TOUCH_TK
            if not inz.any():
                continue
            prev = np.concatenate(([False], inz[:-1]))
            starts = np.flatnonzero(inz & ~prev)        # rising edges = run starts = touches
            kept_ns = -(1 << 62)
            for s in starts.tolist():
                gi = lo + int(s)
                ns = int(TS[gi])
                if ns - kept_ns < LIQ_TOUCH_COOLDOWN_NS:   # collapse chop at the same level
                    continue
                kept_ns = ns
                events.append({"idx": gi, "ns": ns,
                               "t": self.synth_time(int(TS[gi])),
                               "label": p["label"], "cat": p["cat"], "side": p["side"],
                               "price": round(self.disp_px(p["px_real"]), 2),
                               "prio": p["prio"]})
        events.sort(key=lambda e: e["ns"])
        deduped = []
        for e in events:
            hit = None
            for d in reversed(deduped[-8:]):
                if abs(e["ns"] - d["ns"]) <= 30_000_000_000 and abs(e["price"] - d["price"]) <= 0.75:
                    hit = d; break
            if hit is None:
                deduped.append(e)
            elif e["prio"] < hit["prio"]:
                hit.update({"label": e["label"], "cat": e["cat"], "side": e["side"],
                            "prio": e["prio"], "price": e["price"]})
        for e in deduped:
            e["seek_ns"] = e["ns"]        # seek to the EXACT moment of the touch
            e.pop("prio", None)
        self._raw_touches_cache = deduped
        return deduped

    def _tf_closes(self, tf_sec):
        """(end_ns[], close[]) bars at tf_sec over [view_start_idx, end_idx] — the same
        bucketing the chart uses, so server RSI matches the displayed RSI. Closes are
        raw integer ticks (RSI is invariant to the affine display transform)."""
        lo = self.view_start_idx
        hi = self.end_idx
        if hi <= lo:
            return np.array([], dtype=np.int64), np.array([], dtype=np.float64)
        ts = np.asarray(TS[lo:hi], dtype=np.int64)
        px = np.asarray(PX[lo:hi], dtype=np.int64)
        et = pd.DatetimeIndex(pd.to_datetime(ts, utc=True)).tz_convert(ET)
        sec = (et.hour * 3600 + et.minute * 60 + et.second).to_numpy().astype(np.int64)
        base_norm = pd.Timestamp(self.session_start_ns, tz="UTC").tz_convert(ET).normalize()
        day_off = (et.normalize() - base_norm).days.to_numpy().astype(np.int64)
        synth = SYNTH_BASE + sec + day_off * 86400
        bucket = (synth // tf_sec) * tf_sec
        df = pd.DataFrame({"bk": bucket, "px": px, "ts": ts})
        g = df.groupby("bk", sort=True)
        closes = g["px"].last().to_numpy().astype(np.float64)
        end_ns = g["ts"].last().to_numpy().astype(np.int64)
        return end_ns, closes

    def _rsi_series(self, tf_sec):
        """(end_ns[], rsi[]) full-session Wilder RSI(LIQ_RSI_PERIOD) at tf_sec, cached."""
        cached = self._rsi_cache.get(tf_sec)
        if cached is not None:
            return cached
        end_ns, closes = self._tf_closes(tf_sec)
        rsi = _wilder_rsi(closes, LIQ_RSI_PERIOD)
        self._rsi_cache[tf_sec] = (end_ns, rsi)
        return end_ns, rsi

    def touches(self, tf_sec):
        """MAIN-pool touches surfaced ONLY when RSI(14) at `tf_sec` confluences with the
        touch: RSI must reach overbought (>=LIQ_RSI_OB) or oversold (<=LIQ_RSI_OS) within
        ±LIQ_RSI_WINDOW_NS of the touch (already there at the touch, or hits within 5 min
        after). Each kept touch is tagged `rsi` = OB / OS / OB+OS. Cached per TF."""
        cached = self._touches_cache.get(tf_sec)
        if cached is not None:
            return cached
        raw = self._raw_touches()
        end_ns, rsi = self._rsi_series(tf_sec)
        win = LIQ_RSI_WINDOW_NS
        out = []
        if len(end_ns):
            for e in raw:
                t = e["ns"]
                a = int(np.searchsorted(end_ns, t - win, side="left"))
                b = int(np.searchsorted(end_ns, t + win, side="right"))
                if b <= a:
                    continue
                seg = rsi[a:b]
                seg = seg[~np.isnan(seg)]
                if not seg.size:
                    continue
                ob = bool(seg.max() >= LIQ_RSI_OB)
                os_ = bool(seg.min() <= LIQ_RSI_OS)
                if ob or os_:
                    ev = dict(e)
                    ev["rsi"] = "OB+OS" if (ob and os_) else ("OB" if ob else "OS")
                    out.append(ev)
        with self.lock:
            self._touches_cache[tf_sec] = out
        return out

    def _detect_bar_view(self, bk, cur):
        return {"t": int(bk), "o": round(self.disp_px(cur["o"]), 2),
                "h": round(self.disp_px(cur["h"]), 2), "l": round(self.disp_px(cur["l"]), 2),
                "c": round(self.disp_px(cur["c"]), 2), "ns": int(cur["ns"]),
                "idx": int(cur["idx"]), "mod": int(cur["mod"])}

    def _ensure_detect_bars(self, tf_sec):
        """Incremental detection-bar cache (RTH-anchored, with ns/idx/mod) — processes
        only NEW ticks [built_to, cursor) per call so the live overlay is cheap. Mirrors
        _ensure_bars; reset if the cursor rewinds."""
        c = self._detect_cache
        if c is None or c.get("tf") != tf_sec or c["built_to"] > self.cursor:
            c = {"tf": tf_sec, "built_to": self.start_idx, "bars": [], "cur_bk": None, "cur": None}
            self._detect_cache = c
        lo = c["built_to"]; hi = self.cursor
        if hi <= lo:
            return c
        ts = np.asarray(TS[lo:hi], dtype=np.int64)
        px = np.asarray(PX[lo:hi], dtype=np.int64)
        et = pd.DatetimeIndex(pd.to_datetime(ts, utc=True)).tz_convert(ET)
        sec = (et.hour * 3600 + et.minute * 60 + et.second).to_numpy().astype(np.int64)
        base_norm = pd.Timestamp(self.session_start_ns, tz="UTC").tz_convert(ET).normalize()
        day_off = (et.normalize() - base_norm).days.to_numpy().astype(np.int64)
        synth = SYNTH_BASE + sec + day_off * 86400
        bucket = ((synth // tf_sec) * tf_sec).tolist()
        px_l = px.tolist(); ts_l = ts.tolist(); mod_l = (sec // 60).tolist()
        cur_bk = c["cur_bk"]; cur = c["cur"]
        for k in range(len(bucket)):
            b = bucket[k]; p = px_l[k]
            if cur_bk is None or b != cur_bk:
                if cur_bk is not None:
                    c["bars"].append(self._detect_bar_view(cur_bk, cur))
                cur_bk = b
                cur = {"o": p, "h": p, "l": p, "c": p, "ns": ts_l[k], "idx": lo + k, "mod": mod_l[k]}
            else:
                if p > cur["h"]: cur["h"] = p
                if p < cur["l"]: cur["l"] = p
                cur["c"] = p; cur["ns"] = ts_l[k]; cur["idx"] = lo + k
        c["cur_bk"] = cur_bk; c["cur"] = cur; c["built_to"] = hi
        return c

    def active_structures(self):
        """Currently-relevant FVG/IFVG/BOS/MSS/sweep overlays as of the cursor —
        CAUSAL (bars only up to the cursor); mitigated/stale structures are dropped."""
        with self.lock:
            tf = ict_engine.ICT_PARAMS["detection_tf_sec"]
            c = self._ensure_detect_bars(tf)
            bars = list(c["bars"])
            if c["cur"] is not None:
                bars.append(self._detect_bar_view(c["cur_bk"], c["cur"]))
            cur_t = self.synth_time(int(TS[max(self.start_idx, self.cursor - 1)]))
            return ict_engine.active_structures(bars, cur_t)

    def _near_setup(self):
        """True if the cursor's replay time is within ±_setup_gate_sec of a setup."""
        cur_t = self.synth_time(self.replay_now_ns)
        return any(abs(cur_t - su["t"]) <= self._setup_gate_sec for su in self.setups())

    def goto_ns(self, target_ns):
        """Jump the replay clock to a target tick ns (a setup's bar), resolving any
        open position honestly through the skipped ticks, then pause. FORWARD jumps
        resolve open positions honestly; BACKWARD jumps (setup review) rewind the
        cursor only when FLAT and re-hide future bars (caches rebuild) — never a
        look-ahead. A backward jump with a live position is refused."""
        with self.lock:
            if self.ended:
                return
            self.advance()
            target_ns = int(target_ns)
            last_ns = int(TS[self.end_idx - 1])
            target_ns = min(target_ns, last_ns)
            target = int(np.searchsorted(TS[self.start_idx:self.end_idx],
                                         target_ns, side="right")) + self.start_idx
            target = max(self.start_idx + 1, min(target, self.end_idx))
            if target > self.cursor:
                # FORWARD: resolve any open position honestly through the skipped ticks
                self.replay_now_ns = target_ns
                if self.position is None and self.pending is None:
                    self.cursor = target
                else:
                    self._walk(target)
            elif target < self.cursor:
                # BACKWARD (setup review): rewind only when FLAT — re-hide future bars;
                # the bar/footprint/detect/VWAP caches all auto-rebuild when cursor <
                # built_to. A live position/pending can't be rewound, so refuse it.
                if self.position is not None or self.pending is not None:
                    self.paused = True
                    self.last_wall = time.time()
                    return
                self.cursor = target
                self.replay_now_ns = target_ns
            if self.cursor >= self.end_idx:
                self._end_session()
                return
            self.paused = True
            self.last_wall = time.time()

    # ---- footprint building (no lookahead: ticks[start:cursor] only) ----
    def _ensure_footprint(self, tf_sec):
        """Bring the tf footprint cache up to `cursor`, processing only NEW ticks.

        Mirrors _ensure_bars exactly (same bucket math) but aggregates per
        (bucket, price_tick) buy/sell volume from SIDE. Committed buckets are
        sealed into c['fp'][bucket] = {price_tick: [buy, sell]}; the forming
        bucket lives in c['cur'] until a later tick rolls into a new bucket."""
        c = self._fp_cache.get(tf_sec)
        if c is None or c["built_to"] > self.cursor:
            c = {"built_to": self.start_idx, "fp": {}, "order": [],
                 "cur_bucket": None, "cur": None}
            self._fp_cache[tf_sec] = c
        lo = c["built_to"]; hi = self.cursor
        if hi <= lo:
            return c
        ts = np.asarray(TS[lo:hi], dtype=np.int64)
        px = np.asarray(PX[lo:hi], dtype=np.int64)
        sz = np.asarray(SZ[lo:hi], dtype=np.int64)
        sd = (np.asarray(SIDE[lo:hi], dtype=np.int64) if SIDE is not None
              else np.zeros(hi - lo, dtype=np.int64))
        et = pd.DatetimeIndex(pd.to_datetime(ts, utc=True)).tz_convert(ET)
        sec = (et.hour * 3600 + et.minute * 60 + et.second).to_numpy().astype(np.int64)
        base_norm = pd.Timestamp(self.session_start_ns, tz="UTC").tz_convert(ET).normalize()
        day_off = (et.normalize() - base_norm).days.to_numpy().astype(np.int64)
        synth = SYNTH_BASE + sec + day_off * 86400
        bucket = ((synth // tf_sec) * tf_sec).astype(np.int64)
        cur_bucket = c["cur_bucket"]; cur = c["cur"]
        bk_l = bucket.tolist(); px_l = px.tolist(); sz_l = sz.tolist(); sd_l = sd.tolist()
        for i in range(len(bk_l)):
            b = bk_l[i]; p = px_l[i]; z = sz_l[i]; d = sd_l[i]
            if cur_bucket is None or b != cur_bucket:
                if cur_bucket is not None:
                    c["fp"][cur_bucket] = cur; c["order"].append(cur_bucket)
                cur_bucket = b; cur = {}
            cell = cur.get(p)
            if cell is None:
                cell = [0, 0]; cur[p] = cell
            if d > 0:
                cell[0] += z
            elif d < 0:
                cell[1] += z
        c["cur_bucket"] = cur_bucket; c["cur"] = cur
        c["built_to"] = hi
        return c

    def _fp_bar_view(self, bucket, cells):
        """Serialize one bucket's {price_tick:[buy,sell]} into a client cell list
        with display prices, POC (max-total-volume level) and net delta."""
        out = []
        poc_p = None; poc_v = -1; delta = 0
        for pt, (bv, sv) in cells.items():
            tot = bv + sv
            delta += bv - sv
            if tot > poc_v:
                poc_v = tot; poc_p = pt
            out.append({"p": round(self.disp_px(pt), 2), "b": int(bv), "s": int(sv)})
        out.sort(key=lambda x: x["p"])
        return {"time": int(bucket),
                "poc": None if poc_p is None else round(self.disp_px(poc_p), 2),
                "delta": int(delta), "cells": out}

    def build_footprint(self, tf_sec, from_synth=None, to_synth=None):
        """Return footprint bars for buckets in [from_synth, to_synth] (inclusive),
        including the still-forming bucket. Visible-range only: the client passes
        the chart's visible time window so we never serialize the whole session."""
        with self.lock:
            c = self._ensure_footprint(tf_sec)
            order = c["order"]
            lo_i = 0 if from_synth is None else bisect.bisect_left(order, int(from_synth))
            hi_i = len(order) if to_synth is None else bisect.bisect_right(order, int(to_synth))
            out = [self._fp_bar_view(bk, c["fp"][bk]) for bk in order[lo_i:hi_i]]
            if c["cur"] is not None and c["cur_bucket"] is not None:
                fb = int(c["cur_bucket"])
                if (from_synth is None or fb >= int(from_synth)) and \
                   (to_synth is None or fb <= int(to_synth)):
                    out.append(self._fp_bar_view(fb, c["cur"]))
            return out

    # ---- volume profile (no lookahead: reuses footprint cells) ----
    def build_volume_profile(self, tf_sec, from_synth=None, to_synth=None,
                             rows=0, va_pct=70.0):
        """Aggregate buy/sell volume by price across [from_synth, to_synth].
        Reuses the footprint cache (display prices, no-lookahead). Returns
        per-level rows plus POC and value-area (VAH/VAL) bounds. Optional
        row-binning collapses the per-0.25 levels into `rows` price buckets."""
        fp = self.build_footprint(tf_sec, from_synth=from_synth, to_synth=to_synth)
        buy = {}
        sell = {}
        for b in fp:
            for c in b.get("cells", []):
                p = round(float(c["p"]), 2)
                buy[p] = buy.get(p, 0) + int(c["b"])
                sell[p] = sell.get(p, 0) + int(c["s"])
        prices = sorted(set(buy) | set(sell))
        if not prices:
            return {"levels": [], "poc": None, "vah": None, "val": None,
                    "total": 0, "price_hi": None, "price_lo": None}
        levels = [{"p": p, "b": buy.get(p, 0), "s": sell.get(p, 0),
                   "v": buy.get(p, 0) + sell.get(p, 0)} for p in prices]
        # optional binning into `rows` even price buckets for a cleaner profile
        if rows and rows > 0 and len(levels) > rows:
            lo = prices[0]
            hi = prices[-1]
            span = hi - lo
            bin_sz = span / rows if span > 0 else TICK_SIZE
            binned = {}
            for lv in levels:
                k = int((lv["p"] - lo) / bin_sz) if bin_sz > 0 else 0
                if k >= rows:
                    k = rows - 1
                d = binned.setdefault(k, {"b": 0, "s": 0, "v": 0})
                d["b"] += lv["b"]
                d["s"] += lv["s"]
                d["v"] += lv["v"]
            levels = []
            for k in sorted(binned):
                d = binned[k]
                levels.append({"p": round(lo + (k + 0.5) * bin_sz, 2),
                               "b": d["b"], "s": d["s"], "v": d["v"]})
        total = sum(lv["v"] for lv in levels)
        poc_i = max(range(len(levels)), key=lambda i: levels[i]["v"])
        poc = levels[poc_i]["p"]
        # value area: expand around the POC, always taking the heavier neighbor,
        # until cumulative volume reaches va_pct of the total.
        target = total * (va_pct / 100.0)
        lo_i = hi_i = poc_i
        acc = levels[poc_i]["v"]
        while acc < target and (lo_i > 0 or hi_i < len(levels) - 1):
            up = levels[hi_i + 1]["v"] if hi_i < len(levels) - 1 else -1
            dn = levels[lo_i - 1]["v"] if lo_i > 0 else -1
            if up >= dn:
                hi_i += 1
                acc += max(up, 0)
            else:
                lo_i -= 1
                acc += max(dn, 0)
        val = levels[lo_i]["p"]
        vah = levels[hi_i]["p"]
        return {"levels": levels, "poc": poc, "vah": vah, "val": val,
                "total": total, "price_hi": prices[-1], "price_lo": prices[0]}

    # ---- snapshot for the client ----
    def snapshot(self, flow=False, heat=False, vwap=False, tape=False):
        with self.lock:
            cur = self._cur_price()
            open_pnl = None; pos_view = None
            if self.position is not None:
                p = self.position
                pnl_ticks = (cur - p["entry_px"]) * p["side"]
                open_pnl = round(pnl_ticks * TICK_VALUE * p.get("cmult", self.cmult) * p["size"], 2)
                trail_disp = (None if not p.get("trail_armed") or p.get("trail_stop") is None
                              else round(self.disp_px(p["trail_stop"]), 2))
                pos_view = {
                    "side": "LONG" if p["side"] == 1 else "SHORT", "size": p["size"],
                    "entry": round(self.disp_px(p["entry_px"]), 2),
                    # synth time of the fill — left edge of the SL/TP trade box (the box
                    # grows from here to the live bar and freezes at close).
                    "entry_synth": self.synth_time(p["entry_ns"]),
                    "stop": None if p["stop"] is None else round(self.disp_px(p["stop"]), 2),
                    "target": None if p["target"] is None else round(self.disp_px(p["target"]), 2),
                    "stop_tk": p.get("stop_tk"), "target_tk": p.get("target_tk"),
                    "trail_tk": p.get("trail_tk"), "arm_tk": p.get("arm_tk"),
                    "trail_armed": bool(p.get("trail_armed")),
                    "trail_stop": trail_disp,
                    "mfe": round(p["mfe"], 1), "mae": round(p["mae"], 1),
                    "open_pnl": open_pnl, "open_pnl_ticks": round(pnl_ticks, 1),
                }
            pct = 0.0
            span = self.end_idx - self.start_idx
            if span > 0:
                pct = round(100.0 * (self.cursor - self.start_idx) / span, 1)
            snap = {
                "session_id": self.id, "mode": self.mode, "ended": self.ended,
                "paused": self.paused, "speed": self.speed, "slip_tk": self.slip_tk,
                "et_clock": self.et_clock(self.replay_now_ns),
                "cur_price": round(self.disp_px(cur), 2),
                "progress_pct": pct,
                "pending": (self.pending is not None),
                "instrument": self.instrument,
                "tick_value": round(TICK_VALUE * self.cmult, 4),
                "position": pos_view, "stats": self.stats(),
                "flow_thresh": FLOW_THRESH,
                "open_heat_quiet": OPEN_HEAT_QUIET, "open_heat_hot": OPEN_HEAT_HOT,
                "tape_vr_fade": TAPE_VR_FADE, "tape_vr_trend": TAPE_VR_TREND,
                "setup_only": self.setup_only,
                # EXACT cursor synth time (not bucketed) — lets the client match the
                # current jump-to-setup index precisely (setup.t is a 1-min bucket).
                "cursor_synth": self.synth_time(self.replay_now_ns),
            }
            # FLOW LIGHT readout — only when the client asks (toggle ON), so the
            # searchsorted+dot is skipped entirely when the study is OFF.
            if flow:
                snap["flow_delta_60s"] = self._flow_delta(self.cursor, self.replay_now_ns)
            # OPEN HEAT readout — same gating: computed only when the study is ON.
            if heat:
                snap["open5m_range"] = self._open5m_range(self.cursor, self.replay_now_ns)
            # VWAP readout — same gating: incremental, computed only when ON.
            if vwap:
                snap["vwap"] = self._vwap(self.cursor)
            # TAPE REGIME readout — same gating: VR computed only when ON.
            if tape:
                snap["tape_vr"] = self._tape_vr(self.cursor, self.replay_now_ns)
            # DATE REVEAL — when explicitly enabled (env/CLI) OR for a REVIEW session
            # (date-loaded, e.g. the loser navigator, where the user already knows the
            # day). Random sessions stay blinded by default.
            if REVEAL_DATE or self._review:
                snap["session_date"] = self._hidden_date
            return snap

    def stats(self):
        trades = self.trades
        n = len(trades)
        wins = [t for t in trades if t["pnl_net"] > 0]
        losses = [t for t in trades if t["pnl_net"] <= 0]
        net = sum(t["pnl_net"] for t in trades)
        coin_net = sum(t["coinflip_ev_net"] for t in trades)
        gp = sum(t["pnl_net"] for t in wins)
        gl = -sum(t["pnl_net"] for t in losses)
        # max drawdown on cumulative net equity
        eq = 0.0; peak = 0.0; mdd = 0.0
        for t in trades:
            eq += t["pnl_net"]; peak = max(peak, eq); mdd = min(mdd, eq - peak)
        return {
            "n": n,
            "wr": round(100.0 * len(wins) / n, 1) if n else 0.0,
            "net": round(net, 2),
            "expectancy": round(net / n, 2) if n else 0.0,
            # JSON has no Infinity literal; emit None for "wins, no losses" (the UI
            # renders it as "—"). Returning float("inf") here serializes as the
            # invalid token `Infinity`, which throws in the client's r.json() and
            # silently freezes the poll loop.
            "pf": round(gp / gl, 2) if gl > 0 else None,
            "avg_win": round(gp / len(wins), 2) if wins else 0.0,
            "avg_loss": round(-gl / len(losses), 2) if losses else 0.0,
            "max_dd": round(mdd, 2),
            "coinflip_net": round(coin_net, 2),
            "coinflip_exp": round(coin_net / n, 2) if n else 0.0,
            "edge_vs_coin": round((net - coin_net) / n, 2) if n else 0.0,
            # 3-layer decomposition (expectancy = day + selection + direction).
            # DAY      = random-time coin EV/trade (what a coin-flip earns at
            #            random RTH times this day with the same brackets).
            # SELECTION= at-moment coin EV - random-time coin EV (timing skill:
            #            picking better-than-random entry moments).
            # DIRECTION= expectancy - at-moment coin EV (= edge_vs_coin; the long
            #            vs short call on top of the coin-flip). Exact.
            # None until every trade carries a random_time_ev_net (legacy guard).
            **self._decomp(trades, n, net, coin_net),
        }

    @staticmethod
    def _decomp(trades, n, net, coin_net):
        if not n or any("random_time_ev_net" not in t for t in trades):
            return {"day_baseline": None, "selection_skill": None,
                    "direction_skill": round((net - coin_net) / n, 2) if n else None}
        rt_net = sum(t["random_time_ev_net"] for t in trades)
        day = rt_net / n
        selection = (coin_net - rt_net) / n
        direction = (net - coin_net) / n
        return {"day_baseline": round(day, 2),
                "selection_skill": round(selection, 2),
                "direction_skill": round(direction, 2)}

    # ---- logging ----
    def _log_event(self, kind, **kw):
        kw["kind"] = kind; kw["wall"] = time.time()
        self.events.append(kw)

    def _write_csv_header(self):
        with open(self._csv_path, "w", newline="") as f:
            csv.writer(f).writerow(CSV_HEADER)

    def _append_trade_csv(self, t):
        # Self-heal: re-emit header if the CSV is missing/empty.
        if (not self._csv_path.exists()) or self._csv_path.stat().st_size == 0:
            self._write_csv_header()
        with open(self._csv_path, "a", newline="") as f:
            w = csv.writer(f)
            w.writerow([t["order_id"], t["side"], t["size"], t["entry_et"], t["exit_et"],
                        t["entry_px_disp"], t["exit_px_disp"], t["exit_reason"],
                        t["pnl_ticks"], t["pnl_net"], t["mfe_ticks"], t["mae_ticks"],
                        t["hold_s"], t.get("stop_tk"), t.get("target_tk"),
                        t.get("trail_tk"), t.get("arm_tk"),
                        t["coinflip_ev_net"], t.get("random_time_ev_net"),
                        t.get("instrument"), t.get("flow_delta_entry"),
                        t.get("tape_vr_entry")])

    def _persist_json(self):
        # Always stamp the (frozen-if-past-09:35) opening-range width into the
        # persisted stats for forward validation — independent of the study toggle.
        st = self.stats()
        st["open5m_range"] = self._open5m_range(self.cursor, self.replay_now_ns)
        data = {"session_id": self.id, "mode": self.mode, "ended": self.ended,
                "stats": st, "trades": self.trades,
                "play_pause_events": self.play_pause_events,
                "hidden_date_sha": secrets.token_hex(0)}  # date intentionally omitted
        with open(self._json_path, "w") as f:
            json.dump(data, f, indent=2)

    def _maybe_post_discord(self):
        """Post this session's scoreboard to Discord ONCE, iff it had >=1 trade and
        hasn't been posted yet. Idempotent via self.posted, so calling it from both
        _end_session and the new-session abandon path can never double-post. The
        actual network call is fire-and-forget; this only computes stats + sets the
        flag under the lock (RLock -> safe to re-enter from _end_session)."""
        with self.lock:
            if self.posted:
                return
            st = self.stats()
            if st.get("n", 0) < 1:
                return
            self.posted = True
        _post_discord_async(self.id, st)

    def reveal(self):
        """Only called on explicit session end — reveals the hidden date."""
        return {"date": self._hidden_date, "px_offset_ticks": self.px_offset}


# ── Flask app ────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder=None)
STATE = {"session": None}
STATE_LOCK = threading.Lock()


def _sess():
    return STATE["session"]


@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/static/<path:p>")
def static_files(p):
    return send_from_directory(STATIC, p)


@app.route("/api/new_session", methods=["POST"])
def new_session():
    body = request.get_json(silent=True) or {}
    mode = body.get("mode", "rth")
    slip = body.get("slip_tk", DEFAULT_SLIP_TK)
    # REVIEW MODE: an explicit `date` loads that specific market day (loser navigator).
    # Validate it is in the cache; otherwise the loser-nav has nothing to show.
    date = body.get("date")
    if date is not None and date not in _SESS_BY_DATE:
        return jsonify({"ok": False, "err": f"date {date} not in tick cache"})
    with STATE_LOCK:
        prev = STATE["session"]
        if prev is not None:
            # abandon-by-starting-new: post the outgoing session's card once (>=1 trade)
            try:
                prev._maybe_post_discord()
            except Exception:
                pass
        s = ReplaySession(mode=mode, slip_tk=slip, date=date)
        # Instrument continuity: an explicit body param wins; otherwise carry the
        # PREVIOUS session's choice forward. Guarantees a new session never silently
        # resets micro->mini, so what the UI shows is always what the engine bills.
        instr = body.get("instrument")
        if instr is None and prev is not None:
            instr = prev.instrument
        if instr:
            s.set_instrument(instr)
        STATE["session"] = s
    return jsonify({"ok": True, **s.snapshot()})


def _want_flow():
    """True when the client has the Flow study ON (gates the snapshot delta calc)."""
    return request.args.get("flow") in ("1", "true", "True")


def _want_heat():
    """True when the client has the Open Heat study ON (gates the range calc)."""
    return request.args.get("heat") in ("1", "true", "True")


def _want_vwap():
    """True when the client has the VWAP study ON (gates the snapshot VWAP calc)."""
    return request.args.get("vwap") in ("1", "true", "True")


def _want_tape():
    """True when the client has the Tape Regime study ON (gates the VR calc)."""
    return request.args.get("tape") in ("1", "true", "True")


@app.route("/api/state")
def state():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    return jsonify({"ok": True, **s.snapshot(flow=_want_flow(), heat=_want_heat(),
                                             vwap=_want_vwap(), tape=_want_tape())})


@app.route("/api/bars")
def bars():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    tf = request.args.get("tf", "5s")
    tf_sec = _tf_sec(tf)
    since = request.args.get("since")
    since_v = None if since in (None, "", "null") else int(float(since))
    bars_ = s.build_bars(tf_sec, since_synth=since_v)
    return jsonify({"ok": True, "tf": tf, "bars": bars_,
                    **s.snapshot(flow=_want_flow(), heat=_want_heat(), vwap=_want_vwap(),
                                 tape=_want_tape())})


@app.route("/api/footprint")
def footprint():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    if SIDE is None:
        return jsonify({"ok": False, "err": "no side data"})
    s.advance()
    tf = request.args.get("tf", "5s")
    tf_sec = _tf_sec(tf)
    fr = request.args.get("from"); to = request.args.get("to")
    fr_v = None if fr in (None, "", "null") else int(float(fr))
    to_v = None if to in (None, "", "null") else int(float(to))
    fp = s.build_footprint(tf_sec, from_synth=fr_v, to_synth=to_v)
    return jsonify({"ok": True, "tf": tf, "fp": fp})


@app.route("/api/volprofile")
def volprofile():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    if SIDE is None:
        return jsonify({"ok": False, "err": "no side data"})
    s.advance()
    tf = request.args.get("tf", "5s")
    tf_sec = _tf_sec(tf)
    fr = request.args.get("from")
    to = request.args.get("to")
    fr_v = None if fr in (None, "", "null") else int(float(fr))
    to_v = None if to in (None, "", "null") else int(float(to))
    rows = int(float(request.args.get("rows", 0) or 0))
    va = float(request.args.get("va", 70) or 70)
    vp = s.build_volume_profile(tf_sec, from_synth=fr_v, to_synth=to_v,
                                rows=rows, va_pct=va)
    return jsonify({"ok": True, "tf": tf, **vp})


@app.route("/api/setups")
def setups():
    """Full-session TJR setup table for jump-to-setup navigation (synth time + the
    real ns to jump to + the FVG entry zone + direction)."""
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    return jsonify({"ok": True, "setups": s.setups(),
                    "detection_tf": ict_engine.ICT_PARAMS["detection_tf_sec"]})


@app.route("/api/structures")
def structures():
    """Currently-active ICT structures (FVG/IFVG/BOS/MSS/sweep) as of the cursor —
    causal, mitigated/stale ones dropped. Gated client-side by the overlay toggle."""
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    return jsonify({"ok": True, "structures": s.active_structures()})


@app.route("/api/levels")
def levels():
    """All causal liquidity-pool levels as of the cursor (PDH/PDL/ONH/ONL/ORH/ORL/
    PWH/PWL/HOD/LOD/swing/EQ), labeled. Gated client-side by the Liquidity overlay."""
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    return jsonify({"ok": True, "levels": s.liquidity_levels()})


@app.route("/api/zigzag")
def zigzag_api():
    """MT4-style ZigZag++ pivots as of the cursor (causal, display prices), with HH/HL/
    LH/LL labels. Depth/Deviation(ticks)/Backstep + tf are client-passed. Gated client-
    side by the ZigZag++ overlay toggle."""
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    tf = request.args.get("tf", "5s")

    def _iarg(name, default):
        try:
            return max(1, int(float(request.args.get(name, default))))
        except (TypeError, ValueError):
            return default

    depth = _iarg("depth", ZZ_DEPTH)
    dev = _iarg("dev", ZZ_DEVIATION_TK)
    back = _iarg("back", ZZ_BACKSTEP)
    return jsonify({"ok": True, "tf": tf, "pivots": s.zigzag(_tf_sec(tf), depth, dev, back),
                    "depth": depth, "dev": dev, "back": back})


@app.route("/api/play_pause")
def play_pause_api():
    """The session's play/pause catcher events (toggles + instant microstructure), for
    the on-chart pause markers and later analysis. Causal/blinded; persisted in the
    session JSON too."""
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    return jsonify({"ok": True, "events": s.play_pause_events})


# ── TEMPORARY: RSI(15)+Bollinger open-fade LOSER REVIEW navigator ──────────────
# Serves rsibb_losers.json (a static list of losing trades) so the client loser-nav
# can step through each loser's market day. Remove this route + rsibb_losers.json +
# the client "RSI+BB Losers" study when the review is done.
RSIBB_LOSERS_FILE = HERE / "rsibb_losers.json"


@app.route("/api/rsibb_losers")
def rsibb_losers_api():
    """Temporary: the list of RSI+BB losing trades for the loser-review navigator.
    Each: {date, entry_ns, entry_et, min_after_930, side, pnl}."""
    try:
        losers = json.loads(RSIBB_LOSERS_FILE.read_text(encoding="utf-8"))
    except Exception as e:   # noqa: BLE001 — feature is inert if the file is missing
        return jsonify({"ok": False, "err": f"rsibb_losers.json unreadable: {e!r}", "losers": []})
    return jsonify({"ok": True, "losers": losers})


@app.route("/api/touches")
def touches_api():
    """RSI-confluence liquidity-touch index for the navigator (filtered to touches where
    RSI(14) on the requested TF hits >=70 or <=30 within ±5 min). Each touch's `seek_ns`
    is the EXACT touch moment. The RSI filter is TF-dependent, so the client passes tf."""
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    tf = request.args.get("tf", "5s")
    return jsonify({"ok": True, "touches": s.touches(_tf_sec(tf)), "tf": tf,
                    "rsi_ob": LIQ_RSI_OB, "rsi_os": LIQ_RSI_OS,
                    "rsi_window_sec": LIQ_RSI_WINDOW_NS // 1_000_000_000})


@app.route("/api/control", methods=["POST"])
def control():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    b = request.get_json(silent=True) or {}
    act = b.get("action")
    if act == "pause":
        s.set_paused(True)
    elif act == "play":
        s.set_paused(False)
    elif act == "speed":
        s.set_speed(b.get("speed", 1.0))
    elif act == "jump":
        s.jump(float(b.get("seconds", 300)))
    elif act == "to_close":
        s.jump_to_close()
    elif act == "goto":
        s.goto_ns(b.get("ns", 0))                 # jump-to-setup (ns of the setup bar)
    elif act == "setup_only":
        s.setup_only = bool(b.get("on"))          # only allow entry near a TJR setup
    elif act == "instrument":
        s.set_instrument(b.get("instrument", "mini"))
    return jsonify({"ok": True, **s.snapshot()})


@app.route("/api/order", methods=["POST"])
def order():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    b = request.get_json(silent=True) or {}
    side = 1 if b.get("side") == "buy" else -1
    r = s.place_market(side, b.get("size", 1),
                       b.get("stop_tk"), b.get("target_tk"),
                       b.get("trail_tk"), b.get("arm_tk"))
    return jsonify({**r, **s.snapshot()})


@app.route("/api/modify", methods=["POST"])
def modify():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    b = request.get_json(silent=True) or {}
    r = s.modify(b.get("stop_tk", "__keep__"), b.get("target_tk", "__keep__"),
                 b.get("trail_tk", "__keep__"), b.get("arm_tk", "__keep__"))
    return jsonify({**r, **s.snapshot()})


@app.route("/api/flatten", methods=["POST"])
def flatten():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    r = s.flatten()
    return jsonify({**r, **s.snapshot()})


@app.route("/api/end_session", methods=["POST"])
def end_session():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    with s.lock:
        s._end_session()
        rv = s.reveal()
    return jsonify({"ok": True, "reveal": rv, **s.snapshot()})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5056)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--reveal-date", action="store_true",
                    help="expose the session's real calendar date (news trading; default OFF)")
    args = ap.parse_args()
    global REVEAL_DATE
    if args.reveal_date:
        REVEAL_DATE = True
    print(f"[replay_trader] http://{args.host}:{args.port}  reveal_date={REVEAL_DATE}")
    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
