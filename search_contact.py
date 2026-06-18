import os, requests
token = os.environ.get("GHL_API_KEY")
loc_id = os.environ.get("GHL_LOCATION_ID")
headers = {"Authorization": f"Bearer {token}", "Version": "2021-07-28"}
url = f"https://services.leadconnectorhq.com/contacts/?locationId={loc_id}&query=Mario+A+Robles-Rosado"
response = requests.get(url, headers=headers)
print(response.text)
