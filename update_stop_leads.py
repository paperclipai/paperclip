import os, requests
token = os.environ.get("GHL_API_KEY")
loc_id = os.environ.get("GHL_LOCATION_ID")
headers = {"Authorization": f"Bearer {token}", "Version": "2021-07-28", "Content-Type": "application/json"}
stop_leads = ["Kayleigh Bergeron", "Rashid Thomas", "Sonya Crapps", "Lisa Sirabella"]

for name in stop_leads:
    print(f"Processing {name}...")
    q = name.replace(" ", "+")
    url = f"https://services.leadconnectorhq.com/contacts/?locationId={loc_id}&query={q}"
    resp = requests.get(url, headers=headers).json()
    if resp.get("contacts"):
        contact_id = resp["contacts"][0]["id"]
        update_url = f"https://services.leadconnectorhq.com/contacts/{contact_id}"
        update_resp = requests.put(update_url, headers=headers, json={"dnd": True})
        print(f"Updated {name}: {update_resp.status_code}")
    else:
        print(f"Contact {name} not found")
