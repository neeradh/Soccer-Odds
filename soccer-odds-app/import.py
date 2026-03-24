import requests
from datetime import datetime
from dotenv import load_dotenv
import os
import sys

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

# Get current year and calculate season range (past 20 seasons)
current_year = datetime.now().year
current_month = datetime.now().month
# Season year: if we're before August, use previous year as season start
current_season_start = current_year - 1 if current_month < 8 else current_year
SEASON_STARTS = [current_season_start - i for i in range(20)]  # Past 20 seasons


def get_today_matches():
    """Fetch today's Premier League matches across all 20 seasons."""
    today = datetime.now().strftime("%Y-%m-%d")
    matches = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?date={today}&league={LEAGUE_ID}&season={season}"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                matches.extend(res.json()["response"])
        except Exception:
            continue  # Skip seasons with no data
    return matches


def get_upcoming_matches():
    """Fetch upcoming Premier League matches across all 20 seasons."""
    matches = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?league={LEAGUE_ID}&season={season}"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                season_matches = [m for m in res.json()["response"] if m["fixture"]["status"]["short"] == "NS"]
                matches.extend(season_matches)
        except Exception:
            continue  # Skip seasons with no data
    return matches[:10]


def get_last_completed_matches():
    """Fetch the most recent finished matches across all 20 seasons."""
    matches = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?league={LEAGUE_ID}&season={season}&status=FT"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                matches.extend(res.json()["response"])
        except Exception:
            continue  # Skip seasons with no data

    if not matches:
        return []
    # Sort by date descending, take the most recent matchday
    matches.sort(key=lambda x: x["fixture"]["date"], reverse=True)
    latest_date = matches[0]["fixture"]["date"][:10]
    return [m for m in matches if m["fixture"]["date"][:10] == latest_date][:10]


def get_odds(fixture_id):
    """Fetch 1X2 (Match Winner) odds for a fixture."""
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
    """Fetch last 5 finished matches for a team across all 20 seasons and return form (W/D/L)."""
    all_fixtures = []
    for season in SEASON_STARTS:
        try:
            url = f"{BASE_URL}/fixtures?team={team_id}&season={season}&status=FT"
            res = requests.get(url, headers=HEADERS)
            if res.status_code == 200:
                all_fixtures.extend(res.json()["response"])
        except Exception:
            continue  # Skip seasons with no data

    # Sort by date descending, take last 5
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


def format_form(form):
    """Format form list as colored string."""
    if not form:
        return "N/A"
    labels = {"W": "\033[92mW\033[0m", "D": "\033[90mD\033[0m", "L": "\033[91mL\033[0m"}
    return " ".join(labels.get(r, r) for r in form)


def print_match(match):
    home = match["teams"]["home"]["name"]
    away = match["teams"]["away"]["name"]
    league = match["league"]["name"]
    time = datetime.fromisoformat(match["fixture"]["date"].replace("Z", "+00:00"))
    time_str = time.strftime("%a %d %b %Y, %H:%M UTC")

    odds = match.get("odds", {})
    home_odd = odds.get("Home", "N/A")
    draw_odd = odds.get("Draw", "N/A")
    away_odd = odds.get("Away", "N/A")

    home_form = match.get("home_form", [])
    away_form = match.get("away_form", [])

    print("=" * 60)
    print(f"  {home} vs {away}")
    print(f"  {league}  |  {time_str}")
    print("-" * 60)
    print(f"  {'Odds':<12}  {'Home':>6}   {'Draw':>6}   {'Away':>6}")
    print(f"  {' ':<12}  {str(home_odd):>6}   {str(draw_odd):>6}   {str(away_odd):>6}")
    print(f"  {'Form':<12}  {format_form(home_form):<20}  {format_form(away_form)}")
    print()


def main():
    print("\nFetching Premier League matches...\n")

    # 1. Try today's matches
    try:
        matches = get_today_matches()
    except Exception as e:
        print(f"Error fetching today's matches: {e}")
        sys.exit(1)

    # 2. Fallback to upcoming if none today
    if not matches:
        print("No matches today. Fetching upcoming matches...\n")
        matches = get_upcoming_matches()

    # 3. Fallback to last completed matchday if no upcoming either
    if not matches:
        print("No upcoming matches. Showing last completed matchday...\n")
        matches = get_last_completed_matches()

    if not matches:
        print("No Premier League matches found.")
        sys.exit(0)

    # 3. Enrich with odds and form for each match
    for match in matches:
        fixture_id = match["fixture"]["id"]
        home_id = match["teams"]["home"]["id"]
        away_id = match["teams"]["away"]["id"]

        print(f"Processing: {match['teams']['home']['name']} vs {match['teams']['away']['name']} ...", end=" ", flush=True)

        odds = get_odds(fixture_id)
        home_form = get_team_form(home_id)
        away_form = get_team_form(away_id)

        match["odds"] = odds
        match["home_form"] = home_form
        match["away_form"] = away_form

        print("done")

    print(f"\n{' PREMIER LEAGUE MATCHES ':-^60}")
    print()

    for match in matches:
        print_match(match)

    print(f"{'':~<60}")


if __name__ == "__main__":
    main()
