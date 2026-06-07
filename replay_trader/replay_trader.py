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
TICK_VALUE = 5.0           # $ per tick per contract (NQ)
COMMISSION_RT = 4.20       # $ round-trip per contract
DEFAULT_SLIP_TK = 1        # adverse slip ticks on market / stop fills

# Neutral synthetic date so the x-axis shows real ET time-of-day but NO real date.
SYNTH_BASE = 1577836800    # 2020-01-01 00:00:00 UTC (epoch seconds)

CSV_HEADER = ["order_id", "side", "size", "entry_et", "exit_et",
              "entry_px_disp", "exit_px_disp", "exit_reason",
              "pnl_ticks", "pnl_net", "mfe_ticks", "mae_ticks",
              "hold_s", "stop_tk", "target_tk", "trail_tk", "arm_tk",
              "coinflip_ev_net", "random_time_ev_net", "instrument"]

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
        self.instrument = "mini"   # "mini" (NQ) or "micro" (MNQ)
        self.cmult = 1.0           # micro = 0.1 (10 micros = 1 mini)

        sess = secrets.choice(GOOD_SESSIONS)
        self._hidden_date = sess["date"]  # NEVER sent to client
        if mode == "full":
            self.start_idx = int(sess["full_start"]); self.end_idx = int(sess["full_end"])
        else:
            self.start_idx = int(sess["rth_start"]); self.end_idx = int(sess["rth_end"])

        # blinding price offset (integer ticks). Keeps prices positive & plausible.
        self.px_offset = int(secrets.randbelow(16001) - 8000)  # +-2000 points

        self.cursor = self.start_idx + 1        # first tick is "seen" to seed a price
        self.replay_now_ns = int(TS[self.start_idx])
        self.session_start_ns = int(TS[self.start_idx])
        self.speed = 1.0
        self.paused = True
        self.ended = False
        self.last_wall = time.time()

        # trading state
        self.position = None        # dict or None
        self.pending = None         # market order awaiting next-print fill
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
            self.cmult = 0.1 if name == "micro" else 1.0
        return {"instrument": self.instrument}

    def _close(self, i, exit_px, ns, reason):
        pos = self.position; self.position = None
        side = pos["side"]; size = pos["size"]
        pnl_ticks = (exit_px - pos["entry_px"]) * side
        gross = pnl_ticks * TICK_VALUE * self.cmult * size
        net = gross - COMMISSION_RT * self.cmult * size
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
            "instrument": self.instrument,
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
                            tick_value=TICK_VALUE * self.cmult,
                            commission=COMMISSION_RT * self.cmult)

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
                                    tick_value=TICK_VALUE * self.cmult,
                                    commission=COMMISSION_RT * self.cmult))
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
                          "close": cl, "volume": vol})
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
    def snapshot(self):
        with self.lock:
            cur = self._cur_price()
            open_pnl = None; pos_view = None
            if self.position is not None:
                p = self.position
                pnl_ticks = (cur - p["entry_px"]) * p["side"]
                open_pnl = round(pnl_ticks * TICK_VALUE * self.cmult * p["size"], 2)
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
            return {
                "session_id": self.id, "mode": self.mode, "ended": self.ended,
                "paused": self.paused, "speed": self.speed, "slip_tk": self.slip_tk,
                "et_clock": self.et_clock(self.replay_now_ns),
                "cur_price": round(self.disp_px(cur), 2),
                "progress_pct": pct,
                "pending": (self.pending is not None),
                "instrument": self.instrument,
                "tick_value": round(TICK_VALUE * self.cmult, 4),
                "position": pos_view, "stats": self.stats(),
            }

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
                        t.get("instrument")])

    def _persist_json(self):
        data = {"session_id": self.id, "mode": self.mode, "ended": self.ended,
                "stats": self.stats(), "trades": self.trades,
                "hidden_date_sha": secrets.token_hex(0)}  # date intentionally omitted
        with open(self._json_path, "w") as f:
            json.dump(data, f, indent=2)

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
        STATE["session"] = ReplaySession(mode=mode, slip_tk=slip)
        s = STATE["session"]
    return jsonify({"ok": True, **s.snapshot()})


@app.route("/api/state")
def state():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    return jsonify({"ok": True, **s.snapshot()})


@app.route("/api/bars")
def bars():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    s.advance()
    tf = request.args.get("tf", "5s")
    tf_sec = 5 if tf == "5s" else 60
    since = request.args.get("since")
    since_v = None if since in (None, "", "null") else int(float(since))
    bars_ = s.build_bars(tf_sec, since_synth=since_v)
    return jsonify({"ok": True, "tf": tf, "bars": bars_, **s.snapshot()})


@app.route("/api/footprint")
def footprint():
    s = _sess()
    if s is None:
        return jsonify({"ok": False, "err": "no session"})
    if SIDE is None:
        return jsonify({"ok": False, "err": "no side data"})
    s.advance()
    tf = request.args.get("tf", "5s")
    tf_sec = 5 if tf == "5s" else 60
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
    tf_sec = 5 if tf == "5s" else 60
    fr = request.args.get("from")
    to = request.args.get("to")
    fr_v = None if fr in (None, "", "null") else int(float(fr))
    to_v = None if to in (None, "", "null") else int(float(to))
    rows = int(float(request.args.get("rows", 0) or 0))
    va = float(request.args.get("va", 70) or 70)
    vp = s.build_volume_profile(tf_sec, from_synth=fr_v, to_synth=to_v,
                                rows=rows, va_pct=va)
    return jsonify({"ok": True, "tf": tf, **vp})


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
