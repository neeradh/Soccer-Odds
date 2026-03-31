/**
 * test/api.test.js
 * ----------------
 * Integration tests for all /api endpoints.
 * Uses an in-memory SQLite DB seeded with known data.
 *
 * Run:  node test/api.test.js
 * (No test framework needed — uses Node's built-in assert)
 */

process.env.NODE_ENV = "test";
process.env.DB_PATH  = ":memory:";

const assert  = require("assert");
const http    = require("http");
const path    = require("path");
const sqlite3 = require("sqlite3").verbose();

// ─── Seed an in-memory DB ────────────────────────────────────────────────────
function seedDb(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        season TEXT, div TEXT, match_date TEXT, match_time TEXT,
        home TEXT, away TEXT,
        fthg INTEGER, ftag INTEGER, ftr TEXT,
        hthg INTEGER, htag INTEGER, htr TEXT,
        hs INTEGER, as_ INTEGER, hst INTEGER, ast INTEGER,
        hf INTEGER, af INTEGER, hc INTEGER, ac INTEGER,
        hy INTEGER, ay INTEGER, hr INTEGER, ar INTEGER,
        avg_h REAL, avg_d REAL, avg_a REAL,
        UNIQUE(match_date, home, away)
      )`);
      db.run(`CREATE TABLE fixtures (
        fixture_id INTEGER PRIMARY KEY,
        home TEXT, away TEXT,
        match_date TEXT, match_time TEXT,
        league TEXT, season INTEGER, status TEXT, fetched_at TEXT
      )`);

      // Historical results: Arsenal vs Chelsea (Arsenal dominant at home)
      const results = [
        ["2023-24", "E0", "2024-01-01", "15:00", "Arsenal",  "Chelsea",  2, 0, "H", 1, 0, "H"],
        ["2023-24", "E0", "2023-08-14", "20:00", "Chelsea",  "Arsenal",  0, 1, "A", 0, 0, "D"],
        ["2022-23", "E0", "2023-02-01", "15:00", "Arsenal",  "Chelsea",  3, 1, "H", 2, 0, "H"],
        ["2022-23", "E0", "2022-11-06", "16:30", "Chelsea",  "Arsenal",  0, 1, "A", 0, 1, "A"],
        ["2021-22", "E0", "2022-04-20", "17:30", "Arsenal",  "Chelsea",  4, 2, "H", 2, 1, "H"],
        ["2021-22", "E0", "2021-12-22", "20:15", "Chelsea",  "Arsenal",  2, 2, "D", 1, 1, "D"],
        // Extra Arsenal home results for form
        ["2023-24", "E0", "2024-03-01", "15:00", "Arsenal",  "Wolves",   3, 0, "H", 1, 0, "H"],
        ["2023-24", "E0", "2024-02-03", "15:00", "Arsenal",  "Liverpool",1, 1, "D", 0, 0, "D"],
        ["2023-24", "E0", "2024-01-20", "15:00", "Arsenal",  "Tottenham",2, 2, "D", 1, 1, "D"],
        // Chelsea away
        ["2023-24", "E0", "2024-02-24", "15:00", "Liverpool","Chelsea",  4, 1, "H", 2, 0, "H"],
        ["2023-24", "E0", "2024-01-13", "15:00", "Man City", "Chelsea",  1, 0, "H", 0, 0, "D"],
      ];

      const stmt = db.prepare(`INSERT OR IGNORE INTO results
        (season,div,match_date,match_time,home,away,fthg,ftag,ftr,hthg,htag,htr)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of results) stmt.run(r);
      stmt.finalize();

      // Upcoming fixture
      db.run(`INSERT INTO fixtures VALUES (99001,'Arsenal','Chelsea','2025-09-14','14:00','Premier League',2025,'NS',datetime('now'))`,
        (err) => err ? reject(err) : resolve()
      );
    });
  });
}

// ─── Spin up a real HTTP server backed by in-memory DB ───────────────────────
// We patch the DB_PATH before requiring the server module.
// The server uses process.env.DB_PATH, so we swap in a custom openDb.

let server, baseUrl;

