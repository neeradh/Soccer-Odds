import requests
from datetime import datetime

# Replace with your own key
API_KEY = "c5a988a965mshe7c958098847cadp128206jsn1926e4fd87af"
headers = {
    "X-RapidAPI-Key": API_KEY,
    "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com"
}

# Get today's date
today = datetime.now().strftime("%Y-%m-%d")

# Replace league ID as needed (or remove filter)
url = f"https://api-football-v1.p.rapidapi.com/v3/fixtures?date={today}"

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
