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

ISSUES = {
    "ANGA-808": "05365a7e-49be-45fd-a5f1-79cda4d452df",
    "ANGA-723": "745b41f5-195d-46af-8d90-14315e5f4738",
    "ANGA-739": "b2e907d9-6846-4040-84de-b79cda6d672c",
}

for ident, iid in ISSUES.items():
    print(f"\n{'='*60}")
    print(f"=== {ident} ===")
    ctx = api("GET", f"/api/issues/{iid}/heartbeat-context")
    if isinstance(ctx, dict) and not ctx.get("_error"):
        issue = ctx.get("issue", {})
        print(f"Title: {issue.get('title')}")
        print(f"Status: {issue.get('status')} | Priority: {issue.get('priority')}")
        print(f"AssigneeAgentId: {issue.get('assigneeAgentId')}")
        print(f"AssigneeUserId: {issue.get('assigneeUserId')}")
        print(f"Description: {(issue.get('description') or '')[:300]}")
        # recent comments
        comments = api("GET", f"/api/issues/{iid}/comments?order=desc&limit=3")
        comment_list = comments if isinstance(comments, list) else comments.get("comments", [])
        print(f"Recent comments ({len(comment_list)}):")
        for c in comment_list[:3]:
            author = c.get("authorAgentId") or c.get("authorUserId", "?")
            body_text = (c.get("body") or "")[:150]
            print(f"  [{author[:20]}] {body_text}")
    else:
        print(f"Error: {ctx}")
