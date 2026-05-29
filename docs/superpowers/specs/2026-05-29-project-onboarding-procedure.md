# Project Onboarding Procedure

**Date:** 2026-05-29  
**Owner:** ProjectManager (Operations project)  
**Used by:** Any agent or human spinning up a new project under Paperclip management

---

## What This Covers

How to bring a new codebase, product, or workstream under Paperclip management. Run this procedure every time a new project starts. The procedure is largely automated — the onboarding agent reads the target repo's documentation to discover what the project needs, then creates appropriate Paperclip tasks from those findings.

All onboarding issues live in the **Operations** project (`bdb497cb-e7cb-421b-ad1d-b68e7f0b48b8`).

---

## Step 1 — Create the Paperclip Project

```bash
POST /api/companies/{companyId}/projects
{
  "name": "<Project Name>",
  "urlKey": "<lowercase-kebab>",
  "description": "<One paragraph: what this project is, what repo/system it covers, what agents own it>",
  "status": "in_progress"
}
```

**Naming convention:**
- Product features → name matches the product area (e.g. `Voice`, `Chat`, `RBAC`)
- DevOps / platform work → `Infrastructure`
- Marketing / growth → `Marketing`
- Internal tooling → `Tooling`
- Cross-project coordination → `Operations` (already exists)

Save the returned `id` — you'll use it as `projectId` on all issues in this project.

---

## Step 2 — Repo Discovery (Automated)

This is the core of onboarding. The assigned agent reads the target repo to understand what the project needs to run. Do this before creating any tasks.

### What to read (in order)

1. **`README.md`** — overview, install steps, quickstart
2. **`CONTRIBUTING.md`** or **`DEVELOPMENT.md`** — local dev setup, conventions
3. **`docs/`** — any subdirectory docs, architecture notes, ADRs
4. **`GETTING_STARTED*.md`**, **`QUICK_START*.md`** — step-by-step setup guides
5. **Dependency manifests:**
   - Python: `requirements.txt`, `requirements-ci/*.txt`, `pyproject.toml`, `setup.py`
   - Node: `package.json`, `pnpm-workspace.yaml`
   - System: `Dockerfile`, `docker-compose.yml`, `Makefile`, `Brewfile`
6. **`.env.example`** or **`.env.template`** — required environment variables
7. **CI config:** `.github/workflows/*.yml` — what checks run, what they require
8. **Ansible / provisioning:** `ansible/`, `provision*.yml` — infrastructure requirements

### GitHub state scan

Run these after reading the docs:

```bash
# Open issues — full list with labels and age
gh issue list --repo <owner>/<repo> --state open --json number,title,labels,createdAt,assignees --limit 200

# Open pull requests — with CI status and review state
gh pr list --repo <owner>/<repo> --state open --json number,title,headRefName,reviewDecision,statusCheckRollup,createdAt,assignees --limit 50
```

Classify each:

| Item | Classification |
|---|---|
| Issue: `bug`/`fix` label or title | Critical — needs a Paperclip task immediately |
| Issue: `feat`/`design` | Backlog — will be picked up by PM dispatch routine |
| Issue: no label, ambiguous | Flag for CTO triage |
| PR: failing CI | Needs fix — create a Paperclip task |
| PR: approved, not merged | Stale — create a Paperclip task to merge or close |
| PR: open > 7 days, no review | Needs review — assign to CodeReviewer |
| PR: draft | Monitor — no action needed |

### What to extract

From the above, build a structured inventory:

```markdown
## Project Inventory: <Project Name>

### Services required
- [ ] <service name> (e.g. PostgreSQL, Redis, ChromaDB)

### Environment variables required
- [ ] <VAR_NAME> — <description>

### System dependencies
- [ ] <tool/package> — <version if specified>

### Setup steps (in order)
1. <step>
2. <step>

### CI checks that must pass
- [ ] <check name>

### Open GitHub issues (summary)
- Total open: N
- Critical (bug/fix): N — listed below
- Backlog (feat/design): N — PM dispatch will handle

### Open pull requests (summary)
- Total open: N
- Failing CI: N — listed below
- Stale (approved, unmerged): N — listed below
- Needs review (>7 days): N — listed below

### Known gaps / undocumented requirements
- <anything found missing or unclear in the docs>
```

Post this inventory as a document on the kickoff issue (key: `inventory`).

---

## Step 3 — Structure All Findings as Sub-Issues

**Every item found in discovery becomes a child issue of the kickoff issue.** No flat tasks. The kickoff issue is the parent; everything discovered hangs off it with `parentId` set to the kickoff issue ID. When all children reach `done`, Paperclip wakes the parent automatically and the kickoff closes.

