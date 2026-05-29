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

### Labels and project assignment (required on every issue)

Every Paperclip issue created during onboarding **must** have:

1. **`projectId`** set — Operations project for setup/onboarding tasks; the target project for product issues
2. **A label** derived from the issue type:

| Issue type | Label |
|---|---|
| Setup / environment / provisioning | `setup` |
| Documentation gap | `docs` |
| CI / pipeline | `ci` |
| Bug imported from GitHub | `bug` |
| PR needing review | `review` |
| PR needing merge | `merge` |
| Triage / unclear | `triage` |

Apply labels to the **GitHub issue** too where applicable — if a GH issue is missing a `bug` or `fix` label but is clearly a bug, apply it:

```bash
gh issue edit <number> --repo <owner>/<repo> --add-label "bug"
```

### Sweep check before closing Step 3

Before moving on, run a sweep of all issues created so far and verify:

```
For each created Paperclip issue:
  - projectId is set? ✓/✗
  - at least one label? ✓/✗
  - parentId set (for children)? ✓/✗
  - assigneeAgentId set? ✓/✗
```

Fix any gaps inline. Do not proceed to Step 4 with unlabelled or unprojectd issues.

---

## Step 4 — Create Project Documentation Hub

Every project must have a single issue that serves as the permanent documentation home. Create it immediately after the kickoff issue, under the target project (not Operations):

```bash
POST /api/companies/{companyId}/issues
{
  "title": "[Docs] <Project Name> — Project Documentation Hub",
  "description": "Central documentation for <Project Name>. All five sections must be kept up to date. See attached documents.",
  "projectId": "<target-project-id>",
  "status": "in_progress",
  "priority": "high",
  "assigneeAgentId": "<lead-agent-id>",
  "label": "docs"
}
```

This issue stays `in_progress` permanently — it is a living document, not a task to close.

### Required documents (create all five)

Use `PUT /api/issues/{issueId}/documents/{key}` to create each:

**`prd`** — Product Requirements
```markdown
# PRD: <Project Name>

## Scope
<What does this project do? What problem does it solve?>

## Goals
- <Goal 1>
- <Goal 2>

## User Stories
- As a <user>, I want to <action> so that <outcome>

## Acceptance Criteria
- [ ] <criterion>
```

**`tech-stack`** — Technical Stack
```markdown
# Technical Stack: <Project Name>

## Languages
- <language> <version>

## Frameworks & Libraries
- <framework> <version> — <purpose>

## Infrastructure
- <service> — <provider, version, region>

## External Services
- <service> — <what it's used for, API version>
```

**`access-guide`** — Access & Credentials Guide
```markdown
# Access & Credentials: <Project Name>

## Repositories
- <repo URL> — <how to request access>

## Services & Environments
- <service>: <how to get credentials, who to ask>

## Environment Variables
- `<VAR_NAME>` — <where to find the value>

## Notes
<Any special access requirements, VPN, SSH keys, etc.>
```

**`architecture`** — Architecture Notes
```markdown
# Architecture: <Project Name>

## System Overview
<High-level description of how the system works>

## Data Flow
<How data moves through the system>

## Key Components
- <component> — <purpose>

## Decisions & ADRs
- <decision> — <rationale, date>

## Known Constraints
- <constraint>
```

**`runbooks`** — Runbooks
```markdown
# Runbooks: <Project Name>

## Deployment
1. <step>

## Rollback
1. <step>

## Incident Response
1. Identify: <how to detect the problem>
2. Contain: <immediate action>
3. Resolve: <fix steps>
4. Post-mortem: <what to document>

## Common Operations
- <operation>: `<command or procedure>`
```

### Populate from discovery

Fill each document with whatever was found during repo discovery (Step 2). Stub out sections that are unknown — do not leave them blank. Use `_Not yet documented_` for missing sections so agents know they need filling, not that they were forgotten.

The hub issue is also where the inventory document (from Step 2) is linked in the description.

---

## Step 6 — Assign a Lead Agent

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

## Step 7 — Create a Project Kickoff Issue

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

## Step 8 — Link the GitHub Repo to PM Dispatch

If the project has a GitHub repo, update the PM dispatch routine to pull its issues:

1. Update the PM's `## GitHub Issue Ingestion` instructions to add the new repo to its `gh issue list` sweep
2. Add a `projectId` mapping: issues from this repo → assigned to this Paperclip project
3. Post a comment on the kickoff issue confirming the repo is wired

---

## Step 9 — Configure Routines (Optional)

| Routine | Cadence | Purpose |
|---|---|---|
| Weekly delivery snapshot | Monday 09:00 | Lead posts shipped/slipped/at-risk |
| CI health check | Every 15 min | Catch failing checks early |
| Orphan cleanup | Daily | Remove stale branches/worktrees |

---

## Step 10 — Verify

Before closing the onboarding issue as done:

- [ ] Paperclip project created with description
- [ ] Repo discovery completed — inventory document posted
- [ ] Setup tasks created for all unmet requirements, structured as sub-issues
- [ ] **All issues have a label and correct `projectId`** — sweep passed
- [ ] GitHub issues labelled correctly at source (bug labels applied where missing)
- [ ] **Documentation hub issue created** with all 5 documents (`prd`, `tech-stack`, `access-guide`, `architecture`, `runbooks`) — no blank sections, stubs use `_Not yet documented_`
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
