const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.API_SPORTS_KEY;

console.log('Testing different API endpoints...\n');

async function testEndpoints() {
  const tests = [
    { name: 'Base leagues (no version)', url: 'https://football.api-sports.io/leagues' },
    { name: 'v3 leagues', url: 'https://v3.football.api-sports.io/v3/leagues' },
    { name: 'v3 leagues with ID', url: 'https://v3.football.api-sports.io/v3/leagues?id=39' },
    { name: 'v3 fixtures simple', url: 'https://v3.football.api-sports.io/v3/fixtures?league=39&season=2024' },
    { name: 'v3 fixtures by date', url: 'https://v3.football.api-sports.io/v3/fixtures?date=2024-01-15' },
    { name: 'v3 teams', url: 'https://v3.football.api-sports.io/v3/teams?league=39&season=2024' },
  ];

  for (const test of tests) {
    console.log(`Testing: ${test.name}`);
    console.log(`  URL: ${test.url}`);
    try {
      const res = await axios.get(test.url, {
        headers: { 'x-apisports-key': API_KEY }
      });
      console.log(`  Status: ${res.status}`);
      console.log(`  Response:`, JSON.stringify(res.data, null, 2).substring(0, 500));
      console.log();
    } catch (err) {
      console.log(`  Error: ${err.message}`);
      if (err.response) {
        console.log(`  Status: ${err.response.status}`);
        console.log(`  Body:`, JSON.stringify(err.response.data, null, 2));
      }
      console.log();
    }
  }
}

testEndpoints();
