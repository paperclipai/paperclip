import json
import subprocess
import urllib.request

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
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error calling Cube API {url}: {e}")
        return None

def main():
    token = get_cube_token()
    if not token:
        print("No token")
        return
    
    # Analyzing P&L source or pipeline
    # Let's try to get branch list or some higher level info
    print("Listing branches...")
    res = cube_api_call("/loandataapi/v2/branches?perPage=10", token)
    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()
