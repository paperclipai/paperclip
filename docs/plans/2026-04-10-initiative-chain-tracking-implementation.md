# Initiative & Chain Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `issueType` column (initiative/task), enforce strict 2-level hierarchy, add initiative swimlane UI, chain health sweeper, and minimal flow analytics.

**Architecture:** New `issue_type` column with DB constraints, universal enforcement gates in issues.ts POST/PATCH handlers, new `InitiativeBoard` component alongside existing KanbanBoard, chain health sweeper in heartbeat.ts, recharts-based throughput + CFD charts with 2 new API endpoints.

**Tech Stack:** TypeScript, PostgreSQL (Drizzle ORM), Vitest + Supertest, React 19, @dnd-kit, recharts (new), TanStack Query

**Design doc:** `docs/plans/2026-04-10-initiative-chain-tracking-design.md`

---

### Task 1: Add ISSUE_TYPES and TERMINAL_ISSUE_STATUSES constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

**Step 1: Add constants after ISSUE_ORIGIN_KINDS (line ~137)**

Add after the `ISSUE_ORIGIN_KINDS` block:

```typescript
export const ISSUE_TYPES = ["initiative", "task"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;

export const CHAIN_STALL_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
```

**Step 2: Run typecheck**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm --filter @paperclipai/shared build`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat: add ISSUE_TYPES, TERMINAL_ISSUE_STATUSES, CHAIN_STALL_THRESHOLD_MS constants"
```

---

### Task 2: Add issueType to shared types and validators

**Files:**
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/validators/issue.ts`

**Step 1: Add issueType to Issue interface**

In `packages/shared/src/types/issue.ts`, add to the Issue interface (after `parentId: string | null`):

```typescript
issueType: string;
```

**Step 2: Add issueType to createIssueSchema**

In `packages/shared/src/validators/issue.ts`, import ISSUE_TYPES and add to createIssueSchema:

```typescript
import { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES } from "../constants.js";
```

Add field to schema:
```typescript
issueType: z.enum(ISSUE_TYPES),
```

**Step 3: Build shared package**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm --filter @paperclipai/shared build`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/src/types/issue.ts packages/shared/src/validators/issue.ts
git commit -m "feat: add issueType to Issue type and createIssueSchema validator"
```

---

### Task 3: Add issue_type column to DB schema and migration

**Files:**
- Modify: `packages/db/src/schema/issues.ts`
- Create: `packages/db/src/migrations/0053_issue_type.sql`

**Step 1: Add column to schema**

In `packages/db/src/schema/issues.ts`, add after `parentId` (line 29):

```typescript
issueType: text("issue_type").notNull().default("task"),
```

Add index in the indexes section:

```typescript
typeIdx: index("issues_company_type_idx").on(table.companyId, table.issueType),
```

**Step 2: Create migration**

```sql
-- Add issue_type column
ALTER TABLE issues ADD COLUMN issue_type text NOT NULL DEFAULT 'task';

-- Backfill: issues with children become initiatives
UPDATE issues SET issue_type = 'initiative'
WHERE id IN (SELECT DISTINCT parent_id FROM issues WHERE parent_id IS NOT NULL)
AND parent_id IS NULL;

-- Backfill: remaining parentless issues without children stay as 'task'
-- They will be reparented to Unclassified initiatives after gate deployment

-- Add check constraints
ALTER TABLE issues ADD CONSTRAINT issues_issue_type_check
CHECK (issue_type IN ('initiative', 'task'));

ALTER TABLE issues ADD CONSTRAINT issues_type_parent_shape_check
CHECK (
  (issue_type = 'initiative' AND parent_id IS NULL) OR
  (issue_type = 'task' AND parent_id IS NOT NULL)
);

-- Note: the parent shape check will fail for existing parentless tasks.
-- We must first reparent them. For now, add only the type check.
-- The shape check is added in a follow-up migration after backfill.

-- Actually, we need to handle this carefully. Existing parentless tasks
-- need to remain valid. So we add the type check only, and enforce
-- the shape constraint at the application layer for now.
-- Drop the shape check - enforce via application gates only.
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_type_parent_shape_check;

