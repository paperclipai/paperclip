#!/usr/bin/env python3
import json, urllib.request, sys, os

api_url = os.environ.get("PAPERCLIP_API_URL", "http://macbook.praesyn.int:3100")
api_key = os.environ.get("PAPERCLIP_API_KEY", "")
company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
agent_id = os.environ.get("PAPERCLIP_AGENT_ID", "")
run_id = os.environ.get("PAPERCLIP_RUN_ID", "")

headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json"
}

def api_get(path):
    url = f"{api_url}/api/companies/{company_id}{path}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e), "url": url}

# Get my issues
print("=== Issues assigned to me ===")
data = api_get(f"/issues?assignee={agent_id}")
if isinstance(data, list):
    for issue in data:
        print(f"  {issue.get('identifier','?')}: {issue['title']} | status={issue['status']} | priority={issue.get('priority','?')}")
else:
    print(json.dumps(data, indent=2)[:1000])

# Get all issues
print("\n=== All issues (limit 20) ===")
data = api_get("/issues?limit=20")
if isinstance(data, list):
    print(f"  Total returned: {len(data)}")
    for issue in data:
        aid = issue.get('assigneeAgentId', 'none')
        print(f"  {issue.get('identifier','?')}: {issue['title'][:60]} | status={issue['status']} | assignee={aid[:16] if aid else 'none'}")
else:
    print(json.dumps(data, indent=2)[:2000])

# Check the wake reason
print(f"\n=== Wake reason ===")
print(os.environ.get("PAPERCLIP_WAKE_REASON", "not set"))

# Try to find my run
print(f"\n=== Run info ===")
print(f"Run ID: {run_id}")
data = api_get(f"/runs?agentId={agent_id}&limit=5")
print(json.dumps(data, indent=2)[:2000])
