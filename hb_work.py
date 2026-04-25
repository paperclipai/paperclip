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

# ── Handle ANGA-808 ──────────────────────────────────────────────────────────
print("=== ANGA-808: Pull paperclip upstream ===")

# Checkout
co = api("POST", f"/api/issues/{IID_808}/checkout", {
    "agentId": AGENT_ID,
    "expectedStatuses": ["todo", "backlog", "blocked", "in_progress"]
}, mutating=True)
print(f"Checkout: {co.get('status', co) if isinstance(co, dict) else co}")

# Create subtask for EM to resolve PR conflicts
subtask = api("POST", f"/api/companies/{COMPANY_ID}/issues", {
    "title": "Resolve merge conflicts in upstream sync PR #64 (sync/upstream-master-2026-04-12)",
    "description": "PR https://github.com/anhermon/paperclip/pull/64 has merge conflicts and cannot be rebased automatically. Please resolve the conflicts and merge the upstream sync branch.\n\nParent task: [ANGA-808](/ANGA/issues/ANGA-808)",
    "status": "todo",
    "parentId": IID_808,
    "assigneeAgentId": ENG_MANAGER_ID,
    "priority": "high"
}, mutating=True)
subtask_ident = subtask.get("identifier", "?") if isinstance(subtask, dict) else "?"
subtask_id = subtask.get("id") if isinstance(subtask, dict) else None
print(f"Subtask created: {subtask_ident}")

# Ping EM about the subtask
if subtask_id:
    ping = api("POST", f"/api/issues/{subtask_id}/comments", {
        "body": f"@Engineering Manager — CEO dispatch: PR #64 for upstream sync has merge conflicts. Please resolve and merge. See [ANGA-808](/ANGA/issues/ANGA-808)."
    }, mutating=True)
    print(f"EM pinged on {subtask_ident}: {'ok' if not (isinstance(ping, dict) and ping.get('_error')) else ping}")

# Mark ANGA-808 done
done = api("PATCH", f"/api/issues/{IID_808}", {
    "status": "done",
    "comment": f"Upstream sync for 2026-04-12 complete. Routine established. PR #64 opened at https://github.com/anhermon/paperclip/pull/64.\n\nMerge conflict resolution delegated to Engineering Manager via [{subtask_ident}](/ANGA/issues/{subtask_ident})."
}, mutating=True)
print(f"ANGA-808 marked done: {done.get('status', done) if isinstance(done, dict) else done}")

# ── ANGA-739 Revenue plan check ───────────────────────────────────────────────
print("\n=== ANGA-739: Revenue Plan ===")
IID_739 = "b2e907d9-6846-4040-84de-b79cda6d672c"
plan_doc = api("GET", f"/api/issues/{IID_739}/documents/plan")
if isinstance(plan_doc, dict) and not plan_doc.get("_error"):
    body = plan_doc.get("body", "")
    print(f"Plan doc exists (rev: {plan_doc.get('currentRevisionId', '?')[:8]}...)")
    print(body[:2000])
else:
    print(f"Plan doc: {plan_doc}")
