import urllib.request
import json
import os
import os

API_KEY="pit-1138def5-390b-4ffb-b8e9-30b2ea6b5990"
# WRONG API KEY for production? Check if we have another?
# Let's try listing the directory to see if there's a better one?
# Wait, I already know this one works for listing one contact.
# Maybe I need to explicitly pass the Location Header or something?
# The error is 403 Forbidden.
# In my manual test: curl -s -H "Authorization: Bearer pit-11...90" ... WORKS.
# Maybe it's the User-Agent?
# Let's add a User-Agent header.
GHL_BASE_URL="https://services.leadconnectorhq.com"
LOCATION_ID = "y5eLFi2NFVoin9FxJiyc"
PAPERCLIP_API_URL = "http://127.0.0.1:3101/api/companies/5c2551e8-cb65-4ab4-9fee-8e0001be2e41/issues"

def ghl_api_call(url_path, method="GET", body=None):
    # Try removing the trailing slash if it is /contacts/
    if url_path.startswith("/contacts/?"):
        url_path = url_path.replace("/contacts/?", "/contacts?")
    
    url = f"{GHL_BASE_URL}{url_path}" if url_path.startswith("/") else url_path
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Version": "2021-07-28",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    }
    print(f"Calling: {url}") # DEBUG
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
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
    try:
        with urllib.request.urlopen(req) as resp:
            return True
    except Exception as e:
        print(f"Failed to create issue for {lead['id']}: {e}")
        return False

# Fetch contacts that haven't been processed
# Filtering manually for tags since API doesn't support tags in query string
contacts = ghl_api_call(f"/contacts/?locationId={LOCATION_ID}&limit=50")
for c in contacts.get("contacts", []):
    tags = c.get("tags", [])
    if "new-lead" in tags and "hq-cased" not in tags:
        if create_paperclip_issue(c):
            print(f"Created issue for {c['id']}")
            # Tag the contact as processed
            ghl_api_call(f"/contacts/{c['id']}/tags", method="POST", body={"tags": ["hq-cased"]})
