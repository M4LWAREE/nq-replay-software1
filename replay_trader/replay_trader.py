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
import subprocess
import sys
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

# PROP CHALLENGE — Topstep-style 50K combine, per session, OFF by default.
# One replay session = one challenge attempt. Classic ruleset (current firm
# specs may have drifted — tune here, ONE place):
#   • trailing Maximum Loss Limit: fail when EQUITY (balance + open P&L,
#     marked on every print — real-time, Topstep-style) touches
#     (equity high-water mark − mll); the level LOCKS once it reaches
#     start_balance + mll_lock_offset and never trails further.
#   • profit target: REALIZED balance >= start_balance + profit_target = PASSED
#     (frozen — he may keep trading, the result never un-passes).
#   • scaling cap: max position size per order (50K tier: 5 minis / 50 micros).
#   • NO consistency rule (explicit request).
# Fail = flatten at market through the normal honest fill path (adverse slip),
# cancel pending, block further entries. All logging is additive-only.
PROP_CHALLENGE = {
    "start_balance": 50_000.0,
    "mll": 2_000.0,              # trailing Maximum Loss Limit ($ below equity HWM)
    "profit_target": 3_000.0,    # realized $ above start_balance -> PASSED
    "mll_lock_offset": 100.0,    # MLL stops trailing at start_balance + this ($50,100)
    "size_cap": {"mini": 5, "micro": 50},
}

# Neutral synthetic date so the x-axis shows real ET time-of-day but NO real date.
SYNTH_BASE = 1577836800    # 2020-01-01 00:00:00 UTC (epoch seconds)

CSV_HEADER = ["order_id", "side", "size", "entry_et", "exit_et",
              "entry_px_disp", "exit_px_disp", "exit_reason",
              "pnl_ticks", "pnl_net", "mfe_ticks", "mae_ticks",
              "hold_s", "stop_tk", "target_tk", "trail_tk", "arm_tk",
              "coinflip_ev_net", "random_time_ev_net", "instrument",
              "flow_delta_entry"]

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

# Supported chart timeframes -> bucket seconds. Single source of truth for tf
# parsing across /api/bars, /api/footprint, /api/volprofile. The incremental
# bar/footprint caches are keyed by these tf_sec values, so adding a row here is
# all it takes to support a new TF. Unknown labels fall back to 5s.
TF_SECONDS = {"5s": 5, "30s": 30, "1m": 60, "5m": 300, "15m": 900}


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

# Master on/off switch for Discord auto-posting. Flip to True to re-enable
# (a configured discord_webhook.txt is still required). OFF = no session ever
# posts to Discord, regardless of the webhook file. Everything else on the
# session-end path (journal ingest, CSV/JSON persistence) is unaffected.
DISCORD_ENABLED = False


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
    if not DISCORD_ENABLED:
        return   # auto-posting disabled via the master switch — no network attempt
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


# ── Backtest Journal auto-ingest ─────────────────────────────────────────────
# On session end, append the session into the Obsidian Backtest Journal by
# invoking the (idempotent) loader as a fire-and-forget subprocess. The loader
# reads sessions/<id>.json (already persisted by _persist_json), decodes the
# exact regime, appends to trades.ndjson + writes a session note, and PRESERVES
# any hand annotations. Never blocks or crashes the engine.
_JOURNAL_LOADER = HERE / "backtest_journal" / "load_backtest_journal.py"


def _journal_session_async(session_id):
    if not _JOURNAL_LOADER.exists():
        return  # journal not installed — silently inert
    def _worker():
        try:
            r = subprocess.run(
                [sys.executable, str(_JOURNAL_LOADER), session_id, "--seed"],
                cwd=str(_JOURNAL_LOADER.parent),
                capture_output=True, text=True, timeout=180)
            tag = "OK" if r.returncode == 0 else f"rc={r.returncode}"
            print(f"[replay_trader] journal {tag} for {session_id}: "
                  f"{(r.stdout or r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr).strip() else ''}",
                  flush=True)
        except Exception as e:   # noqa: BLE001 — never let journaling crash anything
            print(f"[replay_trader] journal FAILED for {session_id}: {e!r}", flush=True)
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


