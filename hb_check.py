import os
import json
import urllib.request
import urllib.error

API_URL = os.environ["PAPERCLIP_API_URL"]
COMPANY_ID = os.environ["PAPERCLIP_COMPANY_ID"]
AGENT_ID = os.environ["PAPERCLIP_AGENT_ID"]
RUN_ID = os.environ["PAPERCLIP_RUN_ID"]
API_KEY = os.environ["PAPERCLIP_API_KEY"]
ENG_MANAGER_ID = "e1a9742f-0d04-4cdb-97f7-6eeaa87332c8"

def api(method, path, body=None, mutating=False):
    url = f"{API_URL}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    if mutating:
        headers["X-Paperclip-Run-Id"] = RUN_ID
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()
        print(f"  HTTP {e.code} {method} {path}: {body_txt[:300]}")
        return {"_error": e.code, "_body": body_txt}

# Check all issues for EM assignee
em_tasks = api("GET", f"/api/companies/{COMPANY_ID}/issues?assigneeAgentId={ENG_MANAGER_ID}&status=in_progress,todo,blocked&limit=10")
print("EM tasks response:", json.dumps(em_tasks, indent=2)[:2000])

# Also check all issues without status filter
all_issues = api("GET", f"/api/companies/{COMPANY_ID}/issues?limit=10")
print("\nAll issues (latest):", json.dumps(all_issues, indent=2)[:2000])
