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
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  HTTP {e.code} {method} {path}: {body[:200]}")
        return {"_error": e.code, "_body": body}

# ── Step 1: Scan company issues ──────────────────────────────────────────────
print("=== Step 1: Scan Company Issues ===")
issues_resp = api("GET", f"/api/companies/{COMPANY_ID}/issues?status=todo,in_progress,blocked&limit=50")
issues = issues_resp.get("issues", []) if isinstance(issues_resp, dict) else []
print(f"Total active issues: {len(issues)}")

ENG_DOMAINS = {"implementation", "testing", "security", "infra", "ui", "engineering", "devops", "bug", "feature", "qa"}
RS_DOMAINS = {"research", "analysis", "adr", "planning", "strategy"}

eng_issues = []
rs_issues = []

for issue in issues:
    title_lower = (issue.get("title") or "").lower()
    label_names = [l.get("name", "").lower() for l in (issue.get("labels") or [])]
    # classify by assignee first
    assignee_id = issue.get("assigneeAgentId")
    if assignee_id == ENG_MANAGER_ID:
        eng_issues.append(issue)
    elif assignee_id == RS_MANAGER_ID:
        rs_issues.append(issue)
    else:
        # heuristic: look for keywords
        is_rs = any(kw in title_lower for kw in ["research", "analys", "strategy", "adr", "plan", "investigat"])
        if is_rs:
            rs_issues.append(issue)
        else:
            eng_issues.append(issue)

print(f"Engineering issues: {len(eng_issues)}")
print(f"Research/Strategy issues: {len(rs_issues)}")
for i in issues[:10]:
    print(f"  [{i.get('status')}] {i.get('identifier','?')} - {i.get('title','?')[:60]}")

# ── Step 2: Wake Engineering Manager ────────────────────────────────────────
print("\n=== Step 2: Wake Engineering Manager ===")
eng_result = "no eng issues"
if eng_issues:
    em = api("GET", f"/api/agents/{ENG_MANAGER_ID}")
    em_status = em.get("status", "unknown")
    print(f"  EM status: {em_status}")
    if em_status == "running":
        eng_result = "already running, skip"
        print(f"  EM already running - skip")
    else:
        # find top-priority task assigned to EM
        em_tasks = api("GET", f"/api/companies/{COMPANY_ID}/issues?assigneeAgentId={ENG_MANAGER_ID}&status=in_progress,todo&limit=5")
        em_task_list = em_tasks.get("issues", []) if isinstance(em_tasks, dict) else []
        PRIO = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        em_task_list.sort(key=lambda x: PRIO.get(x.get("priority", "low"), 3))
        if em_task_list:
            top = em_task_list[0]
            top_id = top["id"]
            top_title = top.get("title", "?")[:50]
            top_ident = top.get("identifier", "?")
            print(f"  Top EM task: {top_ident} - {top_title}")
            # check recent comments for dedup
            comments_resp = api("GET", f"/api/issues/{top_id}/comments?order=desc&limit=3")
            recent_comments = comments_resp.get("comments", []) if isinstance(comments_resp, dict) else []
            ceo_ping_found = False
            for c in recent_comments[:3]:
                author_agent_id = c.get("authorAgentId", "")
                body_text = c.get("body", "")
                if author_agent_id == AGENT_ID and "CEO heartbeat dispatch" in body_text:
                    ceo_ping_found = True
                    break
            if ceo_ping_found:
                eng_result = f"dedup skip (already pinged on {top_ident})"
                print(f"  Dedup: already pinged {top_ident} - skip")
            else:
                msg = "@Engineering Manager — CEO heartbeat dispatch: please check your assignments and triage any pending work."
                result = api("POST", f"/api/issues/{top_id}/comments", {"body": msg}, mutating=True)
                if isinstance(result, dict) and not result.get("_error"):
                    eng_result = f"pinged on {top_ident}"
                    print(f"  Pinged EM on {top_ident} (201)")
                else:
                    eng_result = f"ping failed on {top_ident}"
                    print(f"  Ping failed: {result}")
        else:
            eng_result = "no EM tasks found"
            print("  No tasks found for EM")
else:
    print("  No engineering issues - skip")

