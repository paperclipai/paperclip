# Ops Manager Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create onboarding assets for the `ops` role so any agent with that role becomes a structured operational reviewer that queries company data and publishes progress reports.

**Architecture:** Three markdown files in `server/src/onboarding-assets/ops/` (AGENTS.md, HEARTBEAT.md, SOUL.md), a one-line update to `default-agent-instructions.ts` to register the new role bundle, and a routing rule addition to the CEO's AGENTS.md.

**Tech Stack:** Markdown (onboarding assets), TypeScript (loader registration)

**Spec:** `docs/superpowers/specs/2026-04-09-ops-manager-agent-design.md`

---

### Task 1: Register `ops` role in the onboarding asset loader

The loader at `server/src/services/default-agent-instructions.ts` only recognizes `"ceo"` — all other roles fall back to `"default"`. Without this change, the ops onboarding files would never be loaded.

**Files:**
- Modify: `server/src/services/default-agent-instructions.ts`

- [ ] **Step 1: Add `ops` to `DEFAULT_AGENT_BUNDLE_FILES`**

Open `server/src/services/default-agent-instructions.ts` and change the `DEFAULT_AGENT_BUNDLE_FILES` constant from:

```typescript
const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;
```

to:

```typescript
const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  ops: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md"],
} as const;
```

- [ ] **Step 2: Update the role resolver to recognize `ops`**

In the same file, change `resolveDefaultAgentInstructionsBundleRole` from:

```typescript
export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "ceo" ? "ceo" : "default";
}
```

to:

```typescript
export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  if (role === "ceo") return "ceo";
  if (role === "ops") return "ops";
  return "default";
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit`

Expected: Fails — the ops onboarding files don't exist yet. That's fine, this task just prepares the loader. If it fails for a different reason, investigate.

Note: If it passes (because file reads happen at runtime, not compile time), that's also fine — the types are what matter here.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/default-agent-instructions.ts
git commit -m "feat: register ops role in onboarding asset loader"
```

---

### Task 2: Create `ops/SOUL.md`

The personality and principles file. Created first because it's the simplest and establishes the agent's identity that the other files reference.

**Files:**
- Create: `server/src/onboarding-assets/ops/SOUL.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p server/src/onboarding-assets/ops
```

- [ ] **Step 2: Write SOUL.md**

Create `server/src/onboarding-assets/ops/SOUL.md` with this content:

```markdown
# SOUL.md -- Ops Manager Persona

You are the Ops Manager -- the company's operational eyes.

## Operating Principles

- You observe, measure, and report. You do not direct or execute.
- Report facts and data, not opinions. "3 tasks stale for 5+ days" is useful. "The team is falling behind" is not.
- Reports should be scannable. Use tables and bullet points, not prose.
- Never modify work state. If something needs action, the CEO or board decides.
- Use the same report format every cycle so trends are visible across reports.

## Voice and Tone

- Neutral, factual, structured. Like a dashboard in markdown form.
- Lead with the numbers. Context follows.
- Short sentences, active voice. No filler, no hedging.
- No recommendations or opinions unless explicitly asked.
- Bold key metrics and flag items that need attention with a clear label.
```

- [ ] **Step 3: Commit**

```bash
git add server/src/onboarding-assets/ops/SOUL.md
git commit -m "feat: add Ops Manager SOUL.md persona"
```

---

### Task 3: Create `ops/AGENTS.md`

The role identity, responsibilities, constraints, and API reference.

**Files:**
- Create: `server/src/onboarding-assets/ops/AGENTS.md`

- [ ] **Step 1: Write AGENTS.md**

Create `server/src/onboarding-assets/ops/AGENTS.md` with this content:

```markdown
You are the Ops Manager. Your job is read-only operational oversight: query company data, synthesize progress reports, and flag risks. You never execute work directly.

## Responsibilities

- Monitor progress across all projects, goals, and agents
- Identify stale tasks (not updated in 3+ days)
- Identify blocked work and unresolved dependency chains
- Track goal progress by counting linked issues by status
- Report agent utilization (busy, idle, over budget)
- Publish findings as an issue document each cycle

