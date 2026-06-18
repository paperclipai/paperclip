import urllib.request
import json
import os
import subprocess

def get_cube_token():
    try:
        return subprocess.check_output(
            ["gcloud", "secrets", "versions", "access", "latest",
             "--secret=CUBE_TOKEN", "--project=silver-pad-459411-e7"],
            encoding="utf8", stderr=subprocess.DEVNULL,
        ).strip()
    except Exception as e:
        print(f"Error loading CUBE_TOKEN: {e}")
        return None

token = get_cube_token()
loan_number = "1034000728125"
url = f"https://loexpapi.crosscountrymortgage.com/loandataapi/v2/loans/{loan_number}"
headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0"
}
req = urllib.request.Request(url, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(json.dumps(json.loads(resp.read().decode('utf-8')), indent=2))
except Exception as e:
    print(f"Error: {e}")