def _profile_stats(levels, rows, va_pct):
    """Shared volume-profile maths: optional row-binning + POC + value area.
    `levels` = [{"p","b","s","v"}, ...] sorted by price ascending; NOT mutated
    (the prev-day cache passes its long-lived list through here)."""
    prices = [lv["p"] for lv in levels]
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


# ── the replay session ───────────────────────────────────────────────────────
class ReplaySession:
    """Server-authoritative replay state. One active session at a time.

    The replay clock advances lazily: each time _advance() runs it moves
    replay_now_ns forward by (wall_elapsed * speed), then walks ticks up to the
    new clock. While flat the cursor jumps directly (cheap); while a position or
    pending order exists the engine walks tick-by-tick so stops/targets resolve
    in true print order (honest fills).
    """

    def __init__(self, mode="rth", slip_tk=DEFAULT_SLIP_TK):
        self.lock = threading.RLock()
        self.id = datetime.now().strftime("%Y%m%d_%H%M%S_") + secrets.token_hex(3)
        self.mode = mode
        self.slip_tk = int(slip_tk)
        self.instrument = "mini"   # "mini" (NQ) or "micro" (MNQ); new_session may carry over
        self.cmult, self.comm_rt = _instr_econ("mini")

        sess = secrets.choice(GOOD_SESSIONS)
        self._hidden_date = sess["date"]  # NEVER sent to client
        if mode == "full":
            self.start_idx = int(sess["full_start"]); self.end_idx = int(sess["full_end"])
        else:
            self.start_idx = int(sess["rth_start"]); self.end_idx = int(sess["rth_end"])

        # PREVIOUS RTH day's tick window (prior-day value context for the
        # volume profile). Resolved by position in the date-sorted index so
        # only the window INDICES are kept — the prev date itself is never
        # stored or sent (blinding holds; profile prices get the same display
        # offset as everything else). None on the dataset's first day.
        self._prev_win = None
        di = next((i for i, x in enumerate(ALL_SESSIONS)
                   if x["date"] == sess["date"]), None)
        if di is not None and di > 0:
            prv = ALL_SESSIONS[di - 1]
            a, b = int(prv["rth_start"]), int(prv["rth_end"])
            if b > a:
                self._prev_win = (a, b)
        self._prev_levels = None    # lazy native-resolution profile cache

        # blinding price offset (integer ticks). Keeps prices positive & plausible.
        self.px_offset = int(secrets.randbelow(16001) - 8000)  # +-2000 points

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
        self._vwap_p2 = 0.0   # Σpx²·sz — powers the VWAP σ bands (same incremental rules)
        self.speed = 1.0
        self.paused = True
        self.ended = False
        self.posted = False         # Discord scoreboard posted? (prevents double-post)
        self.journaled = False      # appended to Backtest Journal? (prevents double-ingest)
        self.last_wall = time.time()

        # trading state
        self.position = None        # dict or None
        self.pending = None         # market order awaiting next-print fill

        # prop-challenge state (None unless enabled via enable_challenge)
        self.challenge = False
        self.ch = None
        self.next_order_id = 1
        self.trades = []            # closed trades (each a dict)
        self.events = []            # raw order/fill log rows

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
        carried in self._vwap_pv / _vwap_v / _vwap_p2 and only NEW ticks
        [built_to, hi_idx) are added each call — never a rescan. NO LOOKAHEAD:
        hi_idx is the cursor, so only ticks strictly before it contribute.
        Returns (vwap_display_points, sd_points) where sd is the volume-weighted
        std-dev of price around VWAP (powers the DeepCharts-style σ bands; an
        offset-free WIDTH, so no px_offset applied), or (None, None) before the
        anchor / with no volume. Cheap: two dots + one sum over new ticks per call."""
        if self._vwap_anchor is None:
            win_s, _ = self._open_window_ns()
            a = int(np.searchsorted(TS[self.start_idx:self.end_idx], win_s, side="left")) + self.start_idx
            self._vwap_anchor = max(a, self.start_idx)
            self._vwap_built_to = self._vwap_anchor
        anchor = self._vwap_anchor
        if hi_idx <= anchor:
            return None, None
        bt = self._vwap_built_to
        # cursor went backwards (shouldn't in normal flow) -> restart from anchor
        if hi_idx < bt:
            self._vwap_pv = 0.0; self._vwap_v = 0.0; self._vwap_p2 = 0.0; bt = anchor
        if bt < anchor:
            bt = anchor
        if hi_idx > bt:
            seg_px = np.asarray(PX[bt:hi_idx], dtype=np.float64)
            seg_sz = np.asarray(SZ[bt:hi_idx], dtype=np.float64)
            self._vwap_pv += float(np.dot(seg_px, seg_sz))
            self._vwap_v += float(seg_sz.sum())
            self._vwap_p2 += float(np.dot(seg_px * seg_px, seg_sz))
            bt = hi_idx
        self._vwap_built_to = bt
        if self._vwap_v <= 0:
            return None, None
        mean = self._vwap_pv / self._vwap_v
        var = max(self._vwap_p2 / self._vwap_v - mean * mean, 0.0)
        sd_pts = round((var ** 0.5) * TICK_SIZE, 2)
        return round(self.disp_px(mean), 2), sd_pts

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
        # prop challenge: REAL-TIME equity mark + MLL check on every surviving
        # print (protective exits, being resting orders, resolve first; a
        # closed trade is re-checked on the realized side in _ch_on_close)
        if self.challenge:
            self._ch_tick(i, px, ns)

    def set_instrument(self, name):
        name = "micro" if str(name).lower().startswith("micro") else "mini"
        with self.lock:
            self.instrument = name
            self.cmult, self.comm_rt = _instr_econ(name)
        return {"instrument": self.instrument}

    # ---- prop challenge (Topstep-style combine; see PROP_CHALLENGE) ----
    def enable_challenge(self, on):
        """Turn challenge mode on for THIS session (set once at session start)."""
        with self.lock:
            self.challenge = bool(on)
            if self.challenge:
                start = float(PROP_CHALLENGE["start_balance"])
                self.ch = {
                    "status": "active",         # active | passed | failed
                    "balance": start,           # realized (net of commission)
                    "hwm": start,               # equity high-water mark (incl. open P&L)
                    "mll_level": start - float(PROP_CHALLENGE["mll"]),
                    "locked": False,            # MLL reached start + lock_offset
                    "peak_equity": start,
                    "max_dd_used": 0.0,         # worst equity excursion below HWM
                    "passed_at": None, "failed_at": None,
                }
                self._persist_json()            # attempt exists on disk from the start
            else:
                self.ch = None

    def _ch_unreal(self, px):
        """Open P&L in $ at integer-tick price px (gross, entry-locked econ)."""
        pos = self.position
        if pos is None:
            return 0.0
        return ((px - pos["entry_px"]) * pos["side"]
                * TICK_VALUE * pos.get("cmult", self.cmult) * pos["size"])

    def _ch_mark(self, px):
        """Mark equity at px: trail the HWM/MLL (lock at start+offset), track
        peak equity + max drawdown used. Returns equity in $."""
        ch = self.ch
        eq = ch["balance"] + self._ch_unreal(px)
        if eq > ch["hwm"]:
            ch["hwm"] = eq
            ch["peak_equity"] = eq
            cap = float(PROP_CHALLENGE["start_balance"]) + float(PROP_CHALLENGE["mll_lock_offset"])
            lvl = ch["hwm"] - float(PROP_CHALLENGE["mll"])
            if lvl >= cap:
                lvl = cap
                ch["locked"] = True
            if lvl > ch["mll_level"]:
                ch["mll_level"] = lvl       # ratchet only — never loosens
        dd = ch["hwm"] - eq
        if dd > ch["max_dd_used"]:
            ch["max_dd_used"] = dd
        return eq

    def _ch_tick(self, i, px, ns):
        """REAL-TIME MLL check on this print (Topstep-style: equity incl. open
        P&L). Touch = FAILED: flatten at market through the honest fill path
        (adverse slip), cancel pending, block further entries."""
        if not self.challenge or self.ch is None:
            return
        if self.ch["status"] != "active":
            self._ch_mark(px)               # keep peak/dd stats after pass/fail
            return
        eq = self._ch_mark(px)
        if eq <= self.ch["mll_level"] + 1e-9:
            self.ch["status"] = "failed"
            self.ch["failed_at"] = self.et_clock(ns)
            self.pending = None
            if self.position is not None:
                self._close(i, px - self.position["side"] * self.slip_tk, ns, "MLL")
            self._persist_json()

    def _ch_on_close(self, net, exit_px, ns):
        """Realized accounting after a trade closes: balance, pass check
        (frozen once reached), and the realized-side MLL check (a slipped exit
        can land the realized balance at/under the level)."""
        if not self.challenge or self.ch is None:
            return
        ch = self.ch
        ch["balance"] += net
        self._ch_mark(exit_px)              # flat now -> equity == balance
        if ch["status"] != "active":
            return
        if ch["balance"] >= float(PROP_CHALLENGE["start_balance"]) + float(PROP_CHALLENGE["profit_target"]):
            ch["status"] = "passed"
            ch["passed_at"] = self.et_clock(ns)
        elif ch["balance"] <= ch["mll_level"] + 1e-9:
            ch["status"] = "failed"
            ch["failed_at"] = self.et_clock(ns)
            self.pending = None

    def _ch_view(self, cur_px):
        """Snapshot block for the client HUD."""
        ch = self.ch
        eq = ch["balance"] + self._ch_unreal(cur_px)
        target_bal = float(PROP_CHALLENGE["start_balance"]) + float(PROP_CHALLENGE["profit_target"])
        return {
            "on": True, "status": ch["status"],
            "balance": round(ch["balance"], 2),
            "equity": round(eq, 2),
            "mll_level": round(ch["mll_level"], 2),
            "dist_mll": round(eq - ch["mll_level"], 2),
            "target_balance": round(target_bal, 2),
            "dist_target": round(target_bal - ch["balance"], 2),
            "start_balance": float(PROP_CHALLENGE["start_balance"]),
            "locked": ch["locked"],
            "peak_equity": round(ch["peak_equity"], 2),
            "max_dd_used": round(ch["max_dd_used"], 2),
            "passed_at": ch["passed_at"], "failed_at": ch["failed_at"],
            "size_cap": int(PROP_CHALLENGE["size_cap"].get(self.instrument, 5)),
        }

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
        }
        self.trades.append(tr)
        self._ch_on_close(net, exit_px, ns)   # challenge: realized balance / pass / fail
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
        self._maybe_journal()

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
            size = max(1, int(size))
            # prop challenge gates: no entries after a fail; 50K scaling cap
            if self.challenge and self.ch is not None:
                if self.ch["status"] == "failed":
                    return {"ok": False, "err": "challenge FAILED — entries blocked this session"}
                cap = int(PROP_CHALLENGE["size_cap"].get(self.instrument, 5))
                if size > cap:
                    return {"ok": False,
                            "err": f"challenge size cap: max {cap} {self.instrument}s per order"}
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
            if not p and self.paused:
                self.last_wall = time.time()  # reset so paused time doesn't accrue
            else:
                self.advance()
            self.paused = bool(p)

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
                          "close": cl, "volume": vol,
                          "delta": int(acc.get("delta", 0))})
        c["times"].append(int(bucket))

    def _ensure_bars(self, tf_sec):
        """Bring the tf cache up to `cursor`, processing only NEW ticks."""
        c = self._bar_cache.get(tf_sec)
        if c is None or c["built_to"] > self.cursor:
            c = {"built_to": self.start_idx, "bars": [], "times": [],
                 "cur_bucket": None, "cur": None}
            self._bar_cache[tf_sec] = c
        lo = c["built_to"]; hi = self.cursor
        if hi <= lo:
            return c
        ts = np.asarray(TS[lo:hi], dtype=np.int64)
        px = np.asarray(PX[lo:hi], dtype=np.int64)
        sz = np.asarray(SZ[lo:hi], dtype=np.int64)
        # per-bar signed delta (Σ side·size) — powers DeepCharts-style delta-colored
        # candles + the 1-min delta panel. Zeros when no aggressor-side data.
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
            b = bk_l[i]; p = px_l[i]; z = sz_l[i]; d = sd_l[i] * z
            if cur_bucket is None:
                cur_bucket = b; cur = {"o": p, "h": p, "l": p, "c": p, "vol": z, "delta": d}
            elif b == cur_bucket:
                if p > cur["h"]: cur["h"] = p
                if p < cur["l"]: cur["l"] = p
                cur["c"] = p; cur["vol"] += z; cur["delta"] = cur.get("delta", 0) + d
            else:
                self._commit_bar(c, cur_bucket, cur)
                cur_bucket = b; cur = {"o": p, "h": p, "l": p, "c": p, "vol": z, "delta": d}
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
                               "close": cl, "volume": int(acc["vol"]),
                               "delta": int(acc.get("delta", 0))}
            lo_i = 0 if since_synth is None else bisect.bisect_left(committed_times, since_synth)
            bars = c["bars"][lo_i:]
            if forming_bar is not None and (since_synth is None or forming_bar["time"] >= since_synth):
                bars = bars + [forming_bar]
            return bars

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
        return _profile_stats(levels, rows, va_pct)

    # ---- previous-session profile (prior-day value context) ----
    def _prev_profile_levels(self):
        """Native per-0.25 levels for the PREVIOUS RTH day (display prices,
        offset applied). Built once, lazily, from the prior day's full tape —
        static for the session's lifetime. None when there is no previous day.
        Vectorized: three bincounts over ~one day of ticks."""
        if self._prev_win is None:
            return None
        if self._prev_levels is None:
            a, b = self._prev_win
            px = np.asarray(PX[a:b], dtype=np.int64)
            sz = np.asarray(SZ[a:b], dtype=np.int64)
            sd = (np.asarray(SIDE[a:b], dtype=np.int64) if SIDE is not None
                  else np.zeros(b - a, dtype=np.int64))
            lo = int(px.min())
            n = int(px.max()) - lo + 1
            idx = px - lo
            tot = np.bincount(idx, weights=sz, minlength=n)
            buy = np.bincount(idx[sd > 0], weights=sz[sd > 0], minlength=n)
            sell = np.bincount(idx[sd < 0], weights=sz[sd < 0], minlength=n)
            self._prev_levels = [
                {"p": round(self.disp_px(lo + int(k)), 2),
                 "b": int(buy[k]), "s": int(sell[k]), "v": int(tot[k])}
                for k in np.nonzero(tot)[0]
            ]
        return self._prev_levels

    def build_prev_profile(self, rows=0, va_pct=70.0):
        """Previous RTH day's profile + POC/VAH/VAL. {'available': False} on
        the dataset's first day. No date fields — blinding holds."""
        with self.lock:
            lv = self._prev_profile_levels()
            if lv is None or not lv:
                return {"available": False}
            return {"available": True, **_profile_stats(lv, rows, va_pct)}

    # ---- snapshot for the client ----
    def snapshot(self, flow=False, heat=False, vwap=False):
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
            }
            if self.challenge and self.ch is not None:
                snap["challenge"] = self._ch_view(cur)
            # FLOW LIGHT readout — only when the client asks (toggle ON), so the
            # searchsorted+dot is skipped entirely when the study is OFF.
            if flow:
                snap["flow_delta_60s"] = self._flow_delta(self.cursor, self.replay_now_ns)
            # OPEN HEAT readout — same gating: computed only when the study is ON.
            if heat:
                snap["open5m_range"] = self._open5m_range(self.cursor, self.replay_now_ns)
            # VWAP readout — same gating: incremental, computed only when ON.
            if vwap:
                v, sd = self._vwap(self.cursor)
                snap["vwap"] = v
                snap["vwap_sd"] = sd
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
                        t.get("instrument"), t.get("flow_delta_entry")])

    def _persist_json(self):
        # Always stamp the (frozen-if-past-09:35) opening-range width into the
        # persisted stats for forward validation — independent of the study toggle.
        st = self.stats()
        st["open5m_range"] = self._open5m_range(self.cursor, self.replay_now_ns)
        data = {"session_id": self.id, "mode": self.mode, "ended": self.ended,
                "stats": st, "trades": self.trades,
                "hidden_date_sha": secrets.token_hex(0)}  # date intentionally omitted
        # prop challenge attempt result — ADDITIVE block, everything else as-is.
        # (Kept out of the per-trade CSV: a summary row would break its schema
        # and the downstream tradedb importer.)
        if self.challenge and self.ch is not None:
            result = {"active": ("INCOMPLETE" if self.ended else "ACTIVE"),
                      "passed": "PASSED", "failed": "FAILED"}[self.ch["status"]]
            data["challenge"] = {
                "result": result,
                "balance": round(self.ch["balance"], 2),
                "peak_equity": round(self.ch["peak_equity"], 2),
                "max_dd_used": round(self.ch["max_dd_used"], 2),
                "mll_level": round(self.ch["mll_level"], 2),
                "mll_locked": self.ch["locked"],
                "passed_at": self.ch["passed_at"], "failed_at": self.ch["failed_at"],
                "config": {k: v for k, v in PROP_CHALLENGE.items()},
            }
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

    def _maybe_journal(self):
        """Append this session to the Backtest Journal ONCE, iff it had >=1 trade.
        Idempotent via self.journaled AND the loader itself (re-runs never dupe —
        notes/ndjson are keyed by session_id/order_id), so the same belt-and-braces
        as _maybe_post_discord. Fire-and-forget; runs after _persist_json so the
        session JSON is on disk for the loader to read."""
        with self.lock:
            if self.journaled:
                return
            if self.stats().get("n", 0) < 1:
                return
            self.journaled = True
        _journal_session_async(self.id)

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
    with STATE_LOCK:
        prev = STATE["session"]
        if prev is not None:
            # abandon-by-starting-new: post the outgoing session's card once (>=1 trade)
            try:
                prev._maybe_post_discord()
                prev._maybe_journal()
            except Exception:
                pass
        s = ReplaySession(mode=mode, slip_tk=slip)
        # Instrument continuity: an explicit body param wins; otherwise carry the
        # PREVIOUS session's choice forward. Guarantees a new session never silently
        # resets micro->mini, so what the UI shows is always what the engine bills.
        instr = body.get("instrument")
        if instr is None and prev is not None:
            instr = prev.instrument
        if instr:
            s.set_instrument(instr)
        # prop challenge: per-session opt-in, OFF by default (client sends the
        # persisted preference; one replay session = one challenge attempt)
        if body.get("challenge"):
            s.enable_challenge(True)
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


@app.route("/api/state")
def state():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    return jsonify({"ok": True, **s.snapshot(flow=_want_flow(), heat=_want_heat(),
                                             vwap=_want_vwap())})


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
                    **s.snapshot(flow=_want_flow(), heat=_want_heat(), vwap=_want_vwap())})


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


@app.route("/api/volprofile_prev")
def volprofile_prev():
    """Previous RTH day's full profile (static per session — the client
    fetches it once). available:false when the replay day is the dataset's
    first day. Carries no date information."""
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    rows = int(float(request.args.get("rows", 0) or 0))
    va = float(request.args.get("va", 70) or 70)
    return jsonify({"ok": True, **s.build_prev_profile(rows=rows, va_pct=va)})


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
    args = ap.parse_args()
    print(f"[replay_trader] http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