Group children into **category parent issues** first, then individual tasks under those:

```
[Kickoff] MyProject
├── [Onboarding] Setup — environment & services
│   ├── [Setup] Configure AUTOBOT_AUDIT_LOG_FILE
│   ├── [Setup] Provision Redis
│   └── [CI] Add linting check to pipeline
├── [Onboarding] Docs gaps
│   └── [Docs] Document local dev setup in README
├── [Onboarding] GitHub issues — critical
│   ├── [GH#42] fix(backend): crash on startup
│   └── [GH#38] bug(auth): token refresh fails
├── [Onboarding] GitHub issues — triage
│   └── [Triage] GH#51: unclear ownership
└── [Onboarding] Pull requests — action needed
    ├── [Merge] PR#88: approved but unmerged
    └── [Review] PR#91: open 9 days, no review
```

Create the category parents first (status `blocked`, `blockedByIssueIds` = their children), then the leaf children. Set `projectId` to the Operations project on every issue.

**Routing for leaf children:**

| Finding | Assignee |
|---|---|
| Missing env var | DevOpsEngineer |
| Missing service | DevOpsEngineer |
| Undocumented requirement | lead agent |
| Broken setup step | appropriate engineer by topic |
| Missing CI check | DevOpsEngineer |
| Critical GH issue (`bug`/`fix`) | routed by topic per standard routing table |
| Ambiguous GH issue | CTO |
| Failing CI on PR | DevOpsEngineer or BackendEngineer |
| Approved + unmerged PR | CodeReviewer |
| Stale PR (>7 days, no review) | CodeReviewer |

Backlog GH issues (`feat`/`design`) are **not** sub-issued here — leave them for the PM dispatch routine to ingest on its next cycle.

---

## Step 4 — Assign a Lead Agent

Every project must have one lead agent who owns delivery:

| Project type | Lead agent |
|---|---|
| Backend product features | BackendEngineer |
| Frontend product features | SeniorFrontendDeveloper |
| Infrastructure / DevOps | DevOpsEngineer |
| Security | SecurityEngineer |
| Architecture / cross-cutting | CTO |
| Marketing | CMO |

---

## Step 5 — Create a Project Kickoff Issue

```bash
POST /api/companies/{companyId}/issues
{
  "title": "[Kickoff] <Project Name> — goals, scope, and first sprint",
  "description": "## Goal\n\n<What does done look like for this project?>\n\n## Scope\n\n<What repo/system? What is out of scope?>\n\n## Inventory\n\nSee document: inventory\n\n## First Sprint\n\n<3–5 concrete deliverables>\n\n## Agents\n\n- Lead: <name>\n- Supporting: <names>\n\n## Links\n\n- Repo: <GitHub URL>\n- Design: <link if applicable>",
  "projectId": "<new-project-id>",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "<lead-agent-id>"
}
```

Attach the inventory document from Step 2 to this issue.

---

## Step 6 — Link the GitHub Repo to PM Dispatch

If the project has a GitHub repo, update the PM dispatch routine to pull its issues:

1. Update the PM's `## GitHub Issue Ingestion` instructions to add the new repo to its `gh issue list` sweep
2. Add a `projectId` mapping: issues from this repo → assigned to this Paperclip project
3. Post a comment on the kickoff issue confirming the repo is wired

---

## Step 7 — Configure Routines (Optional)

| Routine | Cadence | Purpose |
|---|---|---|
| Weekly delivery snapshot | Monday 09:00 | Lead posts shipped/slipped/at-risk |
| CI health check | Every 15 min | Catch failing checks early |
| Orphan cleanup | Daily | Remove stale branches/worktrees |

---

## Step 8 — Verify

Before closing the onboarding issue as done:

- [ ] Paperclip project created with description
- [ ] Repo discovery completed — inventory document posted
- [ ] Setup tasks created for all unmet requirements
- [ ] Lead agent assigned
- [ ] Kickoff issue created
- [ ] GitHub repo linked in PM dispatch
- [ ] At least 3 `backlog`/`todo` issues seeding the new project
- [ ] Relevant routines created

---

## Existing Projects Reference

| Project | ID | Status | Lead |
|---|---|---|---|
| Operations | `bdb497cb-e7cb-421b-ad1d-b68e7f0b48b8` | in_progress | ProjectManager |
| Onboarding | `3da3b2dd-deeb-4e0e-bf0c-9ffff4f2eba0` | in_progress | CEO |
| Autobot | `22d17c44-a12c-4913-b389-8c1690ea4b25` | planned | FoundingEngineer |
| AutoBot Marketing | `31a12eb4-35ad-44d0-a101-ea9901fe131b` | planned | CMO |
