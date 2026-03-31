"""
import_fixtures.py
------------------
Fetches ONLY upcoming (NS) Premier League fixtures from api-sports.io.
This makes a single API call — no odds fetching, no form fetching.
Form is calculated from the local results table at serve time.

Usage:
    python import_fixtures.py
"""

import os
import sys
import sqlite3
import requests
import json
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("API_SPORTS_KEY")
if not API_KEY:
    print("Error: API_SPORTS_KEY not found in .env file")
    sys.exit(1)

DB_PATH = os.path.join(os.path.dirname(__file__), "server", "matches.db")
BASE_URL = "https://v3.football.api-sports.io"
LEAGUE_ID = 39  # Premier League

# Current season year (e.g. 2025 for the 2025-26 season)
current_year = datetime.now().year
current_month = datetime.now().month
SEASON = current_year if current_month >= 8 else current_year - 1


# ---------------------------------------------------------------------------
# DB setup
# ---------------------------------------------------------------------------

def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fixtures (
            fixture_id  INTEGER PRIMARY KEY,
            home        TEXT NOT NULL,
            away        TEXT NOT NULL,
            match_date  TEXT,
            match_time  TEXT,
            league      TEXT,
            season      INTEGER,
            status      TEXT,
            fetched_at  TEXT
        )
    """)
    conn.commit()


# ---------------------------------------------------------------------------
# API — single call
# ---------------------------------------------------------------------------

def fetch_upcoming():
    """One request: all NS fixtures for current season."""
    url = f"{BASE_URL}/fixtures?league={LEAGUE_ID}&season={SEASON}&status=NS"
    print(f"  GET {url}")
    res = requests.get(url, headers={"x-apisports-key": API_KEY}, timeout=15)

    if res.status_code != 200:
        print(f"  API error: {res.status_code} — {res.text[:200]}")
        sys.exit(1)

    data = res.json()
    remaining = res.headers.get("x-ratelimit-requests-remaining", "?")
    print(f"  API calls remaining today: {remaining}")

    return data.get("response", [])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    print(f"\nFetching upcoming Premier League fixtures (season {SEASON})...\n")

    fixtures = fetch_upcoming()

    if not fixtures:
        print("No upcoming fixtures returned by API.")
        conn.close()
        sys.exit(0)

    fetched_at = datetime.utcnow().isoformat()
    saved = 0

    # Clear old upcoming fixtures before re-inserting (keeps data fresh)
    conn.execute("DELETE FROM fixtures")

    for f in fixtures:
        fixture_id = f["fixture"]["id"]
        home       = f["teams"]["home"]["name"]
        away       = f["teams"]["away"]["name"]
        dt         = f["fixture"]["date"]  # ISO8601 e.g. "2025-09-14T14:00:00+00:00"
        status     = f["fixture"]["status"]["short"]
        league     = f["league"]["name"]
        season     = f["league"]["season"]

        # Split into date and time for easier querying
        try:
            parsed = datetime.fromisoformat(dt.replace("Z", "+00:00"))
            match_date = parsed.strftime("%Y-%m-%d")
            match_time = parsed.strftime("%H:%M")
        except Exception:
            match_date = dt[:10]
            match_time = None

        conn.execute("""
            INSERT OR REPLACE INTO fixtures
                (fixture_id, home, away, match_date, match_time,
                 league, season, status, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (fixture_id, home, away, match_date, match_time,
              league, season, status, fetched_at))
        saved += 1

    conn.commit()
    conn.close()

    print(f"\n✅  {saved} upcoming fixture(s) saved to fixtures table.")
    print(f"   Last fetched: {fetched_at} UTC")
    print("\nRun `npm start` to serve the app.\n")


if __name__ == "__main__":
    main()
