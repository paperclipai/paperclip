# Goals as First-Class Citizens

**Date:** 2026-03-14
**Status:** Study / Pre-Implementation Analysis

## Problem Statement

Goals exist in Paperclip as a data model with hierarchy, ownership, status, and connections to issues/projects. However, they are passive metadata today. Nothing happens when a goal changes status. There is no mechanism for the CEO agent to automatically pursue a goal by creating tasks, subgoals, projects, and assigning agents.

We want goals to become a first-class citizen such that:

1. The CEO and human-in-the-loop review are supported as first-class processes
2. The CEO pursues implementing goals automatically by creating tasks and assigning them to agents
3. The CEO creates (or uses a specialized agent to create) subgoals and projects to deliver a goal
4. The CEO is allowed (through the UI) to create more agent types depending on the goal/workload — if this option is turned off, the CEO uses existing agents
5. The CEO has access to all historical context of a goal and any related work

## Core Insight

The infrastructure is already ~90% there. The gap is exactly one thing: **nothing happens when a goal changes status.** The entire design collapses to closing that one loop.

### What Already Exists

| Capability | Status | Location |
|---|---|---|
| Goal hierarchy (parentId) | Exists | `packages/db/src/schema/goals.ts` |
| Goal ownership (ownerAgentId) | Exists | `packages/db/src/schema/goals.ts` |
| Goal statuses (planned/active/achieved/cancelled) | Exists | `packages/shared/src/constants.ts` |
| Goal levels (company/team/agent/task) | Exists | `packages/shared/src/constants.ts` |
| Goal ↔ Issue linking (issues.goalId) | Exists | `packages/db/src/schema/issues.ts` |
| Goal ↔ Project linking (project_goals) | Exists | `packages/db/src/schema/project_goals.ts` |
| Issue goal fallback to company goal | Exists | `server/src/services/issue-goal-fallback.ts` |
| Wakeup system (string-based reasons) | Exists | `server/src/services/heartbeat.ts` |
| Approval system (flexible JSONB payloads) | Exists | `server/src/services/approvals.ts` |
| Agent hiring with governance | Exists | `server/src/routes/agents.ts` (line 763) |
| Activity log (entity-agnostic) | Exists | `server/src/services/activity-log.ts` |
| Heartbeat context injection | Exists | Adapters inject `PAPERCLIP_WAKE_REASON` env var |
| CEO `canCreateAgents` permission | Exists | `server/src/services/agent-permissions.ts` (defaults to `true` for role `"ceo"`) |
| Board approval gate | Exists | `server/src/routes/authz.ts` (`assertBoard`) |
| Company-level hiring approval toggle | Exists | `companies.requireBoardApprovalForNewAgents` |

## Design

### 1. Goal Activation Triggers a CEO Wakeup

This is the keystone change. In `server/src/routes/goals.ts`, the existing `PATCH /goals/:id` handler already has `existing` (the pre-update goal) and `goal` (the post-update goal). Add a transition guard and wakeup after the `logActivity` call:

```typescript
// Fire wakeup only on status *transition* to active — not on unrelated updates to already-active goals.
if (existing.status !== "active" && goal.status === "active") {
  const targetAgentId = goal.ownerAgentId ?? await resolveCeoAgentId(db, goal.companyId);
  if (targetAgentId) {
    void heartbeat.wakeup(targetAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "goal_activated",
      payload: { goalId: goal.id, mutation: "activate" },
      contextSnapshot: {
        goalId: goal.id,
        wakeReason: "goal_activated",
        source: "goal.activated",
      },
    }).catch(() => {});
  }
}
```

The transition guard (`existing.status !== "active" && goal.status === "active"`) prevents re-triggering when an already-active goal is updated for other reasons (title change, description edit, etc.).

This is exactly how `issue_assigned` works today — same pattern, ~15 lines of code. The wakeup system is string-based, no schema changes needed. The adapter will automatically inject `PAPERCLIP_WAKE_REASON=goal_activated` and a new `PAPERCLIP_GOAL_ID` env var.

**This single change closes the loop.** A human (or the CEO itself) sets a goal to "active" → CEO wakes up → CEO acts on it.

### 2. New Approval Type: `goal_plan`

Before the CEO starts creating work, it submits a goal execution plan for board review. This leverages the existing approval system:

