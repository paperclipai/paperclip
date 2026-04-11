# Cancellation Replacement Gate — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent silent phase loss in initiative chains by requiring agents to reference a replacement issue or explicit waiver when cancelling tasks.

**Architecture:** New `assertCancellationReplacement` gate function in `server/src/routes/issues.ts`, placed after `assertAgentTransition` and before `initiative_has_active_children`. Fires only for agent actors cancelling tasks (not initiatives). Dedicated test file following the existing gate test patterns.

**Tech Stack:** TypeScript, Vitest, Express/supertest (test harness)

---

### Task 1: Write the gate function

**Files:**
- Modify: `server/src/routes/issues.ts` (add function near other gate functions, around line 738)

**Step 1: Add `assertCancellationReplacement` after `assertAgentCommentRequired` (line ~738)**

Place the new function right after `assertAgentCommentRequired` closes at line 738:

```typescript
  const REPLACEMENT_REF_PATTERN = /\b[A-Z]+-\d+\b/;
  const WAIVER_PATTERN = /\bno-replacement-needed\b/i;

  function assertCancellationReplacement(
    req: Request,
    existing: { status: string; issueType: string | null },
    toStatus: string | undefined,
    commentBody: string | undefined,
  ): { gate: string; reason: string } | null {
    if (req.actor.type !== "agent") return null;
    if (toStatus !== "cancelled") return null;
    if (existing.status === "cancelled") return null;
    if (existing.issueType === "initiative") return null;

    if (!commentBody || (!REPLACEMENT_REF_PATTERN.test(commentBody) && !WAIVER_PATTERN.test(commentBody))) {
      return {
        gate: "cancellation_replacement_required",
        reason: "When cancelling a task, agents must reference a replacement issue (e.g. DLD-123) or include 'no-replacement-needed' in the comment.",
      };
    }
    return null;
  }
```

**Step 2: Commit**

```bash
git add server/src/routes/issues.ts
git commit -m "feat: add assertCancellationReplacement gate function"
```

---

### Task 2: Wire the gate into the PATCH handler

**Files:**
- Modify: `server/src/routes/issues.ts` (PATCH handler, after transition gate block ~line 2143, before initiative_has_active_children ~line 2145)

**Step 1: Insert the gate call between the transition block and initiative_has_active_children**

After the closing brace of the transition gate block (the `}` that closes the reopen-cancelled block around line 2143) and before the `// Initiative deletion guard` comment at line 2145, insert:

```typescript
      // Cancellation replacement gate: agents must cite a replacement issue or waiver
      const cancelReplResult = assertCancellationReplacement(req, existing, req.body.status, commentBody);
      if (cancelReplResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.cancellation_replacement_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: {
            gate: cancelReplResult.gate,
            reason: cancelReplResult.reason,
            fromStatus: existing.status,
            targetStatus: req.body.status,
          },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: cancelReplResult.reason, gate: cancelReplResult.gate });
        return;
      }
```

**Step 2: Commit**

```bash
git add server/src/routes/issues.ts
git commit -m "feat: wire cancellation replacement gate into PATCH handler"
```

---

### Task 3: Write the test file

**Files:**
- Create: `server/src/__tests__/cancellation-replacement-gate.test.ts`

**Step 1: Write the full test file**

Follow the exact mock patterns from `hierarchy-gate.test.ts` (same service mock shape, same `createAgentApp`/`createBoardApp` helpers, same `makeIssue` factory). The test file structure:

