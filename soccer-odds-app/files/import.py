import requests
from datetime import datetime
from dotenv import load_dotenv
import os
import sys
import sqlite3
import json

# Load environment variables from .env
load_dotenv()

API_KEY = os.getenv("API_SPORTS_KEY")
if not API_KEY:
    print("Error: API_SPORTS_KEY not found in .env file")
    sys.exit(1)

HEADERS = {
    "x-apisports-key": API_KEY
}

BASE_URL = "https://v3.football.api-sports.io"
LEAGUE_ID = 39  # Premier League
DB_PATH = os.path.join(os.path.dirname(__file__), "server", "matches.db")

# Get current year and calculate season range (past 20 seasons)
current_year = datetime.now().year
current_month = datetime.now().month
current_season_start = current_year - 1 if current_month < 8 else current_year
SEASON_STARTS = [current_season_start - i for i in range(20)]


# ---------------------------------------------------------------------------
# Database setup
# ---------------------------------------------------------------------------

def init_db(conn):
    """Create tables if they don't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            fixture_id   INTEGER PRIMARY KEY,
            home         TEXT NOT NULL,
            away         TEXT NOT NULL,
            home_id      INTEGER,
            away_id      INTEGER,
            league       TEXT,
            season       INTEGER,
            match_time   TEXT,
            status       TEXT,
            odds         TEXT,   -- JSON: {"Home": "2.10", "Draw": "3.40", "Away": "3.20"}
            home_form    TEXT,   -- JSON array: ["W","W","D","L","W"]
            away_form    TEXT,   -- JSON array
            fetched_at   TEXT
        )
    """)
    conn.commit()


def upsert_match(conn, row):
    """Insert or replace a match row."""
    conn.execute("""
        INSERT OR REPLACE INTO matches
            (fixture_id, home, away, home_id, away_id, league, season,
             match_time, status, odds, home_form, away_form, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, row)
    conn.commit()


# ---------------------------------------------------------------------------
# API helpers  (unchanged from original, no printing)
# ---------------------------------------------------------------------------

def get_today_matches():
    today = datetime.now().strftime("%Y-%m-%d")
    matches = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?date={today}&league={LEAGUE_ID}&season={season}"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                matches.extend(res.json()["response"])
        except Exception:
            continue
    return matches


def get_upcoming_matches():
    matches = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?league={LEAGUE_ID}&season={season}"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                season_matches = [
                    m for m in res.json()["response"]
                    if m["fixture"]["status"]["short"] == "NS"
                ]
                matches.extend(season_matches)
        except Exception:
            continue
    return matches[:10]


def get_last_completed_matches():
    matches = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?league={LEAGUE_ID}&season={season}&status=FT"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                matches.extend(res.json()["response"])
        except Exception:
            continue

    if not matches:
        return []
    matches.sort(key=lambda x: x["fixture"]["date"], reverse=True)
    latest_date = matches[0]["fixture"]["date"][:10]
    return [m for m in matches if m["fixture"]["date"][:10] == latest_date][:10]


def get_odds(fixture_id):
    url = f"{BASE_URL}/odds?fixture={fixture_id}"
    try:
        res = requests.get(url, headers=HEADERS)
        if res.status_code != 200:
            return {}
        bookmakers = res.json()["response"]
        if not bookmakers:
            return {}
        one_x_two = None
        for bm in bookmakers:
            for bet in bm.get("bets", []):
                if bet["name"] == "Match Winner":
                    one_x_two = bet
                    break
            if one_x_two:
                break
        if not one_x_two:
            return {}
        odds = {}
        for o in one_x_two["values"]:
            odds[o["value"]] = o["odd"]
        return odds
    except Exception:
        return {}


def get_team_form(team_id):
    all_fixtures = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?team={team_id}&season={season}&status=FT"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                all_fixtures.extend(res.json()["response"])
        except Exception:
            continue

    all_fixtures.sort(key=lambda x: x["fixture"]["date"], reverse=True)
    recent = all_fixtures[:5]
    form = []
    for f in recent:
        home_win = f["teams"]["home"].get("winner")
        away_win = f["teams"]["away"].get("winner")
        is_home = f["teams"]["home"]["id"] == team_id
        if home_win is None or away_win is None:
            form.append("D")
        elif (is_home and home_win) or (not is_home and away_win):
            form.append("W")
        elif (is_home and away_win) or (not is_home and home_win):
            form.append("L")
        else:
            form.append("D")
    return form


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Ensure server/ directory exists
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    print("\nFetching Premier League matches...\n")

    matches = get_today_matches()

    if not matches:
        print("No matches today. Fetching upcoming matches...\n")
        matches = get_upcoming_matches()

    if not matches:
        print("No upcoming matches. Fetching last completed matchday...\n")
        matches = get_last_completed_matches()

    if not matches:
        print("No Premier League matches found.")
        conn.close()
        sys.exit(0)

    fetched_at = datetime.utcnow().isoformat()
    saved = 0

    for match in matches:
        fixture_id = match["fixture"]["id"]
        home      = match["teams"]["home"]["name"]
        away      = match["teams"]["away"]["name"]
        home_id   = match["teams"]["home"]["id"]
        away_id   = match["teams"]["away"]["id"]
        league    = match["league"]["name"]
        season    = match["league"]["season"]
        time_str  = match["fixture"]["date"]
        status    = match["fixture"]["status"]["short"]

        print(f"Processing: {home} vs {away} ...", end=" ", flush=True)

        odds      = get_odds(fixture_id)
        home_form = get_team_form(home_id)
        away_form = get_team_form(away_id)

        upsert_match(conn, (
            fixture_id, home, away, home_id, away_id,
            league, season, time_str, status,
            json.dumps(odds),
            json.dumps(home_form),
            json.dumps(away_form),
            fetched_at
        ))

        saved += 1
        print("saved ✓")

    conn.close()
    print(f"\n✅  {saved} match(es) saved to {DB_PATH}")
    print(f"   Last fetched: {fetched_at} UTC")
    print("\nRun `npm start` (or `npm run dev`) to serve the app.\n")


if __name__ == "__main__":
    main()