- Add `"goal_plan"` to `APPROVAL_TYPES` in `packages/shared/src/constants.ts` (one line)
- The approval payload is flexible JSONB — the CEO populates it with its proposed breakdown: subgoals, projects, estimated issues, agent assignments, budget estimate
- Board reviews via the existing Approvals UI, can approve / reject / request revision
- On approval, the existing wakeup fires back to the CEO with `reason: "approval_approved"` — CEO then executes the plan

**This is the human-in-the-loop.** The board sees "CEO wants to pursue Goal X by creating these subgoals, these projects, and assigning these agents" and can say yes, no, or revise. Same flow as `hire_agent` approvals today.

#### Approval Resolution Wakeups

The existing approval routes have a gap: only `POST /approvals/:id/approve` fires a wakeup to the requesting agent. Neither `reject` nor `request-revision` do. For `hire_agent` this was tolerable — the CEO doesn't need to act urgently on hire rejections. For goal pursuit, the board ↔ CEO feedback loop needs to be tight.

Add wakeups in `server/src/routes/approvals.ts` for rejection and revision, following the exact same pattern as the existing `approval_approved` wakeup at line 151:

- `reject` → wakeup with `reason: "approval_rejected"`, `wakeReason: "approval_rejected"`
- `request-revision` → wakeup with `reason: "approval_revision_requested"`, `wakeReason: "approval_revision_requested"`

This is ~20 lines total (copy the existing `approval_approved` block twice, change the reason strings). These wakeups benefit all approval types, not just `goal_plan`.

### 3. Goal Context Endpoint

New endpoint: `GET /api/goals/{goalId}/heartbeat-context`

Returns everything the CEO needs in one call:

- Goal metadata + ancestor goals (parentId chain)
- Child goals (sub-goals)
- Linked projects (via `project_goals` join)
- All issues under this goal (via `issues.goalId`)
- Recent activity on any of these entities (activity log query by entityId)
- Comment cursors for related issues

This parallels the existing `GET /api/issues/{issueId}/heartbeat-context` pattern (at `server/src/routes/issues.ts:319`). The CEO calls this when woken with `goal_activated` to understand the full landscape before planning.

**Implementation note:** The issue service already has `getAncestors()` (an iterative parentId walk at `server/src/services/issues.ts:1394`). The goal service needs an equivalent `getAncestors()` method added — same pattern, ~15 lines of iterative parentId lookup.

### 4. Extend the Heartbeat Skill

Add a "Goal Pursuit" section to `skills/paperclip/SKILL.md`. When `PAPERCLIP_WAKE_REASON=goal_activated`:

1. **Understand** — Call `GET /api/goals/{goalId}/heartbeat-context` to see the full picture
2. **Plan** — Decompose the goal into subgoals, projects, and initial issues
3. **Submit for review** — Create a `goal_plan` approval with the proposed breakdown
4. **Wait** — Exit heartbeat. CEO will be re-woken when board approves

When `PAPERCLIP_WAKE_REASON=approval_approved` and approval type is `goal_plan`:

4. **Execute the plan** — Create subgoals (`POST /companies/{id}/goals`), projects (`POST /companies/{id}/projects`), issues (`POST /companies/{id}/issues`) with appropriate assignments
5. **Hire if needed** — If the company allows goal-driven hiring, CEO can use `paperclip-create-agent` to propose new hires. If disabled, CEO only assigns to existing agents
6. **Report** — Comment on the goal's linked issues with the execution plan

The CEO determines the approval type via the existing skill Step 2 flow: when `PAPERCLIP_APPROVAL_ID` is set, `GET /api/approvals/{approvalId}` returns the full approval including its `type` field. The skill dispatches on `type === "goal_plan"` vs `type === "hire_agent"` etc.

When `PAPERCLIP_WAKE_REASON=approval_revision_requested` and approval type is `goal_plan`:

7. **Revise** — Fetch the approval to read the board's `decisionNote`, adjust the plan, and resubmit via `POST /approvals/{id}/resubmit` with updated payload

When `PAPERCLIP_WAKE_REASON=approval_rejected` and approval type is `goal_plan`:

8. **Acknowledge** — Comment on the goal noting the rejection. Goal remains active for future re-planning if the board chooses

### 5. Agent Creation Toggle

The existing `companies.requireBoardApprovalForNewAgents` boolean already controls whether hires need board approval. Two options, from simplest to most flexible:

**Option A (simplest):** Use the existing flag as-is. CEO can always *propose* hires — the flag controls whether they need approval. Board approval on a `goal_plan` that includes "I need to hire a new engineer" implicitly authorizes the subsequent `hire_agent` flow.

