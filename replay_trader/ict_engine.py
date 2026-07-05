#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ict_engine.py — causal ICT/TJR structure detection for the replay trader.

Pure, side-effect-free detection over a list of OHLC bars. NO look-ahead is baked
into the LIVE path: the server feeds bars only up to the cursor for overlays, and
the FULL session only for the jump-to-setup table (which is intentionally a
navigation index of where setups occur).

Bar dict (built by the server, prices in DISPLAY points so overlays align with the
chart): {"t": synth_seconds, "o","h","l","c": float, "ns": int, "idx": int,
"mod": minute_of_day_ET 0..1439}.

────────────────────────────────────────────────────────────────────────────────
TUNE HERE — every rule threshold lives in ICT_PARAMS. Change these to match how you
trade; the detection functions read them and nothing else is hard-coded. The TJR
setup confluence is assembled in `find_setups` — adjust the sequence/windows there.
────────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

# Killzones as (start_minute_ET, end_minute_ET, name). Minutes since ET midnight:
# 09:30 = 570, 11:00 = 660, 02:00 = 120, 05:00 = 300, 13:30 = 810, 16:00 = 960.
KILLZONES = {
    "ny_am":   (9 * 60 + 30, 11 * 60, "NY AM"),     # default TJR window 09:30–11:00
    "london":  (2 * 60, 5 * 60, "London"),          # 02:00–05:00 ET
    "ny_pm":   (13 * 60 + 30, 16 * 60, "NY PM"),     # 13:30–16:00 ET
}

ICT_PARAMS = {
    "tick_size": 0.25,            # NQ point value of one tick
    "detection_tf_sec": 60,       # bars TF the engine runs on (1-min default)
    "swing_lookback": 2,          # bars each side for a confirmed swing pivot
    "eq_tol_ticks": 8,            # swing pivots within this many ticks = "equal" (EQH/EQL pool)
    "fvg_min_ticks": 6,           # minimum 3-candle gap size to count an FVG
    "active_killzones": ["ny_am"],   # which killzones gate the TJR setup
    "setup_window_bars": 16,      # max bars (≈min on 1m) a supporting sweep/MSS can sit
                                  #   before the FVG — wider = more candidates (TUNE HERE)
    "struct_ttl_sec": 45 * 60,    # BOS/MSS/sweep markers older than this drop off (live overlay)
    "max_active_fvgs": 8,         # cap FVG/IFVG boxes shown live (most recent kept)
    # ── candidate BREADTH (TUNE HERE) — how loose the candidate generation is.
    # "strict" = full confluence only (killzone + sweep + MSS/BOS + FVG, ~few/day,
    # A+); "normal" = any 2 of {killzone, sweep, MSS/BOS} + FVG; "broad" = any FVG
    # with at least ONE supporting event (sweep OR structure shift), killzone optional
    # (richest list for discretionary picking, ~8-15+/day). Strength is TAGGED per
    # setup (A+/A/B) regardless, so high-confluence ones stand out.
    "setup_strictness": "broad",     # "strict" | "normal" | "broad"
    # ── the ONLY hard gates applied to the broad candidate list (TUNE HERE) ───────
    "setup_min_stop_ticks": 100,  # drop a setup unless entry→stop is >= this (room to trail)
    "setup_min_target_ticks": 100,  # drop a setup unless entry→target is >= this
    "dedup_ticks": 50,            # collapse setups whose entry OR anchor level is within this …
    "dedup_window_min": 45,       # … of a prior accepted same-direction setup within this many minutes
}

# strictness -> minimum confluence score required (score = in_killzone + has_sweep +
# has_struct; a supporting structure event, sweep OR struct, is ALWAYS required).
_STRICTNESS_MIN_SCORE = {"strict": 3, "normal": 2, "broad": 1}


def _setup_grade(in_kz, has_sweep, has_struct):
    """Confluence STRENGTH tag from the factors present (FVG entry is always present).
    A+ = full confluence (killzone + sweep + MSS/BOS); A = two factors; B = one."""
    score = int(bool(in_kz)) + int(bool(has_sweep)) + int(bool(has_struct))
    if score >= 3:
        return "A+", "full confluence"
    if score == 2:
        return "A", "strong"
    return "B", "candidate"


