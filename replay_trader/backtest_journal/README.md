# Backtest Journal — Obsidian-native, backtester-ONLY

A scale-ready journal of the NQ **replay/backtest** sessions that lives **natively
in the Obsidian Trading vault** so it's browsable with Dataview/Bases AND queryable
by code. Designed for hundreds–thousands of trades.

> **Scope guard.** These are REPLAY/backtest trades. They live separately from the
> live, hand-logged `Trading Brain/Mentor/Trade Log/` (one-note-per-trade,
> `#trade-entry`). Do not merge the two. This journal also stays out of the live
> edge DB (`DeepChartBot/trades.db` via `tradedb`).

## Where it lives (the vault)

```
<Vault>/Trading Brain/Mentor/Backtest Journal/
  Sessions/                         # ONE note per session (light, human-readable)
    2026-04-06 NQ 77a655.md         #   "<real_date ET> NQ <id8>.md"
    ...
  trades.ndjson                     # CANONICAL flat trade store (heavy; code reads this)
  Backtest Sessions.base            # native Bases dashboard (core plugin, no install)
  Backtest Dashboard.md             # static snapshot + Bases embed + Dataview blocks
```

Code (committed in the repo, generates the vault files):
`replay_trader/backtest_journal/{load_backtest_journal.py, regime_decode.py,
query.py, annotations.json, README.md, .gitignore}`.

`<Vault>` = `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Trading`.

The **code** (loader/query/spec/dashboard templates) lives in the git repo at
`replay_trader/backtest_journal/`. The loader **generates** the vault files; the
bulky `trades.ndjson` is iCloud-synced data, not committed (see `.gitignore`).

## Two-layer model (objective vs annotation)

| Layer | Where | Refreshed on reload? |
|---|---|---|
| **Objective** (stats, per-trade fields) | session-note frontmatter + AUTO block; every ndjson row | **Yes** — regenerated from the source `sessions/*.json` |
| **Annotations** (your observations) | session-note frontmatter `regime/grade/psych_*/lesson` + everything BELOW the `AUTO:STATS:END` marker; ndjson keys `setup_tag/levels_in_play/psych_state/went_right/went_wrong/note` | **No — preserved.** Edit freely in Obsidian or in the ndjson |

The loader only rewrites frontmatter objective keys and the delimited AUTO block.
Your psych notes, lessons, setup tags, and free text survive every reload. Verified
idempotent (re-running 21 sessions preserves hand edits in both notes and ndjson).

### Session-note frontmatter (Dataview/Bases-queryable + trivially code-parseable)

Objective: `session_id, real_date, weekday, mode, n_trades, win_pct, net_usd,
net_ticks, expectancy, profit_factor, avg_win, avg_loss, max_dd, direction_skill,
selection_skill, open5m_range, regime, regime_effective, regime_atr_ratio,
rth_close_dir, first_hour_range_pts, first_entry_et, last_exit_et,
in_window_trades, fade_trades, aligned_trades, fade_net_ticks, aligned_net_ticks,
source_file, loaded_at, reviewed`.
Annotation: `regime_override`, `grade` (A–F), `psych_pre/during/post`, `lesson`.

**Regime is now decoded EXACTLY from the tick cache** (`regime_decode.py`, mirrors
`tradedb/regime.py`): each trade's `entry_idx` → real date via `session_index.json`
→ first-hour range vs a 14-session rolling ATR baseline → `range-chop` (<0.5×) /
`high-vol` (>1.5×) / `trend-up` / `trend-down` (by RTH close direction). The
earliest cached session has no prior ATR and comes back `untagged`; that is the
only case `regime_override` is used (set from the RTH close direction).
**Query `regime_effective`** (= `regime_override` or `regime`) — it's the single
clean column Bases/Dataview/code all read. Needs numpy + the tick cache at
`tick_engine/cache/`; without them regime degrades to `untagged` and the rest of
the loader still runs.

> Keep frontmatter values **single-line** (the loader uses a tiny flat-YAML parser
> to preserve them without a yaml dependency). Long-form psych/narrative goes in the
> body sections (`## What went right`, `## Lesson`, `## Free notes`), which the
> loader never touches.

### `trades.ndjson` (one JSON object per line — the heavy store)

Objective per trade: `session_id, order_id, real_date, side, size, instrument,
entry_et, exit_et, entry_ns, exit_ns, entry_px_disp, exit_px_disp, exit_reason,
pnl_ticks, pnl_net, mfe_ticks, mae_ticks, hold_s, stop_tk, target_tk, trail_tk,
arm_tk, flow_delta_entry, fade_or_aligned, time_window, coinflip_ev_net,
random_time_ev_net`. Annotation: `setup_tag, levels_in_play, psych_state,
went_right, went_wrong, note`.

Derived fields the raw export doesn't carry: `real_date` (decoded from `entry_ns`),
`fade_or_aligned` (sign of `flow_delta_entry` vs `side` — the FADE classifier),
`time_window` (open / 10-11 / lunch / 13-15 / other; locked windows are 10-11 &
13-15 ET).

> **Timestamp note:** `entry_et` here is already correct ET (verified vs `entry_ns`).
> The "+1h" rule is for broker CSV exports, NOT these JSON sidecars — don't double-shift.
> **Money:** `instrument: mini` = E-mini NQ ($5/tick/contract); `pnl_net` is $ net of
> fees. `*_px_disp` are session-blinded — never compare prices across sessions.