**Option B (one new field):** Add `allowGoalDrivenHiring: boolean` to companies schema. When true, the CEO includes hiring proposals in `goal_plan` approvals. When false, the CEO only uses existing agents. This is one column, one migration.

### 6. Goal Lifecycle

```
planned ──[human or CEO sets active]──→ active
                                          │
                                    CEO wakes up (goal_activated)
                                    CEO reads context
                                    CEO creates goal_plan approval
                                          │
                                    Board reviews plan
                                          │
                              ┌───────────┼───────────┐
                              │           │           │
                          approves    requests     rejects
                              │       revision        │
                              │           │      CEO acknowledges
                              │     CEO revises   goal stays active
                              │     resubmits
                              │     (loops back to board)
                              │
                        CEO wakes up (approval_approved)
                        CEO creates subgoals, projects, issues
                        CEO assigns agents (or proposes hires)
                              │
                        Agents wake up (issue_assigned)
                        Agents do work
                        Agents complete issues
                              │
                        [goal completion detection]
                              │
                           achieved
```

## What Makes This Elegant

**It adds almost nothing new.** It reuses:

- The wakeup system (just a new string reason)
- The approval system (just a new type string)
- The heartbeat skill pattern (just a new section)
- The existing goal schema (no new fields needed for MVP)
- The existing `ownerAgentId` field (already there, underutilized)
- The existing `parentId` hierarchy (subgoals are just goals with a parent)
- The existing `project_goals` junction (projects already link to goals)
- The existing activity log (already tracks `goal.*` events)

## Actual New Code Needed

1. ~15 lines in `server/src/routes/goals.ts` to trigger wakeup on status → active (with transition guard)
2. Two strings added to `APPROVAL_TYPES` in `packages/shared/src/constants.ts` (`goal_plan`, `goal_completion`)
3. One new API endpoint `GET /api/goals/{goalId}/heartbeat-context` (~60 lines in route + ~15 lines `getAncestors` in goal service)
4. One new UI component `GoalPlanPayload` in `ui/src/components/ApprovalPayload.tsx`
5. A new "Goal Pursuit" section in `skills/paperclip/SKILL.md`
6. Adapter env var injection for `PAPERCLIP_GOAL_ID` in 7 adapter execute functions (claude_local, codex_local, gemini_local, opencode_local, pi_local, cursor, openclaw_gateway — ~2 lines each, following the existing `PAPERCLIP_TASK_ID` pattern)
7. ~20 lines in `server/src/routes/approvals.ts` to add `approval_rejected` and `approval_revision_requested` wakeups (mirroring the existing `approval_approved` wakeup at line 151)

## What It Does NOT Do (Intentionally)

- No new database tables
- No new orchestration engine
- No goal-specific scheduler or daemon
- No complex state machine beyond the existing status field
- No new permission types (CEO already has `canCreateAgents`)

## Goal Completion Detection

Goal completion is two separate problems with different characteristics:

1. **Detection** — knowing when all work under a goal is finished (mechanical)
2. **Decision** — deciding whether the goal is truly *achieved* (judgment)

### Current State of the Codebase

- No completion cascade exists anywhere. When an issue goes "done", nothing checks parents, siblings, or goals.
- All side effects are explicit and local — the pattern is always `mutation → logActivity() → optional wakeup`.
- No `goalId` filter exists in the `IssueFilters` interface (supports `status`, `assigneeAgentId`, `projectId`, `parentId` — but not `goalId`). This needs to be added.
- No per-goal progress tracking. Dashboard counts are company-wide only.
- Live events are UI-only (EventEmitter for WebSocket). All reactive behavior is imperative — explicit calls in route handlers.

### Detection: Signal on Last Issue Done

When an issue with a `goalId` transitions to `done` or `cancelled`, add one count query in the issue update route:

```sql
SELECT count(*) FROM issues
WHERE goal_id = $1 AND status NOT IN ('done', 'cancelled')
```

If count is 0, fire a `goal_work_complete` wakeup to the goal's `ownerAgentId`. This is ~15 lines in the issue update route, following the exact same pattern as the existing `issue_assigned` wakeup.

This is minimal, instant, only fires when relevant, and follows existing patterns. The slight coupling between issue updates and goal logic is consistent with how issue→agent wakeups already work.

### Detection: Subgoal Completion (Same Pattern)

The same pattern works recursively for subgoals. When a child goal transitions to `achieved`, add to the goal update route:

