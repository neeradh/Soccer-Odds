const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 3000;

async function getOddsForFixture(fixtureId) {
  try {
    const oddsRes = await axios.get(`https://api-football-v1.p.rapidapi.com/v3/odds?fixture=${fixtureId}`, {
      headers: {
        'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPID_API_KEY,
      },
    });

    const bookmakers = oddsRes.data.response[0]?.bookmakers;
    const oneXtwo = bookmakers?.[0]?.bets.find(b => b.name === "Match Winner");
    if (!oneXtwo) return null;

    const odds = {};
    oneXtwo.values.forEach(o => {
      odds[o.value] = o.odd; // "Home", "Draw", "Away"
    });

    return odds;

  } catch (err) {
    console.error(`Odds error for fixture ${fixtureId}:`, err.message);
    return null;
  }
}

async function getTeamForm(teamId) {
  try {
    const res = await axios.get(
      `https://api-football-v1.p.rapidapi.com/v3/fixtures?team=${teamId}&season=2025&status=FT`,
      {
        headers: {
          'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPID_API_KEY,
        },
      }
    );

    const fixtures = res.data.response
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date)) // most recent first
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

    return form;
  } catch (err) {
    console.error(`Form error for team ${teamId}:`, err.message);
    return [];
  }
}

app.get('/api/matches', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const headers = {
      'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
      'x-rapidapi-key': process.env.RAPID_API_KEY,
    };

    // 1. Try today's Premier League matches
    const todayRes = await axios.get(
      `https://api-football-v1.p.rapidapi.com/v3/fixtures?date=${today}&league=39&season=2025`,
      { headers }
    );

    let matches = todayRes.data.response;

    // 2. If none today, get upcoming ones
    if (matches.length === 0) {
      const upcomingRes = await axios.get(
        `https://api-football-v1.p.rapidapi.com/v3/fixtures?league=39&season=2025`,
        { headers }
      );

      matches = upcomingRes.data.response.filter(
        m => m.fixture.status.short === 'NS'
      ).slice(0, 10);
    }

    // 3. Process each match and enrich with odds + form
    const finalMatches = await Promise.all(matches.map(async (match) => {
      const odds = await getOddsForFixture(match.fixture.id);
      const homeForm = await getTeamForm(match.teams.home.id);
      const awayForm = await getTeamForm(match.teams.away.id);

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

// Serve index.html and static files
app.use(express.static(__dirname + '/../'));

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