async function startServer() {
  return new Promise(async (resolve) => {
    // We need to inject the in-memory db — patch openDb via a thin wrapper
    // by writing a temp override module. Simpler: just start the real server
    // with DB_PATH=":memory:" and seed before first request.
    // Since sqlite3 in-memory DBs are per-connection, we seed via the test
    // helper endpoint we inject below.

    // Actually the cleanest approach without monkey-patching:
    // write a real temp file DB, seed it, point server at it.
    const tmpDb = path.join(require("os").tmpdir(), `test_${Date.now()}.db`);
    process.env.DB_PATH = tmpDb;

    const db = new sqlite3.Database(tmpDb);
    await seedDb(db);
    db.close();

    // Now require the server (after env is set)
    // We do a fresh require by clearing cache
    Object.keys(require.cache).forEach(k => { if (k.includes("index")) delete require.cache[k]; });

    // The server calls app.listen — we capture it via the exports
    // Since our server doesn't export app, we start it and wait for the port.
    const PORT = 13999;
    process.env.PORT = String(PORT);
    require("./index");

    baseUrl = `http://localhost:${PORT}`;
    setTimeout(() => resolve(tmpDb), 300); // give server time to bind
  });
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let body = "";
      r.on("data", d => body += d);
      r.on("end",  () => {
        try { res({ status: r.statusCode, headers: r.headers, body: JSON.parse(body) }); }
        catch { res({ status: r.statusCode, headers: r.headers, body }); }
      });
    }).on("error", rej);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  return fn().then(() => { console.log(`  ✅  ${name}`); passed++; })
             .catch(e  => { console.error(`  ❌  ${name}\n     ${e.message}`); failed++; });
}

async function run() {
  const tmpDb = await startServer();
  console.log("\n⚽  Running API integration tests\n");

  await test("GET /api/status returns ok:true", async () => {
    const r = await get(`${baseUrl}/api/status`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.results.count > 0, "should have results");
    assert.ok(r.body.upcoming_fixtures.count > 0, "should have fixtures");
  });

  await test("GET /api/matches returns match array with prediction", async () => {
    const r = await get(`${baseUrl}/api/matches`);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.matches), "body.matches should be array");
    assert.ok(r.body.matches.length > 0, "should have at least one match");
    const m = r.body.matches[0];
    assert.strictEqual(m.home, "Arsenal");
    assert.strictEqual(m.away, "Chelsea");
    assert.ok(m.prediction, "should have prediction");
    assert.ok(typeof m.prediction.home === "number", "prediction.home should be number");
    assert.strictEqual(m.prediction.home + m.prediction.draw + m.prediction.away, 100, "percentages should sum to 100");
  });

  await test("GET /api/matches form arrays are populated", async () => {
    const r = await get(`${baseUrl}/api/matches`);
    const m = r.body.matches[0];
    assert.ok(m.form["Arsenal"].length > 0, "home form should not be empty");
    assert.ok(["W","D","L"].includes(m.form["Arsenal"][0]), "form entries should be W/D/L");
  });

  await test("GET /api/matches includes stale meta", async () => {
    const r = await get(`${baseUrl}/api/matches`);
    assert.ok("stale" in r.body.meta, "meta.stale should exist");
    assert.ok("hours_since_fetch" in r.body.meta, "meta.hours_since_fetch should exist");
  });

  await test("GET /api/matches returns ETag header", async () => {
    const r = await get(`${baseUrl}/api/matches`);
    assert.ok(r.headers.etag, "should have ETag header");
    assert.ok(r.headers["cache-control"], "should have Cache-Control header");
  });

  await test("GET /api/h2h returns meeting history", async () => {
    const r = await get(`${baseUrl}/api/h2h?home=Arsenal&away=Chelsea`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.meetings.length > 0, "should have meetings");
    assert.ok(r.body.summary.home_wins >= 0, "should have summary");
    assert.strictEqual(r.body.summary.home_wins + r.body.summary.draws + r.body.summary.away_wins, r.body.meetings.length);
  });

  await test("GET /api/h2h 400 on missing params", async () => {
    const r = await get(`${baseUrl}/api/h2h?home=Arsenal`);
    assert.strictEqual(r.status, 400);
  });

  await test("GET /api/h2h 400 on invalid team name", async () => {
    const r = await get(`${baseUrl}/api/h2h?home=${encodeURIComponent("<script>")}&away=Chelsea`);
    assert.strictEqual(r.status, 400);
  });

  await test("GET /api/results returns rows", async () => {
    const r = await get(`${baseUrl}/api/results?team=Arsenal&limit=5`);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.ok(r.body.length > 0);
  });

  await test("GET /api/results 400 on invalid season format", async () => {
    const r = await get(`${baseUrl}/api/results?season=badformat`);
    assert.strictEqual(r.status, 400);
  });

  await test("GET /api/results respects limit cap", async () => {
    const r = await get(`${baseUrl}/api/results?limit=99999`);
    assert.strictEqual(r.status, 200, "should succeed, just capped");
  });

  await test("GET /api/unknown returns 404", async () => {
    const r = await get(`${baseUrl}/api/unknown-route`);
    assert.strictEqual(r.status, 404);
  });

  // Cleanup
  try { require("fs").unlinkSync(tmpDb); } catch {}

  console.log(`\n   ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