def _killzone_for(mod, params):
    """Return the killzone NAME a minute-of-day falls in (from active_killzones), else None."""
    for key in params["active_killzones"]:
        a, b, name = KILLZONES[key]
        if a <= mod <= b:
            return name
    return None


# ── component detectors ──────────────────────────────────────────────────────
def find_fvgs(bars, params):
    """3-candle fair-value gaps + their lifecycle (touch / close-through→IFVG /
    IFVG-invalidation), all computed CAUSALLY (each lifecycle event uses only bars
    at or after formation, never before). Returns a list of fvg dicts."""
    n = len(bars)
    min_gap = params["fvg_min_ticks"] * params["tick_size"]
    out = []
    for i in range(2, n):
        c1, c3 = bars[i - 2], bars[i]
        if c1["h"] < c3["l"] and (c3["l"] - c1["h"]) >= min_gap:
            g = {"dir": "bull", "bot": c1["h"], "top": c3["l"]}
        elif c1["l"] > c3["h"] and (c1["l"] - c3["h"]) >= min_gap:
            g = {"dir": "bear", "bot": c3["h"], "top": c1["l"]}
        else:
            continue
        g.update({"i": i, "t_form": bars[i]["t"], "ns": bars[i]["ns"],
                  "idx": bars[i]["idx"], "mod": bars[i]["mod"],
                  "mit_t": None, "inv_t": None, "ifvg_mit_t": None})
        # forward lifecycle scan (causal: only bars after formation)
        for j in range(i + 1, n):
            b = bars[j]
            if g["inv_t"] is None:
                if g["dir"] == "bull":
                    if g["mit_t"] is None and b["l"] <= g["top"]:   # tapped the gap
                        g["mit_t"] = b["t"]
                    if b["c"] < g["bot"]:                           # closed THROUGH -> IFVG
                        g["inv_t"] = b["t"]
                else:
                    if g["mit_t"] is None and b["h"] >= g["bot"]:
                        g["mit_t"] = b["t"]
                    if b["c"] > g["top"]:
                        g["inv_t"] = b["t"]
            else:
                # IFVG phase: invalidated when price reclaims the far side
                if g["dir"] == "bull" and b["c"] > g["top"]:
                    g["ifvg_mit_t"] = b["t"]; break
                if g["dir"] == "bear" and b["c"] < g["bot"]:
                    g["ifvg_mit_t"] = b["t"]; break
        out.append(g)
    return out


def find_swings(bars, params):
    """Boolean pivot-high / pivot-low arrays. A pivot at i is only CONFIRMED `lb`
    bars later (it needs the right-hand bars) — callers must respect that."""
    n = len(bars)
    lb = params["swing_lookback"]
    ph = [False] * n
    pl = [False] * n
    for i in range(lb, n - lb):
        hi, lo = bars[i]["h"], bars[i]["l"]
        is_h = all(hi >= bars[i + k]["h"] for k in range(-lb, lb + 1)) and \
            any(hi > bars[i + k]["h"] for k in range(-lb, lb + 1) if k)
        is_l = all(lo <= bars[i + k]["l"] for k in range(-lb, lb + 1)) and \
            any(lo < bars[i + k]["l"] for k in range(-lb, lb + 1) if k)
        ph[i] = is_h
        pl[i] = is_l
    return ph, pl


def _cluster_equal(swings, tol, side):
    """Greedy-cluster a TIME-ORDERED list of same-kind swings into equal-high/low
    pools: any swings within `tol` (display points) of each other are one cluster.
    The pool LEVEL is the cluster extreme (highest for highs / lowest for lows —
    that is the resting-liquidity edge); the pool is only CONFIRMED (and thus only
    becomes touchable) when its SECOND member prints, so formation is causal. Each
    returned dict carries that confirmation member's t/ns/idx + a member count."""
    out = []
    used = [False] * len(swings)
    for i in range(len(swings)):
        if used[i]:
            continue
        members = [swings[i]]
        for j in range(i + 1, len(swings)):
            if used[j]:
                continue
            if abs(swings[j]["price"] - swings[i]["price"]) <= tol:
                members.append(swings[j])
                used[j] = True
        if len(members) >= 2:
            used[i] = True
            prices = [m["price"] for m in members]
            lvl = max(prices) if side == "high" else min(prices)
            conf = members[1]   # 2nd swing confirms the equal pair -> causal formation time
            out.append({"price": lvl, "t": conf["t"], "ns": conf["ns"],
                        "idx": conf["idx"], "count": len(members)})
    return out


