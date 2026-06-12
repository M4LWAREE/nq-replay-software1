#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""verify_challenge.py — deterministic check of the prop-challenge engine.

Drives synthetic prices through the REAL code paths (_ch_tick / _ch_on_close /
place_market / _persist_json) on a live ReplaySession so the trail / lock /
fail-flatten / pass-freeze / size-cap rules are asserted exactly, independent
of whatever random market day the session picked.

Run:  .venv/bin/python replay_trader/verify_challenge.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import replay_trader as rt  # noqa: E402  (loads the tick cache, ~2s)

CFG = rt.PROP_CHALLENGE
START = CFG["start_balance"]            # 50_000
MLL = CFG["mll"]                        # 2_000
TARGET = CFG["profit_target"]           # 3_000
LOCK = START + CFG["mll_lock_offset"]   # 50_100

ENTRY = 100_000                          # synthetic entry, integer ticks ($25,000.00)


def fake_pos(s, side=1, size=1):
    """Minimal honest position dict (mini economics) planted on the session."""
    return {
        "order_id": s.next_order_id, "side": side, "size": size,
        "entry_idx": s.start_idx, "entry_ns": int(rt.TS[s.start_idx]),
        "entry_px": ENTRY, "stop": None, "target": None,
        "stop_tk": None, "target_tk": None, "trail_tk": None, "arm_tk": 0,
        "trail_armed": False, "trail_stop": None, "mfe": 0, "mae": 0,
        "instrument": "mini", "cmult": 1.0, "comm_rt": rt.COMMISSION_RT,
        "flow_delta_entry": None,
    }


def tick(s, px_ticks):
    """One synthetic print through the real challenge mark/fail path."""
    s._ch_tick(s.start_idx + 50, px_ticks, int(rt.TS[s.start_idx + 50]))


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""))
    if not cond:
        raise SystemExit(f"verification failed: {label}")


print("== 1) MLL trails on real-time equity, locks at start+offset, fail flattens ==")
s = rt.ReplaySession(mode="rth")
s.enable_challenge(True)
s.position = fake_pos(s)                            # long 1 mini from ENTRY
check("initial MLL level = start - MLL", s.ch["mll_level"] == START - MLL)

tick(s, ENTRY + 100)                                # +$500 equity
check("MLL trails with HWM (+$500 -> level 48,500)",
      abs(s.ch["mll_level"] - (START - MLL + 500)) < 1e-6, f"level={s.ch['mll_level']}")

tick(s, ENTRY + 419)                                # +$2,095 — just below the lock
check("still trailing below lock", not s.ch["locked"]
      and abs(s.ch["mll_level"] - (START - MLL + 2095)) < 1e-6)

tick(s, ENTRY + 500)                                # +$2,500 — crosses the lock
check("MLL locks at $50,100", s.ch["locked"] and s.ch["mll_level"] == LOCK)

tick(s, ENTRY + 800)                                # +$4,000 — locked level must hold
check("locked level never trails further", s.ch["mll_level"] == LOCK)
check("unrealized gain alone does NOT pass (realized rule)", s.ch["status"] == "active")
check("peak equity tracked", s.ch["peak_equity"] == START + 4000)

tick(s, ENTRY + 20)                                 # equity $50,100 == level -> FAIL
check("MLL touch fails the challenge", s.ch["status"] == "failed")
check("position flattened at market", s.position is None)
check("flatten logged honestly as MLL exit",
      s.trades[-1]["exit_reason"] == "MLL"
      and s.trades[-1]["pnl_ticks"] == 19,           # 20 favorable - 1 adverse slip
      f"pnl_ticks={s.trades[-1]['pnl_ticks']}")
# dd at the touch is $3,900; the honest flatten (slip + commission) then deepens
# it to peak_equity - final_balance — the drawdown actually used.
expect_dd = s.ch["peak_equity"] - s.ch["balance"]
check("max drawdown used incl. exit costs",
      s.ch["max_dd_used"] >= 3900 and abs(s.ch["max_dd_used"] - expect_dd) < 1e-6,
      f"dd={s.ch['max_dd_used']:.2f}")
r = s.place_market(1, 1)
check("entries blocked after fail", r["ok"] is False and "FAILED" in r["err"])
j = json.loads(Path(s._json_path).read_text())
check("session JSON logs FAILED + dd + peak",
      j["challenge"]["result"] == "FAILED"
      and abs(j["challenge"]["max_dd_used"] - expect_dd) < 0.01
      and j["challenge"]["peak_equity"] == 54000.0)

print("== 2) profit target: realized pass, frozen afterwards ==")
s2 = rt.ReplaySession(mode="rth")
s2.enable_challenge(True)
s2.ch["balance"] = START + 2900                      # one good trade from the target
s2.position = fake_pos(s2)
s2._close(s2.start_idx + 50, ENTRY + 25, int(rt.TS[s2.start_idx + 50]), "TARGET")
check("realized balance >= $53,000 passes",
      s2.ch["status"] == "passed" and s2.ch["balance"] >= START + TARGET,
      f"balance={s2.ch['balance']:.2f}")
r = s2.place_market(1, 1)
check("trading still allowed after pass", r["ok"] is True)
s2.pending = None
s2.position = fake_pos(s2)
s2._close(s2.start_idx + 60, ENTRY - 200, int(rt.TS[s2.start_idx + 60]), "MANUAL")
check("pass result frozen through a later losing trade", s2.ch["status"] == "passed")
j2 = json.loads(Path(s2._json_path).read_text())
check("session JSON logs PASSED + timestamp",
      j2["challenge"]["result"] == "PASSED" and j2["challenge"]["passed_at"] is not None)

print("== 3) scaling cap (50K tier) ==")
s3 = rt.ReplaySession(mode="rth")
s3.enable_challenge(True)
check("6 minis rejected", s3.place_market(1, 6)["ok"] is False)
check("5 minis accepted", s3.place_market(1, 5)["ok"] is True)
s3.flatten()                                         # cancels the pending order
s3.set_instrument("micro")
check("51 micros rejected", s3.place_market(1, 51)["ok"] is False)
check("50 micros accepted", s3.place_market(1, 50)["ok"] is True)

print("== 4) realized-side MLL (slipped exit lands balance at/under level) ==")
s4 = rt.ReplaySession(mode="rth")
s4.enable_challenge(True)
s4.ch["balance"] = START - MLL + 100                 # $100 above the (untrailed) level
s4.position = fake_pos(s4)
s4._close(s4.start_idx + 50, ENTRY - 30, int(rt.TS[s4.start_idx + 50]), "STOP")
check("realized close through the level fails the challenge",
      s4.ch["status"] == "failed", f"balance={s4.ch['balance']:.2f}")

print("== 5) non-challenge sessions untouched ==")
s5 = rt.ReplaySession(mode="rth")
check("challenge off by default", s5.challenge is False and s5.ch is None)
check("no size cap off-challenge", s5.place_market(1, 25)["ok"] is True)
snap = s5.snapshot()
check("no challenge block in snapshot", "challenge" not in snap)

print("\nALL CHALLENGE CHECKS PASSED")
