"""
import_historical.py
--------------------
Reads all Premier League season CSV files and loads them into SQLite.

Usage:
    python import_historical.py                        # scans ./data/ for csv files
    python import_historical.py path/to/data/          # custom data directory

Expected file naming: anything ending in .csv inside the data directory.
Expected columns (football-data.org format):
    Div, Date, Time, HomeTeam, AwayTeam,
    FTHG, FTAG, FTR,          <- full-time goals / result
    HTHG, HTAG, HTR,          <- half-time goals / result
    HS, AS, HST, AST,         <- shots / shots on target
    HF, AF, HC, AC,           <- fouls, corners
    HY, AY, HR, AR,           <- yellows, reds
    AvgH, AvgD, AvgA          <- average bookmaker odds
"""

import os
import sys
import sqlite3
import json
import glob
import pandas as pd
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "server", "matches.db")
DATA_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "data")


# ---------------------------------------------------------------------------
# DB setup
# ---------------------------------------------------------------------------

def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS results (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            season      TEXT,
            div         TEXT,
            match_date  TEXT,
            match_time  TEXT,
            home        TEXT NOT NULL,
            away        TEXT NOT NULL,
            fthg        INTEGER,
            ftag        INTEGER,
            ftr         TEXT,
            hthg        INTEGER,
            htag        INTEGER,
            htr         TEXT,
            hs          INTEGER,
            as_         INTEGER,
            hst         INTEGER,
            ast         INTEGER,
            hf          INTEGER,
            af          INTEGER,
            hc          INTEGER,
            ac          INTEGER,
            hy          INTEGER,
            ay          INTEGER,
            hr          INTEGER,
            ar          INTEGER,
            avg_h       REAL,
            avg_d       REAL,
            avg_a       REAL,
            UNIQUE(match_date, home, away)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_results_home ON results(home);
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_results_away ON results(away);
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_results_date ON results(match_date);
    """)
    conn.commit()


def safe_int(val):
    try:
        if pd.isna(val):
            return None
        return int(val)
    except Exception:
        return None


def safe_float(val):
    try:
        if pd.isna(val):
            return None
        return float(val)
    except Exception:
        return None


def safe_str(val):
    try:
        if pd.isna(val):
            return None
        return str(val).strip()
    except Exception:
        return None


def parse_date(val):
    """Normalise date to YYYY-MM-DD."""
    if pd.isna(val):
        return None
    if isinstance(val, datetime):
        return val.strftime("%Y-%m-%d")
    s = str(val).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d/%m/%y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return s


def infer_season(filepath):
    """Try to pull season from filename, e.g. '2024-25.xlsx' -> '2024-25'."""
    name = os.path.splitext(os.path.basename(filepath))[0]
    return name


def load_file(filepath, conn):
    season = infer_season(filepath)
    try:
        df = pd.read_csv(filepath, encoding="utf-8", on_bad_lines="skip")
    except Exception as e:
        print(f"  ✗ Could not read {filepath}: {e}")
        return 0

    # Normalise column names (strip whitespace)
    df.columns = [c.strip() for c in df.columns]

    # Require at minimum these columns
    required = {"HomeTeam", "AwayTeam", "Date"}
    missing = required - set(df.columns)
    if missing:
        print(f"  ✗ Skipping {filepath} — missing columns: {missing}")
        return 0

    inserted = 0
    skipped = 0

    for _, row in df.iterrows():
        home = safe_str(row.get("HomeTeam"))
        away = safe_str(row.get("AwayTeam"))
        date = parse_date(row.get("Date"))

        if not home or not away or not date:
            skipped += 1
            continue

        try:
            conn.execute("""
                INSERT OR IGNORE INTO results
                    (season, div, match_date, match_time,
                     home, away,
                     fthg, ftag, ftr,
                     hthg, htag, htr,
                     hs, as_, hst, ast,
                     hf, af, hc, ac,
                     hy, ay, hr, ar,
                     avg_h, avg_d, avg_a)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                season,
                safe_str(row.get("Div")),
                date,
                safe_str(row.get("Time")),
                home, away,
                safe_int(row.get("FTHG")), safe_int(row.get("FTAG")), safe_str(row.get("FTR")),
                safe_int(row.get("HTHG")), safe_int(row.get("HTAG")), safe_str(row.get("HTR")),
                safe_int(row.get("HS")),   safe_int(row.get("AS")),
                safe_int(row.get("HST")),  safe_int(row.get("AST")),
                safe_int(row.get("HF")),   safe_int(row.get("AF")),
                safe_int(row.get("HC")),   safe_int(row.get("AC")),
                safe_int(row.get("HY")),   safe_int(row.get("AY")),
                safe_int(row.get("HR")),   safe_int(row.get("AR")),
                safe_float(row.get("AvgH")),
                safe_float(row.get("AvgD")),
                safe_float(row.get("AvgA")),
            ))
            inserted += 1
        except Exception as e:
            skipped += 1
            continue

    conn.commit()
    return inserted


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    if not os.path.isdir(DATA_DIR):
        print(f"Error: data directory not found: {DATA_DIR}")
        print("Create a ./data/ folder and put your xlsx files there, or pass the path as an argument.")
        sys.exit(1)

    files = sorted(glob.glob(os.path.join(DATA_DIR, "*.csv")))
    if not files:
        print(f"No csv files found in {DATA_DIR}")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    total = 0
    print(f"\nImporting {len(files)} file(s) into {DB_PATH}\n")

    for f in files:
        print(f"  Loading {os.path.basename(f)} ...", end=" ", flush=True)
        n = load_file(f, conn)
        print(f"{n} rows inserted")
        total += n

    conn.close()

    print(f"\n✅  Done — {total} total rows saved to results table.")
    print(f"   Run import_fixtures.py next to fetch upcoming matches.\n")


if __name__ == "__main__":
    main()
