# ⚽ Match Centre

A Premier League match dashboard with statistical predictions, form guides, and head-to-head history. Built with Node.js, Express, SQLite, and vanilla JS.

![dark UI with match cards showing predictions and form badges]

---

## Features

- **Match predictions** — weighted model blending H2H history, home venue record, and away venue record
- **Form guide** — last 5 results (W/D/L) for each team, calculated at serve time from historical data
- **Head-to-head** — last 20 meetings with score and result, loaded on demand
- **Live search** — filter matches by team name instantly
- **Stale data banner** — warns if fixture data is older than 24 hours
- **Auto-refresh** — page silently re-fetches every 5 minutes
- **10,479 historical results** — Premier League seasons from 1998–99 to 2025–26

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js 18+, Express 5 |
| Database | SQLite via `sqlite3` |
| Frontend | Vanilla JS, single HTML file |
| Data import | Python 3 (`pandas`, `requests`) |
| Container | Docker / docker-compose |

---

## Quick start

### 1. Install dependencies

```bash
npm install
pip install pandas requests python-dotenv
```

### 2. Configure environment

Create a `.env` file in the project root:

```
API_SPORTS_KEY=your_key_here
```

Get a free key at [api-sports.io](https://api-sports.io). The free plan covers seasons up to 2024.

### 3. Import historical data

```bash
python import_historical.py
```

Reads all CSV files from `./data/` (football-data.org format) and loads them into `server/matches.db`.

### 4. Import upcoming fixtures

```bash
python import_fixtures.py
```

Fetches upcoming (NS) Premier League fixtures from the API and saves them to the `fixtures` table.

### 5. Start the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

---

## npm scripts

| Command | Description |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with `--watch` (auto-restart on file changes) |
| `npm run import:historical` | Import all CSV files into the DB |
| `npm run import:fixtures` | Fetch upcoming fixtures from the API |
| `npm run setup` | Run both import scripts in sequence |
| `npm test` | Run API tests |

---

## API endpoints

### `GET /api/matches`
Returns all upcoming fixtures with predictions and last-5 form for each team.

```json
{
  "matches": [
    {
      "id": 123456,
      "time": "2025-04-05T15:00:00Z",
      "home": "Arsenal",
      "away": "Chelsea",
      "league": "Premier League",
      "status": "NS",
      "prediction": { "home": 48, "draw": 24, "away": 28, "confidence": "high", "data_points": 134 },
      "form": {
        "Arsenal":  ["W", "W", "D", "W", "L"],
        "Chelsea":  ["W", "L", "W", "D", "W"]
      }
    }
  ],
  "meta": { "stale": false, "hours_since_fetch": 2 }
}
```

### `GET /api/h2h?home=Arsenal&away=Chelsea`
Last 20 meetings between two teams with a win/draw/loss summary.

### `GET /api/results?team=Arsenal&season=2023-24`
Historical results. Both `YYYY-YY` (e.g. `2023-24`) and `YY_YY` (e.g. `23_24`) season formats are accepted. Supports `?limit=` up to 2000.

### `GET /api/status`
Database health check — result count, date range, fixture freshness.

---

## Prediction model

Probabilities are a weighted blend of three signals:

| Signal | Weight (when all available) |
|---|---|
| Head-to-head record (last 20) | 50% |
| Home team's home record (last 57) | 30% |
| Away team's away record (last 57) | 20% |

Falls back to home/away-only weights if H2H data is sparse, and to league-average priors if fewer than 5 games are available. Confidence is rated `high / medium / low` based on total data points.

---

## Data

Historical CSV files are sourced from [football-data.org](https://www.football-data.co.uk/englandm.php) and cover every Premier League season from 1998–99 onwards. Each file follows this naming convention: `YY_YY.csv` (e.g. `23_24.csv`).

Key columns used:

| Column | Description |
|---|---|
| `HomeTeam` / `AwayTeam` | Club names |
| `FTR` | Full-time result: `H` / `D` / `A` |
| `FTHG` / `FTAG` | Full-time goals |
| `AvgH` / `AvgD` / `AvgA` | Average bookmaker odds |

---

## Docker

```bash
docker-compose up
```

The app runs on port `3000` inside the container. Set environment variables in `docker-compose.yml` or via a `.env` file.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | Set to `production` to enforce auth |
| `API_TOKEN` | _(none)_ | Bearer token required in production |
| `DB_PATH` | `server/matches.db` | Path to the SQLite database |
| `STALE_HOURS` | `24` | Hours before fixtures are considered stale |
| `RATE_LIMIT_RPM` | `60` | Max requests per minute per IP |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS origins |
| `API_SPORTS_KEY` | _(required)_ | api-sports.io key for fixture imports |

---

## Project structure

```
soccer-odds-app/
├── index.js              # Express server — API routes, prediction model
├── index.html            # Frontend (single-file, no build step)
├── import_historical.py  # Load CSV season files into SQLite
├── import_fixtures.py    # Fetch upcoming fixtures from api-sports.io
├── data/                 # CSV files (98_99.csv → 25_26.csv)
├── server/
│   └── matches.db        # SQLite database (generated)
├── package.json
└── docker-compose.yml
```
