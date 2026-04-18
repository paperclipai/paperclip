#!/usr/bin/env python3
"""
Paperclip Evolution — Plane API Client
======================================
Reusable client for AI agents to interact with the Plane project board.

Usage:
  python3 plane-client.py status           # Show current sprint status
  python3 plane-client.py backlog          # Show backlog items
  python3 plane-client.py in-progress      # Show items being worked on
  python3 plane-client.py done             # Show completed items
  python3 plane-client.py modules          # Show module/phase progress
  python3 plane-client.py pick             # Pick next priority issue
  python3 plane-client.py start <issue-id> # Move issue to In Progress + comment
  python3 plane-client.py comment <id> <text>  # Add comment to issue
  python3 plane-client.py complete <id> <text> # Mark done + completion comment
  python3 plane-client.py create <name> <priority> <label> [parent-id]  # Create issue
"""

import sys
import json
import urllib.request
import urllib.error
from datetime import datetime

# ============================================================================
# Configuration
# ============================================================================
PLANE_BASE = "http://plane.nexus.local/api/v1/workspaces/nous"
API_KEY = "plane_api_7af44b8e6eb34b8b8d4397918a46e55e"
PROJECT_ID = "6ea59a32-3d6a-4602-81bd-0df63db085a5"

STATES = {
    "backlog": "20e43ed5-651d-4d21-9800-8591204d5ce3",
    "todo": "1bd18247-2025-49d1-830f-873864658341",
    "in_progress": "9242f915-72b6-402d-8923-118e8b5d2898",
    "done": "8ac06912-fc0f-4338-92a4-f17fa62dc7f8",
    "cancelled": "4fc993f5-e834-4649-bd38-7910cc5669da",
}

STATE_NAMES = {v: k for k, v in STATES.items()}

PRIORITY_EMOJI = {
    "urgent": "!!!",
    "high": "!! ",
    "medium": "!  ",
    "low": ".  ",
    "none": "   ",
}

MODULES = {
    "116e85d1-e76a-4f88-a069-62db122e81f0": "Phase 1: Org Structure",
    "ea38f859-f570-48a5-af6f-767819f57a61": "Phase 2: RBAC",
    "4b18aeaa-e9ff-4e23-9767-75edfbf6efae": "Phase 3: SLA & Deadlines",
    "6c5198cc-ff39-46f5-a014-3acdaa1cac9b": "Phase 4: Integrations",
    "61323024-d1b9-4e0d-898f-7dc2cfe5d2f4": "Phase 5: Observability",
    "a2320ada-9599-499f-81d8-108d9a810a1c": "Phase 6: Queue & Workers",
    "4d66736b-9e49-442f-8551-10f6b0a0585f": "Phase 7: Enterprise & i18n",
}

EPICS = {
    "phase_1_org": "873976fd-f510-4dda-b677-e6a99189e82f",
    "phase_2_rbac": "939a2fc0-ba00-456d-bf33-eee7e3296dcf",
    "phase_3_sla": "f35695e7-375c-47df-a6e5-878144e1d80d",
    "phase_4_integrations": "fdb3dbbb-c88b-4fee-9581-883e0bdedb48",
    "phase_5_observability": "f9d4ae58-64fa-4f2e-8851-bfb5a3254f2b",
    "phase_6_queue": "bc6182b2-8944-4e9e-862b-a375ec33827b",
    "phase_7_enterprise": "4a89c33d-d1f0-45c9-bff9-252c803d0ff9",
}


# ============================================================================
# API Helper
# ============================================================================
def api(method, path, data=None):
    url = f"{PLANE_BASE}/projects/{PROJECT_ID}{path}"
    headers = {
        "X-API-Key": API_KEY,
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"API Error {e.code}: {body}", file=sys.stderr)
        sys.exit(1)


def get_issues(state_key=None):
    result = api("GET", "/issues/")
    issues = result.get("results", result) if isinstance(result, dict) else result
    if state_key and state_key in STATES:
        issues = [i for i in issues if i.get("state") == STATES[state_key]]
    return issues


def format_issue(issue):
    state = STATE_NAMES.get(issue.get("state", ""), "?")
    prio = issue.get("priority", "none")
    emoji = PRIORITY_EMOJI.get(prio, "   ")
    name = issue.get("name", "?")
    iid = issue.get("id", "?")[:8]
    return f"  {emoji} [{state:11s}] {iid}.. {name}"


# ============================================================================
# Commands
# ============================================================================
def cmd_status():
    issues = get_issues()
    counts = {}
    for i in issues:
        s = STATE_NAMES.get(i.get("state", ""), "unknown")
        counts[s] = counts.get(s, 0) + 1

    print("=== Paperclip Evolution — Board Status ===")
    print(f"  Total issues: {len(issues)}")
    for state in ["backlog", "todo", "in_progress", "done", "cancelled"]:
        if state in counts:
            print(f"  {state:15s}: {counts[state]}")
    print()

    in_progress = [i for i in issues if i.get("state") == STATES["in_progress"]]
    if in_progress:
        print("Currently In Progress:")
        for i in sorted(in_progress, key=lambda x: x.get("priority", "none")):
            print(format_issue(i))


