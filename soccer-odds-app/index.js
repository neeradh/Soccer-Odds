require("dotenv").config();

const express = require("express");
const path    = require("path");
const fs      = require("fs");
const zlib    = require("zlib");
const sqlite3 = require("sqlite3").verbose();

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT            || "3000", 10);
const NODE_ENV        = process.env.NODE_ENV                 || "development";
const API_TOKEN       = process.env.API_TOKEN                || "";
const DB_PATH         = process.env.DB_PATH                  || path.join(__dirname, "server", "matches.db");
const RATE_LIMIT_RPM  = parseInt(process.env.RATE_LIMIT_RPM  || "60", 10);
const STALE_HOURS     = parseInt(process.env.STALE_HOURS     || "24", 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",").map(s => s.trim());
const IS_PROD         = NODE_ENV === "production";

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

// ─── Rate limiter (no extra dep) ──────────────────────────────────────────────
const rlStore = new Map();
function rateLimit(req, res, next) {
  const ip  = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  let r = rlStore.get(ip);
  if (!r || now > r.reset) r = { count: 0, reset: now + 60_000 };
  r.count++;
  rlStore.set(ip, r);
  res.setHeader("X-RateLimit-Limit",     RATE_LIMIT_RPM);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT_RPM - r.count));
  res.setHeader("X-RateLimit-Reset",     Math.ceil(r.reset / 1000));
  if (r.count > RATE_LIMIT_RPM) {
    log("warn", "rate_limit", { ip });
    return res.status(429).json({ error: "Too many requests." });
  }
  next();
}
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of rlStore) if (n > v.reset) rlStore.delete(k);
}, 5 * 60_000);

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!IS_PROD && !API_TOKEN) return next();
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token || token !== API_TOKEN) {
    log("warn", "auth_fail", { ip: req.socket.remoteAddress, path: req.path });
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Gzip compression (no extra dep) ─────────────────────────────────────────
function compress(req, res, next) {
  if (!(req.headers["accept-encoding"] || "").includes("gzip")) return next();
  const _json = res.json.bind(res);
  res.json = (data) => {
    zlib.gzip(Buffer.from(JSON.stringify(data)), (err, buf) => {
      if (err) return _json(data);
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Type",     "application/json");
      res.setHeader("Vary",             "Accept-Encoding");
      res.end(buf);
    });
  };
  next();
}

// ─── ETag + Cache-Control ─────────────────────────────────────────────────────
function fnv32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
function withCache(maxAge) {
  return (req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (data) => {
      const tag = `"${fnv32(JSON.stringify(data))}"`;
      res.setHeader("ETag",          tag);
      res.setHeader("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=60`);
      if (req.headers["if-none-match"] === tag) return res.status(304).end();
      orig(data);
    };
    next();
  };
}

// ─── Input validation ─────────────────────────────────────────────────────────
const TEAM_RE   = /^[a-zA-Z0-9\s'\-\.&]{1,80}$/;
const SEASON_RE_LONG  = /^\d{4}-\d{2}$/;   // e.g. 2023-24
const SEASON_RE_SHORT = /^\d{2}_\d{2}$/;   // e.g. 23_24 (DB format)
const vTeam   = (s) => { if (!s) return null; const t = s.trim(); return TEAM_RE.test(t) ? t : null; };
// Accept 2023-24 or 23_24; normalise to DB format YY_YY
const vSeason = (s) => {
  if (!s) return null;
  if (SEASON_RE_SHORT.test(s)) return s;
  if (SEASON_RE_LONG.test(s)) {
    const [y4, y2] = s.split("-");
    return `${y4.slice(2)}_${y2}`;
  }
  return null;
};
const vLimit  = (s, def = 500, max = 2000) => { const n = parseInt(s, 10); return isNaN(n) ? def : Math.min(Math.max(1, n), max); };

// ─── DB helpers ───────────────────────────────────────────────────────────────
function openDb() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`DB not found at ${DB_PATH}. Run import scripts first.`);
  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
  db.run("PRAGMA busy_timeout=5000");
  return db;
}
const qa = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const qg = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// ─── Team name normalisation ──────────────────────────────────────────────────
// Maps API names (api-sports.io) → football-data.org names used in xlsx files.
// Run `node server/audit-names.js` to find any remaining mismatches.
const TEAM_MAP = {
  "Manchester City":         "Man City",
  "Manchester United":       "Man United",
  "Newcastle United":        "Newcastle",
  "Tottenham Hotspur":       "Tottenham",
  "Wolverhampton Wanderers": "Wolves",
  "Brighton & Hove Albion":  "Brighton",
  "Nottingham Forest":       "Nott'm Forest",
  "Leicester City":          "Leicester",
  "Leeds United":            "Leeds",
  "West Bromwich Albion":    "West Brom",
  "Sheffield United":        "Sheffield United",
  "Norwich City":            "Norwich",
  "Luton Town":              "Luton",
};
const norm = (name) => TEAM_MAP[name] || name;

// ─── Form (last 5) ────────────────────────────────────────────────────────────
async function getForm(db, team) {
  const n = norm(team);
  const rows = await qa(db,
    `SELECT home, away, ftr FROM results
     WHERE (home = ? OR away = ?) AND ftr IS NOT NULL
     ORDER BY match_date DESC LIMIT 5`,
    [n, n]
  );
  return rows.map(r => {
    const h = r.home === n;
    if (r.ftr === "H") return h ? "W" : "L";
    if (r.ftr === "A") return h ? "L" : "W";
    return "D";
  });
}

// ─── Prediction model ─────────────────────────────────────────────────────────
// Weighted blend of h2h history, home venue record, away venue record.
// Returns percentages that sum to 100 (rounded), or null if insufficient data.
async function getPrediction(db, homeTeam, awayTeam) {
  const h = norm(homeTeam);
  const a = norm(awayTeam);

  const [h2h, homeRec, awayRec] = await Promise.all([
    qa(db,
      `SELECT ftr, home FROM results
       WHERE ((home=? AND away=?) OR (home=? AND away=?)) AND ftr IS NOT NULL
       ORDER BY match_date DESC LIMIT 20`,
      [h, a, a, h]
    ),
    qa(db,
      `SELECT ftr FROM results WHERE home=? AND ftr IS NOT NULL ORDER BY match_date DESC LIMIT 57`,
      [h]
    ),
    qa(db,
      `SELECT ftr FROM results WHERE away=? AND ftr IS NOT NULL ORDER BY match_date DESC LIMIT 57`,
      [a]
    ),
  ]);

  if (h2h.length < 3 && homeRec.length < 5) {
    return { home: null, draw: null, away: null, confidence: "insufficient_data" };
  }

  function tally(rows, teamName, side) {
    let w = 0, d = 0, l = 0;
    for (const r of rows) {
      const isHome = r.home !== undefined ? r.home === teamName : side === "home";
      if (r.ftr === "D") { d++; continue; }
      if ((r.ftr === "H" && isHome) || (r.ftr === "A" && !isHome)) w++; else l++;
    }
    const tot = w + d + l || 1;
    return { w: w/tot, d: d/tot, l: l/tot };
  }

  const h2hS  = h2h.length  >= 3 ? tally(h2h,     h, "home") : null;
  const homeS = homeRec.length >= 5 ? tally(homeRec, h, "home") : null;
  const awayS = awayRec.length >= 5 ? tally(awayRec, a, "away") : null;

  let hp, dp, ap;
  if (h2hS && homeS && awayS) {
    hp = 0.5*h2hS.w + 0.3*homeS.w + 0.2*(1-awayS.w-awayS.d);
    dp = 0.5*h2hS.d + 0.3*homeS.d + 0.2*awayS.d;
    ap = 0.5*h2hS.l + 0.3*homeS.l + 0.2*awayS.w;
  } else if (homeS && awayS) {
    hp = 0.5*homeS.w + 0.5*(1-awayS.w-awayS.d);
    dp = 0.5*homeS.d + 0.5*awayS.d;
    ap = 0.5*homeS.l + 0.5*awayS.w;
  } else {
    hp = 0.45; dp = 0.27; ap = 0.28;
  }

  const tot = hp + dp + ap || 1;
  hp /= tot; dp /= tot; ap /= tot;

  const pts = h2h.length + homeRec.length + awayRec.length;
  return {
    home: Math.round(hp * 100),
    draw: Math.round(dp * 100),
    away: Math.round(ap * 100),
    confidence: pts > 60 ? "high" : pts > 20 ? "medium" : "low",
    data_points: pts,
  };
}

// ─── Stale fixtures check ─────────────────────────────────────────────────────
async function checkStale(db) {
  const row = await qg(db, `SELECT MAX(fetched_at) as last FROM fixtures WHERE status='NS'`);
  if (!row?.last) return { stale: true, hours_since_fetch: null };
  const h = (Date.now() - new Date(row.last).getTime()) / 3_600_000;
  const stale = h > STALE_HOURS;
  if (stale) log("warn", "stale_fixtures", { hours_since_fetch: Math.round(h) });
  return { stale, hours_since_fetch: Math.round(h) };
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();

// CORS
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (!o || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin",  o || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age",        "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Security headers
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options",        "DENY");
  res.setHeader("Referrer-Policy",        "same-origin");
  next();
});

// HTTP access log
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => log("info", "http", {
    method: req.method, path: req.path, status: res.statusCode,
    ms: Date.now() - t,
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress,
  }));
  next();
});

