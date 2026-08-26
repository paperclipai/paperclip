#!/usr/bin/env python3
"""Bounded P1/P2 unassigned routing sweep for the TSMC-16557 route.

Eligible issues have status ``todo``, priority ``critical`` or ``high``, and
no user or agent assignee. They must be untouched for over 30 minutes.
Candidates are assigned without changing their state to RoutingPA if running,
otherwise to a healthy CEO fallback from the current company topology. If no
healthy owner is available, they remain unassigned.
The execution issue receives the auditable summary and is marked done.
"""
from __future__ import annotations

import argparse, json, os, socket, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

ROUTING_PA_AGENT_ID = "c4d49b19-af16-4962-a915-7e9fbe525beb"
PARKED_CLAUDE_CEO_AGENT_ID = "391be1fe-4dac-4944-b6c7-16576ca51579"
PRIORITIES = {"critical", "high"}
STATUSES = ("todo",)

def api(method, path, body=None):
    base = os.environ["PAPERCLIP_API_URL"].rstrip("/")
    key = os.environ["PAPERCLIP_API_KEY"]
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method)
    request.add_header("Authorization", f"Bearer {key}")
    if os.environ.get("PAPERCLIP_RUN_ID"):
        request.add_header("X-Paperclip-Run-Id", os.environ["PAPERCLIP_RUN_ID"])
    if body is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read().decode()
    return json.loads(raw) if raw else {}

def parse_timestamp(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None

def candidate(issue, now):
    status = str(issue.get("status") or "").lower()
    if status not in STATUSES or issue.get("priority") not in PRIORITIES:
        return False
    if issue.get("assigneeAgentId") or issue.get("assigneeUserId"):
        return False
    updated = parse_timestamp(issue.get("updatedAt") or issue.get("createdAt"))
    if updated is None:
        return False
    return now - updated >= timedelta(minutes=30)

def agent_running(agent_id):
    try:
        agent = api("GET", f"/api/agents/{agent_id}")
    except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, ConnectionError):
        return False
    return str(agent.get("status") or "").lower() in {"running", "idle"}

def healthy_ceo_fallback(agents):
    """Return a live CEO from topology, never the deliberately parked lane."""
    for agent in agents:
        if not isinstance(agent, dict):
            continue
        agent_id = agent.get("id")
        identity = " ".join(
            str(agent.get(field) or "") for field in ("role", "title", "name")
        ).lower()
        if (
            isinstance(agent_id, str)
            and agent_id != PARKED_CLAUDE_CEO_AGENT_ID
            and "ceo" in identity
            and str(agent.get("status") or "").lower() in {"running", "idle"}
        ):
            return agent_id
    return None


def route_target(company_id):
    if agent_running(ROUTING_PA_AGENT_ID):
        return ROUTING_PA_AGENT_ID, "RoutingPA"
    try:
        payload = api("GET", f"/api/companies/{company_id}/agents")
    except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, ConnectionError):
        payload = []
    agents = payload if isinstance(payload, list) else payload.get("agents", [])
    fallback = healthy_ceo_fallback(agents)
    if fallback:
        return fallback, "healthy CEO fallback"
    return None, "unassigned"

def list_issues(company_id):
    payload = api("GET", f"/api/companies/{company_id}/issues?status={','.join(STATUSES)}&limit=200")
    return payload if isinstance(payload, list) else payload.get("issues", [])

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("issue_id", nargs="?")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    execution_id = args.issue_id or os.environ.get("PAPERCLIP_TASK_ID")
    if not execution_id:
        raise SystemExit("missing execution issue id")
    now = datetime.now(timezone.utc)
    target_id, target_name = route_target(os.environ["PAPERCLIP_COMPANY_ID"])
    candidates = [item for item in list_issues(os.environ["PAPERCLIP_COMPANY_ID"]) if candidate(item, now)]
    routed = []
    if not args.dry_run and target_id:
        for item in candidates:
            try:
                api("PATCH", f"/api/issues/{item['id']}", {"status": item["status"], "assigneeAgentId": target_id, "comment": f"Auto-routed by TSMC-16557 P1/P2 visibility sweep to `{target_name}`; status preserved."})
                routed.append(item.get("identifier") or item["id"])
            except urllib.error.HTTPError as exc:
                if exc.code != 403:
                    raise
        summary = {"routeTarget": target_name, "candidateCount": len(candidates), "routed": routed, "mode": "apply"}
        api("PATCH", f"/api/issues/{execution_id}", {"status": "done", "comment": "## Unassigned P1/P2 auto-routing sweep\n\n```json\n" + json.dumps(summary, indent=2) + "\n```"})
    elif not args.dry_run:
        summary = {"routeTarget": target_name, "candidateCount": len(candidates), "routed": [], "mode": "apply"}
        api("PATCH", f"/api/issues/{execution_id}", {"status": "done", "comment": "## Unassigned P1/P2 auto-routing sweep\n\n```json\n" + json.dumps(summary, indent=2) + "\n```"})
    else:
        summary = {"routeTarget": target_name, "candidateCount": len(candidates), "mode": "dry-run"}
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
