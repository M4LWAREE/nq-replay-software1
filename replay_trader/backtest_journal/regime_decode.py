#!/usr/bin/env python3
"""
regime_decode.py — exact session regime from the NQ tick cache.

Mirrors tradedb/src/tradedb/regime.py so the backtest journal labels each session
with a precise regime instead of a direction_skill heuristic. The replay tool
blinds the date, but every trade carries `entry_idx` into the shared tick cache;
session_index.json maps that index → the real date, from which we read the real
first-hour range and RTH close direction (the range is offset-invariant).

Classification (KB "06 - Position Sizing & Risk" buckets), ATR = mean of prior N
sessions' first-hour ranges:
    ratio = first_hour_range / ATR_baseline
    ratio < 0.5  -> range-chop ; ratio > 1.5 -> high-vol
    else         -> trend-up (RTH close >= open) | trend-down (close < open)
Earliest cached session (no prior ATR) -> "untagged"; caller may set an override
from rth_close_dir.

Requires numpy + the tick cache. Degrades to "untagged" if either is missing, so
the loader still runs without the cache.
"""
import bisect, json, os
from datetime import datetime, time
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
SESSION_INDEX = os.path.join(REPO, "replay_trader", "session_index.json")
CACHE = os.path.join(REPO, "tick_engine", "cache")
TICK_SIZE = 0.25
ATR_LOOKBACK, CHOP_RATIO, HIGHVOL_RATIO = 14, 0.5, 1.5
_RTH_OPEN, _FH_END = time(9, 30), time(10, 30)

_np = None
_idx = _ts = _px = _baseline = None


def _lazy():
    global _np, _idx, _ts, _px
    if _np is not None or _idx is not None:
        return
    try:
        import numpy as np
        _np = np
    except Exception:
        _np = None
    if os.path.exists(SESSION_INDEX):
        _idx = sorted(json.load(open(SESSION_INDEX))["sessions"], key=lambda s: s["full_start"])
    else:
        _idx = []
    if _np is not None and os.path.isdir(CACHE):
        tp, pp = os.path.join(CACHE, "nq_ticks_ts.npy"), os.path.join(CACHE, "nq_ticks_px.npy")
        _ts = _np.load(tp, mmap_mode="r") if os.path.exists(tp) else None
        _px = _np.load(pp, mmap_mode="r") if os.path.exists(pp) else None


def available():
    _lazy()
    return bool(_idx) and _ts is not None and _px is not None


def _et_ns(ds, t):
    y, m, d = (int(x) for x in ds.split("-"))
    return int(datetime(y, m, d, t.hour, t.minute, tzinfo=ET).timestamp() * 1e9)


def _fh_range(s):
    if _ts is None or _px is None or s["rth_ticks"] <= 0:
        return None
    rs, re = s["rth_start"], s["rth_end"]
    seg = _np.asarray(_ts[rs:re])
    lo = int(_np.searchsorted(seg, _et_ns(s["date"], _RTH_OPEN), "left"))
    hi = int(_np.searchsorted(seg, _et_ns(s["date"], _FH_END), "left"))
    if hi <= lo:
        return None
    sp = _np.asarray(_px[rs + lo:rs + hi])
    return float(sp.max() - sp.min()) * TICK_SIZE if sp.size else None


def _close_dir(s):
    if _px is None or s["rth_ticks"] <= 0:
        return None
    rs, re = s["rth_start"], s["rth_end"]
    return 1 if float(_px[re - 1]) >= float(_px[rs]) else -1


def _build_baseline():
    global _baseline
    if _baseline is not None:
        return _baseline
    out = []
    for s in sorted(_idx, key=lambda x: x["date"]):
        if s["rth_ticks"] < 5000:
            continue
        v = _fh_range(s)
        if v is not None:
            out.append((s["date"], v))
    _baseline = out
    return out


def _atr(ds):
    prior = [v for d, v in _build_baseline() if d < ds]
    if not prior:
        return None
    w = prior[-ATR_LOOKBACK:]
    return float(sum(w) / len(w)) if w else None


def _decode(entry_idx):
    starts = [s["full_start"] for s in _idx]
    p = bisect.bisect_right(starts, entry_idx) - 1
    if 0 <= p < len(_idx) and _idx[p]["full_start"] <= entry_idx < _idx[p]["full_end"]:
        return _idx[p]
    return None


def regime_for_entry_idx(entry_idx):
    """Return dict(regime, ratio, close_dir, date, first_hour_pts, suggested_override)."""
    blank = {"regime": "untagged", "ratio": None, "close_dir": None,
             "date": None, "first_hour_pts": None, "suggested_override": ""}
    _lazy()
    if entry_idx is None or not available():
        return blank
    s = _decode(int(entry_idx))
    if s is None:
        return blank
    fh = _fh_range(s)
    atr = _atr(s["date"])
    cd = _close_dir(s)
    ratio = (fh / atr) if (fh is not None and atr not in (None, 0)) else None
    if ratio is None:
        regime = "untagged"
    elif ratio < CHOP_RATIO:
        regime = "range-chop"
    elif ratio > HIGHVOL_RATIO:
        regime = "high-vol"
    else:
        regime = "trend-up" if (cd or 0) >= 0 else "trend-down"
    override = ""
    if regime == "untagged" and cd is not None:
        override = "trend-up" if cd >= 0 else "trend-down"
    return {"regime": regime, "ratio": round(ratio, 3) if ratio else None,
            "close_dir": cd, "date": s["date"], "first_hour_pts": round(fh, 2) if fh else None,
            "suggested_override": override}


if __name__ == "__main__":
    import sys
    print(json.dumps(regime_for_entry_idx(int(sys.argv[1])), indent=2))