-- Index for fast initiative queries
CREATE INDEX issues_company_type_idx ON issues (company_id, issue_type);
```

**Step 3: Build DB package**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm --filter @paperclipai/db build`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/db/src/schema/issues.ts packages/db/src/migrations/0053_issue_type.sql
git commit -m "feat: add issue_type column with migration and type check constraint"
```

---

### Task 4: Write hierarchy gate tests

**Files:**
- Create: `server/src/__tests__/hierarchy-gate.test.ts`

**Step 1: Write tests following department-label-gate.test.ts pattern**

The test file should cover:
1. Agent creating task without parentId → 422 task_requires_initiative_parent
2. Agent creating initiative with parentId → 422 initiative_cannot_have_parent
3. Agent creating task with parentId pointing to another task → 422 parent_must_be_initiative
4. Agent creating task with parentId pointing to initiative → 201 success
5. Agent creating initiative without parentId → 201 success
6. Board user creating task without parentId → 422 (universal enforcement)
7. Board user creating initiative → 201 success
8. Agent creating task with nonexistent parentId → 422 parent_not_found
9. Department consistency: task dept label must match parent initiative dept label → 422
10. Initiative cannot be cancelled with active children → 422

Use the same mock pattern from `department-label-gate.test.ts`.

**Step 2: Run tests to verify they fail**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run server/src/__tests__/hierarchy-gate.test.ts`
Expected: FAIL (gates not implemented yet)

**Step 3: Commit**

```bash
git add server/src/__tests__/hierarchy-gate.test.ts
git commit -m "test: add hierarchy gate tests for initiative/task enforcement"
```

---

### Task 5: Implement hierarchy gates in issues.ts POST handler

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/issues.ts`

**Step 1: Add getIssueTypeById service function**

In `server/src/services/issues.ts`, add a function to look up an issue's type:

```typescript
getIssueTypeById: async (issueId: string): Promise<{ id: string; issueType: string; companyId: string } | null> => {
  const [row] = await db
    .select({ id: issues.id, issueType: issues.issueType, companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId));
  return row ?? null;
},
```

Also add `getLabelsByIssueId` to fetch labels for an issue (for department consistency check):

```typescript
getLabelsByIssueId: async (issueId: string): Promise<Array<{ labelId: string }>> => {
  return db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId));
},
```

**Step 2: Add hierarchy gate in POST handler**

In `server/src/routes/issues.ts`, insert after the rate limit gate (after line 1606) and before the relay dedup gate:

```typescript
// Issue type hierarchy gate — universal enforcement (agents AND board users)
const issueType: string = req.body.issueType ?? "task";
if (issueType === "initiative" && req.body.parentId) {
  await logActivity(db, {
    companyId, actorType: actor.actorType, actorId: actor.actorId,
    agentId: actor.agentId, runId: actor.runId,
    action: "issue.hierarchy_gate_blocked",
    entityType: "issue", entityId: actor.agentId ?? actor.actorId,
    details: { issueType, parentId: req.body.parentId, reason: "initiative_cannot_have_parent" },
  });
  res.status(422).json({
    error: "initiative_cannot_have_parent",
    gate: "initiative_cannot_have_parent",
    message: "Initiatives are top-level containers and cannot have a parentId.",
  });
  return;
}
if (issueType === "task" && !req.body.parentId) {
  await logActivity(db, {
    companyId, actorType: actor.actorType, actorId: actor.actorId,
    agentId: actor.agentId, runId: actor.runId,
    action: "issue.hierarchy_gate_blocked",
    entityType: "issue", entityId: actor.agentId ?? actor.actorId,
    details: { issueType, reason: "task_requires_initiative_parent" },
  });
  res.status(422).json({
    error: "task_requires_initiative_parent",
    gate: "task_requires_initiative_parent",
    message: "Tasks must have a parentId pointing to an existing initiative.",
  });
  return;
}
if (issueType === "task" && req.body.parentId) {
  const parent = await svc.getIssueTypeById(req.body.parentId);
  if (!parent) {
    res.status(422).json({
      error: "parent_not_found",
      gate: "parent_not_found",
      message: `Parent issue ${req.body.parentId} does not exist.`,
    });
    return;
  }
  if (parent.issueType !== "initiative") {
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "issue.hierarchy_gate_blocked",
      entityType: "issue", entityId: actor.agentId ?? actor.actorId,
      details: { issueType, parentId: req.body.parentId, parentType: parent.issueType, reason: "parent_must_be_initiative" },
    });
    res.status(422).json({
      error: "parent_must_be_initiative",
      gate: "parent_must_be_initiative",
      message: "Tasks can only be children of initiatives, not other tasks.",
    });
    return;
  }
}
```

**Step 3: Add department consistency gate**

After the hierarchy gate, add department consistency check for tasks:

```typescript
// Department consistency gate: task's dept label must match parent initiative's dept label
if (issueType === "task" && req.body.parentId && req.body.labelIds?.length) {
  const deptLabelIds = await svc.getDepartmentLabelIds(companyId);
  const taskDeptLabel = req.body.labelIds.find((id: string) => deptLabelIds.has(id));
  if (taskDeptLabel) {
    const parentLabels = await svc.getLabelsByIssueId(req.body.parentId);
    const parentDeptLabel = parentLabels.find(l => deptLabelIds.has(l.labelId));
    if (parentDeptLabel && parentDeptLabel.labelId !== taskDeptLabel) {
      res.status(422).json({
        error: "department_mismatch",
        gate: "department_mismatch",
        message: "Task's department label must match its parent initiative's department label.",
      });
      return;
    }
  }
}
```

**Step 4: Reorder gates — move department label gate before dedup gates**

Reorder the POST handler so gates run in this sequence:
1. Rate limit
2. Issue type hierarchy gate (new)
3. Department label gate (moved before dedup)
4. Department consistency gate (new)
5. Relay dedup
6. Department dedup

**Step 5: Run hierarchy gate tests**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run server/src/__tests__/hierarchy-gate.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All pass (existing tests may need `issueType` added to mock data)

**Step 7: Commit**

```bash
git add server/src/routes/issues.ts server/src/services/issues.ts
git commit -m "feat: implement hierarchy gates for initiative/task enforcement"
```

---

### Task 6: Add initiative deletion guard in PATCH handler

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/issues.ts`

