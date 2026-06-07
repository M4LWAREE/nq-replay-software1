"""Build a cached index of trading sessions from the tick cache.

For each ET calendar date present in the tick stream, record:
  - full-day tick index range [full_start, full_end)
  - RTH (09:30:00–16:00:00 ET) tick index range [rth_start, rth_end)
  - first/last ns, tick counts

Read-only over tick_engine/cache. Writes replay_trader/session_index.json.
Run once: .venv\Scripts\python.exe replay_trader\build_session_index.py
"""
from __future__ import annotations
import json, os, time
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "..", "tick_engine", "cache")
OUT = os.path.join(HERE, "session_index.json")
NY = "America/New_York"


def main():
    t0 = time.time()
    ts = np.load(os.path.join(CACHE, "nq_ticks_ts.npy"), mmap_mode="r")
    n = len(ts)
    print(f"loaded {n:,} ticks")

    # ET datetime for every tick (vectorized). 44.8M -> a few seconds.
    idx = pd.DatetimeIndex(pd.to_datetime(np.asarray(ts), utc=True)).tz_convert(NY)
    etd = idx.normalize()                       # ET midnight per tick
    date_str = etd.strftime("%Y-%m-%d").to_numpy()
    sec_into_day = (idx.hour * 3600 + idx.minute * 60 + idx.second).to_numpy()

    # day group boundaries
    uniq, starts = np.unique(date_str, return_index=True)
    order = np.argsort(starts)
    uniq = uniq[order]; starts = starts[order]
    ends = np.append(starts[1:], n)

    RTH_OPEN = 9 * 3600 + 30 * 60     # 34200
    RTH_CLOSE = 16 * 3600            # 57600

    sessions = []
    for d, s, e in zip(uniq, starts, ends):
        s = int(s); e = int(e)
        sd = sec_into_day[s:e]
        rmask = (sd >= RTH_OPEN) & (sd < RTH_CLOSE)
        if rmask.any():
            rel = np.nonzero(rmask)[0]
            rth_start = s + int(rel[0]); rth_end = s + int(rel[-1]) + 1
        else:
            rth_start = rth_end = 0
        sessions.append({
            "date": str(d),
            "full_start": s, "full_end": e, "full_ticks": e - s,
            "rth_start": rth_start, "rth_end": rth_end,
            "rth_ticks": max(0, rth_end - rth_start),
        })

    # keep only sessions with a real RTH window (>= ~5000 ticks so charts are meaty)
    good = [x for x in sessions if x["rth_ticks"] >= 5000]
    meta = {
        "n_sessions": len(sessions),
        "n_good_rth": len(good),
        "tick_size": 0.25,
        "built_utc": str(pd.Timestamp.utcnow()),
    }
    with open(OUT, "w") as f:
        json.dump({"meta": meta, "sessions": sessions}, f)
    print(f"wrote {OUT}: {len(sessions)} sessions, {len(good)} with RTH>=5000 ticks "
          f"in {time.time()-t0:.1f}s")
    # sanity print a few
    for x in sessions[:3]:
        print("  ", x["date"], "rth_ticks", x["rth_ticks"], "full_ticks", x["full_ticks"])


if __name__ == "__main__":
    main()
