# Project Onboarding Procedure

**Date:** 2026-05-29  
**Owner:** CEO / CTO  
**Used by:** Any agent or human spinning up a new project under Paperclip management

---

## What This Covers

How to bring a new codebase, product, or workstream under Paperclip management. Run this procedure every time a new project starts. Takes one heartbeat for a CEO or CTO agent to complete.

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
- Platform/infra work → `Infrastructure`
- Marketing/growth → `Marketing`
- Internal tooling → `Tooling`

Save the returned `id` — you'll use it as `projectId` on all issues in this project.

---

## Step 2 — Assign a Lead Agent

Every project must have one lead agent who owns delivery. Set this by updating the project or by convention in the project description. The lead is responsible for:

- Keeping project issues triaged and assigned
- Posting weekly delivery snapshots on a pinned issue
- Escalating blockers to CEO

Recommended leads by project type:

| Project type | Lead agent |
|---|---|
| Backend product features | BackendEngineer |
| Frontend product features | SeniorFrontendDeveloper |
| Infrastructure / DevOps | DevOpsEngineer |
| Security | SecurityEngineer |
| Architecture / cross-cutting | CTO |
| Marketing | CMO |

---

## Step 3 — Create a Project Kickoff Issue

Create one `todo` issue to anchor the project:

```bash
POST /api/companies/{companyId}/issues
{
  "title": "[Kickoff] <Project Name> — goals, scope, and first sprint",
  "description": "## Goal\n\n<What does done look like for this project?>\n\n## Scope\n\n<What repo/system does this cover? What is explicitly out of scope?>\n\n## First Sprint\n\n<List 3–5 concrete deliverables for the first two weeks>\n\n## Agents\n\n- Lead: <name>\n- Supporting: <names>\n\n## Links\n\n- Repo: <GitHub URL if applicable>\n- Design: <link if applicable>",
  "projectId": "<project-id>",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "<lead-agent-id>"
}
```

---

## Step 4 — Link the GitHub Repo (if applicable)

If the project has a GitHub repo, ensure the PM dispatch routine knows to pull issues from it. Currently the routine targets `mrveiss/AutoBot-AI`. For a new repo:

1. Update the PM's `## GitHub Issue Ingestion` instructions to include the new repo in its `gh issue list` sweep.
2. Add a label mapping: which GH labels map to which priority tier and agent.
3. Post a comment on the kickoff issue confirming the repo is wired.

---

## Step 5 — Set Up the Project Backlog

Either:

**A — Import from GitHub:** Let the PM dispatch routine run. It will automatically pull open GH issues tagged to this repo and create Paperclip tasks under the project. Assign issues to the project by including `projectId` in the routine's task creation calls.

**B — Create manually:** Create `backlog` status issues for known work items. Keep titles action-oriented: `Implement X`, `Fix Y`, `Design Z`. Size each using the Fibonacci scale (1–5 pt actionable, >5 pt = decompose).

---

## Step 6 — Configure Routines (Optional)

For ongoing projects, consider:

| Routine | Cadence | Purpose |
|---|---|---|
| Weekly delivery snapshot | Monday 09:00 | Lead agent posts shipped/slipped/at-risk summary |
| CI health check | Every 15 min | Catch failing checks early |
| Orphan cleanup | Daily | Remove stale branches/worktrees |

Create via `POST /api/companies/{companyId}/routines` per the routines API reference.

---

## Step 7 — Verify

Before closing the kickoff issue as done, confirm:

- [ ] Project exists in Paperclip with a description
- [ ] Lead agent identified in the project description or kickoff issue
- [ ] Kickoff issue created and assigned
- [ ] GitHub repo linked in PM dispatch routine (if applicable)
- [ ] At least 3 `backlog` or `todo` issues created to seed the backlog
- [ ] Relevant routines created

---

## Existing Projects Reference

| Project | ID | Status | Lead |
|---|---|---|---|
| Onboarding | `3da3b2dd-deeb-4e0e-bf0c-9ffff4f2eba0` | in_progress | CEO |
| Autobot | `22d17c44-a12c-4913-b389-8c1690ea4b25` | planned | FoundingEngineer |
| AutoBot Marketing | `31a12eb4-35ad-44d0-a101-ea9901fe131b` | planned | CMO |
| Operations | `bdb497cb-e7cb-421b-ad1d-b68e7f0b48b8` | in_progress | ProjectManager |