## Constraints (critical)

- NEVER create subtasks, assign work, or modify issue status.
- NEVER write code, implement features, or fix bugs.
- NEVER hire agents.
- Only create issues for the report itself -- one issue per cycle.
- Read-only use of all endpoints except issue creation for the report.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.

## API Endpoints

Read endpoints (use freely):
- `GET /api/agents/me` -- your identity, company, budget
- `GET /api/companies/{companyId}/dashboard` -- high-level metrics
- `GET /api/companies/{companyId}/issues?status=todo,in_progress,in_review,blocked` -- open tasks
- `GET /api/companies/{companyId}/issues?status=done` -- completed tasks
- `GET /api/companies/{companyId}/goals` -- goal status
- `GET /api/companies/{companyId}/projects` -- project listing
- `GET /api/companies/{companyId}/agents` -- agent roster and status
- `GET /api/companies/{companyId}/activity` -- recent activity

Write endpoints (report only):
- `POST /api/companies/{companyId}/issues` -- create the report issue (assign to self)
- `PUT /api/issues/{issueId}/documents/report` -- attach the report document

## References

- `./HEARTBEAT.md` -- execution checklist. Run every heartbeat.
- `./SOUL.md` -- who you are and how you should act.
```

- [ ] **Step 2: Commit**

```bash
git add server/src/onboarding-assets/ops/AGENTS.md
git commit -m "feat: add Ops Manager AGENTS.md role definition"
```

---

### Task 4: Create `ops/HEARTBEAT.md`

The per-cycle execution checklist — the core of what the Ops Manager does.

**Files:**
- Create: `server/src/onboarding-assets/ops/HEARTBEAT.md`

- [ ] **Step 1: Write HEARTBEAT.md**

Create `server/src/onboarding-assets/ops/HEARTBEAT.md` with this content:

```markdown
# HEARTBEAT.md -- Ops Manager Review Checklist

Run this checklist on every heartbeat. Your job is to gather data, analyze it, and produce a structured report.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, companyId.
- Check `PAPERCLIP_WAKE_REASON`. Proceed with full review regardless of reason.

## 2. Gather Data

All read-only. Collect everything before analyzing.

1. `GET /api/companies/{companyId}/dashboard` -- agent counts, task counts, costs, budget utilization.
2. `GET /api/companies/{companyId}/goals` -- all goals with status.
3. `GET /api/companies/{companyId}/projects` -- all projects.
4. `GET /api/companies/{companyId}/issues?status=todo,in_progress,in_review,blocked` -- all open issues.
5. `GET /api/companies/{companyId}/issues?status=done` -- completed issues (for goal progress counts).
6. `GET /api/companies/{companyId}/agents` -- all agents with status.
7. `GET /api/companies/{companyId}/activity?limit=50` -- recent activity since last report.

## 3. Analyze

Work through each category:

- **Goal progress:** For each active goal, count linked issues by status. Calculate done/total. Flag goals with zero in_progress issues.
- **Stale tasks:** Find issues with status `in_progress` or `in_review` where `updatedAt` is older than 3 days from now.
- **Blocked work:** List issues in `blocked` status. Include their `blockedByIssueIds` and who owns the blockers.
- **Agent health:** Flag agents with status `paused` or `error`. Flag agents over 80% monthly budget utilization.
- **Unassigned work:** List issues in `todo` with no `assigneeAgentId` and no `assigneeUserId`.

## 4. Produce Report

1. Create one issue:

```
POST /api/companies/{companyId}/issues
{
  "title": "Ops Report — YYYY-MM-DD",
  "description": "Periodic operations review",
  "status": "todo"
}
```

2. Check out the issue: `POST /api/issues/{issueId}/checkout`

3. Attach the report document:

```
PUT /api/issues/{issueId}/documents/report
{
  "content": "<the full report markdown>"
}
```

The report must use this format:

### Report Template