def cmd_list(state_key):
    issues = get_issues(state_key)
    issues.sort(key=lambda x: {"urgent": 0, "high": 1, "medium": 2, "low": 3, "none": 4}.get(x.get("priority", "none"), 5))
    print(f"=== {state_key.upper()} ({len(issues)} issues) ===")
    for i in issues:
        print(format_issue(i))


def cmd_modules():
    print("=== Module / Phase Progress ===")
    for mod_id, mod_name in MODULES.items():
        try:
            mod = api("GET", f"/modules/{mod_id}/")
            print(f"\n{mod_name}")
            print(f"  Status: {mod.get('status', '?')}")
            if mod.get("start_date"):
                print(f"  Timeline: {mod['start_date'][:10]} to {mod.get('target_date', '?')[:10]}")
        except Exception:
            print(f"\n{mod_name}: (could not fetch)")


def cmd_pick():
    """Pick the highest priority backlog/todo issue."""
    issues = get_issues("backlog") + get_issues("todo")
    prio_order = {"urgent": 0, "high": 1, "medium": 2, "low": 3, "none": 4}
    issues.sort(key=lambda x: prio_order.get(x.get("priority", "none"), 5))

    if not issues:
        print("No backlog/todo issues found!")
        return

    pick = issues[0]
    print("=== Next Issue to Work On ===")
    print(format_issue(pick))
    print(f"\n  Full ID: {pick['id']}")
    print(f"  Priority: {pick.get('priority', 'none')}")
    print(f"\n  To start: python3 plane-client.py start {pick['id']}")


def cmd_start(issue_id):
    api("PATCH", f"/issues/{issue_id}/", {"state": STATES["in_progress"]})
    api("POST", f"/issues/{issue_id}/comments/", {
        "comment_html": f"<p>Starting work on this issue. Timestamp: {datetime.now().isoformat()}</p>"
    })
    print(f"Issue {issue_id[:8]}.. moved to In Progress.")


def cmd_comment(issue_id, text):
    api("POST", f"/issues/{issue_id}/comments/", {
        "comment_html": f"<p>{text}</p>"
    })
    print(f"Comment added to {issue_id[:8]}..")


def cmd_complete(issue_id, text):
    api("POST", f"/issues/{issue_id}/comments/", {
        "comment_html": f"<p><strong>Completed:</strong> {text}</p>"
    })
    api("PATCH", f"/issues/{issue_id}/", {"state": STATES["done"]})
    print(f"Issue {issue_id[:8]}.. marked as Done.")


def cmd_create(name, priority, label_name, parent_id=None):
    LABEL_MAP = {
        "epic": "279a0cc3-c85b-4cc8-a854-121ca38fea42",
        "feature": "ffebdfb0-aa2a-47f9-8c65-5eb01f3a29de",
        "infrastructure": "beeb8f83-0c9d-4f4c-8456-67b6131ca60e",
        "integration": "75732288-0a72-43fb-899b-8a05fa87ac1f",
        "ux": "f55846ed-5db2-48d3-844c-b6ff8b40089c",
        "security": "98ab186b-9196-4137-9390-0f7de57ef435",
        "docs": "a564277e-8fa9-4afb-bb6d-b57ebe495157",
        "plugin": "4dc76708-d891-4634-8b30-d5692371a6d3",
        "tech_debt": "92a7f172-4ac3-4f70-afa2-0fed19044244",
    }
    payload = {
        "name": name,
        "priority": priority,
        "state": STATES["backlog"],
        "labels": [LABEL_MAP.get(label_name, label_name)],
    }
    if parent_id:
        payload["parent"] = parent_id

    result = api("POST", "/issues/", payload)
    print(f"Created: {result['id'][:8]}.. — {name}")


# ============================================================================
# Main
# ============================================================================
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "status":
        cmd_status()
    elif cmd in ("backlog", "todo", "in_progress", "in-progress", "done", "cancelled"):
        cmd_list(cmd.replace("-", "_"))
    elif cmd == "modules":
        cmd_modules()
    elif cmd == "pick":
        cmd_pick()
    elif cmd == "start" and len(sys.argv) >= 3:
        cmd_start(sys.argv[2])
    elif cmd == "comment" and len(sys.argv) >= 4:
        cmd_comment(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "complete" and len(sys.argv) >= 4:
        cmd_complete(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "create" and len(sys.argv) >= 5:
        cmd_create(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else None)
    else:
        print(__doc__)
        sys.exit(1)
