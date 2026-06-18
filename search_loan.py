import urllib.request
import json
import subprocess

def get_cube_token():
    try:
        return subprocess.check_output(
            ["gcloud", "secrets", "versions", "access", "latest",
             "--secret=CUBE_TOKEN", "--project=silver-pad-459411-e7"],
            encoding="utf8", stderr=subprocess.DEVNULL,
        ).strip()
    except Exception as e:
        return None

token = get_cube_token()
# Try listing loans
url = f"https://loexpapi.crosscountrymortgage.com/loandataapi/v2/loans?loanNumber=1034000728125"
headers = {"Authorization": f"Bearer {token}", "User-Agent": "Mozilla/5.0"}
req = urllib.request.Request(url, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(resp.read().decode('utf-8'))
except Exception as e:
    print(f"Error: {e}")
