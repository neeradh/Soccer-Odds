const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Cache configuration
const CACHE_TTL_HOURS = 24; // Refresh data every 24 hours

// Get current year and calculate season range (past 20 seasons)
const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth();
// Season year: if we're before August, use previous year as season start
const currentSeasonStart = currentMonth < 8 ? currentYear - 1 : currentYear;
const SEASON_STARTS = Array.from({ length: 20 }, (_, i) => currentSeasonStart - i);

// Import database cache
const {
  isSeasonDataFresh,
  getCachedMatches,
  getCachedOdds,
  getCachedTeamForm,
  saveMatch,
  saveOdds,
  saveTeamForm
} = require('./db');

async function getOddsForFixture(fixtureId, useCache = true) {
  // Try cache first
  if (useCache) {
    const cached = await getCachedOdds(fixtureId);
    if (cached) {
      return {
        Home: cached.home_odd?.toString(),
        Draw: cached.draw_odd?.toString(),
        Away: cached.away_odd?.toString()
      };
    }
  }

  // Fetch from API
  try {
    const oddsRes = await axios.get(`https://v3.football.api-sports.io/v3/odds?fixture=${fixtureId}`, {
      headers: {
        'x-apisports-key': process.env.API_SPORTS_KEY,
      },
    });

    const bookmakers = oddsRes.data.response[0]?.bookmakers;
    const oneXtwo = bookmakers?.[0]?.bets.find(b => b.name === "Match Winner");
    if (!oneXtwo) return null;

    const odds = {};
    oneXtwo.values.forEach(o => {
      odds[o.value] = o.odd;
    });

    // Save to cache
    await saveOdds(fixtureId, odds, bookmakers?.[0]?.name);

    return odds;

  } catch (err) {
    console.error(`Odds error for fixture ${fixtureId}:`, err.message);
    return null;
  }
}

async function getTeamForm(teamId, seasonStarts, useCache = true) {
  // Try cache first - aggregate form from all cached seasons
  if (useCache) {
    const allCachedForm = [];
    for (const season of seasonStarts) {
      const cached = await getCachedTeamForm(teamId, season);
      if (cached) {
        allCachedForm.push(...cached);
      }
    }
    if (allCachedForm.length >= 5) {
      return allCachedForm.slice(0, 5);
    }
  }

  // Fetch from API
  try {
    const allFixtures = [];

    for (const season of seasonStarts) {
      try {
        const res = await axios.get(
          `https://v3.football.api-sports.io/v3/fixtures?team=${teamId}&season=${season}&status=FT`,
          {
            headers: {
              'x-apisports-key': process.env.API_SPORTS_KEY,
            },
          }
        );
        allFixtures.push(...res.data.response);
      } catch (err) {
        // Skip seasons with no data
      }
    }

    // Sort by date descending and take last 5
    const fixtures = allFixtures
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

    // Save form for each season to cache
    const seasonFormMap = {};
    fixtures.forEach(fix => {
      const fixSeason = fix.season;
      if (!seasonFormMap[fixSeason]) seasonFormMap[fixSeason] = [];
      const homeWin = fix.teams.home.winner;
      const awayWin = fix.teams.away.winner;
      const isHome = fix.teams.home.id === teamId;
      let result = 'D';
      if (homeWin !== null && awayWin !== null) {
        if ((isHome && homeWin) || (!isHome && awayWin)) result = 'W';
        else if ((isHome && awayWin) || (!isHome && homeWin)) result = 'L';
      }
      seasonFormMap[fixSeason].push(result);
    });

    for (const [season, form] of Object.entries(seasonFormMap)) {
      await saveTeamForm(teamId, parseInt(season), form);
    }

    return form;
  } catch (err) {
    console.error(`Form error for team ${teamId}:`, err.message);
    return [];
  }
}

