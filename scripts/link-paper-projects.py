#!/usr/bin/env python3
"""Reconcile research papers into board projects (project-per-paper).

Reads the paper registry (``paper-candidates.jsonl``) and the Paperclip board
API, then:

- creates one board project per registered paper (``PAPER-0NN — <title>``)
  when none exists yet, mapping the paper state to a project status
  (PREREG-CANDIDATE/REFERENCE-ONLY -> backlog, DROP-*/RETIRED-* -> cancelled,
  bumped to in_progress when the paper already has open linked issues);
- links issues that mention a ``PAPER-0NN`` token (title preferred over
  description) to that paper's project, only when ``projectId`` is null;
- ensures the standard label vocabulary exists (stage:*, verdict:*) so intake
  and agents can tag issues consistently.

Reconcile-only, idempotent, and deliberately non-destructive: it never edits
or archives an existing project, never re-links an issue that already has a
project, never touches issue labels, and never deletes anything. Operator
edits on the board always win. Default is a dry-run report; pass ``--apply``
to write. Unknown paper tokens (papers no longer in the registry) are
reported and skipped.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_REGISTRY = Path("/root/cli/micro-addon/research-loop/paper-candidates.jsonl")
DEFAULT_API_BASE = "http://127.0.0.1:3110/api"
DEFAULT_COMPANY_NAME = "fincli.ai"

PAPER_TOKEN_RE = re.compile(r"PAPER-\d+")

# Paper registry state -> project status at creation time only. Existing
# projects are never updated, so later state changes are the operator's call.
STATE_TO_STATUS = {
    "PREREG-CANDIDATE": "backlog",
    "REFERENCE-ONLY": "backlog",
    "DROP-NO-EDGE-MECHANISM": "cancelled",
    "RETIRED-REFUTED": "cancelled",
}
OPEN_ISSUE_STATUSES = {"backlog", "todo", "in_progress", "in_review", "blocked"}

STATUS_COLOR = {
    "backlog": "#6366f1",
    "in_progress": "#f59e0b",
    "cancelled": "#64748b",
}

STANDARD_LABELS = [
    ("stage:predeclare", "#6366f1"),
    ("stage:oos", "#0ea5e9"),
    ("stage:verdict", "#f59e0b"),
    ("verdict:kill", "#64748b"),
    ("verdict:promote", "#22c55e"),
]


def api(base: str, path: str, payload: dict | None = None, method: str | None = None):
    url = f"{base}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method or ("POST" if data else "GET"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read() or b"null")


def load_registry(path: Path) -> dict[str, dict]:
    papers: dict[str, dict] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        token = row.get("id")
        if token and PAPER_TOKEN_RE.fullmatch(token):
            papers[token] = row  # last row per id wins (registry appends updates)
    return papers


def issue_paper_token(issue: dict) -> str | None:
    in_title = PAPER_TOKEN_RE.findall(issue.get("title") or "")
    if in_title:
        return in_title[0]
    in_desc = PAPER_TOKEN_RE.findall(issue.get("description") or "")
    return in_desc[0] if in_desc else None


def project_paper_token(project: dict) -> str | None:
    match = PAPER_TOKEN_RE.match(project.get("name") or "")
    return match.group(0) if match else None


def build_project_payload(token: str, paper: dict, has_open_issue: bool) -> dict:
    title = (paper.get("title") or "untitled").strip()
    status = STATE_TO_STATUS.get(paper.get("state") or "", "backlog")
    if status == "backlog" and has_open_issue:
        status = "in_progress"
    desc_lines = [
        title,
        f"state: {paper.get('state', 'unknown')}",
        f"url: {paper.get('url') or paper.get('pdf_url') or 'n/a'}",
        f"source: {paper.get('source', 'n/a')}",
    ]
    if paper.get("reason"):
        desc_lines.append(f"reason: {paper['reason']}")
    return {
        "name": f"{token} — {title[:70]}",
        "description": "\n".join(desc_lines),
        "status": status,
        "color": STATUS_COLOR.get(status, "#6366f1"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--company-name", default=DEFAULT_COMPANY_NAME)
    parser.add_argument("--apply", action="store_true", help="write changes (default: dry-run report)")
    args = parser.parse_args()

    papers = load_registry(args.registry)
    companies = api(args.api_base, "/companies")
    company = next((c for c in companies if c["name"] == args.company_name), None)
    if not company:
        print(f"ERROR: company {args.company_name!r} not found", file=sys.stderr)
        return 1
    cid = company["id"]

    projects = api(args.api_base, f"/companies/{cid}/projects")
    project_by_token = {t: p for p in projects if (t := project_paper_token(p))}

    issues = api(args.api_base, f"/companies/{cid}/issues?limit=1000")
    if isinstance(issues, dict):
        issues = issues.get("issues") or issues.get("items") or []
    open_tokens = {
        issue_paper_token(i)
        for i in issues
        if i.get("status") in OPEN_ISSUE_STATUSES and issue_paper_token(i)
    }

    failures = 0
    created = 0
    for token, paper in sorted(papers.items()):
        if token in project_by_token:
            continue
        payload = build_project_payload(token, paper, token in open_tokens)
        print(f"create project: {payload['name']} [{payload['status']}]")
        if args.apply:
            try:
                project_by_token[token] = api(args.api_base, f"/companies/{cid}/projects", payload)
                created += 1
            except urllib.error.URLError as err:
                failures += 1
                print(f"  FAILED: {err}", file=sys.stderr)

    linked = 0
    for issue in issues:
        if issue.get("projectId"):
            continue
        token = issue_paper_token(issue)
        if not token:
            continue
        project = project_by_token.get(token)
        if not project:
            if token in papers:
                # Dry-run (project not created yet) or its create failed above.
                print(f"link {issue.get('identifier')} -> {token} (project pending)")
            else:
                print(f"skip {issue.get('identifier')}: {token} not in registry")
            continue
        print(f"link {issue.get('identifier')} -> {project['name']}")
        if args.apply:
            try:
                api(args.api_base, f"/issues/{issue['id']}", {"projectId": project["id"]}, method="PATCH")
                linked += 1
            except urllib.error.URLError as err:
                failures += 1
                print(f"  FAILED: {err}", file=sys.stderr)

    existing_labels = {label["name"] for label in api(args.api_base, f"/companies/{cid}/labels")}
    for name, color in STANDARD_LABELS:
        if name in existing_labels:
            continue
        print(f"create label: {name}")
        if args.apply:
            try:
                api(args.api_base, f"/companies/{cid}/labels", {"name": name, "color": color})
            except urllib.error.URLError as err:
                failures += 1
                print(f"  FAILED: {err}", file=sys.stderr)

    mode = "applied" if args.apply else "dry-run"
    print(f"{mode}: {len(papers)} papers, {created} projects created, {linked} issues linked, {failures} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