## Run the loader (idempotent)

```bash
cd ~/DeepChartBot/nq-replay-software1-main/replay_trader/backtest_journal
python3 load_backtest_journal.py --all --min-trades 9 --seed   # backfill real sessions
python3 load_backtest_journal.py 20260609_133346_77a655        # one session
python3 load_backtest_journal.py --install-dashboard           # rewrite .base + dashboard
# vault override: BACKTEST_JOURNAL_VAULT=/path python3 load_backtest_journal.py --all
```
`--seed` applies `annotations.json` (mentor write-ups) **only on first create**;
thereafter the note is the source of truth for annotations.

## Query it

### From Obsidian (no code)
- **Bases** (core, already enabled): open `Backtest Sessions.base` or the
  `Backtest Dashboard` note → views *All Sessions / Losing / By Regime / Fade vs
  Aligned / Needs Review*, sortable & groupable in-UI.
- **Static snapshot** in `Backtest Dashboard.md` (fade-by-regime, grade dist,
  equity curve) — refreshed by the loader, renders with zero plugins.
- **Dataview** blocks in the dashboard go live once you install the Dataview
  community plugin (optional; Bases + the snapshot already cover it).

### From code
```bash
# canned reports + ad-hoc SQL over the ndjson (stdlib sqlite, no deps)
python3 query.py --report
python3 query.py --schema
python3 query.py --sql "SELECT regime, fade_or_aligned, COUNT(*), SUM(pnl_ticks) \
                        FROM v_trades GROUP BY 1,2 ORDER BY 4 DESC"

# jq one-liners
jq -c 'select(.fade_or_aligned==\"fade\")' trades.ndjson | head
jq -s 'group_by(.exit_reason)[] | {exit:.[0].exit_reason, n:length}' trades.ndjson

# pandas
python3 -c "import pandas as pd; df=pd.read_json('$VAULT/trades.ndjson', lines=True); \
            print(df.groupby('fade_or_aligned').pnl_ticks.agg(['count','mean','sum']))"
```
`query.py` builds an in-memory SQLite from `trades.ndjson` and joins session
`regime`/`grade` from the note frontmatter into a `v_trades` view.

## Auto-ingest from the replay engine (no manual step)

The replay engine (`replay_trader.py`) auto-appends every finished session. On
session end, `ReplaySession._end_session()` → `_maybe_journal()` fires the loader
for that one session as a **fire-and-forget subprocess** (`_journal_session_async`),
after `_persist_json()` has written the session JSON. Same idempotent loader
(`load_backtest_journal.py <id> --seed`), so the note + `trades.ndjson` rows appear
automatically with the exact regime, and hand annotations are preserved.

- **Idempotent twice over:** `self.journaled` guards double-ingest within a run; the
  loader is keyed by `session_id`/`order_id` so re-runs never dupe.
- **Concurrency-safe:** the loader takes an advisory `flock` on `.journal.lock` in
  the vault, so sessions ending near-simultaneously queue instead of racing on
  `trades.ndjson` (verified: 2 concurrent runs → no lost rows, no corruption).
- **Never blocks/crashes the engine:** daemon thread; errors caught and logged
  (`[replay_trader] journal OK/FAILED …`).
- **Threshold:** journals any session with ≥1 trade — raise it via the
  `self.stats().get("n", 0) < 1` guard in `_maybe_journal()`.

Safety-net (optional cron/launchd): `load_backtest_journal.py --all --min-trades 9
--seed` re-syncs everything; idempotent, only adds what's new.

## Adding sessions manually

Print new replay sessions, then `python3 load_backtest_journal.py --all
--min-trades 9 --seed`. New sessions get a note (exact `regime`,
`reviewed: false`, blank `grade`) and their trades append to `trades.ndjson`.
Add a block to `annotations.json` keyed by `session_id` for a seeded mentor read,
or just edit the note in Obsidian.

## Current contents

21 sessions / 413 trades (real dates 2025-10-30 → 2026-04-22), **all mentor-reviewed
with exact regimes**. Grade distribution: A- 2 · B+ 2 · B 2 · B- 2 · C+ 1 · C 2 ·
C- 2 · D+ 1 · D 4 · F 3.

**Headline edge (with EXACT regimes):** fade pays on **trend-up** days
(+672 tk across 151 trades @ 60.9% WR) and **high-vol** (+171 tk @ 73.3%), but
**loses on trend-down** days (−369 tk across 95 trades despite a 56.8% WR — the
losers run bigger). The earlier "+1057 tk range-chop fade" number was an artifact
of a provisional regime heuristic; once regimes are decoded from the tick cache
there is essentially no range-chop fade sample (the one true range-chop day was a
−5R loser), and the real structure is a trend-up-vs-trend-down asymmetry.

**Discipline patterns:** overtrading amplifies losses (the F/D sessions run
25–38 trades; the A-/B sessions stay ≤22 and never cluster stops). Several big-$
sessions are **size experiments** (up to 500 minis) whose P&L is not edge —
graded on R/discipline, not the inflated dollars. Sizing is read only through the
KB-06 tiers (Tier-0 = 4 micros; 1 mini = hard ceiling; 3 minis = "do not").
