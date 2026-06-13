#!/usr/bin/env python3
"""
query.py — code-side access to the Obsidian backtest journal.

Loads the vault's trades.ndjson into an in-memory SQLite DB (stdlib only) so you
can run arbitrary SQL over thousands of trades instantly, with no DuckDB/yaml dep.
Also prints a few canned reports.

Usage:
  python3 query.py --sql "SELECT fade_or_aligned, COUNT(*), SUM(pnl_ticks) FROM trades GROUP BY 1"
  python3 query.py --report            # fade-by-regime + grade dist + equity tail
  python3 query.py --schema            # list columns
Env: BACKTEST_JOURNAL_VAULT overrides the vault path (same as the loader).
"""
import argparse, glob, json, os, re, sqlite3

DEFAULT_VAULT = os.path.expanduser(
    "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Trading/"
    "Trading Brain/Mentor/Backtest Journal")
VAULT = os.environ.get("BACKTEST_JOURNAL_VAULT", DEFAULT_VAULT)
NDJSON = os.path.join(VAULT, "trades.ndjson")


def load_db():
    rows = [json.loads(l) for l in open(NDJSON) if l.strip()]
    if not rows:
        raise SystemExit(f"no trades in {NDJSON}")
    cols = sorted({k for r in rows for k in r})
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute(f"CREATE TABLE trades ({','.join(f'\"{c}\"' for c in cols)})")
    con.executemany(
        f"INSERT INTO trades ({','.join(f'\"{c}\"' for c in cols)}) "
        f"VALUES ({','.join('?' for _ in cols)})",
        [[r.get(c) for c in cols] for r in rows])
    # session-level regime/grade pulled from the note frontmatter -> sessions table
    srows = []
    for p in glob.glob(os.path.join(VAULT, "Sessions", "*.md")):
        fm = {}
        txt = open(p).read()
        if txt.startswith("---"):
            blk = txt[3:txt.find("\n---", 3)]
            for line in blk.splitlines():
                m = re.match(r'^([A-Za-z0-9_]+):\s?(.*)$', line)
                if m: fm[m.group(1)] = m.group(2).strip().strip('"')
        if fm.get("session_id"):
            srows.append(fm)
    if srows:
        scols = sorted({k for r in srows for k in r})
        con.execute(f"CREATE TABLE sessions ({','.join(f'\"{c}\"' for c in scols)})")
        con.executemany(
            f"INSERT INTO sessions ({','.join(f'\"{c}\"' for c in scols)}) "
            f"VALUES ({','.join('?' for _ in scols)})",
            [[r.get(c) for c in scols] for r in srows])
        con.execute("CREATE VIEW v_trades AS SELECT t.*, s.regime, s.grade, s.weekday "
                    "FROM trades t LEFT JOIN sessions s USING(session_id)")
    con.commit()
    return con


def show(con, sql):
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description]
    print(" | ".join(cols))
    for row in cur.fetchall():
        print(" | ".join("" if row[c] is None else str(row[c]) for c in cols))


def report(con):
    print("== fade vs aligned by regime ==")
    show(con, """SELECT regime, fade_or_aligned,
      COUNT(*) n, ROUND(100.0*SUM(pnl_ticks>0)/COUNT(*),1) wr, SUM(pnl_ticks) net_tk
      FROM v_trades GROUP BY regime, fade_or_aligned ORDER BY regime, net_tk DESC""")
    print("\n== grade distribution ==")
    show(con, "SELECT grade, COUNT(DISTINCT session_id) sessions FROM v_trades GROUP BY grade")
    print("\n== overtrading: trades vs net $ per session ==")
    show(con, """SELECT real_date, session_id, COUNT(*) n, ROUND(SUM(pnl_net),1) net_usd
      FROM trades GROUP BY session_id ORDER BY n DESC LIMIT 8""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sql")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--schema", action="store_true")
    args = ap.parse_args()
    con = load_db()
    if args.schema:
        show(con, "SELECT name FROM pragma_table_info('trades')")
    elif args.sql:
        show(con, args.sql)
    else:
        report(con)


if __name__ == "__main__":
    main()