app.get('/api/matches', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const useCache = req.query.cache !== 'false'; // Allow bypass with ?cache=false

    const headers = {
      'x-apisports-key': process.env.API_SPORTS_KEY,
    };

    let matches = [];
    let needsApiFetch = false;

    // Check cache freshness for each season
    if (useCache) {
      for (const season of SEASON_STARTS) {
        const fresh = await isSeasonDataFresh(season, CACHE_TTL_HOURS);
        if (!fresh) {
          needsApiFetch = true;
          break;
        }
      }
    } else {
      needsApiFetch = true;
    }

    if (!needsApiFetch && useCache) {
      // Use cached data
      console.log('📦 Serving from cache...');
      for (const season of SEASON_STARTS) {
        const cachedMatches = await getCachedMatches(season);
        matches.push(...cachedMatches);
      }

      // Filter to today's matches if available
      const todayMatches = matches.filter(m => m.date.startsWith(today));
      if (todayMatches.length > 0) {
        matches = todayMatches;
      } else {
        // Get upcoming (NS status)
        const upcoming = matches.filter(m => m.status === 'NS');
        if (upcoming.length > 0) {
          matches = upcoming.slice(0, 10);
        }
      }
    } else {
      // Fetch from API
      console.log('🌐 Fetching from API...');

      // 1. Try today's Premier League matches across all 20 seasons
      for (const season of SEASON_STARTS) {
        try {
          const todayRes = await axios.get(
            `https://v3.football.api-sports.io/v3/fixtures?date=${today}&league=39&season=${season}`,
            { headers }
          );
          if (todayRes.data.response?.length > 0) {
            matches.push(...todayRes.data.response.map(m => ({ ...m, season })));
            // Save to cache
            for (const m of todayRes.data.response) {
              await saveMatch({ ...m, season });
            }
            await saveTeamFormCache(todayRes.data.response, season, headers);
          }
        } catch (err) {
          // Skip seasons with no data
        }
      }

      // 2. If none today, get upcoming ones from all seasons
      if (matches.length === 0) {
        for (const season of SEASON_STARTS) {
          try {
            const upcomingRes = await axios.get(
              `https://v3.football.api-sports.io/v3/fixtures?league=39&season=${season}`,
              { headers }
            );
            const seasonMatches = upcomingRes.data.response.filter(
              m => m.fixture.status.short === 'NS'
            ).map(m => ({ ...m, season }));
            matches.push(...seasonMatches);
            // Save to cache
            for (const m of upcomingRes.data.response) {
              await saveMatch({ ...m, season });
            }
          } catch (err) {
            // Skip seasons with no data
          }
        }
        matches = matches.slice(0, 10);
      }

      // 3. If still none, get recently completed matches from all seasons
      if (matches.length === 0) {
        for (const season of SEASON_STARTS) {
          try {
            const completedRes = await axios.get(
              `https://v3.football.api-sports.io/v3/fixtures?league=39&season=${season}&status=FT`,
              { headers }
            );
            const seasonMatches = completedRes.data.response.map(m => ({ ...m, season }));
            matches.push(...seasonMatches);
            // Save to cache
            for (const m of completedRes.data.response) {
              await saveMatch({ ...m, season });
            }
          } catch (err) {
            // Skip seasons with no data
          }
        }
        // Sort by date descending and take most recent matchday
        if (matches.length > 0) {
          matches.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
          const latestDate = matches[0].fixture.date.substring(0, 10);
          matches = matches.filter(m => m.fixture.date.startsWith(latestDate)).slice(0, 10);
        }
      }

      // Update cache timestamps
      for (const season of SEASON_STARTS) {
        const { setLastFetchTime } = require('./db');
        await setLastFetchTime(season, new Date().toISOString());
      }
    }

    // Enrich matches with odds and form
    const finalMatches = await Promise.all(matches.map(async (match) => {
      const odds = await getOddsForFixture(match.fixture.id, useCache);
      const homeForm = await getTeamForm(match.teams.home.id, SEASON_STARTS, useCache);
      const awayForm = await getTeamForm(match.teams.away.id, SEASON_STARTS, useCache);

      return {
        id: match.fixture.id,
        time: match.fixture.date,
        home: match.teams.home.name,
        away: match.teams.away.name,
        league: match.league.name,
        odds: odds || {},
        form: {
          [match.teams.home.name]: homeForm,
          [match.teams.away.name]: awayForm,
        },
      };
    }));

    res.json(finalMatches);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Helper to save team form cache
async function saveTeamFormCache(matches, season, headers) {
  const teamIds = new Set();
  matches.forEach(m => {
    teamIds.add(m.teams.home.id);
    teamIds.add(m.teams.away.id);
  });

  for (const teamId of teamIds) {
    try {
      const res = await axios.get(
        `https://v3.football.api-sports.io/v3/fixtures?team=${teamId}&season=${season}&status=FT`,
        { headers }
      );
      const fixtures = res.data.response
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
    } catch (err) {
      // Skip if error
    }
  }
}

// Serve index.html and static files
app.use(express.static(__dirname + '/../'));

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📦 Cache: SQLite database at data/soccer.db`);
  console.log(`🔄 Cache TTL: ${CACHE_TTL_HOURS} hours`);
});