def find_liquidity_pools(bars, params=None):
    """Resting-liquidity pools from swing structure: every CONFIRMED swing high/low
    (buy-side / sell-side liquidity) plus EQUAL-high / equal-low clusters. Causal —
    a swing at bar i is only emitted once it is confirmed `swing_lookback` bars later
    (so `idx`/`ns` is the confirmation tick, the first moment the level is real). The
    caller passes bars up to the cursor (live overlay) or the whole session (touch
    index). Prices are in DISPLAY points (bars are). Returns
    dict(swing_highs, swing_lows, eqh, eql) — each item: price, pivot_t, t, ns, idx."""
    P = params or ICT_PARAMS
    n = len(bars)
    lb = P["swing_lookback"]
    if n < 2 * lb + 1:
        return {"swing_highs": [], "swing_lows": [], "eqh": [], "eql": []}
    ph, pl = find_swings(bars, P)
    sh, sl = [], []
    for i in range(n):
        conf = bars[min(i + lb, n - 1)]   # confirmation bar (right-hand side filled)
        if ph[i]:
            sh.append({"price": bars[i]["h"], "pivot_t": bars[i]["t"],
                       "t": conf["t"], "ns": conf["ns"], "idx": conf["idx"]})
        if pl[i]:
            sl.append({"price": bars[i]["l"], "pivot_t": bars[i]["t"],
                       "t": conf["t"], "ns": conf["ns"], "idx": conf["idx"]})
    tol = P.get("eq_tol_ticks", 8) * P["tick_size"]
    return {"swing_highs": sh, "swing_lows": sl,
            "eqh": _cluster_equal(sh, tol, "high"),
            "eql": _cluster_equal(sl, tol, "low")}


def detect(bars, params=None):
    """Full causal detection over `bars`. Returns dict(fvgs, events, swings_n)."""
    P = params or ICT_PARAMS
    if len(bars) < 3:
        return {"fvgs": [], "events": []}
    fvgs = find_fvgs(bars, P)
    events = _structure_events(bars, P)
    return {"fvgs": fvgs, "events": events}


def _structure_events(bars, params):
    """Sweeps + BOS/MSS with the correct sweep-direction mapping (see note)."""
    n = len(bars)
    lb = params["swing_lookback"]
    ph, pl = find_swings(bars, params)
    events = []
    trend = None
    last_sh = None
    last_sl = None
    for j in range(n):
        p = j - lb
        if p >= 0:
            if ph[p]:
                last_sh = (p, bars[p]["h"])
            if pl[p]:
                last_sl = (p, bars[p]["l"])
        b = bars[j]
        base = {"t": b["t"], "i": j, "ns": b["ns"], "idx": b["idx"], "mod": b["mod"]}

        def _swing(ref, kind):   # the swing pivot bar this event keyed on
            pi = ref[0]
            return {"swing_t": bars[pi]["t"], "swing_price": ref[1],
                    "swing_idx": bars[pi]["idx"], "swing_kind": kind}

        # sweep of buy-side (swing high): wick over, close back under -> bearish reversal
        if last_sh and b["h"] > last_sh[1] and b["c"] < last_sh[1]:
            events.append({**base, "kind": "SWEEP", "dir": "bear", "level": last_sh[1],
                           **_swing(last_sh, "swing_high")})
        # sweep of sell-side (swing low): wick under, close back over -> bullish reversal
        if last_sl and b["l"] < last_sl[1] and b["c"] > last_sl[1]:
            events.append({**base, "kind": "SWEEP", "dir": "bull", "level": last_sl[1],
                           **_swing(last_sl, "swing_low")})
        # BOS/MSS on a close beyond a confirmed swing
        if last_sh and b["c"] > last_sh[1]:
            events.append({**base, "kind": "BOS" if trend == "up" else "MSS",
                           "dir": "bull", "level": last_sh[1], **_swing(last_sh, "swing_high")})
            trend = "up"; last_sh = None
        elif last_sl and b["c"] < last_sl[1]:
            events.append({**base, "kind": "BOS" if trend == "down" else "MSS",
                           "dir": "bear", "level": last_sl[1], **_swing(last_sl, "swing_low")})
            trend = "down"; last_sl = None
    return events


