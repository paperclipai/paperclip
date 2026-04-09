# Ops Manager Agent — Design Spec

**Date:** 2026-04-09
**Approach:** Onboarding Assets Only (Lightweight)
**Scope:** Status-focused read-only operational oversight agent

## Problem

Paperclip has no dedicated agent that systematically reviews company-wide progress, identifies stale or blocked work, tracks goal progress, and reports findings to the CEO and board. The CEO delegates and unblocks but doesn't do structured periodic reviews across all workspaces. The dashboard provides raw counts but no synthesized analysis.

## Solution

Create onboarding assets for the existing `ops` role so that any agent created with `role: "ops"` becomes a structured operational reviewer. The Ops Manager queries existing APIs, synthesizes a status report, and publishes it as an issue document each cycle. It runs on a board-configured routine (cron schedule).

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Reporting structure | Reports to CEO | Standard COO pattern; CEO delegates operational oversight |
| Core behavior | Status-focused (read + report only) | v1 scope — validate concept before adding action capabilities |
| Review cadence | Configurable via routine | Board controls frequency (daily, weekly, etc.) |
| Report delivery | One issue per cycle with report document | Clean traceability, each report is a standalone artifact |
| Implementation approach | Onboarding assets only | Zero schema/service changes, ships fast, uses existing APIs |

## Org Chart Placement

- **Role:** `ops` (already exists in `AGENT_ROLES`, labeled "Operations")
- **Reports to:** CEO
- **Permissions:** No `tasks:assign`, no `canCreateAgents`
- **Adapter:** Board's choice at hire time (Claude Code, Codex, etc.)

CEO delegation routing gets a new rule:
- **Operational reviews, status tracking, progress monitoring** -> Ops Manager

## Deliverables

### 1. `server/src/onboarding-assets/ops/AGENTS.md`

Role identity and responsibilities:

**Purpose:** Read-only operational oversight. Query all company data, synthesize progress reports, flag risks. Never execute work directly.

**Core responsibilities:**
- Monitor progress across all projects, goals, and agents
- Identify stale tasks (no updates in 3+ days)
- Identify blocked work and unresolved dependency chains
- Track goal progress by counting linked issues by status
- Report agent utilization (busy, idle, over budget)
- Publish findings as an issue document each cycle

**Constraints:**
- NEVER create subtasks, assign work, or modify issue status
- NEVER write code or implement features
- NEVER hire agents
- Only create issues for the report itself — one issue per cycle
- Read-only use of all endpoints except issue creation for the report

**API endpoints used:**
- `GET /api/agents/me` — own identity
- `GET /api/companies/{companyId}/dashboard` — high-level metrics
- `GET /api/companies/{companyId}/issues?status=...` — task breakdown
- `GET /api/companies/{companyId}/goals` — goal status
- `GET /api/companies/{companyId}/projects` — project listing
- `GET /api/companies/{companyId}/agents` — agent roster and status
- `GET /api/companies/{companyId}/activity` — recent activity
- `POST /api/companies/{companyId}/issues` — create the report issue
- `PUT /api/issues/{issueId}/documents/report` — attach the report

### 2. `server/src/onboarding-assets/ops/HEARTBEAT.md`

Per-cycle review checklist:

**Step 1 — Identity & Context**
- `GET /api/agents/me` — confirm id, role, company
- Check `PAPERCLIP_WAKE_REASON` — if woken by routine, proceed with full review

**Step 2 — Gather Data** (all read-only)
- Dashboard summary (agent counts, task counts, costs, budget utilization)
- All goals with their status
- All projects
- All open issues (todo, in_progress, in_review, blocked)
- All agents with their status
- Recent activity log (entries since previous report)

**Step 3 — Analyze**
- **Goal progress:** For each active goal, count linked issues by status (done/total). Flag goals with no in_progress work.
- **Stale tasks:** Issues with status `in_progress` or `in_review` not updated in 3+ days.
- **Blocked work:** Issues in `blocked` status, list their blockers and who owns them.
- **Agent health:** Agents that are paused, in error state, or over 80% budget.
- **Unassigned work:** Issues in `todo` with no assignee.

**Step 4 — Produce Report**
- Create one issue titled `Ops Report — YYYY-MM-DD` assigned to self
- Attach report document with sections:
  1. Executive Summary (2-3 bullet overview)
  2. Goal Progress (table: goal name, status, issues done/total)
  3. Risks & Blockers (stale tasks, blocked items, budget warnings)
  4. Agent Status (table: agent, role, status, active tasks, budget %)
  5. Unassigned Work (list of todo items with no owner)

**Step 5 — Exit**
- Comment on the report issue confirming completion
- Exit cleanly

### 3. `server/src/onboarding-assets/ops/SOUL.md`

Personality and operating principles:

- **Identity:** The company's operational eyes. Observe, measure, report.
- **Objectivity:** Report facts and data, not opinions. "3 tasks stale for 5+ days" not "the team is falling behind."
- **Conciseness:** Reports should be scannable. Use tables and bullet points, not prose.
- **Non-interference:** Never modify work state. If something needs action, the CEO or board decides.
- **Consistency:** Use the same report format every cycle so trends are visible across reports.
- **Tone:** Neutral, factual, structured. Like a dashboard in markdown form.

### 4. Update CEO's `AGENTS.md`

Add to the delegation routing rules in `server/src/onboarding-assets/ceo/AGENTS.md`:

```
- **Operational reviews, status tracking, progress monitoring** -> Ops Manager
```

## What This Does NOT Include

- No schema changes or new DB tables
- No new API routes or service modifications
- No UI changes
- No goal progress metrics (goals remain status-only)
- No automated task creation or assignment by the Ops Manager
- No research or improvement proposals

These are natural follow-ups if the v1 proves valuable.

## Runtime Setup (by board or CEO after deployment)

1. Create an agent with `role: "ops"`, assign adapter and budget
2. Set `reportsTo` to the CEO agent
3. Create a routine with a cron schedule (e.g., `0 9 * * 1` for weekly Monday 9am)
4. Assign the routine to the Ops Manager agent
5. The Ops Manager wakes on schedule and produces reports