```sql
SELECT count(*) FROM goals
WHERE parent_id = $1 AND status NOT IN ('achieved', 'cancelled')
```

If count is 0, fire a `goal_work_complete` wakeup to the parent goal's `ownerAgentId`. Same ~15 lines, applied to the goal update route. Parent goal owner then follows the same review policy.

### Decision: Policy-Based Review

Add one field to the goals schema: **`reviewPolicy`** with two values:

- **`"owner"`** (default) — the goal's `ownerAgentId` (typically CEO) can assess and mark achieved. Suitable for goals with clear, measurable KPIs the CEO can evaluate.
- **`"board"`** — only a human board member can mark achieved. The CEO prepares a completion report and submits a `goal_completion` approval for board review.

### Decision Flow: `reviewPolicy: "owner"` (CEO-Assessed Goals)

```
Last issue under goal transitions to "done"
  → count remaining open issues = 0
  → fire wakeup to ownerAgentId, reason: "goal_work_complete"

CEO wakes up
  → calls GET /api/goals/{goalId}/heartbeat-context
  → reviews: are the KPIs met? (reads goal description, checks work products)
  → if satisfied: PATCH /goals/{goalId} { status: "achieved" }
  → if not: creates new issues for remaining work
```

KPIs are documented in the goal's description (which already supports markdown). The CEO reads the description, reviews the completed work, and decides. No structured KPI schema needed — the LLM reads and assesses naturally. This keeps KPIs as a prompt-level concern rather than a system-level one.

### Decision Flow: `reviewPolicy: "board"` (Human-Reviewed Goals)

```
Last issue under goal transitions to "done"
  → count remaining open issues = 0
  → fire wakeup to ownerAgentId, reason: "goal_work_complete"

CEO wakes up
  → calls GET /api/goals/{goalId}/heartbeat-context
  → prepares a completion report (summary of work done, outcomes vs. KPIs)
  → creates approval type "goal_completion" for board review

Board reviews in Approvals UI
  → sees completion report, linked work, outcomes
  → approves → wakeup fires (approval_approved) → goal marked "achieved"
  → requests revision → wakeup fires (approval_revision_requested) → CEO creates more work
  → rejects → wakeup fires (approval_rejected) → goal stays active or gets cancelled
```

This reuses the existing approval system identically to `hire_agent` and `goal_plan`.

### Progress Display (Derived, Not Stored)

There is no need for a stored `progressPercentage` field. Progress is derived:

- The goal context endpoint returns all issues and their statuses
- The CEO (or board) sees "8 of 10 issues done" from the context
- The UI computes and displays progress from the same data (`count done / count total`)

### Updated Goal Lifecycle (Complete)

```
planned ──[human or CEO sets active]──→ active
                                          │
                                    CEO wakes up (goal_activated)
                                    CEO reads context
                                    CEO creates goal_plan approval
                                          │
                                    Board reviews plan
                                          │
                              ┌───────────┼───────────┐
                              │           │           │
                          approves    requests     rejects
                              │       revision        │
                              │           │      CEO wakes up
                              │     CEO wakes up  (approval_rejected)
                              │     (approval_revision_requested)
                              │     CEO revises, resubmits
                              │     (loops back to board)
                              │
                        CEO wakes up (approval_approved)
                        CEO creates subgoals, projects, issues
                        CEO assigns agents (or proposes hires)
                              │
                        Agents wake up (issue_assigned)
                        Agents do work
                        Agents complete issues
                              │
                        Last issue done → goal_work_complete wakeup
                              │
                  ┌───────────┴───────────┐
                  │                       │
        reviewPolicy: "owner"    reviewPolicy: "board"
                  │                       │
        CEO assesses KPIs       CEO prepares completion report
        CEO marks achieved      CEO creates goal_completion approval
                  │                       │
                  │             Board reviews and decides
                  │                       │
                  └───────────┬───────────┘
                              │
                           achieved
                              │
                  (if parent goal exists)
                  count remaining sibling goals
                  if 0 → fire goal_work_complete to parent owner
                  (recursive)
```

## Summary: Total New Code

### Schema Changes (1 migration)

- Add `reviewPolicy` field to goals table (text, default `"owner"`)

### Constants Changes

- Add `"goal_plan"` and `"goal_completion"` to `APPROVAL_TYPES`

### Backend Changes

