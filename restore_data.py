#!/usr/bin/env python3
"""Rebuild the tick data cache from the committed split parts, if it's missing.

The ~727MB tick data can't live in git as raw files (GitHub blocks >100MB), so
it's committed as a set of <50MB parts under data/ (nq_replay_data.zip.000 ...).
This script reassembles them into the zip and unpacks the 5 nq_ticks_* files into
tick_engine/cache/ on first run. Uses only the standard library so it can run
with the system Python before any venv exists. Safe to run every launch — it
no-ops the instant the data is already present.
"""
import os
import sys
import glob
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "tick_engine", "cache")
MARKER = os.path.join(CACHE, "nq_ticks_ts.npy")  # biggest file = "data present" sentinel
PARTS_GLOB = os.path.join(HERE, "data", "nq_replay_data.zip.*")
ZIP_TMP = os.path.join(HERE, "data", "_nq_replay_data_reassembled.zip")


def main() -> int:
    if os.path.exists(MARKER):
        return 0  # data already unpacked — nothing to do

    parts = sorted(glob.glob(PARTS_GLOB))
    if not parts:
        print("[restore] No data parts found under data/ and no cache present.")
        print("[restore] Expected data/nq_replay_data.zip.000 ... — re-clone the repo.")
        return 1

    os.makedirs(CACHE, exist_ok=True)
    print(f"[restore] First run: reassembling {len(parts)} data parts (~244MB)...")
    with open(ZIP_TMP, "wb") as out:
        for p in parts:
            with open(p, "rb") as f:
                while True:
                    b = f.read(1 << 20)
                    if not b:
                        break
                    out.write(b)

    print("[restore] Unpacking tick data into tick_engine/cache/ ...")
    with zipfile.ZipFile(ZIP_TMP) as z:
        z.extractall(CACHE)

    try:
        os.remove(ZIP_TMP)
    except OSError:
        pass

    ok = os.path.exists(MARKER)
    print("[restore] Done." if ok else "[restore] WARNING: expected files missing after unpack.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