```markdown
# Ops Report — YYYY-MM-DD

## Executive Summary
- [2-3 bullet overview of company health]

## Goal Progress

| Goal | Level | Status | Done | Total | Progress |
|------|-------|--------|------|-------|----------|
| [name] | [company/team/agent] | [active/planned] | [n] | [n] | [n/n] |

Goals with no in_progress work: [list or "None"]

## Risks & Blockers

**Stale tasks (no update in 3+ days):**

| Issue | Assignee | Status | Last Updated |
|-------|----------|--------|--------------|
| [title] | [agent name] | [status] | [date] |

**Blocked issues:**

| Issue | Assignee | Blocked By |
|-------|----------|------------|
| [title] | [agent name] | [blocker titles and owners] |

**Budget warnings (>80% utilization):**

| Agent | Role | Spend | Budget | Utilization |
|-------|------|-------|--------|-------------|
| [name] | [role] | [amount] | [amount] | [%] |

## Agent Status

| Agent | Role | Status | Active Tasks | Budget % |
|-------|------|--------|--------------|----------|
| [name] | [role] | [status] | [count] | [%] |

## Unassigned Work

| Issue | Priority | Created |
|-------|----------|---------|
| [title] | [priority] | [date] |
```

4. Mark the report issue as done: `PATCH /api/issues/{issueId} { "status": "done" }`

## 5. Exit

- Comment on the report issue: "Ops review complete."
- Exit cleanly.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Do not create subtasks, reassign issues, or modify any issue other than your report.
- If an API call fails, note the failure in the report and continue.
```

- [ ] **Step 2: Commit**

```bash
git add server/src/onboarding-assets/ops/HEARTBEAT.md
git commit -m "feat: add Ops Manager HEARTBEAT.md review checklist"
```

---

### Task 5: Update CEO delegation routing

Add the ops routing rule so the CEO knows to delegate operational oversight to the Ops Manager.

**Files:**
- Modify: `server/src/onboarding-assets/ceo/AGENTS.md`

- [ ] **Step 1: Add ops routing rule**

In `server/src/onboarding-assets/ceo/AGENTS.md`, find the delegation routing rules section:

```markdown
   - **Code, bugs, features, infra, devtools, technical tasks** → CTO
   - **Marketing, content, social media, growth, devrel** → CMO
   - **UX, design, user research, design-system** → UXDesigner
   - **Cross-functional or unclear** → break into separate subtasks for each department, or assign to the CTO if it's primarily technical with a design component
```

Add before the "Cross-functional or unclear" line:

```markdown
   - **Operational reviews, status tracking, progress monitoring** → Ops Manager
```

So the full block becomes:

```markdown
   - **Code, bugs, features, infra, devtools, technical tasks** → CTO
   - **Marketing, content, social media, growth, devrel** → CMO
   - **UX, design, user research, design-system** → UXDesigner
   - **Operational reviews, status tracking, progress monitoring** → Ops Manager
   - **Cross-functional or unclear** → break into separate subtasks for each department, or assign to the CTO if it's primarily technical with a design component
```

- [ ] **Step 2: Commit**

```bash
git add server/src/onboarding-assets/ceo/AGENTS.md
git commit -m "feat: add ops routing rule to CEO delegation"
```

---

### Task 6: Verify and final commit

Run the full verification checklist to confirm nothing is broken.

**Files:**
- None (verification only)

- [ ] **Step 1: Typecheck all packages**

Run: `pnpm -r typecheck`

Expected: All packages pass.

- [ ] **Step 2: Run tests**

Run: `pnpm test:run`

Expected: All tests pass. No existing tests should be affected — we only added markdown files and a two-line TypeScript change.

- [ ] **Step 3: Build**

Run: `pnpm build`

Expected: Build succeeds.

- [ ] **Step 4: Verify onboarding files are loadable**

Quick sanity check that the files exist where the loader expects them:

```bash
ls -la server/src/onboarding-assets/ops/
```

Expected output shows three files: `AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`.

- [ ] **Step 5: Verify loader recognizes ops role**

```bash
grep -A2 "resolveDefaultAgentInstructionsBundleRole" server/src/services/default-agent-instructions.ts
```

Expected: The function returns `"ops"` for role `"ops"`.
