
import urllib.request
import json

API_KEY = "pit-1138def5-390b-4ffb-b8e9-30b2ea6b5990"
GHL_BASE_URL = "https://services.leadconnectorhq.com"
LOCATION_ID = "y5eLFi2NFVoin9FxJiyc"

def ghl_api_call(url_path, method="GET"):
    url = f"{GHL_BASE_URL}{url_path}"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Version": "2021-07-28",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error calling {url}: {e}")
        return None

# Try listing workflows or automation, or something related to conversation AI
print("Workflows:", ghl_api_call(f"/workflows/?locationId={LOCATION_ID}"))
# Print conversation AI settings if possible
print("Conversation AI:", ghl_api_call(f"/conversations/settings/?locationId={LOCATION_ID}"))
