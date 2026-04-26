import os
import json
import urllib.request
import urllib.error

API_URL = os.environ["PAPERCLIP_API_URL"]
COMPANY_ID = os.environ["PAPERCLIP_COMPANY_ID"]
AGENT_ID = os.environ["PAPERCLIP_AGENT_ID"]
RUN_ID = os.environ["PAPERCLIP_RUN_ID"]
API_KEY = os.environ["PAPERCLIP_API_KEY"]

def api(method, path, body=None, mutating=False):
    url = f"{API_URL}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    if mutating:
        headers["X-Paperclip-Run-Id"] = RUN_ID
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()[:300]}

def get_list(path):
    r = api("GET", path)
    if isinstance(r, list): return r
    if isinstance(r, dict): return r.get("issues", r.get("items", []))
    return []

# Get full inbox
inbox = api("GET", "/api/agents/me/inbox-lite")
if isinstance(inbox, list):
    items = inbox
elif isinstance(inbox, dict):
    items = inbox.get("issues", [])
else:
    items = []

print(f"Inbox items: {len(items)}")
for i in items:
    print(f"\n  [{i.get('priority')}][{i.get('status')}] {i.get('identifier','?')} - {i.get('title','?')}")
    print(f"    assigneeAgentId: {i.get('assigneeAgentId')}")
    print(f"    id: {i.get('id')}")
