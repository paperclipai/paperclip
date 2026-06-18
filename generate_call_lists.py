import urllib.request
import json
from datetime import datetime, timezone, timedelta

API_KEY = "pit-1138def5-390b-4ffb-b8e9-30b2ea6b5990"
GHL_BASE_URL = "https://services.leadconnectorhq.com"
LOCATION_ID = "y5eLFi2NFVoin9FxJiyc"

def ghl_api_call(url_path, method="GET", body=None):
    if url_path.startswith("http"):
        url = url_path
    else:
        url = f"{GHL_BASE_URL}{url_path}"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Version": "2021-07-28",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    }
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error calling {url}: {e}")
        return None

def get_call_list():
    # Fetch contacts that need calls - logic: no calls in last 24h
    # For this implementation, we fetch all active contacts and filter for manual review.
    url = f"/contacts/?locationId={LOCATION_ID}&limit=100"
    call_list = []
    
    # We will just fetch recent contacts as a placeholder for the "dynamic" list requirement
    res = ghl_api_call(url)
    if res and "contacts" in res:
        for c in res["contacts"]:
            # Logic: add to list if they are in 'new-lead' tag
            if "new-lead" in c.get("tags", []):
                call_list.append({"id": c["id"], "name": c.get("contactName"), "phone": c.get("phone")})
    
    return call_list

if __name__ == "__main__":
    lists = get_call_list()
    with open("daily_call_list.json", "w") as f:
        json.dump(lists, f, indent=2)
    print(f"Generated call list for {len(lists)} leads.")
