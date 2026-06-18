import urllib.request
import json
from datetime import datetime, timezone

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
        "Origin": "https://app.gohighlevel.com",
        "Referer": "https://app.gohighlevel.com/"
    }
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        if hasattr(e, 'read'):
            print(f"Error calling {url}: {e.read().decode('utf-8')}")
        else:
            print(f"Error calling {url}: {e}")
        return None

may_contacts = []
url = f"/contacts/?locationId={LOCATION_ID}&limit=100"

print("Fetching May 2026 contacts...")
while url:
    res = ghl_api_call(url)
    if not res:
        break
    
    contacts = res.get('contacts', [])
    if not contacts:
        break
    
    finished_may = False
    for c in contacts:
        date_added_str = c.get('dateAdded')
        if not date_added_str:
            continue
        # Format is like '2026-05-27T20:31:04.643Z'
        # Let's parse it
        date_added = datetime.fromisoformat(date_added_str.replace('Z', '+00:00'))
        if date_added.year == 2026 and date_added.month == 5:
            may_contacts.append(c)
        elif date_added.year < 2026 or (date_added.year == 2026 and date_added.month < 5):
            # Since contacts are sorted by dateAdded descending, once we see April 2026 or older, we are done!
            finished_may = True
            break
            
    if finished_may:
        break
        
    meta = res.get('meta', {})
    url = meta.get('nextPageUrl')
    # nextPageUrl includes the full GHL_BASE_URL, which is handled by ghl_api_call

print(f"Fetched {len(may_contacts)} contacts in May 2026.")
with open("may_contacts.json", "w") as f:
    json.dump(may_contacts, f, indent=2)
print("Saved to may_contacts.json")