def _setup_levels(g, protect_level, params):
    """The implied trade levels for a setup — ONE source of truth (used by the size
    filter AND the chart anatomy so they never diverge). Entry at the FVG proximal
    edge, stop just beyond `protect_level` (the swept liquidity if present, else the
    broken structure — structural invalidation), target a 2R projection. TUNE the
    entry/stop/target logic here to match how you take the trade."""
    bull = g["dir"] == "bull"
    tick = params["tick_size"]
    entry = g["top"] if bull else g["bot"]
    buf = tick * 4
    stop = (protect_level - buf) if bull else (protect_level + buf)
    risk = abs(entry - stop)
    target = (entry + 2 * risk) if bull else (entry - 2 * risk)
    return entry, stop, target


def _setup_components(g, struct, sweep, protect_level, params):
    """Break a detected setup into its labeled mechanical PARTS for the chart: the
    swing point(s) used, the swept liquidity pool + sweep candle, the MSS/BOS break
    level, the FVG entry zone, and the implied entry / stop / target levels. `struct`
    and/or `sweep` may be None (broad candidates can be anchored by just one), so each
    part is built only when its event is present. Each part carries its own synth time
    `t` so the front-end can reveal it CAUSALLY (only once the cursor reaches it).
    Levels (`kind:'level'`) draw as a line from `t`; `point` = a marker; `box` = a box."""
    comps = []   # each: t (draw anchor x), reveal_t (causal show time), kind/role/label/price...
    # 1) swept liquidity pool (the swing the sweep raided) + the swing point + sweep candle
    if sweep is not None:
        if sweep.get("swing_t") is not None:
            liq = "sell-side liquidity" if sweep["dir"] == "bull" else "buy-side liquidity"
            comps.append({"role": "liquidity", "kind": "level", "label": liq,
                          "t": sweep["swing_t"], "reveal_t": sweep["swing_t"], "t1": sweep["t"],
                          "price": round(sweep["level"], 2), "dir": sweep["dir"]})
            comps.append({"role": "swing", "kind": "point",
                          "label": "swing low" if sweep["dir"] == "bull" else "swing high",
                          "t": sweep["swing_t"], "reveal_t": sweep["swing_t"],
                          "price": round(sweep["swing_price"], 2), "dir": sweep["dir"]})
        comps.append({"role": "sweep", "kind": "point", "label": "swept",
                      "t": sweep["t"], "reveal_t": sweep["t"], "price": round(sweep["level"], 2),
                      "dir": sweep["dir"]})
    # 2) structure break level (the swing that broke) — drawn from the swing, but only
    #    REVEALED once it actually breaks (struct['t']) + that swing point
    if struct is not None:
        comps.append({"role": "structure", "kind": "level", "label": struct["kind"] + " break",
                      "t": struct.get("swing_t", struct["t"]), "reveal_t": struct["t"],
                      "t1": struct["t"], "price": round(struct["level"], 2), "dir": struct["dir"]})
        if struct.get("swing_t") is not None:
            comps.append({"role": "swing", "kind": "point",
                          "label": "swing high" if struct["dir"] == "bull" else "swing low",
                          "t": struct["swing_t"], "reveal_t": struct["swing_t"],
                          "price": round(struct["swing_price"], 2), "dir": struct["dir"]})
    # 3) FVG/IFVG entry zone (the box the entry is based on)
    comps.append({"role": "fvg", "kind": "box", "label": "FVG entry", "t": g["t_form"],
                  "reveal_t": g["t_form"], "lo": round(g["bot"], 2), "hi": round(g["top"], 2),
                  "dir": g["dir"]})
    # 4) implied entry / stop / target (shared with the size filter — see _setup_levels)
    entry, stop, target = _setup_levels(g, protect_level, params)
    for role, lbl, pr in (("entry", "entry", entry), ("stop", "stop", stop),
                          ("target", "target (2R)", target)):
        comps.append({"role": role, "kind": "level", "label": lbl, "t": g["t_form"],
                      "reveal_t": g["t_form"], "price": round(pr, 2), "dir": g["dir"]})
    return comps


