# Autonomous Agent Delegation Pipeline

**Date:** 2026-04-03
**Status:** Approved

## Problem

When an agent receives a project, it cannot autonomously hire specialists, delegate work, and have them start implementing. The plumbing exists but 4 gaps prevent the end-to-end flow.

## Design

### Fix 1: Auto-assign core skills on every hire

**File:** `server/src/routes/agents.ts` — `resolveDesiredSkillAssignment()`

When `desiredSkills` is empty/missing, inject bundled skill keys (`paperclip`, `paperclip-create-agent`) so every agent gets the heartbeat protocol and hiring capability.

### Fix 2: Wake new agent after CEO approval + assign delegated task

**File:** `server/src/routes/approvals.ts` — approve handler

After `activatePendingApproval()`:
1. If approval payload has `delegateIssueId`, assign that issue to the new agent
2. Call `heartbeat.wakeup()` on the **new agent** (not just the requester) with `PAPERCLIP_TASK_ID` in context

### Fix 3: `delegateIssueId` in agent-hires payload

**Files:** `packages/shared/src/validators/agent.ts`, `server/src/routes/agents.ts`

Add optional `delegateIssueId` and `delegateTaskDescription` fields to `createAgentHireSchema`. If `delegateTaskDescription` is provided but no `delegateIssueId`, create a new issue and link it.

### Fix 4: Delegation awareness for all agents

**File:** `server/src/onboarding-assets/default/AGENTS.md`

Expand default agent instructions so all agents (not just CEOs) know they can hire when they have `canCreateAgents` permission. Gate the instruction on checking permissions via `GET /api/agents/me`.

### Org Chart Visibility

Already works — agents created via `/agent-hires` immediately appear in the org chart with correct `reportsTo` hierarchy, even in `pending_approval` status.

## End-to-End Flow

```
User assigns task to CEO Agent
  → CEO heartbeat fires, reads task
  → CEO decides specialist needed
  → POST /agent-hires { name, role, reportsTo: ceoId, delegateIssueId, adapterType, ... }
  → System creates agent (pending_approval), shows in org chart
  → CEO (board user) approves in UI
  → System: activates agent, assigns task, auto-assigns skills, wakes new agent
  → New agent first heartbeat: sees task, starts real implementation
  → Requesting agent woken with approval_approved status
```

## Files Changed

- `server/src/routes/agents.ts` — skill auto-assign in resolveDesiredSkillAssignment
- `server/src/routes/approvals.ts` — wake new agent + assign task on approval
- `packages/shared/src/validators/agent.ts` — add delegateIssueId/delegateTaskDescription
- `server/src/onboarding-assets/default/AGENTS.md` — delegation instructions for all agents
- `server/src/onboarding-assets/ceo/AGENTS.md` — verify CEO instructions are complete
