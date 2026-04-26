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
RS_MANAGER_ID = "fb082e44-c93b-40f3-8606-ce414e735c52"

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
            raw = json.loads(resp.read())
            # Normalize: API may return array or {"issues": [...]}
            if isinstance(raw, list):
                return raw
            return raw
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()
        print(f"  HTTP {e.code} {method} {path}: {body_txt[:300]}")
        return {"_error": e.code, "_body": body_txt}

def get_issues(path):
    """Always returns a list."""
    result = api("GET", path)
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        return result.get("issues", [])
    return []

# ── Re-scan with corrected parsing ──────────────────────────────────────────
print("=== Corrected Heartbeat Scan ===")
all_active = get_issues(f"/api/companies/{COMPANY_ID}/issues?status=todo,in_progress,blocked&limit=50")
print(f"Active issues (corrected): {len(all_active)}")

eng_issues = []
rs_issues = []
for issue in all_active:
    assignee_id = issue.get("assigneeAgentId")
    title_lower = (issue.get("title") or "").lower()
    if assignee_id == ENG_MANAGER_ID:
        eng_issues.append(issue)
    elif assignee_id == RS_MANAGER_ID:
        rs_issues.append(issue)
    else:
        is_rs = any(kw in title_lower for kw in ["research", "analys", "strategy", "adr", "plan", "investigat"])
        if is_rs:
            rs_issues.append(issue)
        else:
            eng_issues.append(issue)

print(f"  Engineering: {len(eng_issues)}")
print(f"  Research/Strategy: {len(rs_issues)}")
for i in all_active:
    print(f"  [{i.get('priority')}][{i.get('status')}] {i.get('identifier','?')} - {i.get('title','?')[:60]}")

# ── Engineering Manager status ───────────────────────────────────────────────
print("\n=== EM Status ===")
em_info = api("GET", f"/api/agents/{ENG_MANAGER_ID}")
em_status = em_info.get("status", "unknown") if isinstance(em_info, dict) else "unknown"
active_run = em_info.get("activeRun") if isinstance(em_info, dict) else None
print(f"  EM agent status: {em_status}")
print(f"  EM active run: {active_run.get('id', 'none') if active_run else 'none'}")

eng_result = ""
if not eng_issues:
    eng_result = "no eng issues"
elif em_status == "running" or active_run:
    eng_result = "already running, skip"
    print("  EM is already running — skipping ping")
else:
    # EM idle — find top task and ping
    em_tasks = get_issues(f"/api/companies/{COMPANY_ID}/issues?assigneeAgentId={ENG_MANAGER_ID}&status=in_progress,todo&limit=5")
    PRIO = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    em_tasks.sort(key=lambda x: PRIO.get(x.get("priority", "low"), 3))
    if em_tasks:
        top = em_tasks[0]
        top_id = top["id"]
        top_ident = top.get("identifier", "?")
        comments_resp = api("GET", f"/api/issues/{top_id}/comments?order=desc&limit=3")
        recent_comments = comments_resp.get("comments", []) if isinstance(comments_resp, dict) else (comments_resp if isinstance(comments_resp, list) else [])
        ceo_ping_found = any(
            c.get("authorAgentId") == AGENT_ID and "CEO heartbeat dispatch" in c.get("body", "")
            for c in recent_comments[:3]
        )
        if ceo_ping_found:
            eng_result = f"dedup skip (already pinged on {top_ident})"
        else:
            msg = "@Engineering Manager — CEO heartbeat dispatch: please check your assignments and triage any pending work."
            result = api("POST", f"/api/issues/{top_id}/comments", {"body": msg}, mutating=True)
            eng_result = f"pinged on {top_ident}" if not (isinstance(result, dict) and result.get("_error")) else f"ping failed on {top_ident}"
    else:
        eng_result = "no EM tasks found"

# ── R&S Manager status ───────────────────────────────────────────────────────
print("\n=== R&S Manager Status ===")
rm_info = api("GET", f"/api/agents/{RS_MANAGER_ID}")
rm_status = rm_info.get("status", "unknown") if isinstance(rm_info, dict) else "unknown"
rm_active_run = rm_info.get("activeRun") if isinstance(rm_info, dict) else None
print(f"  R&S Manager status: {rm_status}")

rs_result = ""
if not rs_issues:
    rs_result = "no rs issues"
elif rm_status == "running" or rm_active_run:
    rs_result = "already running, skip"
else:
    rm_tasks = get_issues(f"/api/companies/{COMPANY_ID}/issues?assigneeAgentId={RS_MANAGER_ID}&status=in_progress,todo&limit=5")
    PRIO = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    rm_tasks.sort(key=lambda x: PRIO.get(x.get("priority", "low"), 3))
    if rm_tasks:
        top = rm_tasks[0]
        top_id = top["id"]
        top_ident = top.get("identifier", "?")
        comments_resp = api("GET", f"/api/issues/{top_id}/comments?order=desc&limit=3")
        recent_comments = comments_resp if isinstance(comments_resp, list) else comments_resp.get("comments", [])
        ceo_ping_found = any(
            c.get("authorAgentId") == AGENT_ID and "CEO heartbeat dispatch" in c.get("body", "")
            for c in recent_comments[:3]
        )
        if ceo_ping_found:
            rs_result = f"dedup skip (already pinged on {top_ident})"
        else:
            msg = "@Research & Strategy Manager — CEO heartbeat dispatch: please check your assignments and triage any pending work."
            result = api("POST", f"/api/issues/{top_id}/comments", {"body": msg}, mutating=True)
            rs_result = f"pinged on {top_ident}" if not (isinstance(result, dict) and result.get("_error")) else f"ping failed on {top_ident}"
    else:
        rs_result = "no R&S tasks found"

# ── Own inbox ────────────────────────────────────────────────────────────────
own_inbox_raw = api("GET", "/api/agents/me/inbox-lite")
own_items = own_inbox_raw if isinstance(own_inbox_raw, list) else own_inbox_raw.get("issues", []) if isinstance(own_inbox_raw, dict) else []
print(f"\nOwn inbox items: {len(own_items)}")

# ── Post summary on ANGA-809 ─────────────────────────────────────────────────
anga809 = next((i for i in all_active if i.get("identifier") == "ANGA-809"), None)
if not anga809 and all_active:
    anga809 = all_active[0]

if anga809:
    sid = anga809["id"]
    summary_body = f"""**Heartbeat complete.**
- Issues scanned: {len(all_active)} total, {len(eng_issues)} engineering, {len(rs_issues)} research
- Engineering Manager: {eng_result}
- R&S Manager: {rs_result}
- Unassigned issues triaged: 0
- Own assignments handled: none
"""
    result = api("POST", f"/api/issues/{sid}/comments", {"body": summary_body}, mutating=True)
    ident = anga809.get("identifier", "?")
    if not (isinstance(result, dict) and result.get("_error")):
        print(f"\nSummary posted on {ident}")
    else:
        print(f"\nFailed to post summary: {result}")
else:
    print("\nNo active issues to post summary on")

print("\n=== DONE ===")
print(f"Engineering: {eng_result}")
print(f"R&S: {rs_result}")
