const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data/soccer.db');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

// Initialize tables
db.serialize(() => {
  // Matches table
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      fixture_id INTEGER UNIQUE,
      date TEXT,
      home_team TEXT,
      away_team TEXT,
      home_team_id INTEGER,
      away_team_id INTEGER,
      league TEXT,
      status TEXT,
      season INTEGER,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Odds table
  db.run(`
    CREATE TABLE IF NOT EXISTS odds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fixture_id INTEGER,
      home_odd REAL,
      draw_odd REAL,
      away_odd REAL,
      bookmaker TEXT,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(fixture_id) REFERENCES matches(fixture_id)
    )
  `);

  // Team form table
  db.run(`
    CREATE TABLE IF NOT EXISTS team_form (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER,
      season INTEGER,
      form TEXT,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, season)
    )
  `);

  // Cache metadata table
  db.run(`
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Helper to get last fetch time
function getLastFetchTime(season) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT value FROM cache_meta WHERE key = ?`,
      [`last_fetch_season_${season}`],
      (err, row) => {
        if (err) reject(err);
        resolve(row ? row.value : null);
      }
    );
  });
}

// Helper to set last fetch time
function setLastFetchTime(season, timestamp) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO cache_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [`last_fetch_season_${season}`, timestamp],
      (err) => {
        if (err) reject(err);
        resolve();
      }
    );
  });
}

// Check if season data is fresh (fetched within N hours)
function isSeasonDataFresh(season, hours = 24) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT updated_at FROM cache_meta WHERE key = ?`,
      [`last_fetch_season_${season}`],
      (err, row) => {
        if (err) reject(err);
        if (!row) {
          resolve(false);
        } else {
          const fetchedTime = new Date(row.updated_at);
          const now = new Date();
          const diffHours = (now - fetchedTime) / (1000 * 60 * 60);
          resolve(diffHours < hours);
        }
      }
    );
  });
}

// Get cached matches for a season
function getCachedMatches(season) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM matches WHERE season = ? ORDER BY date DESC`,
      [season],
      (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      }
    );
  });
}

// Get cached odds for a fixture
function getCachedOdds(fixtureId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM odds WHERE fixture_id = ? ORDER BY fetched_at DESC LIMIT 1`,
      [fixtureId],
      (err, row) => {
        if (err) reject(err);
        resolve(row);
      }
    );
  });
}

// Get cached team form
function getCachedTeamForm(teamId, season) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT form FROM team_form WHERE team_id = ? AND season = ?`,
      [teamId, season],
      (err, row) => {
        if (err) reject(err);
        resolve(row ? JSON.parse(row.form) : null);
      }
    );
  });
}

// Save match to cache
function saveMatch(match) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO matches
       (fixture_id, date, home_team, away_team, home_team_id, away_team_id, league, status, season)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        match.fixture.id,
        match.fixture.date,
        match.teams.home.name,
        match.teams.away.name,
        match.teams.home.id,
        match.teams.away.id,
        match.league.name,
        match.fixture.status.short,
        match.season
      ],
      (err) => {
        if (err) reject(err);
        resolve();
      }
    );
  });
}

// Save odds to cache
function saveOdds(fixtureId, odds, bookmaker) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO odds (fixture_id, home_odd, draw_odd, away_odd, bookmaker) VALUES (?, ?, ?, ?, ?)`,
      [
        fixtureId,
        odds?.Home ? parseFloat(odds.Home) : null,
        odds?.Draw ? parseFloat(odds.Draw) : null,
        odds?.Away ? parseFloat(odds.Away) : null,
        bookmaker || 'default'
      ],
      (err) => {
        if (err) reject(err);
        resolve();
      }
    );
  });
}

// Save team form to cache
function saveTeamForm(teamId, season, form) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO team_form (team_id, season, form) VALUES (?, ?, ?)`,
      [teamId, season, JSON.stringify(form)],
      (err) => {
        if (err) reject(err);
        resolve();
      }
    );
  });
}

// Close database connection
function closeDb() {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      resolve();
    });
  });
}

module.exports = {
  db,
  getLastFetchTime,
  setLastFetchTime,
  isSeasonDataFresh,
  getCachedMatches,
  getCachedOdds,
  getCachedTeamForm,
  saveMatch,
  saveOdds,
  saveTeamForm,
  closeDb
};
