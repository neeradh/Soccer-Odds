/**
 * audit-names.js
 * --------------
 * Finds team names in the fixtures table that have NO matching rows
 * in the results table. These are likely name mismatches that need
 * adding to the TEAM_MAP in server/index.js.
 *
 * Usage:
 *   node server/audit-names.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path    = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "matches.db");
const db      = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

const qa = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

async function main() {
  // All unique team names from fixtures
  const fixtureTeams = await qa(
    `SELECT DISTINCT home as name FROM fixtures
     UNION
     SELECT DISTINCT away as name FROM fixtures
     ORDER BY name`
  );

  // All unique team names from results
  const resultTeams = await qa(
    `SELECT DISTINCT home as name FROM results
     UNION
     SELECT DISTINCT away as name FROM results
     ORDER BY name`
  );

  const resultSet = new Set(resultTeams.map(r => r.name));

  console.log("\n⚽  Team name audit\n");
  console.log(`   Fixture teams:  ${fixtureTeams.length}`);
  console.log(`   Results teams:  ${resultTeams.length}\n`);

  const mismatches = fixtureTeams.filter(t => !resultSet.has(t.name));

  if (mismatches.length === 0) {
    console.log("✅  All fixture team names match results table. No action needed.\n");
  } else {
    console.log(`⚠️   ${mismatches.length} fixture team(s) not found in results:\n`);
    for (const { name } of mismatches) {
      // Find closest match in results for a hint
      const candidates = resultTeams
        .map(r => ({ name: r.name, score: similarity(name, r.name) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(c => c.name);
      console.log(`   ✗  "${name}"`);
      console.log(`      Closest in results: ${candidates.map(c => `"${c}"`).join(", ")}`);
    }
    console.log(`\n   Add these to TEAM_MAP in server/index.js:\n`);
    console.log(`   const TEAM_MAP = {`);
    for (const { name } of mismatches) {
      const best = resultTeams
        .map(r => ({ name: r.name, score: similarity(name, r.name) }))
        .sort((a, b) => b.score - a.score)[0];
      console.log(`     "${name}": "${best?.name || "???"}",   // verify this`);
    }
    console.log(`   };\n`);
  }

  db.close();
}

// Simple bigram similarity (good enough for team names)
function similarity(a, b) {
  const bg = s => {
    const set = new Set();
    const l = s.toLowerCase();
    for (let i = 0; i < l.length - 1; i++) set.add(l[i] + l[i+1]);
    return set;
  };
  const A = bg(a), B = bg(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size) || 0;
}

main().catch(e => { console.error(e.message); process.exit(1); });