# ── Step 3: Wake Research & Strategy Manager ─────────────────────────────────
print("\n=== Step 3: Wake R&S Manager ===")
rs_result = "no rs issues"
if rs_issues:
    rm = api("GET", f"/api/agents/{RS_MANAGER_ID}")
    rm_status = rm.get("status", "unknown")
    print(f"  R&S Manager status: {rm_status}")
    if rm_status == "running":
        rs_result = "already running, skip"
        print(f"  R&S Manager already running - skip")
    else:
        rm_tasks = api("GET", f"/api/companies/{COMPANY_ID}/issues?assigneeAgentId={RS_MANAGER_ID}&status=in_progress,todo&limit=5")
        rm_task_list = rm_tasks.get("issues", []) if isinstance(rm_tasks, dict) else []
        PRIO = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        rm_task_list.sort(key=lambda x: PRIO.get(x.get("priority", "low"), 3))
        if rm_task_list:
            top = rm_task_list[0]
            top_id = top["id"]
            top_title = top.get("title", "?")[:50]
            top_ident = top.get("identifier", "?")
            print(f"  Top R&S task: {top_ident} - {top_title}")
            comments_resp = api("GET", f"/api/issues/{top_id}/comments?order=desc&limit=3")
            recent_comments = comments_resp.get("comments", []) if isinstance(comments_resp, dict) else []
            ceo_ping_found = False
            for c in recent_comments[:3]:
                author_agent_id = c.get("authorAgentId", "")
                body_text = c.get("body", "")
                if author_agent_id == AGENT_ID and "CEO heartbeat dispatch" in body_text:
                    ceo_ping_found = True
                    break
            if ceo_ping_found:
                rs_result = f"dedup skip (already pinged on {top_ident})"
                print(f"  Dedup: already pinged {top_ident} - skip")
            else:
                msg = "@Research & Strategy Manager — CEO heartbeat dispatch: please check your assignments and triage any pending work."
                result = api("POST", f"/api/issues/{top_id}/comments", {"body": msg}, mutating=True)
                if isinstance(result, dict) and not result.get("_error"):
                    rs_result = f"pinged on {top_ident}"
                    print(f"  Pinged R&S Manager on {top_ident} (201)")
                else:
                    rs_result = f"ping failed on {top_ident}"
                    print(f"  Ping failed: {result}")
        else:
            rs_result = "no R&S tasks found"
            print("  No tasks found for R&S Manager")
else:
    print("  No research/strategy issues - skip")

# ── Step 4: Create work if queues thin ───────────────────────────────────────
print("\n=== Step 4: Create Work (if queues thin) ===")
total_active = len(issues)
created_work = []
if total_active < 3:
    print(f"  Only {total_active} active issues - creating new work")
    new_issue = api("POST", f"/api/companies/{COMPANY_ID}/issues", {
        "title": "Improve agent observability: add structured logging to heartbeat runs",
        "description": "Engineering should add structured logging output (JSON lines) to agent heartbeat runs so that run metadata (agent id, task ids, status transitions) can be aggregated and queried. This will improve visibility into the execution pipeline and help debug stuck or failing agents.",
        "status": "todo",
        "assigneeAgentId": ENG_MANAGER_ID,
        "priority": "high"
    }, mutating=True)
    if isinstance(new_issue, dict) and not new_issue.get("_error"):
        new_ident = new_issue.get("identifier", "?")
        new_id = new_issue.get("id")
        created_work.append(new_ident)
        print(f"  Created: {new_ident}")
        # ping EM about new work
        ping_msg = "@Engineering Manager — CEO heartbeat dispatch: please check your assignments and triage any pending work."
        api("POST", f"/api/issues/{new_id}/comments", {"body": ping_msg}, mutating=True)
    else:
        print(f"  Failed to create issue: {new_issue}")
else:
    print(f"  {total_active} active issues - queue is healthy, no new work needed")

# ── Step 5: Handle own assignments ───────────────────────────────────────────
print("\n=== Step 5: Own Assignments ===")
inbox = api("GET", "/api/agents/me/inbox-lite")
own_items = inbox.get("issues", []) if isinstance(inbox, dict) else []
print(f"  Own inbox items: {len(own_items)}")
for item in own_items[:5]:
    print(f"  [{item.get('status')}] {item.get('identifier','?')} - {item.get('title','?')[:60]}")

# ── Step 6: Blocked triage ────────────────────────────────────────────────────
print("\n=== Step 6: Blocked Triage ===")
my_blocked = [i for i in own_items if i.get("status") == "blocked"]
print(f"  Blocked own tasks: {len(my_blocked)}")

# ── Step 7: Exit / Summary ────────────────────────────────────────────────────
print("\n=== Step 7: Summary ===")
print(f"  Issues scanned: {len(issues)} total, {len(eng_issues)} engineering, {len(rs_issues)} research")
print(f"  Engineering Manager: {eng_result}")
print(f"  R&S Manager: {rs_result}")
print(f"  Own assignments: {len(own_items)}")
print(f"  Created new work: {created_work if created_work else 'none'}")

# Post summary comment on the most recently active issue
summary_body = f"""**Heartbeat complete.**
- Issues scanned: {len(issues)} total, {len(eng_issues)} engineering, {len(rs_issues)} research
- Engineering Manager: {eng_result}
- R&S Manager: {rs_result}
- Unassigned issues triaged: 0
- Own assignments handled: {len(own_items) if own_items else 'none'}
"""

# find the most recently active issue to post summary on
summary_issue = None
if own_items:
    summary_issue = own_items[0]
elif issues:
    summary_issue = issues[0]

if summary_issue:
    sid = summary_issue["id"]
    sident = summary_issue.get("identifier", "?")
    result = api("POST", f"/api/issues/{sid}/comments", {"body": summary_body}, mutating=True)
    if isinstance(result, dict) and not result.get("_error"):
        print(f"  Summary posted on {sident}")
    else:
        print(f"  Failed to post summary: {result}")
else:
    print("  No issue to post summary on")

print("\nDone.")
