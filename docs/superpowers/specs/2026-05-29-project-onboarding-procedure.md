# Project Onboarding Procedure

**Date:** 2026-05-29  
**Owner:** ProjectManager (Operations project)  
**Trigger:** User creates a new Paperclip project → PM detects it has no documentation hub → runs onboarding automatically

---

## Concept

The user creates an empty project in Paperclip — just a name and a GitHub repo URL in the description. That's it. The PM onboarding routine detects the new project, reads the repo, and populates everything: documentation hub, issue backlog, setup tasks, PR cleanup. The project goes from empty to fully structured in one PM heartbeat.

---

## Trigger Detection

On every PM heartbeat, after inbox routing, check for uninitialised projects:

```bash
GET /api/companies/{companyId}/projects
```

A project is **uninitialised** if it has no issue with `[Docs]` in the title. For each uninitialised project, run the onboarding flow below. Extract the GitHub repo URL from the project description.

---

## Step 1 — Parse the GitHub Repo URL

Extract `<owner>/<repo>` from the project description. If no URL is present, create a `[Onboarding] <Project Name> — needs GitHub repo URL` issue assigned to CEO and skip remaining steps until it's provided.

---

## Step 2 — Read the Repo

Read the repo to understand what the project is and what it needs to run. Do this in parallel where possible.

### Documentation files (extract content, not just existence)

```bash
# Core docs
gh api repos/<owner>/<repo>/contents/README.md | jq -r '.content' | base64 -d
gh api repos/<owner>/<repo>/contents/CONTRIBUTING.md | jq -r '.content' | base64 -d
gh api repos/<owner>/<repo>/contents/DEVELOPMENT.md | jq -r '.content' | base64 -d

# Docs directory — list and read all .md files
gh api repos/<owner>/<repo>/git/trees/HEAD --jq '.tree[] | select(.path | startswith("docs/")) | .path'
```

Files to read and extract from:

| File | Extract |
|---|---|
| `README.md` | Project overview, tech stack mentions, setup steps, quickstart |
| `CONTRIBUTING.md` / `DEVELOPMENT.md` | Local dev setup, conventions, prerequisites |
| `docs/**/*.md` | Architecture notes, ADRs, guides, runbooks, procedures |
| `GETTING_STARTED*.md`, `QUICK_START*.md` | Step-by-step setup |
| `.env.example` / `.env.template` | All required environment variables |
| `docker-compose.yml` | Services (names, ports, images) |
| `requirements*.txt`, `package.json`, `pyproject.toml` | Dependencies and versions |
| `.github/workflows/*.yml` | CI checks, required tooling, test commands |
| `ansible/`, `provision*.yml`, `Makefile` | Infrastructure and operational procedures |
| `**/runbook*.md`, `**/RUNBOOK*.md` | Operational runbooks — extract verbatim |
| `**/adr/*.md`, `**/architecture*.md` | Architecture decisions — extract verbatim |

**For AutoBot-AI and its subprojects**, also check:
```
autobot-slm-backend/ansible/roles/*/README.md   — role-level procedures
autobot-backend/docs/                            — backend architecture
docs/architecture/                               — system design docs
docs/runbooks/                                   — operational runbooks
docs/adr/                                        — architecture decisions
```

### GitHub state

```bash
# Open issues
gh issue list --repo <owner>/<repo> --state open \
  --json number,title,body,labels,createdAt,assignees --limit 200

# Open pull requests
gh pr list --repo <owner>/<repo> --state open \
  --json number,title,headRefName,reviewDecision,statusCheckRollup,createdAt,assignees --limit 50
```

---

## Step 3 — Create the Documentation Hub

Create the hub issue first — everything else references it:

```bash
POST /api/companies/{companyId}/issues
{
  "title": "[Docs] <Project Name> — Project Documentation Hub",
  "description": "Central documentation for <Project Name>. Populated automatically from repo. Keep up to date as the project evolves.\n\nRepo: <GitHub URL>",
  "projectId": "<project-id>",
  "status": "in_progress",
  "priority": "high",
  "label": "docs"
}
```

Then create all five documents using content extracted from the repo. **Do not leave sections blank — use content from the repo where it exists, stub with `_Not yet documented_` where it does not.**

### `prd` — Product Requirements

Populate from: README overview section, any `docs/prd*.md`, `docs/product*.md`, or product-related docs found.

```markdown
# PRD: <Project Name>

## What This Is
<Extracted from README — what the project does, who it's for>

## Goals
<Extracted from docs or README goals/objectives section>

## User Stories
<Extracted from any user story docs, or derived from feature list>

## Acceptance Criteria
<Extracted from CONTRIBUTING or test descriptions where found>
```

### `tech-stack` — Technical Stack

Populate from: `requirements*.txt`, `package.json`, `docker-compose.yml`, `Dockerfile`, README tech mentions.

