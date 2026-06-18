import urllib.request
import json

api_base = "http://127.0.0.1:3101/api"
issue_id = "9e65270c-ccbf-40bd-8c64-62c5aadb8b13" # ROC-2353
agent_id = "279d57c7-c517-4cd6-8c67-d3441e86d6bb" # My Agent ID

def api_request(path, method="GET", data=None):
    url = f"{api_base}{path}"
    req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8") if data else None, headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode("utf-8"))

# Checkout
print("Checking out issue...")
api_request(f"/issues/{issue_id}/checkout", "POST", {
    "agentId": agent_id,
    "expectedStatuses": ["blocked", "todo"]
})

# Update
print("Updating issue...")
api_request(f"/issues/{issue_id}", "PATCH", {
    "status": "in_progress",
    "assigneeUserId": "03338d2a-2396-4354-9059-4d27faf1845c" # Yauvan Kumar
})

# Post comment
print("Commenting...")
api_request(f"/issues/{issue_id}/comments", "POST", {
    "body": "Executed Pathway B Fallback: Updated all 3 loans (ROC-1098, ROC-1077, ROC-1068) to Pathway B in CUBE and assigned ownership to Yauvan Kumar for re-engagement."
})

# Done
print("Marking done...")
api_request(f"/issues/{issue_id}", "PATCH", {
    "status": "done"
})
print("Success.")
