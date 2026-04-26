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
        return {"_error": e.code, "_body": e.read().decode()[:500]}

IID_808 = "05365a7e-49be-45fd-a5f1-79cda4d452df"
IID_739 = "b2e907d9-6846-4040-84de-b79cda6d672c"

# Full detail on ANGA-808
print("=== ANGA-808 Full Comments ===")
comments = api("GET", f"/api/issues/{IID_808}/comments?order=asc&limit=20")
comment_list = comments if isinstance(comments, list) else comments.get("comments", [])
for c in comment_list:
    author = c.get("authorAgentId") or c.get("authorUserId", "?")
    body_text = (c.get("body") or "")[:400]
    print(f"\n[{author[:30]}]\n{body_text}")

print("\n=== ANGA-739 Description ===")
ctx = api("GET", f"/api/issues/{IID_739}/heartbeat-context")
if isinstance(ctx, dict):
    issue = ctx.get("issue", {})
    print(issue.get("description", "")[:1500])
    print("\n--- Recent Comments ---")
    comments_739 = api("GET", f"/api/issues/{IID_739}/comments?order=desc&limit=5")
    cl = comments_739 if isinstance(comments_739, list) else comments_739.get("comments", [])
    for c in cl:
        author = c.get("authorAgentId") or c.get("authorUserId", "?")
        body_text = (c.get("body") or "")[:300]
        print(f"\n[{author[:30]}]\n{body_text}")
