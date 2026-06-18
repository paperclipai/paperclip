import urllib.request
import json
API_KEY="pit-1138def5-390b-4ffb-b8e9-30b2ea6b5990"
GHL_BASE_URL="https://services.leadconnectorhq.com"
PAPERCLIP_API_URL = "http://127.0.0.1:3101/api/companies/5c2551e8-cb65-4ab4-9fee-8e0001be2e41/issues"
def ghl_api_call(url_path, method="GET", body=None):
    url = f"{GHL_BASE_URL}{url_path}" if url_path.startswith("/") else url_path
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Version": "2021-07-28",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
    }
    req = urllib.request.Request(url, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode('utf-8'))
def create_paperclip_issue(lead):
    name = lead.get("firstName", "") + " " + lead.get("lastName", "")
    town = lead.get("city", "Unknown")
    payload = {
        "title": f"New lead — {name} ({town})",
        "description": f"Source: Meta\nContact ID: {lead['id']}\nName: {name}\nCity: {town}",
        "status": "todo",
        "priority": "high",
        "assigneeAgentId": "c3257775-f0b5-4983-ba6e-bced179e339e"
    }
    req = urllib.request.Request(PAPERCLIP_API_URL, data=json.dumps(payload).encode('utf-8'), 
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        return True
lead = ghl_api_call("/contacts/7bVeOaVENg6tuVLk5n97")["contact"]
print(create_paperclip_issue(lead))