// Static files
app.use(express.static(__dirname));

// API middleware
app.use("/api", rateLimit, requireAuth, compress);

// ─── GET /api/matches ─────────────────────────────────────────────────────────
app.get("/api/matches", withCache(300), async (req, res) => {
  let db;
  try {
    db = openDb();
    const [fixtures, stale] = await Promise.all([
      qa(db, `SELECT * FROM fixtures WHERE status='NS' ORDER BY match_date ASC, match_time ASC`),
      checkStale(db),
    ]);

    const matches = await Promise.all(fixtures.map(async f => {
      const [homeForm, awayForm, prediction] = await Promise.all([
        getForm(db, f.home),
        getForm(db, f.away),
        getPrediction(db, f.home, f.away),
      ]);
      return {
        id: f.fixture_id,
        time: `${f.match_date}T${f.match_time || "00:00"}:00Z`,
        home: f.home, away: f.away,
        league: f.league, season: f.season, status: f.status,
        prediction,
        form: { [f.home]: homeForm, [f.away]: awayForm },
        fetched_at: f.fetched_at,
      };
    }));

    res.json({ matches, meta: { stale: stale.stale, hours_since_fetch: stale.hours_since_fetch } });
  } catch (err) {
    log("error", "matches_err", { message: err.message });
    res.status(err.message.includes("not found") ? 503 : 500).json({ error: err.message });
  } finally { db?.close(); }
});