**Step 1: Add getActiveChildCount service function**

```typescript
getActiveChildCount: async (issueId: string): Promise<{ count: number; identifiers: string[] }> => {
  const children = await db
    .select({ id: issues.id, identifier: issues.identifier, status: issues.status })
    .from(issues)
    .where(eq(issues.parentId, issueId));
  const active = children.filter(c => c.status !== "done" && c.status !== "cancelled");
  return { count: active.length, identifiers: active.map(c => c.identifier).filter(Boolean) as string[] };
},
```

**Step 2: Add initiative deletion gate in PATCH handler**

In the PATCH handler, after the transition gate and before the delivery gate, add:

```typescript
// Initiative deletion guard — cannot cancel/complete initiative with active children
if (
  req.body.status &&
  (req.body.status === "done" || req.body.status === "cancelled") &&
  existing.issueType === "initiative"
) {
  const { count, identifiers } = await svc.getActiveChildCount(existing.id);
  if (count > 0) {
    res.status(422).json({
      error: "initiative_has_active_children",
      gate: "initiative_has_active_children",
      message: `Cannot close initiative with ${count} active child task(s). Complete or cancel children first.`,
      activeChildCount: count,
      activeChildIdentifiers: identifiers,
    });
    return;
  }
}
```

**Step 3: Run tests**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run server/src/__tests__/hierarchy-gate.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add server/src/routes/issues.ts server/src/services/issues.ts
git commit -m "feat: add initiative deletion guard - cannot close with active children"
```

---

### Task 7: Add chain health sweeper

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/index.ts`
- Create: `server/src/__tests__/chain-health-sweeper.test.ts`

**Step 1: Write sweeper tests**

Test cases:
1. Initiative with blocked child → logs chain_degraded
2. Initiative with no status change in 4h → logs chain_stalled
3. Initiative with all children terminal → auto-closes after 5min debounce
4. Initiative with all children terminal but last transition <5min ago → skips
5. Empty initiative → not auto-closed
6. Stalled overrides degraded (precedence)
7. Dedup — doesn't log duplicate events within 1 hour

**Step 2: Implement detectChainHealth in heartbeat.ts**

```typescript
async detectChainHealth(): Promise<{ degraded: number; stalled: number; autoClosed: number }> {
  // Find all active initiatives
  // For each: check children for blocked status, check activity_log for recent status transitions
  // Log chain_degraded or chain_stalled events (with dedup)
  // Auto-close initiatives where all children are terminal and debounce passed
}
```

**Step 3: Wire into scheduler in index.ts**

Add at the ~10 tick interval (every ~5 minutes):