```markdown
# Technical Stack: <Project Name>

## Languages
<Extracted from manifests>

## Frameworks & Libraries
<Extracted from requirements/package.json with versions>

## Infrastructure & Services
<Extracted from docker-compose.yml, ansible roles>

## External Services & APIs
<Extracted from .env.example keys, README mentions>
```

### `access-guide` — Access & Credentials Guide

Populate from: `.env.example`, `README` setup sections, `CONTRIBUTING` access notes.

```markdown
# Access & Credentials: <Project Name>

## Repositories
- <repo URL>

## Required Environment Variables
<Every key from .env.example with its description>

## Services Access
<Extracted from README/CONTRIBUTING — how to get access to each external service>

## Notes
<Any VPN, SSH key, or special access requirements found in docs>
```

### `architecture` — Architecture Notes

Populate from: `docs/architecture*.md`, `docs/adr/*.md`, README architecture section, any system design docs.

```markdown
# Architecture: <Project Name>

## System Overview
<Extracted from README or architecture docs>

## Components
<Extracted from docs — key services, modules, their roles>

## Data Flow
<Extracted from architecture docs or diagrams descriptions>

## Key Decisions & ADRs
<Extracted verbatim from ADR files — include dates and rationale>

## Known Constraints
<Extracted from docs — performance limits, known issues, design constraints>
```

### `runbooks` — Runbooks

Populate from: `docs/runbooks/*.md`, `Makefile` targets, `ansible/` playbooks, `CONTRIBUTING` run instructions, CI workflow steps.

```markdown
# Runbooks: <Project Name>

## Local Development Setup
<Extracted from CONTRIBUTING/DEVELOPMENT/README setup steps>

## Deployment
<Extracted from CI workflows, Makefile deploy targets, ansible playbooks>

## Rollback
<Extracted from any rollback docs or Makefile targets>

## Incident Response
<Extracted from runbook docs, or stubbed if not found>

## Common Operations
<Extracted from Makefile, ansible roles, or docs — include actual commands>
```

---

## Step 4 — Structure All Findings as Sub-Issues

Create a sub-issue tree under the kickoff issue. Every finding gets a child issue. Group by category.

```
[Kickoff] <Project Name>
├── [Onboarding] Setup — environment & services
│   └── one child per unmet requirement
├── [Onboarding] Docs gaps
│   └── one child per missing or incomplete doc section
├── [Onboarding] GitHub issues — critical
│   └── one child per bug/fix GH issue
├── [Onboarding] GitHub issues — triage
│   └── one child per ambiguous GH issue
└── [Onboarding] Pull requests — action needed
    └── one child per actionable PR
```

Category parents: status `blocked`, `blockedByIssueIds` = their leaf children.  
Kickoff: status `blocked`, `blockedByIssueIds` = category parent IDs.

**Routing:**

| Child type | Assignee |
|---|---|
| Missing env var / service / CI | DevOpsEngineer |
| Docs gap | lead agent |
| Broken setup step | engineer by topic |
| Critical GH issue (bug/fix) | routed by topic |
| Ambiguous GH issue | CTO |
| Failing CI PR | DevOpsEngineer or BackendEngineer |
| Approved + unmerged PR | CodeReviewer |
| Stale PR (>7 days) | CodeReviewer |

Backlog GH issues (feat/design) → leave for PM dispatch, do not sub-issue here.

### Labels and project assignment (required on every issue)

Every issue must have: `projectId` + at least one label + `parentId` (if child) + assignee.

Apply labels back to GitHub issues where missing:
```bash
gh issue edit <number> --repo <owner>/<repo> --add-label "bug"
```

Sweep all created issues before moving on. Fix gaps inline.

---

## Step 5 — Link to PM Dispatch

Update the PM dispatch routine to include this repo in its `gh issue list` sweep, with the correct `projectId` mapping so future issues land in the right project.

---

## Step 6 — Configure Routines (Optional)

| Routine | Cadence | Purpose |
|---|---|---|
| Weekly delivery snapshot | Monday 09:00 | Lead posts shipped/slipped/at-risk |
| CI health check | Every 15 min | Catch failing checks early |
| Orphan cleanup | Daily | Remove stale branches/worktrees |

---

## Step 7 — Verify

- [ ] Documentation hub created with all 5 documents populated (no blank sections)
- [ ] Content extracted from repo — not just stubs
- [ ] Sub-issue tree created: kickoff → category parents → leaf children
- [ ] All issues labelled and assigned to correct project
- [ ] GitHub issues labelled at source where missing
- [ ] PM dispatch updated with new repo
- [ ] Routines configured

---

## Existing Projects Reference

| Project | ID | Status |
|---|---|---|
| Operations | `bdb497cb-e7cb-421b-ad1d-b68e7f0b48b8` | in_progress |
| Onboarding | `3da3b2dd-deeb-4e0e-bf0c-9ffff4f2eba0` | in_progress |
| Autobot | `22d17c44-a12c-4913-b389-8c1690ea4b25` | planned |
| AutoBot Marketing | `31a12eb4-35ad-44d0-a101-ea9901fe131b` | planned |
