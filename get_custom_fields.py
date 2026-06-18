import urllib.request
import json

API_KEY = "pit-1138def5-390b-4ffb-b8e9-30b2ea6b5990"
GHL_BASE_URL = "https://services.leadconnectorhq.com"
LOCATION_ID = "y5eLFi2NFVoin9FxJiyc"

def ghl_api_call(path, method="GET", body=None):
    url = f"{GHL_BASE_URL}{path}"
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
            print(f"Error calling {path}: {e.read().decode('utf-8')}")
        else:
            print(f"Error calling {path}: {e}")
        return None

# GHL v2 API: GET /locations/{locationId}/customFields
res = ghl_api_call(f"/locations/{LOCATION_ID}/customFields")
if res:
    for cf in res.get('customFields', []):
        print(f"ID: {cf.get('id')} -> Name: {cf.get('name')} / Key: {cf.get('fieldKey')} / Type: {cf.get('dataType')}")