def find_setups(bars, params=None):
    """Surface entry-worthy ICT/TJR setups for DISCRETIONARY selection. Candidate
    BREADTH is the `setup_strictness` knob (TUNE HERE): "strict" = full confluence
    only (killzone + sweep + MSS/BOS + FVG); "broad" = any FVG/IFVG with at least ONE
    supporting event (sweep OR structure shift), killzone optional — the richest list.

    The ONLY hard gates on that broad list are:
      • SIZE — drop a setup unless BOTH entry→stop and entry→target are >= the tick
        minimums (cramped setups are the noise; the user trails arm+150/25 so needs
        ≥100–150tk of room).
      • DEDUP — suppress a candidate at the same FVG entry OR anchor (swept/structure)
        level + direction within the dedup window; no re-taking the same failed area.

    Every surfaced setup is TAGGED with a confluence strength grade (A+/A/B) so the
    high-confluence ones stand out even in the broader list. Each carries the cursor
    target (ns/idx), the FVG entry zone, grade, and a `components` breakdown (swing /
    liquidity / swept / MSS|BOS / FVG / entry-stop-target) for the anatomy overlay.

    Direction: sell-side sweep / bullish shift → bullish FVG = LONG (mirror for short).
    """
    P = params or ICT_PARAMS
    if len(bars) < 5:
        return []
    d = detect(bars, P)
    fvgs, events = d["fvgs"], d["events"]
    win = P["setup_window_bars"]
    tick = P["tick_size"]
    min_stop = P["setup_min_stop_ticks"]
    min_tgt = P["setup_min_target_ticks"]
    dedup_pts = P["dedup_ticks"] * tick
    dedup_win = P["dedup_window_min"] * 60     # synth seconds
    min_score = _STRICTNESS_MIN_SCORE.get(P.get("setup_strictness", "broad"), 1)

    # 1) BROAD candidate generation: every FVG that has a supporting structure event
    # (sweep OR MSS/BOS) in its direction within the window. Killzone is a STRENGTH
    # factor, not a gate (unless strictness demands it). The ONLY hard cuts here are
    # the strictness score and the size floor — dedup runs after, in time order.
    cands = []
    for g in fvgs:
        gi, gdir = g["i"], g["dir"]
        sweep = struct = None      # nearest same-direction supporting events at/before the FVG
        for e in events:
            if e["dir"] != gdir or not ((gi - win) <= e["i"] <= gi):
                continue
            if e["kind"] == "SWEEP":
                sweep = e
            elif e["kind"] in ("BOS", "MSS"):
                struct = e
        has_sweep, has_struct = sweep is not None, struct is not None
        if not (has_sweep or has_struct):
            continue                                   # need >=1 supporting structure event
        kz = _killzone_for(g["mod"], P)
        in_kz = kz is not None
        if (int(in_kz) + int(has_sweep) + int(has_struct)) < min_score:
            continue                                   # strictness gate (the breadth knob)
        # the level the stop is protected by: the swept liquidity if present, else the
        # broken structure level. Used for size, dedup, and the anatomy.
        protect_level = sweep["level"] if has_sweep else struct["level"]
        entry, stop, target = _setup_levels(g, protect_level, P)
        stop_ticks = abs(entry - stop) / tick
        tgt_ticks = abs(target - entry) / tick
        if stop_ticks < min_stop or tgt_ticks < min_tgt:   # SIZE floor (hard gate)
            continue
        grade, grade_desc = _setup_grade(in_kz, has_sweep, has_struct)
        cands.append({
            "t": g["t_form"], "ns": g["ns"], "idx": g["idx"],
            "dir": "long" if gdir == "bull" else "short",
            "killzone": kz, "grade": grade, "grade_desc": grade_desc,
            "zone": {"lo": round(g["bot"], 2), "hi": round(g["top"], 2)},
            "entry": round(entry, 2), "stop": round(stop, 2), "target": round(target, 2),
            "stop_ticks": round(stop_ticks), "target_ticks": round(tgt_ticks),
            "anchor_level": round(protect_level, 2),
            "sweep_level": round(sweep["level"], 2) if has_sweep else None,
            "struct_kind": struct["kind"] if has_struct else None,
            "struct_level": round(struct["level"], 2) if has_struct else None,
            "sweep_t": sweep["t"] if has_sweep else None,
            "struct_t": struct["t"] if has_struct else None,
            "components": _setup_components(g, struct, sweep, protect_level, P),
            "first_t": (sweep.get("swing_t") if has_sweep else struct.get("swing_t")) or g["t_form"],
        })

    # 2) DEDUP (hard gate) — one setup per distinct structure/level. In time order,
    # suppress a candidate if a same-direction setup already fired at the same FVG
    # entry OR the same anchor (swept/structure) level within the dedup window — i.e.
    # no re-taking the same failed area; a genuinely new structure is required.
    cands.sort(key=lambda x: x["t"])
    accepted = []
    for c in cands:
        dup = False
        for a in accepted:
            if a["dir"] != c["dir"] or (c["t"] - a["t"]) > dedup_win:
                continue
            if abs(c["entry"] - a["entry"]) <= dedup_pts or abs(c["anchor_level"] - a["anchor_level"]) <= dedup_pts:
                dup = True
                break
        if not dup:
            accepted.append(c)
    return accepted


