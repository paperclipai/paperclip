---
name: derive-issues
description: >
  Analyze the current codebase and generate prioritized improvement issues for Paperclip.
  Use when you want to extract follow-up work from: TODO/FIXME comments, test gaps,
  CI failures, refactoring opportunities, missing docs, or post-implementation review.
  Creates issues directly in Paperclip under a specified parent and goal.
argument-hint: "[--parent ISSUE-ID] [--dry-run] [focus: tests|docs|ci|refactor|all]"
---

# Derive Issues Skill

Analyze the current project and produce a prioritized list of improvement issues, then create them in Paperclip.

## When to use

After implementing a feature, merging a PR, or whenever the board asks for the "generate feedback → derive issues" loop. This skill closes the gap between "code exists" and "improvement backlog exists in Paperclip."

## Step 1 — Gather context

Collect the raw signals. Run these in parallel:

```bash
# Recent commits (understand what just landed)
git log --oneline -15

# Uncommitted or staged work
git status --short

# TODO/FIXME/HACK/XXX in source (exclude vendor/node_modules)
grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.go" --include="*.ts" --include="*.tsx" --include="*.js" . \
  | grep -v node_modules | grep -v vendor | grep -v dist | head -40

# Test files — spot which packages have tests and which don't
find . -name "*_test.go" -o -name "*.spec.ts" -o -name "*.test.ts" 2>/dev/null | grep -v node_modules | sort

# CI config (understand what's being checked)
cat .github/workflows/*.yml 2>/dev/null | head -80

# Recent CI runs (if gh is available)
gh run list --limit 5 2>/dev/null || echo "gh not available"

# Coverage report if present
cat coverage.out 2>/dev/null | tail -5 || echo "no coverage.out"

# Open issues already in Paperclip for this project (avoid duplicates)
# (Use Paperclip API if PAPERCLIP_API_KEY is set)
```

Also read key files: README, main entrypoint, any CLAUDE.md.

## Step 2 — Identify gaps

Think systematically across these categories:

| Category | Questions to ask |
|----------|-----------------|
| **Tests** | Which packages/modules lack tests? What error paths are untested? Is race detection enabled? Is there a coverage threshold? |
| **CI/Build** | Are there flaky tests? Missing lint rules? No branch protection? Release pipeline incomplete? |
| **Docs** | Is the README accurate? Are CLI flags documented? Are span attributes documented for all code paths? |
| **Code quality** | TODOs in hot paths? Error handling gaps (unchecked errors, missing context propagation)? Magic numbers? |
| **Features** | What's in the roadmap but not tracked as an issue? What did the last PR intentionally defer? |
| **Security** | Hardcoded secrets? Missing TLS options? Unvalidated inputs at boundaries? |
| **Observability** | Missing log levels? No health check? Metrics not tracked? |

## Step 3 — Draft issues

For each identified gap, draft a Paperclip issue with:

```
Title: <imperative verb> <what> (e.g. "Add race detector to test matrix", "Document --trace-all flag behavior")
Priority: critical | high | medium | low
  - critical: breaks builds or causes data loss
  - high: significant improvement to reliability or correctness
  - medium: quality of life, coverage, docs
  - low: nice-to-have, cosmetic
Description:
  ## Why
  (one sentence on the impact or risk if not done)

  ## What
  (concrete, actionable steps)

  ## Acceptance criteria
  - [ ] specific, testable condition
```

Aim for 3–8 issues per run. Do not pad. Each issue must be actionable in one session.

## Step 4 — Parse arguments

From `$ARGUMENTS`:

- `--parent ISSUE-ID` — set as `parentId` on all created issues (e.g. `--parent ANGA-17`)
- `--dry-run` — print issues but do NOT call the API to create them
- Focus keywords: `tests`, `docs`, `ci`, `refactor`, `security`, `all` (default: `all`)

If no `--parent` is given, ask the user or check `PAPERCLIP_TASK_ID` for the current issue.

## Step 5 — Create issues in Paperclip

Unless `--dry-run`, create each issue via the Paperclip API. Resolve the parent issue's `goalId` and `projectId` first (GET the parent issue), then post each derived issue.

Use Python urllib (not curl + pipe) for reliability on Windows:

```python
import json, urllib.request, os

api_key = os.environ['PAPERCLIP_API_KEY']
api_url = os.environ.get('PAPERCLIP_API_URL', 'http://127.0.0.1:3100')
company_id = os.environ['PAPERCLIP_COMPANY_ID']
run_id = os.environ.get('PAPERCLIP_RUN_ID', '')

# 1. Resolve parent issue
parent_id = '<resolved-from-args>'
req = urllib.request.Request(
    f'{api_url}/api/issues/{parent_id}',
    headers={'Authorization': f'Bearer {api_key}'}
)
with urllib.request.urlopen(req) as resp:
    parent = json.loads(resp.read()).get('issue', {})
    goal_id = parent.get('goalId')
    project_id = parent.get('projectId')

# 2. Create each derived issue
issues_to_create = [
    # {"title": "...", "priority": "high", "description": "..."},
]

for issue in issues_to_create:
    body = {
        "title": issue["title"],
        "priority": issue["priority"],
        "description": issue["description"],
        "parentId": parent_id,  # resolved UUID or identifier
        "goalId": goal_id,
        "projectId": project_id,
        "status": "todo",
        "assigneeAgentId": os.environ.get('PAPERCLIP_AGENT_ID'),
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f'{api_url}/api/companies/{company_id}/issues',
        data=data, method='POST',
        headers={
            'Authorization': f'Bearer {api_key}',
            'X-Paperclip-Run-Id': run_id,
            'Content-Type': 'application/json',
        }
    )
    with urllib.request.urlopen(req) as resp:
        created = json.loads(resp.read())
        print(f"Created {created.get('identifier')}: {created.get('title')}")
```

## Step 6 — Report

After creation, post a summary comment on the parent issue listing all created issues with their identifiers and priorities. Use the standard comment style (links, not bare identifiers).

## Key rules

- **No padding**: if the codebase is clean, say so and create 0–1 issues
- **No duplicates**: check existing Paperclip issues before creating; skip if similar issue exists
- **Actionable only**: each issue must be completable in a single agent session
- **Always set parentId + goalId**: never create orphaned issues
