# GitHub Issue Auto-Dispatch Design

**Date:** 2026-05-29  
**Status:** Approved  
**Owner:** ProjectManager agent

## Problem

GitHub issues accumulate faster than they are closed. Agents have no mechanism to self-load from the backlog — they sit idle unless someone manually creates a Paperclip task and assigns it. The AutoBot-AI repo currently has 33 open issues spanning 6 weeks, with most agents idle.

## Goal

Every open GitHub issue automatically becomes a Paperclip task, routed to the right agent, with complex issues decomposed into manageable subtasks for cheaper assistant-tier agents — all without human intervention.

## Design

### Dispatch Routine

A **ProjectManager dispatch routine** fires every **30 minutes** on a schedule.

Each cycle:

1. Fetch all open GH issues: `gh issue list --repo mrveiss/AutoBot-AI --state open --json number,title,body,labels --limit 200`
2. Fetch existing Paperclip tasks to identify already-tracked issues (match by `GH#NNNN` prefix in task title)
3. Filter to untracked issues only
4. Sort by priority tier (see below)
5. For each issue (up to batch cap of **5 per cycle**): assess complexity, create Paperclip task(s), assign
6. Post a dispatch summary comment on each created task

### Priority Tiers

Processed in this order within each cycle:

| Tier | Matches | Examples |
|------|---------|---------|
| 1 — Critical | Title starts with `fix(`, `bug(`, `hotfix(`; or label `bug`, `critical` | Bug fixes, crashes, regressions |
| 2 — Discovery | Title starts with `discovery(`; label `discovery` | Investigation, research tasks |
| 3 — Feature/Design | Everything else: `feat(`, `design(`, `ux(`, `chore(` | New functionality, UX work |

Within each tier, issues are processed oldest-first (by GH issue number ascending).

### Deduplication

A GH issue is considered already tracked if any Paperclip task has `GH#<number>` in its title. The PM prefixes all created tasks with `[GH#<number>]` to make this scannable:

```
[GH#8922] fix(backend): SecurityLayer crashes on startup...
```

Tasks in terminal states (`done`, `cancelled`) do not block re-creation if the GH issue is still open — they mean the fix was reverted or incomplete.

### Agent Routing

PM reads the issue title + first 200 characters of body and assigns based on topic:

| Topic signals | Primary agent | Assistant fallback |
|---|---|---|
| Python, FastAPI, backend API, database, Redis, config | BackendEngineer | BackendAssistant |
| Vue, React, TypeScript, frontend, UI, components, Storybook | SeniorFrontendDeveloper | FrontendAssistant |
| CI/CD, Docker, Ansible, provisioning, deployment, SLM, fleet | DevOpsEngineer | DevOpsAssistant |
| Security, auth, RBAC, audit, encryption, compliance | SecurityEngineer | SecurityAssistant |
| Architecture, system design, ADR, cross-stack | SeniorCodeArchitect | ArchitectAssistant |
| UX, wireframes, design system, interaction design | UXDesigner | — |
| No clear match | CTO for triage | — |

PM uses the **primary agent** for complex issues and Engineer-tier subtasks. It uses the **assistant fallback** for simple issues and decomposed leaf subtasks.

### Concurrency Gate

Before routing any issue in a cycle, PM checks:

```
GET /api/companies/{companyId}/agents
```

Count agents where `status == "running"` and `role == "engineer"`. If **≥ 2 IC agents are running**, skip routing this cycle entirely — post no comment, create no tasks. Try again in 30 minutes.

Additionally, per-agent: if an agent already has **≥ 2 tasks** in `in_progress` or `in_review`, skip assigning to that agent this cycle and fall back to their assistant tier.

### Complexity Assessment & Decomposition

PM assesses complexity before creating tasks. **Complexity triggers** (any 2+ → complex):

- Issue body > 300 words
- Multiple distinct system components mentioned (e.g. "backend + frontend + CI")
- Keywords: "integrate", "refactor", "migrate", "full", "system", "overhaul", "phase", "end-to-end"
- Cross-cutting: touches more than one agent specialty

**Simple path** — create one Paperclip task, assign to the right agent per routing table above. Size it on the Fibonacci scale (1–5 pt). If the issue seems > 5 pt but isn't clearly complex by the signals above, PM sizes it at 5 pt and lets the assigned agent decompose further if needed.

