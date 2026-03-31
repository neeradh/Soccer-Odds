require("dotenv").config();
const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "matches.db");

// ---------------------------------------------------------------------------
// DB helper — opens a read-only connection per request (safe for concurrent
// reads; import.py writes are short-lived so no WAL needed for this scale)
// ---------------------------------------------------------------------------
function getDb() {
  return new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
      // Will be caught per-request below
    }
  });
}

function queryAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ---------------------------------------------------------------------------
// Static files — serve index.html from project root
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "..")));

// ---------------------------------------------------------------------------
// GET /api/matches
// Returns all stored matches shaped to match what index.html expects:
// { id, time, home, away, league, status, odds, form, fetched_at }
// ---------------------------------------------------------------------------
app.get("/api/matches", async (req, res) => {
  // Check DB exists before trying to open it
  const fs = require("fs");
  if (!fs.existsSync(DB_PATH)) {
    return res.status(503).json({
      error: "Database not found. Run `python import.py` first to populate match data.",
    });
  }

  const db = getDb();

  try {
    const rows = await queryAll(
      db,
      `SELECT * FROM matches ORDER BY match_time ASC`
    );

    const matches = rows.map((row) => {
      let odds = {};
      let home_form = [];
      let away_form = [];

      try { odds = JSON.parse(row.odds || "{}"); } catch (_) {}
      try { home_form = JSON.parse(row.home_form || "[]"); } catch (_) {}
      try { away_form = JSON.parse(row.away_form || "[]"); } catch (_) {}

      return {
        id: row.fixture_id,
        time: row.match_time,
        home: row.home,
        away: row.away,
        league: row.league,
        season: row.season,
        status: row.status,
        odds,
        // index.html reads form as: match.form?.[match.home] and match.form?.[match.away]
        form: {
          [row.home]: home_form,
          [row.away]: away_form,
        },
        fetched_at: row.fetched_at,
      };
    });

    res.json(matches);
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Failed to read match data from database." });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// GET /api/status  — quick health check + last fetch time
// ---------------------------------------------------------------------------
app.get("/api/status", async (req, res) => {
  const fs = require("fs");
  if (!fs.existsSync(DB_PATH)) {
    return res.json({ ok: false, message: "Database not found. Run import.py first." });
  }

  const db = getDb();
  try {
    const rows = await queryAll(
      db,
      `SELECT COUNT(*) as count, MAX(fetched_at) as last_fetched FROM matches`
    );
    const { count, last_fetched } = rows[0];
    res.json({ ok: true, match_count: count, last_fetched });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n⚽  Match Center running at http://localhost:${PORT}`);
  console.log(`   API:    http://localhost:${PORT}/api/matches`);
  console.log(`   Status: http://localhost:${PORT}/api/status`);
  console.log(`\n   Tip: run "python import.py" to refresh match data.\n`);
});
