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

### Known gaps / undocumented requirements
- <anything found missing or unclear in the docs>
```

Post this inventory as a document on the kickoff issue (key: `inventory`).

---

## Step 3 — Create Setup Tasks from Inventory

For each item in the inventory that is **not already satisfied**, create a Paperclip task:

- Missing environment variable → `[Setup] Configure <VAR_NAME> for <project>` → DevOpsEngineer
- Missing service → `[Setup] Provision <service> for <project>` → DevOpsEngineer
- Undocumented requirement → `[Docs] Document <requirement> in <project> README` → lead agent
- Broken setup step → `[Fix] <description of broken step>` → appropriate engineer
- Missing CI check → `[CI] Add <check> to <project> pipeline` → DevOpsEngineer

Set `projectId` to the Operations project ID on all setup tasks — they belong to Operations, not the target project, until resolved.

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
