import urllib.request
import json
import subprocess
import os

PROJECT = "silver-pad-459411-e7"

def get_cube_token():
    try:
        return subprocess.check_output(
            ["gcloud", "secrets", "versions", "access", "latest",
             "--secret=CUBE_TOKEN", f"--project={PROJECT}"],
            encoding="utf8", stderr=subprocess.DEVNULL,
        ).strip()
    except Exception as e:
        print(f"Error loading CUBE_TOKEN: {e}")
        return None

def cube_api_call(url_path, token):
    url = f"https://loexpapi.crosscountrymortgage.com{url_path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; ROC-FES/1.1; +https://app.mortgagearchitect.net)"
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error calling Cube API {url}: {e}")
        return None

def main():
    token = get_cube_token()
    if not token:
        return
    
    for branch in ["3793", "4056", "4331", "4821"]:
        print(f"Querying branch {branch}...")
        res = cube_api_call(f"/loandataapi/v2/loans?branchNumber={branch}&perPage=5", token)
        if res and "value" in res:
            loans = res["value"]
            print(f"  First 3 loan numbers: {[l.get('loanNumber') for l in loans[:3]]}")
        else:
            print("  Failed or empty response")

if __name__ == "__main__":
    main()