def active_structures(bars, cursor_t, params=None):
    """Currently-relevant structures as of `cursor_t` (synth secs), for the LIVE
    overlay. FVGs that are filled/mitigated are dropped; close-throughs show as
    IFVGs until reclaimed; BOS/MSS/sweep markers older than struct_ttl_sec drop off.
    Returns a flat list of overlay dicts with synth coords + label."""
    P = params or ICT_PARAMS
    d = detect(bars, P)
    out = []
    # FVG / IFVG boxes — only the currently-active ones
    boxes = []
    for g in d["fvgs"]:
        inv, mit, ifm = g["inv_t"], g["mit_t"], g["ifvg_mit_t"]
        if inv is not None and inv <= cursor_t and (ifm is None or ifm > cursor_t):
            # inverted FVG acting as S/R now
            boxes.append({"kind": "IFVG", "dir": g["dir"], "t0": inv, "t1": cursor_t,
                          "lo": round(g["bot"], 2), "hi": round(g["top"], 2),
                          "label": "IFVG"})
        elif inv is None and (mit is None or mit > cursor_t):
            # fresh, unmitigated FVG
            boxes.append({"kind": "FVG", "dir": g["dir"], "t0": g["t_form"], "t1": cursor_t,
                          "lo": round(g["bot"], 2), "hi": round(g["top"], 2),
                          "label": "FVG"})
    # keep only the most recent N to stay clean — but GUARANTEE the latest active box
    # of EACH direction survives, so a lone bear FVG in a bull trend (or vice-versa)
    # is never sliced away. Otherwise the overlay can look one-sided in a strong trend.
    recent = boxes[-P["max_active_fvgs"]:]
    for _dir in ("bull", "bear"):
        last_d = next((b for b in reversed(boxes) if b["dir"] == _dir), None)
        if last_d is not None and last_d not in recent:
            recent.append(last_d)
    recent.sort(key=lambda b: b["t0"])
    out.extend(recent)
    # recent BOS/MSS/sweep markers (lines)
    ttl = P["struct_ttl_sec"]
    for e in d["events"]:
        if e["t"] <= cursor_t and (cursor_t - e["t"]) <= ttl:
            out.append({"kind": e["kind"], "dir": e["dir"], "t": e["t"],
                        "level": round(e["level"], 2), "label": e["kind"]})
    return out