```typescript
void heartbeat
  .detectChainHealth()
  .then((result) => {
    if (result.degraded > 0 || result.stalled > 0 || result.autoClosed > 0) {
      logger.info({ ...result }, "chain health sweep completed");
    }
  })
  .catch((err) => {
    logger.error({ err }, "chain health sweep failed");
  });
```

**Step 4: Run tests**

Expected: PASS

**Step 5: Commit**

```bash
git add server/src/services/heartbeat.ts server/src/index.ts server/src/__tests__/chain-health-sweeper.test.ts
git commit -m "feat: add chain health sweeper - degraded/stalled detection + auto-close"
```

---

### Task 8: Add groupBy initiative to IssuesList

**Files:**
- Modify: `ui/src/components/IssuesList.tsx`
- Modify: `ui/src/lib/issue-tree.ts`

**Step 1: Extend IssueViewState groupBy type**

Change line 47:
```typescript
groupBy: "status" | "priority" | "assignee" | "initiative" | "none";
```

**Step 2: Add initiative grouping logic**

Add a new grouping branch in the group-building logic that groups tasks by their parentId, using initiative titles as group labels, with summary stats in headers.

**Step 3: Add initiative health header**

Show completion ratio, blocked count, and stale age in each group header.

**Step 4: Commit**

```bash
git add ui/src/components/IssuesList.tsx ui/src/lib/issue-tree.ts
git commit -m "feat: add groupBy initiative swimlanes with health indicators"
```

---

### Task 9: Build InitiativeBoard component

**Files:**
- Create: `ui/src/components/InitiativeBoard.tsx`
- Modify: `ui/src/components/IssuesList.tsx`

**Step 1: Create InitiativeBoard with swimlane layout**

New component that renders one row per initiative with status columns.
Uses @dnd-kit for drag-and-drop within rows.

**Step 2: Add "initiatives" viewMode**

Change viewMode type:
```typescript
viewMode: "list" | "board" | "initiatives";
```

Add view toggle button and route to InitiativeBoard when selected.

**Step 3: Commit**

```bash
git add ui/src/components/InitiativeBoard.tsx ui/src/components/IssuesList.tsx
git commit -m "feat: add InitiativeBoard swimlane component with health headers"
```

---

### Task 10: Update NewIssueDialog for initiative/task creation

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx`

**Step 1: Add issueType toggle and initiative picker**

Add:
- Toggle between initiative and task modes
- Required initiative dropdown when creating tasks (filtered by department)
- Inline "Create initiative" option

**Step 2: Commit**

```bash
git add ui/src/components/NewIssueDialog.tsx
git commit -m "feat: add initiative picker and issueType toggle to NewIssueDialog"
```

---

### Task 11: Add analytics API endpoints

**Files:**
- Create: `server/src/routes/analytics.ts`
- Create: `server/src/services/analytics.ts`
- Modify: `server/src/index.ts` (register routes)
- Create: `server/src/__tests__/analytics-endpoints.test.ts`

**Step 1: Create analytics service**

```typescript
// throughput: count terminal transitions per day
// flow: daily status distribution snapshot
```

**Step 2: Create analytics routes**

```
GET /api/companies/:companyId/analytics/throughput?days=30&deptLabelId=...&initiativeId=...
GET /api/companies/:companyId/analytics/flow?days=30&deptLabelId=...&initiativeId=...
```

**Step 3: Write tests and commit**

---

### Task 12: Add recharts and build FlowAnalytics component

**Files:**
- Install: `recharts` in ui/package.json
- Create: `ui/src/components/FlowAnalytics.tsx`
- Create: `ui/src/api/analytics.ts`
- Modify: `ui/src/components/IssuesList.tsx` (add Analytics tab)

**Step 1: Install recharts**

```bash
cd /Users/damondecrescenzo/paperclip/ui && pnpm add recharts
```

**Step 2: Create analytics API client**

**Step 3: Build FlowAnalytics component with throughput + CFD charts**

**Step 4: Integrate as tab in IssuesList**

**Step 5: Commit**

---

### Task 13: Update AGENTS.md with new requirements

**Files:**
- Modify: `server/src/onboarding-assets/default/AGENTS.md`

Add initiative/task creation requirements and examples.

---

### Task 14: Full test suite run and cleanup

Run all tests, fix any failures, ensure typecheck passes across all packages.

---