**Complex path** — PM breaks the issue into 2–5 subtasks:

1. Creates a parent Paperclip task (`[GH#NNNN]` prefix, status `blocked`, linked to the GH issue)
2. Creates child tasks, each scoped to one agent specialty, each ≤ 5 pt
3. Sets `parentId` and `goalId` on every child
4. Sets `blockedByIssueIds` on parent = all child IDs
5. Routes children: Engineer-tier for ambiguous/architectural subtasks, Assistant-tier for well-defined implementation subtasks
6. Each child title gets a size prefix: `[5pt] [GH#NNNN-1] Implement auth token refresh`

**Decomposition cap:** max 5 children. If an issue needs more, it is an epic — PM creates a Paperclip goal instead and assigns triage to CTO.

### Batch Cap

**5 issues dispatched per 30-minute cycle.** This prevents the backlog from flooding agents all at once. With the current 33-issue backlog, it clears in roughly 3–4 hours of cycles (accounting for the concurrency gate skipping some cycles).

### What PM Does NOT Do

- Write code or implement anything
- Self-assign GH issues (Paperclip tasks only)
- Create tasks for issues already in terminal state in both GH (closed) and Paperclip (done/cancelled)
- Route to paused agents

## Implementation

### Step 1 — Update PM instructions

Add a `## GitHub Issue Ingestion` section to the PM's `AGENTS.md`. This section runs **after** the existing INTAKE routing step (which handles unassigned Paperclip issues) and handles GH backlog ingestion.

The section describes:
- How to fetch and deduplicate GH issues
- Priority sort logic
- Complexity assessment signals
- Routing table (mirrors and extends the existing routing table)
- Decomposition rules (already in PM instructions — extend, don't duplicate)
- Batch cap and concurrency gate

### Step 2 — Create the dispatch routine

Create a Paperclip routine assigned to ProjectManager:

```json
POST /api/companies/{companyId}/routines
{
  "agentId": "d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00",
  "description": "...(full dispatch instructions)...",
  "triggers": [{
    "kind": "schedule",
    "label": "gh-issue-dispatch-30min",
    "cronExpression": "*/30 * * * *",
    "timezone": "Europe/Riga"
  }]
}
```

The routine description is self-contained: it tells PM exactly what to do each cycle, referencing the GH CLI commands, deduplication logic, priority tiers, and agent IDs.

### Step 3 — Verify

After first routine fire, confirm:
- At least one `[GH#NNNN]` Paperclip task created
- Priority ordering respected (bug/fix first)
- No duplicates on second fire
- Concurrency gate correctly skips when agents are running

## Agent ID Reference

| Agent | ID |
|---|---|
| ProjectManager | `d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00` |
| BackendEngineer | `97ca3669-ee7c-400a-bd3e-774d417022d1` |
| BackendAssistant | `f6434ce4-ca56-4881-ba9d-a07938ea3b4a` |
| SeniorFrontendDeveloper | `fbc60351-211d-427a-ad28-27d609e80a4c` |
| FrontendAssistant | `f4e81b79-1bfb-42d7-84c8-0cff20353081` |
| DevOpsEngineer | `9c6116f1-e429-453e-a288-30e88c11e182` |
| DevOpsAssistant | `f6f46105-5213-42df-977d-17e993d66838` |
| SecurityEngineer | `b49788d7-334a-4cd4-b046-42c12f4d9af5` |
| SecurityAssistant | `51731530-7df1-4f03-a642-c5149069c606` |
| SeniorCodeArchitect | `24536e3f-a21f-4ed9-950f-e883654cab27` |
| ArchitectAssistant | `bd23c291-6eb5-4f24-9dd5-accd9775a452` |
| UXDesigner | `86d91e0d-b4e7-44a3-8d9c-52d01d6ebdda` |
| CTO | `a074bb26-f1d0-4009-842b-1bdb109367ec` |
| CEO | `cef2fd38-5cfb-4622-9034-4e5383ec6aa7` |

## Open Questions / Future Work

- **Closed GH issues:** if a GH issue is closed but the Paperclip task is still open, PM should detect this on next cycle and mark the task `done` or `cancelled`.
- **Label sync:** GH labels could be written back after Paperclip task creation (`in-progress`, `assigned`) to make the GH board reflect state.
- **Velocity tracking:** PM's weekly snapshot should include "issues ingested from GH this week" as a metric.