- `server/src/routes/goals.ts`: ~15 lines — wakeup on status transition to active (with guard)
- `server/src/routes/goals.ts`: ~15 lines — subgoal completion detection on status → achieved
- `server/src/routes/issues.ts`: ~15 lines — issue completion detection, fire wakeup if all goal issues done
- `server/src/routes/approvals.ts`: ~20 lines — add `approval_rejected` and `approval_revision_requested` wakeups to reject/request-revision handlers
- `server/src/services/issues.ts`: add `goalId` to `IssueFilters`
- `server/src/services/goals.ts`: add `getAncestors()` method (~15 lines, iterative parentId walk)
- New endpoint `GET /api/goals/{goalId}/heartbeat-context`: ~60 lines

### Adapter Changes

- Inject `PAPERCLIP_GOAL_ID` env var in 7 adapter execute functions (~2 lines each: read `context.goalId`, set `env.PAPERCLIP_GOAL_ID`)

### UI Changes

- `GoalPlanPayload` component in `ApprovalPayload.tsx` for rendering goal plan approvals
- `GoalCompletionPayload` component for rendering completion review approvals

### Skill Changes

- New "Goal Pursuit" section in `skills/paperclip/SKILL.md`
- Handle `goal_activated`, `goal_work_complete`, and `approval_approved`/`approval_revision_requested`/`approval_rejected` wake reasons for goal-related approval types

### What It Does NOT Do (Intentionally)

- No new database tables
- No new orchestration engine or daemon
- No goal-specific scheduler
- No complex state machine beyond the existing status field
- No new permission types (CEO already has `canCreateAgents`)
- No structured KPI schema (goal description is sufficient)
- No stored progress percentage (derived from issue counts)

## Handling Existing Goals After Deployment

### Current State of Existing Goals

Most existing goals have `ownerAgentId: null`. The UI's NewGoalDialog and the onboarding wizard both create goals without setting an owner. Only the seed data sets `ownerAgentId` to the CEO. A typical existing goal looks like:

```
{ title: "Ship V1", status: "active", ownerAgentId: null }
```

### Unowned Goals: Fall Back to CEO

When a goal has no `ownerAgentId` and a wakeup needs to fire, resolve the company's CEO agent by querying `agents` where `role = 'ceo'` and `companyId` matches. This is natural — the CEO is the default responsible party for company goals. The resolution logic mirrors `getDefaultCompanyGoal()` — a simple query, already a proven pattern. ~5 lines of code, no data backfill needed.

### No Retroactive Triggering

The wakeup logic lives in the `PATCH /goals/:id` handler — it fires on status *transitions*. Existing goals that are already `"active"` won't trigger because their status isn't changing. This is the safest default: existing active goals continue as passive metadata. Only goals that transition to `"active"` after deployment get the new behavior.

### Opting Existing Goals In: The "Pursue" Action

Add a dedicated endpoint: `POST /goals/:id/pursue`

This endpoint:
- Sets `ownerAgentId` to the CEO if not already set
- Fires the `goal_activated` wakeup without changing status
- The UI gets a "Pursue" button on the Goal Detail page

This is cleaner than faking a status transition (planned → active). The goal was already active — the human is opting it into the automation. It also works as a general-purpose "kick off this goal" action for any goal at any time.

### Onboarding Flow: No Changes Needed

The onboarding wizard creates goals with `status: "active"` and no `ownerAgentId` via `POST /companies/:companyId/goals`. During onboarding, the CEO agent doesn't exist yet — it's bootstrapped separately later via `auth-bootstrap-ceo`. Even if wakeup logic were added to the CREATE endpoint, the CEO fallback query would find nobody to wake. The onboarding goal is naturally passive.

Once the CEO is bootstrapped, the human clicks "Pursue" on the existing goal, which sets the owner and fires the wakeup. No special handling required.

### Migration Summary

1. **Schema migration**: Add `reviewPolicy` column with default `"owner"`. All existing goals get this value. Zero data backfill.
2. **No retroactive wakeups.** Existing active goals stay passive until a human clicks "Pursue".
3. **CEO fallback logic**: When `ownerAgentId` is null and a wakeup fires, resolve the company's CEO agent. ~5 lines.
4. **New "Pursue" endpoint**: `POST /goals/:id/pursue`. Sets `ownerAgentId` to CEO if unset, fires `goal_activated` wakeup. UI gets a button on Goal Detail page.
5. **`reviewPolicy` default**: `"owner"` — preserves current permissiveness where no governance exists around goal completion.
