#!/usr/bin/env python3
"""
Blocker Hygiene Auditor (ROC-1286)

Scans blocked issues missing blockedByIssueIds, detects candidate blockers from comments,
posts HITL comments with idempotency marker.
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime
from typing import List, Dict, Any, Optional
import requests

API_BASE = "http://127.0.0.1:3101/api"
COMPANY_ID = "5c2551e8-cb65-4ab4-9fee-8e0001be2e41"
AGENT_ID = "e5d74e0c-aff9-494d-b70c-f0ae557a49fe"
MARKER = "<!-- blocker-hygiene-auditor -->"
AUTO_REMINDER_PATTERN = re.compile(r"ROC-\d+ — Blocker auto-reminder")

def api_get(path: str) -> Any:
    resp = requests.get(f"{API_BASE}{path}")
    resp.raise_for_status()
    return resp.json()

def api_post(path: str, data: dict) -> Any:
    resp = requests.post(f"{API_BASE}{path}", json=data)
    resp.raise_for_status()
    return resp.json()

def api_patch(path: str, data: dict) -> Any:
    resp = requests.patch(f"{API_BASE}{path}", json=data)
    resp.raise_for_status()
    return resp.json()

def get_blocked_issues() -> List[Dict]:
    issues = api_get(f"/companies/{COMPANY_ID}/issues?status=blocked")
    return [i for i in issues if i.get("status") == "blocked"]

def get_issue_comments(issue_id: str) -> List[Dict]:
    # Assuming comments endpoint; adjust if different
    try:
        return api_get(f"/issues/{issue_id}/comments")
    except:
        return []

def get_full_issue(issue_id: str) -> Dict:
    try:
        return api_get(f"/issues/{issue_id}")
    except:
        return {}

def extract_candidate_blockers(comments: List[Dict]) -> List[str]:
    candidates = []
    for c in comments:
        body = c.get("body", "")
        if AUTO_REMINDER_PATTERN.search(body):
            continue
        matches = re.findall(r"ROC-\d+", body)
        for m in matches:
            if m not in candidates:
                candidates.append(m)
    return candidates

def has_audit_marker(comments: List[Dict]) -> bool:
    for c in comments:
        if MARKER in c.get("body", ""):
            return True
    return False

def post_hitl_comment(issue_id: str, candidates: List[str]) -> None:
    body = f"""{MARKER}
**Blocker Hygiene Audit** — This issue is marked `blocked` but `blockedByIssueIds` is empty.

Candidate blocker references found in comments:
{', '.join(candidates) if candidates else 'None detected'}

Please PATCH the issue with the correct `blockedByIssueIds` array.
"""
    api_post(f"/issues/{issue_id}/comments", {"body": body})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--max-actions", type=int, default=20)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    issues = get_blocked_issues()
    print(f"Found {len(issues)} blocked issues")

    actions = 0
    for issue in issues:
        if actions >= args.max_actions:
            break
        iid = issue["id"]
        identifier = issue["identifier"]

        full = get_full_issue(iid)
        if full.get("blockedBy"):
            print(f"{identifier}: already_tracked")
            continue

        comments = get_issue_comments(iid)
        if has_audit_marker(comments):
            print(f"{identifier}: already audited")
            continue
        candidates = extract_candidate_blockers(comments)
        if not candidates:
            print(f"{identifier}: no signal")
            continue
        print(f"{identifier}: candidates {candidates}")
        if args.apply:
            post_hitl_comment(iid, candidates)
            actions += 1
            print(f"  -> posted HITL comment")
            time.sleep(0.5)

    print(f"Completed. Actions taken: {actions}")

if __name__ == "__main__":
    main()
