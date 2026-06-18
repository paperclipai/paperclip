import urllib.request
import json
import os

api_base = "http://127.0.0.1:3101/api"
issue_id = "9e65270c-ccbf-40bd-8c64-62c5aadb8b13" # ROC-2353

def api_request(path, method="GET", data=None):
    url = f"{api_base}{path}"
    req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8") if data else None, headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode("utf-8"))

# 1. Update the status of the issue to in_progress and assign to Yauvan Kumar
print("Updating issue ROC-2353...")
api_request(f"/issues/{issue_id}", "PATCH", {
    "status": "in_progress",
    "assigneeUserId": "03338d2a-2396-4354-9059-4d27faf1845c" # Yauvan Kumar's ID
})

# 2. Post a comment
print("Posting update comment...")
api_request(f"/issues/{issue_id}/comments", "POST", {
    "body": "Executed Pathway B Fallback: Updated all 3 loans (ROC-1098, ROC-1077, ROC-1068) to Pathway B in CUBE and assigned ownership to Yauvan Kumar for re-engagement."
})

# 3. Mark the issue as done
print("Marking as done...")
api_request(f"/issues/{issue_id}", "PATCH", {
    "status": "done"
})
print("Done.")
