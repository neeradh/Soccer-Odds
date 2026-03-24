const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');

const DB_PATH = path.join(__dirname, '../data/soccer.db');
const EXPORT_DIR = path.join(__dirname, '../exports');

// Ensure export directory exists
if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

// Export matches to CSV
async function exportMatches() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM matches ORDER BY date DESC`,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// Export odds to CSV
async function exportOdds() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM odds ORDER BY fetched_at DESC`,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// Export team form to CSV
async function exportTeamForm() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM team_form`,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// Write CSV file
async function writeCsv(data, filename, columns) {
  const csvWriter = createObjectCsvWriter({
    path: path.join(EXPORT_DIR, filename),
    header: columns.map(field => ({ id: field, title: field.toUpperCase() }))
  });

  await csvWriter.writeRecords(data);
  console.log(`✅ Exported: ${filename}`);
}

async function main() {
  console.log('📤 Exporting data to CSV files...\n');

  // Export matches
  const matches = await exportMatches();
  const matchesCsv = matches.map(m => ({
    id: m.fixture_id,
    date: m.date,
    home_team: m.home_team,
    away_team: m.away_team,
    home_team_id: m.home_team_id,
    away_team_id: m.away_team_id,
    league: m.league,
    status: m.status,
    season: m.season,
    fetched_at: m.fetched_at
  }));
  await writeCsv(matchesCsv, 'matches.csv', [
    'id', 'date', 'home_team', 'away_team', 'home_team_id', 'away_team_id',
    'league', 'status', 'season', 'fetched_at'
  ]);

  // Export odds
  const odds = await exportOdds();
  const oddsCsv = odds.map(o => ({
    fixture_id: o.fixture_id,
    home_odd: o.home_odd,
    draw_odd: o.draw_odd,
    away_odd: o.away_odd,
    bookmaker: o.bookmaker,
    fetched_at: o.fetched_at
  }));
  await writeCsv(oddsCsv, 'odds.csv', [
    'fixture_id', 'home_odd', 'draw_odd', 'away_odd', 'bookmaker', 'fetched_at'
  ]);

  // Export team form
  const form = await exportTeamForm();
  const formCsv = form.map(f => ({
    team_id: f.team_id,
    season: f.season,
    form: f.form,
    fetched_at: f.fetched_at
  }));
  await writeCsv(formCsv, 'team_form.csv', [
    'team_id', 'season', 'form', 'fetched_at'
  ]);

  console.log('\n📁 Files saved to:', EXPORT_DIR);
  console.log('   - matches.csv');
  console.log('   - odds.csv');
  console.log('   - team_form.csv');

  db.close();
}

main().catch(console.error);
