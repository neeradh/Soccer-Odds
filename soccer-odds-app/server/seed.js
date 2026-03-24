const axios = require('axios');
require('dotenv').config();

const {
  saveMatch,
  saveOdds,
  saveTeamForm,
  setLastFetchTime,
  closeDb
} = require('./db');

// Rate limit handling with retry
async function apiRequest(url, headers, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await axios.get(url, { headers });
      return res;
    } catch (err) {
      if (err.response?.status === 429) {
        const waitMs = (i + 1) * 2000; // Wait 2s, 4s, 6s
        console.log(`   ⏳ Rate limited, waiting ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
      } else if (err.response?.status === 403) {
        throw new Error('API key invalid or expired');
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

// Get current year and calculate season range (only 3 seasons - current + 2 past)
const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth();
const currentSeasonStart = currentMonth < 8 ? currentYear - 1 : currentYear;
const SEASON_STARTS = [currentSeasonStart, currentSeasonStart - 1, currentSeasonStart - 2];

const HEADERS = {
  'x-apisports-key': process.env.API_SPORTS_KEY,
};

const LEAGUE_ID = 39; // Premier League

async function seedSeason(season) {
  console.log(`\n📥 Seeding season ${season}...`);

  try {
    // Fetch all fixtures for the season
    const res = await apiRequest(
      `https://v3.football.api-sports.io/v3/fixtures?league=${LEAGUE_ID}&season=${season}`,
      HEADERS
    );

    const matches = res.data.response;
    console.log(`   Found ${matches.length} matches`);

    // Save matches
    for (const match of matches) {
      await saveMatch({ ...match, season });
    }

    // Fetch and save odds for recent matches only (last 30 per season)
    console.log(`   Fetching odds...`);
    const recentMatches = matches
      .filter(m => m.fixture.status.short !== 'NS')
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, 30);

    const fixtureIds = recentMatches.map(m => m.fixture.id);

    for (let i = 0; i < fixtureIds.length; i++) {
      const fixtureId = fixtureIds[i];
      try {
        const oddsRes = await apiRequest(
          `https://v3.football.api-sports.io/v3/odds?fixture=${fixtureId}`,
          HEADERS
        );
        const bookmakers = oddsRes.data.response[0]?.bookmakers;
        const oneXtwo = bookmakers?.[0]?.bets.find(b => b.name === "Match Winner");
        if (oneXtwo) {
          const odds = {};
          oneXtwo.values.forEach(o => {
            odds[o.value] = o.odd;
          });
          await saveOdds(fixtureId, odds, bookmakers?.[0]?.name);
        }
        if (i % 10 === 9) console.log(`   Progress: ${i + 1}/${fixtureIds.length} odds fetched`);
      } catch (err) {
        // Skip if odds not available
      }
      // Delay between odds requests
      await new Promise(r => setTimeout(r, 500));
    }

    // Fetch and save team form for all unique teams
    console.log(`   Fetching team form...`);
    const teamIds = new Set();
    matches.forEach(m => {
      teamIds.add(m.teams.home.id);
      teamIds.add(m.teams.away.id);
    });

    const teamIdArray = Array.from(teamIds);
    for (let i = 0; i < teamIdArray.length; i++) {
      const teamId = teamIdArray[i];
      try {
        const teamRes = await apiRequest(
          `https://v3.football.api-sports.io/v3/fixtures?team=${teamId}&season=${season}&status=FT`,
          HEADERS
        );
        const fixtures = teamRes.data.response
          .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
          .slice(0, 5);

        const form = fixtures.map(fix => {
          const homeWin = fix.teams.home.winner;
          const awayWin = fix.teams.away.winner;
          const isHome = fix.teams.home.id === teamId;

          if (homeWin === null || awayWin === null) return 'D';
          if ((isHome && homeWin) || (!isHome && awayWin)) return 'W';
          if ((isHome && awayWin) || (!isHome && homeWin)) return 'L';
          return 'D';
        });

        await saveTeamForm(teamId, season, form);
        if (i % 10 === 9) console.log(`   Progress: ${i + 1}/${teamIdArray.length} teams processed`);
      } catch (err) {
        // Skip if form not available
      }
      // Delay between team form requests
      await new Promise(r => setTimeout(r, 300));
    }

    // Mark as fetched
    await setLastFetchTime(season, new Date().toISOString());
    console.log(`   ✅ Season ${season} seeded successfully`);

  } catch (err) {
    console.error(`   ❌ Error seeding season ${season}:`, err.message);
  }
}

async function main() {
  console.log('🚀 Starting database seed...');
  console.log(`📊 Seasons to seed: ${SEASON_STARTS.join(', ')}`);
  console.log(`📝 Note: Only seeding 3 seasons to avoid rate limits`);

  for (const season of SEASON_STARTS) {
    await seedSeason(season);
    // Delay between seasons
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n✅ Seeding complete!');
  console.log('💡 Run `npm start` to launch the server');
  await closeDb();
}

main().catch(console.error);
