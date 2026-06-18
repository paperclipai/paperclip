import os, requests
token = os.environ.get("GHL_API_KEY")
headers = {"Authorization": f"Bearer {token}", "Version": "2021-07-28", "Content-Type": "application/json"}
url = "https://services.leadconnectorhq.com/contacts/twLWHQObS4iM0YdMn9Cd"
data = {"dnd": True, "dndSettings": {"SMS": {"status": "permanent", "message": "Manual DND set by COO"}, "Call": {"status": "permanent", "message": "Manual DND set by COO"}, "Email": {"status": "permanent", "message": "Manual DND set by COO"}}}
response = requests.put(url, headers=headers, json=data)
print(response.status_code)
print(response.text)
