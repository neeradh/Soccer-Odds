import requests
from datetime import datetime
from dotenv import load_dotenv
import os

# Load environment variables from .env
load_dotenv()

# Get API Key from environment
API_KEY = os.getenv("RAPID_API_KEY")
headers = {
    "X-RapidAPI-Key": API_KEY,
    "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com"
}

# Date
today = datetime.now().strftime("%Y-%m-%d")

# League Id
url = f"https://api-football-v1.p.rapidapi.com/v3/fixtures?date={today}&league=39&season=2025"

response = requests.get(url, headers=headers)

if response.status_code == 200:
    data = response.json()
    for match in data["response"]:
        home = match["teams"]["home"]["name"]
        away = match["teams"]["away"]["name"]
        time = match["fixture"]["date"]
        print(f"{time}: {home} vs {away}")
else:
    print("Error:", response.status_code, response.text)