// ─── GET /api/h2h ─────────────────────────────────────────────────────────────
app.get("/api/h2h", withCache(3600), async (req, res) => {
  const home = vTeam(req.query.home);
  const away = vTeam(req.query.away);
  if (!home || !away) return res.status(400).json({ error: "home and away query params required." });

  let db;
  try {
    db = openDb();
    const hN = norm(home), aN = norm(away);
    const rows = await qa(db,
      `SELECT match_date, home, away, fthg, ftag, ftr, season FROM results
       WHERE ((home=? AND away=?) OR (home=? AND away=?)) AND ftr IS NOT NULL
       ORDER BY match_date DESC LIMIT 20`,
      [hN, aN, aN, hN]
    );
    const summary = rows.reduce((acc, r) => {
      const isHome = r.home === hN;
      if (r.ftr === "D") acc.draws++;
      else if ((r.ftr === "H" && isHome) || (r.ftr === "A" && !isHome)) acc.home_wins++;
      else acc.away_wins++;
      return acc;
    }, { home_wins: 0, draws: 0, away_wins: 0 });

    res.json({ home, away, summary, meetings: rows });
  } catch (err) {
    log("error", "h2h_err", { message: err.message });
    res.status(500).json({ error: err.message });
  } finally { db?.close(); }
});

// ─── GET /api/results ─────────────────────────────────────────────────────────
app.get("/api/results", withCache(3600), async (req, res) => {
  const team   = vTeam(req.query.team);
  const season = vSeason(req.query.season);
  const limit  = vLimit(req.query.limit);
  if (req.query.team   && !team)   return res.status(400).json({ error: "Invalid team name." });
  if (req.query.season && !season) return res.status(400).json({ error: "Season format: YYYY-YY (e.g. 2023-24) or YY_YY (e.g. 23_24)." });

  let db;
  try {
    db = openDb();
    let sql = "SELECT * FROM results WHERE 1=1";
    const p = [];
    if (team)   { sql += " AND (home=? OR away=?)"; p.push(norm(team), norm(team)); }
    if (season) { sql += " AND season=?";           p.push(season); }
    sql += " ORDER BY match_date DESC LIMIT ?";
    p.push(limit);
    res.json(await qa(db, sql, p));
  } catch (err) {
    log("error", "results_err", { message: err.message });
    res.status(500).json({ error: err.message });
  } finally { db?.close(); }
});

// ─── GET /api/status ──────────────────────────────────────────────────────────
app.get("/api/status", async (req, res) => {
  let db;
  try {
    db = openDb();
    const [rs, fs, stale] = await Promise.all([
      qa(db,  `SELECT COUNT(*) as count, MIN(match_date) as earliest, MAX(match_date) as latest FROM results`),
      qa(db,  `SELECT COUNT(*) as count, MAX(fetched_at) as last_fetched FROM fixtures WHERE status='NS'`),
      checkStale(db),
    ]);
    res.json({
      ok: true, env: NODE_ENV,
      fixtures_stale:    stale.stale,
      hours_since_fetch: stale.hours_since_fetch,
      results:           { count: rs[0].count, earliest: rs[0].earliest, latest: rs[0].latest },
      upcoming_fixtures: { count: fs[0].count, last_fetched: fs[0].last_fetched },
    });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  } finally { db?.close(); }
});

app.use("/api", (_, res) => res.status(404).json({ error: "Not found." }));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log("info", "start", { port: PORT, env: NODE_ENV, db: DB_PATH });
  console.log(`\n⚽  Match Centre  http://localhost:${PORT}`);
  console.log(`   GET /api/matches`);
  console.log(`   GET /api/h2h?home=Arsenal&away=Chelsea`);
  console.log(`   GET /api/results?team=Arsenal&season=2023-24`);
  console.log(`   GET /api/status\n`);
  if (IS_PROD && !API_TOKEN) log("warn", "no_api_token", { msg: "Set API_TOKEN in production" });
});

let dying = false;
function shutdown(sig) {
  if (dying) return;
  dying = true;
  log("info", "shutdown", { sig });
  server.close(() => { log("info", "closed"); process.exit(0); });
  setTimeout(() => { log("error", "forced_exit"); process.exit(1); }, 10_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException",  e => { log("error", "uncaught",  { msg: e.message }); shutdown("uncaughtException"); });
process.on("unhandledRejection", e => { log("error", "unhandled", { msg: String(e) }); });