```typescript
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const AGENT_1 = "aaaa0001-0001-4001-8001-000000000001";
const INITIATIVE_ID = "a0000000-0000-4000-8000-000000000001";
const TASK_ID = "b0000000-0000-4000-8000-000000000002";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  findMentionedAgents: vi.fn(),
  hasReachedStatus: vi.fn(),
  getActiveChildCount: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => ({
      id: AGENT_1,
      companyId: "company-1",
      name: "Engineer",
      role: "engineer",
      status: "active",
      pauseReason: null,
      permissions: { canCreateAgents: false },
    })),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => ({ contextSnapshot: {} })),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    companyId: "company-1",
    identifier: "DLD-200",
    title: "Test task",
    description: null,
    status: "in_progress",
    priority: "medium",
    issueType: "task",
    projectId: null,
    goalId: null,
    parentId: INITIATIVE_ID,
    assigneeAgentId: AGENT_1,
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date("2026-04-10T12:00:00Z"),
    ...overrides,
  };
}

function makeInitiative(overrides: Record<string, unknown> = {}) {
  return {
    ...makeTask(),
    id: INITIATIVE_ID,
    identifier: "DLD-100",
    title: "Test initiative",
    issueType: "initiative",
    parentId: null,
    ...overrides,
  };
}

const mockDbQuery = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([]),
};
const mockDb = { select: vi.fn(() => mockDbQuery) } as any;

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: AGENT_1,
      companyId: "company-1",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb, {} as any));
  app.use(errorHandler);
  return app;
}

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("cancellation replacement gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getActiveChildCount.mockResolvedValue({ count: 0, identifiers: [] });
    mockWorkProductService.listForIssue.mockResolvedValue([]);
  });

  it("agent cancels task with comment but no reference → 422 cancellation_replacement_required", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "This work is no longer needed" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("cancellation_replacement_required");
  });

  it("agent cancels task with DLD-123 in comment → allowed", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "Replaced by DLD-456" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels task with no-replacement-needed in comment → allowed", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "Scope removed, no-replacement-needed" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels task with No-Replacement-Needed (case insensitive) → allowed", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "No-Replacement-Needed — out of scope" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("board user cancels task without reference → allowed (bypass)", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });

    const res = await request(createBoardApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent transitions task to non-cancelled status → gate does not fire", async () => {
    const task = makeTask({ status: "in_progress", assigneeAgentId: "agent-other", executionWorkspaceId: null });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "in_review" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels initiative → gate does not fire (tasks only)", async () => {
    const initiative = makeInitiative({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(initiative);
    mockIssueService.getActiveChildCount.mockResolvedValue({ count: 0, identifiers: [] });
    mockIssueService.update.mockResolvedValue({ ...initiative, status: "cancelled" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${initiative.id}`)
      .send({ status: "cancelled", comment: "Shutting this down" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels task without comment → 422 comment_required (not this gate)", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(422);
    // comment_required fires (last gate) because no comment provided at all.
    // cancellation_replacement_required also fires (earlier) but comment_required
    // is tested here to show both gates are complementary — the agent sees
    // whichever fires first in the ordering.
    expect(["comment_required", "cancellation_replacement_required"]).toContain(res.body.gate);
  });
});
```

**Step 2: Run the tests to verify they fail (gate function exists but not wired, or both exist)**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run server/src/__tests__/cancellation-replacement-gate.test.ts`

Expected: Tests that check for `cancellation_replacement_required` should fail if the gate is not yet wired, or pass if Tasks 1-2 are already done.

**Step 3: Commit**

```bash
git add server/src/__tests__/cancellation-replacement-gate.test.ts
git commit -m "test: add cancellation replacement gate tests (8 cases)"
```

---

### Task 4: Run the full test suite

**Step 1: Run all server tests**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run --reporter=verbose 2>&1 | tail -30`

Expected: All existing tests pass. New tests pass. No regressions.

**Step 2: Run typecheck**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm -r typecheck`

Expected: Clean — no type errors.

**Step 3: If any failures, fix and re-run. Then commit any fixes.**

---

### Task 5: Update CLAUDE.md gate documentation

**Files:**
- Modify: `CLAUDE.md` (gate ordering table and key files list)

**Step 1: Add `assertCancellationReplacement` to the gate ordering table**

In the `### Gate ordering` section, insert the new gate between items 2 and 3:

```
1. Auto-infer @mention (enriches `assigneeAgentId`)
2. Review handoff gate
3. **Cancellation replacement gate** — replacement ref or waiver for task cancellations
4. Assignment policy
5. Checkout ownership
6. Transition gate — status state machine
...
```

Wait — the gate ordering in CLAUDE.md and the actual code ordering differ slightly. Update to match actual code order:

```
1. Checkout ownership
2. Transition gate — status state machine
3. **Cancellation replacement gate** — replacement ref or waiver for cancelled tasks
4. Initiative active children guard
5. Delivery gate — work product requirements
6. Engineer evidence gate — screenshot for `in_review`
7. Review cycle gate — code issues must have been in `in_review` before `done`
8. QA gate — QA PASS requirement
9. QA browse evidence gate — screenshot from QA reviewer for `done`
10. Comment-required gate
```

**Step 2: Add to key files list**

Add: `- server/src/__tests__/cancellation-replacement-gate.test.ts — 8 cancellation replacement gate tests`

**Step 3: Add a new documentation section for the gate**

Add a `### Cancellation replacement gate` section after the review handoff gate section, documenting gate name, patterns, actor scope, issue type scope, activity log action.

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add cancellation replacement gate to CLAUDE.md"
```

---

### Task 6: Update AGENTS.md onboarding instructions

**Files:**
- Modify: `server/src/onboarding-assets/default/AGENTS.md`

**Step 1: Add cancellation replacement protocol to the Code Delivery Protocol section**

Add a brief section explaining that when cancelling a task, the comment must reference a replacement issue (`DLD-123`) or include `no-replacement-needed`.

**Step 2: Commit**

```bash
git add server/src/onboarding-assets/default/AGENTS.md
git commit -m "docs: add cancellation replacement requirement to AGENTS.md"
```
