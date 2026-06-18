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

# Current date in ET (UTC -4 for May DST)
now_utc = datetime.now(timezone.utc)
# ET is UTC - 4
now_et = now_utc - timedelta(hours=4)

today_start_et = datetime(now_et.year, now_et.month, now_et.day, tzinfo=timezone(timedelta(hours=-4)))
# Monday of this week (resets Monday)
monday_start_et = today_start_et - timedelta(days=today_start_et.weekday())
# MTD (1st of this month)
mtd_start_et = datetime(now_et.year, now_et.month, 1, tzinfo=timezone(timedelta(hours=-4)))

print(f"Today start ET: {today_start_et.isoformat()}")
print(f"Monday start ET: {monday_start_et.isoformat()}")
print(f"MTD start ET: {mtd_start_et.isoformat()}")

all_leads_mtd = []
url = f"/contacts/?locationId={LOCATION_ID}&limit=100"

while url:
    res = ghl_api_call(url)
    if not res:
        break
    contacts = res.get("contacts", [])
    if not contacts:
        break
    
    reached_end = False
    for c in contacts:
        date_added_str = c.get("dateAdded")
        if not date_added_str:
            continue
        date_added = datetime.fromisoformat(date_added_str.replace("Z", "+00:00"))
        # Compare with MTD start
        if date_added < mtd_start_et:
            reached_end = True
            break
        
        # Check if they have a source tag or lead-source tag
        tags = c.get("tags", [])
        has_source_tag = any(t.startswith("source-") or t.startswith("source:") for t in tags)
        if has_source_tag:
            all_leads_mtd.append((c, date_added))
            
    if reached_end:
        break
    
    meta = res.get("meta", {})
    url = meta.get("nextPageUrl")

print(f"Fetched {len(all_leads_mtd)} lead-source contacts in MTD.")

# Count today, this week, MTD
cnt_today = 0
cnt_this_week = 0
cnt_mtd = len(all_leads_mtd)

for c, dt in all_leads_mtd:
    if dt >= today_start_et:
        cnt_today += 1
    if dt >= monday_start_et:
        cnt_this_week += 1

print(f"New Loan Leads count:")
print(f"  Today: {cnt_today}")
print(f"  This week: {cnt_this_week}")
print(f"  MTD: {cnt_mtd}")
