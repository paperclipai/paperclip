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
        body = e.read().decode()
        print(f"  HTTP {e.code} {method} {path}: {body[:200]}")
        return {"_error": e.code, "_body": body}

# Find ANGA-810 and post summary
issues_resp = api("GET", f"/api/companies/{COMPANY_ID}/issues?q=ANGA-810&limit=5")
issues = issues_resp.get("issues", []) if isinstance(issues_resp, dict) else []
print(f"Found {len(issues)} issues matching ANGA-810")

target = None
for i in issues:
    if i.get("identifier") == "ANGA-810":
        target = i
        break

if not target and issues:
    target = issues[0]

if target:
    tid = target["id"]
    tident = target.get("identifier", "?")
    summary_body = """**Heartbeat complete.**
- Issues scanned: 0 total, 0 engineering, 0 research
- Engineering Manager: pinged on ANGA-810 (new work created)
- R&S Manager: no rs issues
- Unassigned issues triaged: 0
- Own assignments handled: none
- New work created: [ANGA-810](/ANGA/issues/ANGA-810) — Improve agent observability: add structured logging to heartbeat runs
"""
    result = api("POST", f"/api/issues/{tid}/comments", {"body": summary_body}, mutating=True)
    if isinstance(result, dict) and not result.get("_error"):
        print(f"Summary posted on {tident}")
    else:
        print(f"Failed: {result}")
else:
    print("Could not find ANGA-810")
