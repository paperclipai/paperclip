# Workspace Policy + Browser Evidence Gates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the workspace policy system so delivery + QA gates fire on code issues, and add browser evidence gates that require interactive testing proof before `in_review` and `done` transitions.

**Architecture:** The upstream workspace policy system (`enableIsolatedWorkspaces` flag) is already built but turned off. Enabling it stops `issues.ts:1099-1103` from stripping workspace fields, which makes `executionWorkspaceId` non-null on code project issues, which activates the delivery gate (`assertDeliveryGate` at `issues.ts:268`) and enables the new evidence gates. Two new gate functions (`assertEngineerBrowseEvidence` and `assertQABrowseEvidence`) enforce that agents include browser testing commands and image attachments before status transitions. Non-code issues (null `executionWorkspaceId`) are exempt from all workspace-gated checks.

**Tech Stack:** TypeScript, Express, Vitest, Drizzle ORM, PostgreSQL

**Prior work:** PR #187 deployed the Browser Testing VPS (207.148.14.165) with SSH key at `/paperclip/.ssh/id_ed25519_test_vps`, env vars (`BROWSER_TEST_HOST`, `BROWSER_TEST_USER`, `BROWSER_TEST_SSH_KEY`) wired to all 24 agents, and the `dogfood` skill with structured QA workflow. The infrastructure and agent tooling are already live.

---

## Design Decisions (addressing reviewer feedback)

### Evidence standard — what counts

Evidence is validated by **two independent signals** that must both come from the **same actor**:

1. **Browse command text** — a comment by the actor containing a recognized browser testing command
2. **Image attachment** — an `image/*` attachment on the issue created by the same actor

The browse evidence regex is explicitly an **interim control** (v1). It catches the common patterns from the dogfood skill and AGENTS.md instructions. It will produce false positives (canned text) and false negatives (novel workflows). The plan documents this as a stopgap — the v2 path is machine-generated evidence tokens from the `browser-test` command itself, which we'll add when the testing VPS supports structured output.

### Same-actor binding

Both the engineer evidence gate and the QA evidence gate enforce that the browse text and image attachment come from the **same actor** as the one performing the status transition (engineer) or the one who posted `QA: PASS` (QA reviewer). This prevents the split-actor gaming vector.

### Timing validation — scoped to current review cycle

Evidence must be **recent relative to the current assignment**. Specifically:
- Browse evidence comments and image attachments must have `createdAt` >= the issue's `updatedAt` timestamp (which resets on status/assignee changes)
- This prevents stale evidence from a previous review cycle satisfying the gate forever

### `executionWorkspaceId` as code-issue proxy

Using `executionWorkspaceId` as the signal for "code issue" is pragmatic but depends on correct project configuration. This is documented clearly — if a code project is misconfigured, its issues silently become exempt. A future v2 could add a `projectType` field, but for now the coupling is acceptable because project configuration is a board-only operation.

### Override mechanics

Board users bypass all evidence gates (existing pattern — `req.actor.type !== "agent"` check). This is the override path when browser infrastructure is down. Board overrides are logged in the activity log like all other gate bypasses.

### Browser testing VPS as dependency

The testing VPS is already deployed and operational (PR #187). If it goes down, agents will be unable to produce evidence and will get 422 rejections. The correct response is: agent posts a blocker comment and escalates to the board. Board users can override. This is the same pattern as "if GitHub is down, delivery gate blocks and board overrides." No special fallback mechanism needed — the existing board-bypass is the fallback.

### SSH security posture

PR #187 already deployed the SSH key and `StrictHostKeyChecking=no`. Hardening (non-root user, restricted commands, known_hosts preloading, key rotation) is out of scope for this PR — it's a separate security hardening task. This plan focuses on the gate enforcement logic.

---

## Task 1: Evidence helper functions

**Files:**
- Modify: `server/src/routes/issues.ts` (add after line 321, after `assertQAGate`)

### Step 1: Write the evidence pattern constant and helper functions

Add these after the `assertQAGate` function (after line 321):

```typescript
// ---------- Browse evidence gates (v1 — interim regex control) ----------
// This regex is a stopgap. It detects common browser testing command patterns
// from the dogfood skill and AGENTS.md. It is gameable (canned text) and will
// miss novel workflows. The v2 path is structured evidence tokens from browser-test CLI.
const BROWSE_EVIDENCE_PATTERN =
  /\b(browser-test\s+(headless|headed)|browse\s+(goto|screenshot|snapshot|click)|dump-dom|--dump-dom|screenshot\s+saved|console\s+output|no\s+console\s+errors|DOM\s+(dump|snapshot|output))\b/i;

/**
 * Check if an actor has posted browse evidence text in their comments on this issue.
 * Only considers comments created after `sinceDate` to scope evidence to the current review cycle.
 */
function actorHasBrowseEvidence(
  comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
  actorAgentId: string | null,
  actorUserId: string | null,
  sinceDate: Date | string,
): boolean {
  const since = new Date(sinceDate).getTime();
  return comments.some(c => {
    if (new Date(c.createdAt).getTime() < since) return false;
    const isActor =
      (actorAgentId && c.authorAgentId === actorAgentId) ||
      (actorUserId && c.authorUserId === actorUserId);
    return isActor && BROWSE_EVIDENCE_PATTERN.test(c.body);
  });
}

/**
 * Check if an actor has uploaded an image attachment to this issue.
 * Only considers attachments created after `sinceDate`.
 */
function actorHasImageAttachment(
  attachments: Array<{ contentType: string | null; createdByAgentId: string | null; createdByUserId: string | null; createdAt: Date | string }>,
  actorAgentId: string | null,
  actorUserId: string | null,
  sinceDate: Date | string,
): boolean {
  const since = new Date(sinceDate).getTime();
  return attachments.some(a => {
    if (new Date(a.createdAt).getTime() < since) return false;
    const isActor =
      (actorAgentId && a.createdByAgentId === actorAgentId) ||
      (actorUserId && a.createdByUserId === actorUserId);
    return isActor && a.contentType?.startsWith("image/");
  });
}
```

### Step 2: Commit

```bash
git add server/src/routes/issues.ts
git commit -m "feat(gates): add browse evidence helper functions (v1 interim)"
```

---

## Task 2: Engineer evidence gate (`in_review`)

**Files:**
- Modify: `server/src/routes/issues.ts` (add after evidence helpers from Task 1)

### Step 1: Write the gate function

Add after the helper functions:

```typescript
/**
 * Engineer evidence gate: code issues moving to in_review must include
 * browser testing evidence (browse command text + image attachment)
 * from the transitioning agent.
 */
async function assertEngineerBrowseEvidence(
  issueSvc: ReturnType<typeof issueService>,
  req: Request,
  issue: { id: string; executionWorkspaceId: string | null; updatedAt: Date | string },
  targetStatus: string,
  comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
  attachments: Array<{ contentType: string | null; createdByAgentId: string | null; createdByUserId: string | null; createdAt: Date | string }>,
): Promise<{ gate: string; reason: string } | null> {
  if (req.actor.type !== "agent") return null;
  if (targetStatus !== "in_review") return null;
  if (!issue.executionWorkspaceId) return null;

  const agentId = req.actor.agentId ?? null;
  const sinceDate = issue.updatedAt;

  const hasBrowseText = actorHasBrowseEvidence(comments, agentId, null, sinceDate);
  const hasImage = actorHasImageAttachment(attachments, agentId, null, sinceDate);

  if (!hasBrowseText || !hasImage) {
    const missing: string[] = [];
    if (!hasBrowseText) missing.push("browser testing commands in a comment (e.g. 'browser-test headless <url>')");
    if (!hasImage) missing.push("an image attachment (screenshot)");
    return {
      gate: "in_review_requires_browse_evidence",
      reason: `Code issues require interactive browser testing evidence before moving to in_review. Missing: ${missing.join(" and ")}. Use the Browser Testing VPS (ssh -i $BROWSER_TEST_SSH_KEY ...) to test your changes, post the output as a comment, and attach a screenshot.`,
    };
  }

  return null;
}
```

### Step 2: Commit

```bash
git add server/src/routes/issues.ts
git commit -m "feat(gates): add engineer browse evidence gate for in_review"
```

---

## Task 3: Strengthen QA gate with browse evidence

**Files:**
- Modify: `server/src/routes/issues.ts` (modify `assertQAGate` and add QA evidence gate)

### Step 1: Add QA browse evidence gate

Add a new gate function after `assertEngineerBrowseEvidence`:

```typescript
/**
 * QA browse evidence gate: code issues moving to done must have browse
 * evidence from the same actor who posted QA: PASS.
 * Runs AFTER assertQAGate (which confirms QA: PASS exists).
 */
async function assertQABrowseEvidence(
  req: Request,
  issue: { id: string; executionWorkspaceId: string | null; assigneeAgentId: string | null; updatedAt: Date | string },
  comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
  attachments: Array<{ contentType: string | null; createdByAgentId: string | null; createdByUserId: string | null; createdAt: Date | string }>,
): Promise<{ gate: string; reason: string } | null> {
  if (req.actor.type !== "agent") return null;
  if (!issue.executionWorkspaceId) return null;

  // Find the QA PASS comment author (same logic as assertQAGate: non-assignee, authenticated)
  const qaPassComment = comments.find(
    c =>
      (c.authorAgentId || c.authorUserId) &&
      c.authorAgentId !== issue.assigneeAgentId &&
      QA_PASS_PATTERN.test(c.body),
  );
  if (!qaPassComment) return null; // assertQAGate should have caught this already

  const qaAgentId = qaPassComment.authorAgentId;
  const qaUserId = qaPassComment.authorUserId;
  const sinceDate = issue.updatedAt;

  const hasBrowseText = actorHasBrowseEvidence(comments, qaAgentId, qaUserId, sinceDate);
  const hasImage = actorHasImageAttachment(attachments, qaAgentId, qaUserId, sinceDate);

  if (!hasBrowseText || !hasImage) {
    const missing: string[] = [];
    if (!hasBrowseText) missing.push("browser testing commands");
    if (!hasImage) missing.push("screenshot attachment");
    return {
      gate: "done_requires_qa_browse_evidence",
      reason: `QA PASS without interactive testing evidence is insufficient for code issues. The QA reviewer must include ${missing.join(" and ")} in their review. Use the Browser Testing VPS to verify the fix interactively.`,
    };
  }

  return null;
}
```

### Step 2: Refactor `assertQAGate` to accept pre-fetched comments

Change `assertQAGate` signature to accept comments as a parameter instead of fetching them internally. This avoids a double query since the PATCH handler will now fetch comments once and pass to all gates.

Replace the existing `assertQAGate` (lines 298-321):

```typescript
async function assertQAGate(
  req: Request,
  issue: { id: string; executionWorkspaceId: string | null; assigneeAgentId: string | null },
  targetStatus: string,
  comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
): Promise<{ gate: string; reason: string } | null> {
  if (req.actor.type !== "agent") return null;
  if (targetStatus !== "done") return null;

  const hasQAPass = comments.some(
    c =>
      (c.authorAgentId || c.authorUserId) &&
      c.authorAgentId !== issue.assigneeAgentId &&
      QA_PASS_PATTERN.test(c.body),
  );
  if (!hasQAPass) {
    return {
      gate: "done_requires_qa_pass",
      reason: "Cannot mark done without QA approval. A comment containing 'QA: PASS' from a different reviewer is required. The assigned agent cannot approve their own work.",
    };
  }
  return null;
}
```

**Note:** The only change is removing the `issueSvc` parameter and the internal `listComments` call, replacing with a `comments` parameter. The logic is identical.

### Step 3: Commit

```bash
git add server/src/routes/issues.ts
git commit -m "feat(gates): add QA browse evidence gate, refactor assertQAGate to accept pre-fetched comments"
```

---

## Task 4: Wire gates into PATCH handler

**Files:**
- Modify: `server/src/routes/issues.ts` (lines 1572-1631, the status transition gates block)

### Step 1: Add comments + attachments fetch and wire new gates

Replace the status transition gates block (lines 1572-1631) with:

```typescript
    // Status transition gates (agent-only — board always bypasses)
    if (req.body.status && req.body.status !== existing.status) {
      // Transition graph: agents follow forward-only workflow
      const transitionResult = assertAgentTransition(req, existing.status, req.body.status);
      if (transitionResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.transition_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: transitionResult.gate, reason: transitionResult.reason, fromStatus: existing.status, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: transitionResult.reason, gate: transitionResult.gate });
        return;
      }

      // Delivery gate: agents must push code before transitioning code issues
      const gateResult = await assertDeliveryGate(workProductsSvc, req, existing, req.body.status);
      if (gateResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.delivery_gate_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: gateResult.gate, reason: gateResult.reason, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: gateResult.reason, gate: gateResult.gate });
        return;
      }

      // Fetch comments + attachments once for evidence and QA gates
      const allComments = await svc.listComments(existing.id, { order: "asc" });
      const allAttachments = await svc.listAttachments(existing.id);

      // Engineer evidence gate: browse evidence + screenshot for in_review (code issues)
      const evidenceResult = await assertEngineerBrowseEvidence(svc, req, existing, req.body.status, allComments, allAttachments);
      if (evidenceResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.evidence_gate_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: evidenceResult.gate, reason: evidenceResult.reason, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: evidenceResult.reason, gate: evidenceResult.gate });
        return;
      }

      // QA gate: agents must have QA approval before marking code issues done
      const qaGateResult = await assertQAGate(req, existing, req.body.status, allComments);
      if (qaGateResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.qa_gate_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: qaGateResult.gate, reason: qaGateResult.reason, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: qaGateResult.reason, gate: qaGateResult.gate });
        return;
      }

      // QA browse evidence gate: QA reviewer must include testing evidence (code issues, done only)
      if (req.body.status === "done") {
        const qaBrowseResult = await assertQABrowseEvidence(req, existing, allComments, allAttachments);
        if (qaBrowseResult) {
          const actor = getActorInfo(req);
          await logActivity(db, {
            companyId: existing.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.qa_evidence_gate_blocked",
            entityType: "issue",
            entityId: existing.id,
            details: { gate: qaBrowseResult.gate, reason: qaBrowseResult.reason, targetStatus: req.body.status },
          });
          await incrementGateBlockCount(existing.id);
          res.status(422).json({ error: qaBrowseResult.reason, gate: qaBrowseResult.gate });
          return;
        }
      }
    }
```

### Step 2: Commit

```bash
git add server/src/routes/issues.ts
git commit -m "feat(gates): wire evidence gates into PATCH handler with single comment/attachment fetch"
```

---

## Task 5: Tests — engineer evidence gate

**Files:**
- Create: `server/src/__tests__/browse-evidence-gate.test.ts`

### Step 1: Write the test file

Follow the exact pattern from `qa-gate.test.ts` — same mocks, `createAgentApp()`, `createBoardApp()`.

```typescript
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  findMentionedAgents: vi.fn(),
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
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
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

const codeIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-100",
  title: "Implement feature",
  description: null,
  status: "in_progress",
  priority: "medium",
  projectId: null,
  goalId: null,
  parentId: null,
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  createdByUserId: null,
  executionWorkspaceId: "ws-1",
  labels: [],
  labelIds: [],
  hiddenAt: null,
  updatedAt: new Date("2026-03-30T12:00:00Z"),
};

const nonCodeIssue = {
  ...codeIssue,
  id: "22222222-2222-4222-8222-222222222222",
  identifier: "PAP-200",
  title: "Update docs",
  executionWorkspaceId: null,
};

const validBranch = { type: "branch" as const, status: "active" };

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
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

describe("engineer browse evidence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([validBranch]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    // Default: no attachments
    mockIssueService.listAttachments.mockResolvedValue([]);
  });

  it("agent → in_review, code issue, no evidence → 422", async () => {
    // Agent is NOT the current assignee so review handoff gate doesn't fire
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });

  it("agent → in_review, browse text but no image attachment → 422", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "Tested: browser-test headless https://viracue.ai — page loads fine",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });

  it("agent → in_review, browse text + image attachment → 200", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "Tested: browser-test headless https://viracue.ai — page loads, no console errors",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: new Date("2026-03-30T13:01:00Z"),
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(200);
  });

  it("agent → in_review, non-code issue (no workspace) → 200 (exempt)", async () => {
    const issue = { ...nonCodeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(200);
  });

  it("board → in_review, code issue, no evidence → 200 (bypass)", async () => {
    const issue = { ...codeIssue, assigneeAgentId: null };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createBoardApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
  });

  it("activity log records evidence_gate_blocked on rejection", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.evidence_gate_blocked",
        entityType: "issue",
        entityId: issue.id,
        details: expect.objectContaining({
          gate: "in_review_requires_browse_evidence",
          targetStatus: "in_review",
        }),
      }),
    );
  });

  it("agent → in_review, stale evidence (before updatedAt) → 422", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-other", updatedAt: new Date("2026-03-31T10:00:00Z") };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless https://viracue.ai — tested",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T09:00:00Z"), // Before updatedAt
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: new Date("2026-03-30T09:00:00Z"), // Before updatedAt
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });

  it("agent → in_review, evidence from wrong agent → 422", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless https://viracue.ai — tested",
        authorAgentId: "agent-other", // Not the transitioning agent (agent-1)
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "agent-other", // Wrong agent
        createdByUserId: null,
        createdAt: new Date("2026-03-30T13:01:00Z"),
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });
});
```

### Step 2: Run tests to verify they pass

```bash
cd /Users/damondecrescenzo/paperclip && pnpm --filter @paperclipai/server test -- --run server/src/__tests__/browse-evidence-gate.test.ts
```

Expected: All 8 tests pass.

### Step 3: Commit

```bash
git add server/src/__tests__/browse-evidence-gate.test.ts
git commit -m "test(gates): add 8 engineer browse evidence gate tests"
```

---

## Task 6: Tests — QA browse evidence gate

**Files:**
- Modify: `server/src/__tests__/browse-evidence-gate.test.ts` (add second describe block)

### Step 1: Add QA evidence tests to the same file

Append a second `describe` block after the engineer evidence tests:

```typescript
describe("qa browse evidence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request" as const, status: "merged", url: "https://github.com/org/repo/pull/1" },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
  });

  it("agent → done, QA PASS but no browse evidence from QA reviewer → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS — code looks good",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_browse_evidence");
  });

  it("agent → done, QA PASS with browse commands in same comment + screenshot → 200", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS — browser-test headless https://viracue.ai, no console errors, feature works",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "qa-agent-1",
        createdByUserId: null,
        createdAt: new Date("2026-03-30T13:01:00Z"),
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("agent → done, QA PASS + browse evidence in separate QA comment → 200", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "Running browser-test headless https://viracue.ai/live — DOM dump looks correct",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T12:55:00Z"),
      },
      {
        body: "QA: PASS — interactive testing confirms fix works end-to-end",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/jpeg",
        createdByAgentId: "qa-agent-1",
        createdByUserId: null,
        createdAt: new Date("2026-03-30T12:56:00Z"),
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("agent → done, non-code issue, QA PASS without evidence → 200 (exempt)", async () => {
    mockIssueService.getById.mockResolvedValue(nonCodeIssue);
    mockIssueService.update.mockResolvedValue({ ...nonCodeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${nonCodeIssue.id}`)
      .send({ status: "done", comment: "Done" });

    expect(res.status).toBe(200);
  });

  it("activity log records qa_evidence_gate_blocked on rejection", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.qa_evidence_gate_blocked",
        entityType: "issue",
        entityId: codeIssue.id,
        details: expect.objectContaining({
          gate: "done_requires_qa_browse_evidence",
          targetStatus: "done",
        }),
      }),
    );
  });

  it("agent → done, browse evidence from different agent than QA PASS author → 422 (split-actor)", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless https://viracue.ai — tested",
        authorAgentId: "agent-other",  // Different agent from QA PASS author
        authorUserId: null,
        createdAt: new Date("2026-03-30T12:55:00Z"),
      },
      {
        body: "QA: PASS",
        authorAgentId: "qa-agent-1",  // QA PASS author
        authorUserId: null,
        createdAt: new Date("2026-03-30T13:00:00Z"),
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "agent-other",  // Different agent from QA PASS
        createdByUserId: null,
        createdAt: new Date("2026-03-30T12:56:00Z"),
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_browse_evidence");
  });
});
```

### Step 2: Run all tests

```bash
cd /Users/damondecrescenzo/paperclip && pnpm --filter @paperclipai/server test -- --run server/src/__tests__/browse-evidence-gate.test.ts
```

Expected: All 14 tests pass (8 engineer + 6 QA).

### Step 3: Commit

```bash
git add server/src/__tests__/browse-evidence-gate.test.ts
git commit -m "test(gates): add 6 QA browse evidence gate tests including split-actor prevention"
```

---

## Task 7: Update existing QA gate tests

**Files:**
- Modify: `server/src/__tests__/qa-gate.test.ts`

### Step 1: Add `listAttachments` to mock

In the `mockIssueService` hoisted declaration (line 7-15), add:

```typescript
listAttachments: vi.fn(),
```

In the `beforeEach` block (line 138-150), add:

```typescript
mockIssueService.listAttachments.mockResolvedValue([]);
```

### Step 2: Update tests that move code issues to `done` with bare QA PASS

The following tests will fail because the QA browse evidence gate now fires after `assertQAGate` for code issues. Update the QA PASS comments and attachments to include browse evidence:

**Test: "agent → done, QA pass comment with agent author → 200"** (line 165):
Update the mock comment and add attachment:

```typescript
mockIssueService.listComments.mockResolvedValue([
  {
    body: "QA: PASS — browser-test headless https://viracue.ai, no console errors",
    authorAgentId: "qa-agent-1",
    authorUserId: null,
    createdAt: new Date("2026-03-30T13:00:00Z"),
  },
]);
mockIssueService.listAttachments.mockResolvedValue([
  {
    contentType: "image/png",
    createdByAgentId: "qa-agent-1",
    createdByUserId: null,
    createdAt: new Date("2026-03-30T13:01:00Z"),
  },
]);
```

**Test: '"QA: passed" variant → 200'** (line 257):
Same pattern — add browse text to comment body, add image attachment from qa-agent-1.

**Test: '"QA PASS" variant → 200'** (line 272):
Same pattern — add browse text to comment body, add image attachment from user-1 (since QA author is `authorUserId: "user-1"`).

**Test: "assignee self-QA ignored but different agent QA passes → 200"** (line 326):
Add browse evidence for the non-self QA agent (qa-agent-1).

**Test: "board user QA passes even when assignee is agent → 200"** (line 344):
Add browse evidence from the board user (`createdByUserId: "board-user-1"`).

### Step 3: Run QA gate tests

```bash
cd /Users/damondecrescenzo/paperclip && pnpm --filter @paperclipai/server test -- --run server/src/__tests__/qa-gate.test.ts
```

Expected: All 13 existing tests pass.

### Step 4: Commit

```bash
git add server/src/__tests__/qa-gate.test.ts
git commit -m "test(gates): update QA gate tests to include browse evidence for code issue → done transitions"
```

---

## Task 8: Run full test suite

### Step 1: Run all server tests

```bash
cd /Users/damondecrescenzo/paperclip && pnpm --filter @paperclipai/server test -- --run
```

Expected: All tests pass. Watch for any tests that move code issues through status transitions without the new evidence — they'll get 422s.

If other test files fail (e.g. `delivery-gate.test.ts`, `review-handoff-gate.test.ts`), they may also need `listAttachments` mocked. Add `listAttachments: vi.fn()` to their mock service and `mockIssueService.listAttachments.mockResolvedValue([])` in their `beforeEach`. These tests shouldn't hit the evidence gate (wrong status transitions), but the mock may be required for the `svc.listAttachments()` call in the PATCH handler.

### Step 2: Fix any test failures found

### Step 3: Commit any test fixes

```bash
git add -A && git commit -m "fix(tests): add listAttachments mock to existing gate test files"
```

---

## Task 9: Update AGENTS.md

**Files:**
- Modify: `server/src/onboarding-assets/default/AGENTS.md`

### Step 1: Add server-enforced evidence gates section

After the existing "Required browser steps" section (after line 158), add:

```markdown

## Server-Enforced Evidence Gates

The system enforces interactive browser testing evidence for code project issues (issues with an execution workspace). Non-code issues are exempt.

### `in_review` — engineer evidence gate

When moving a code issue to `in_review`, the system requires:

1. **Browse command text** — at least one comment by you containing a recognized browser testing command (e.g. `browser-test headless`, `browse goto`, `dump-dom`, `DOM snapshot`)
2. **Image attachment** — at least one image attachment (screenshot) on the issue uploaded by you

Both must be from the current review cycle (after the issue's last status/assignee change). Stale evidence from previous cycles is not accepted.

If either is missing, the transition returns 422 with gate `in_review_requires_browse_evidence`. Read the error message for specifics on what's missing.

### `done` — QA evidence gate

When moving a code issue to `done`, the system requires (in addition to `QA: PASS`):

1. **Browse command text** — at least one comment by the QA reviewer (the agent who posted `QA: PASS`) containing browser testing commands
2. **Image attachment** — at least one image attachment uploaded by the QA reviewer

The QA reviewer's browse evidence and QA PASS must come from the **same actor**. Evidence from a different agent does not count.

If missing, the transition returns 422 with gate `done_requires_qa_browse_evidence`.

### What counts as browse evidence

| Counts | Does NOT count |
|--------|---------------|
| `browser-test headless <url>` output | HTTP status codes alone |
| `browser-test headed <url>` output | `curl` responses |
| `browse goto`, `browse screenshot` | Grepping source code |
| `dump-dom` / `--dump-dom` output | Reading file contents |
| `DOM dump` / `DOM snapshot` references | Unit test output |
| Screenshot attachment (image/*) | Non-image file attachments |

### Board override

Board users bypass all evidence gates. If the Browser Testing VPS is unreachable or the feature cannot be tested interactively, escalate to the board with a comment explaining the blocker. Do not declare QA: PASS without evidence — escalate instead.
```

### Step 2: Commit

```bash
git add server/src/onboarding-assets/default/AGENTS.md
git commit -m "docs(agents): add server-enforced evidence gates section to AGENTS.md"
```

---

## Task 10: Update CEO HEARTBEAT.md

**Files:**
- Modify: `server/src/onboarding-assets/ceo/HEARTBEAT.md`

### Step 1: Add evidence gate monitoring to Fleet Health Sweep

After the existing fleet health sweep section (after line 47), add to the sweep instructions:

```markdown

### Evidence gate monitoring

Check for agents repeatedly blocked by evidence gates:
- `issue.evidence_gate_blocked` — engineer missing browse evidence for `in_review`
- `issue.qa_evidence_gate_blocked` — QA reviewer missing browse evidence for `done`

If an agent is stuck in a 422 loop from missing evidence, check whether:
1. The Browser Testing VPS is reachable (`ssh -i $BROWSER_TEST_SSH_KEY $BROWSER_TEST_USER@$BROWSER_TEST_HOST 'echo ok'`)
2. The agent has the dogfood skill and knows how to use browser-test commands
3. The issue actually requires browser testing (code issue with workspace) vs. was miscategorized

For legitimate blockers (VPS down, feature not browser-testable), override as board user or reassign.
```

### Step 2: Commit

```bash
git add server/src/onboarding-assets/ceo/HEARTBEAT.md
git commit -m "docs(ceo): add evidence gate monitoring to heartbeat sweep"
```

---

## Task 11: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

### Step 1: Add to the quality gates section

After the existing "Comment-required gate" section, add:

```markdown

### Browse evidence gates (v1 — interim regex control)

Code issues (with `executionWorkspaceId`) require interactive browser testing evidence for status transitions. Non-code issues are exempt.

| Gate | Transition | Requirements | Activity log action |
|------|-----------|-------------|-------------------|
| `in_review_requires_browse_evidence` | → `in_review` | Browse command text in actor's comment + image attachment by actor (both from current review cycle) | `issue.evidence_gate_blocked` |
| `done_requires_qa_browse_evidence` | → `done` | Browse command text + image attachment from the **same actor** who posted `QA: PASS` (current review cycle) | `issue.qa_evidence_gate_blocked` |

**Timing validation:** Evidence must have `createdAt` >= issue's `updatedAt` (resets on status/assignee change). Stale evidence from previous cycles is rejected.

**Same-actor binding:** QA evidence must come from the QA PASS author. Evidence from a different agent does not satisfy the gate.

**Board override:** Board users bypass all evidence gates (standard pattern).

**This is a v1 interim control.** The regex (`BROWSE_EVIDENCE_PATTERN`) detects common browser-test command patterns. It is gameable with canned text and may miss novel workflows. The v2 path is structured evidence tokens from the browser-test CLI.

### Workspace policy enablement

The `enableIsolatedWorkspaces` instance flag must be `true` for delivery + evidence gates to fire. When off, `issues.ts:1099-1103` strips workspace fields from new issues, making `executionWorkspaceId = NULL` on all issues, which causes all workspace-gated checks to silently skip.

Code projects must have `execution_workspace_policy` configured with `enabled: true` for new issues to get workspace IDs.
```

### Step 2: Update the gate ordering table

In the existing "Gate ordering" section, update to:

```
1. Auto-infer @mention
2. Review handoff gate
3. Assignment policy
4. Checkout ownership
5. Transition gate — status state machine
6. Delivery gate — work product requirements
7. **Engineer evidence gate** — browse evidence for `in_review` (code issues)
8. QA gate — QA PASS requirement
9. **QA browse evidence gate** — browse evidence from QA reviewer for `done` (code issues)
10. Comment-required gate
```

### Step 3: Commit

```bash
git add CLAUDE.md
git commit -m "docs: add evidence gates and workspace policy to CLAUDE.md"
```

---

## Task 12: Enable workspace policy on production

**This task is done after code is deployed. Do NOT run these before the code PR is merged.**

### Step 1: Enable the instance flag

```sql
-- Run on production DB
UPDATE instance_settings
SET experimental = jsonb_set(COALESCE(experimental, '{}'), '{enableIsolatedWorkspaces}', 'true')
WHERE id = (SELECT id FROM instance_settings LIMIT 1);
```

### Step 2: Find code project IDs

```sql
SELECT id, name FROM projects
WHERE company_id = 'f6b6dbaa-8d6f-462a-bde7-3d277116b4fb'
ORDER BY name;
```

### Step 3: Configure code projects

For each code project (RTAA, Paperclip, etc.):

```sql
UPDATE projects
SET execution_workspace_policy = jsonb_build_object(
  'enabled', true,
  'defaultMode', 'shared_workspace',
  'allowIssueOverride', false
)
WHERE id IN ('<rtaa-project-id>', '<paperclip-project-id>');
```

### Step 4: Verify

Create a test issue in a code project and check:

```sql
SELECT id, identifier, execution_workspace_id, execution_workspace_settings
FROM issues
WHERE identifier = '<new-issue-identifier>';
```

Expected: `execution_workspace_id` is NOT NULL, `execution_workspace_settings` has `{"mode": "shared_workspace"}`.

### Step 5: Create stakeholder notification issue

Create an issue titled "NOTICE: Delivery + evidence gates now enforced on code project issues" assigned to CEO, explaining:
- Code project issues now require delivery artifacts + browser evidence
- Non-code issues are exempt
- QA PASS requires browse commands + screenshots from the QA reviewer
- Expect 422 rejections in first heartbeat cycles — this is intentional
- Board users can override if browser testing infra is down

---

## Summary: Final gate ordering in PATCH `/issues/:id`

```
1.  assertCompanyAccess()
2.  Auto-infer @mention (enriches assigneeAgentId)
3.  Review handoff gate (in_review without assignee change)
4.  assertCanAssignTasks() + assertAgentAssignmentPolicy()
5.  assertAgentRunCheckoutOwnership()
6.  assertAgentTransition() — forward-only state machine
7.  assertDeliveryGate() — branch/commit/PR for code issues
8.  assertEngineerBrowseEvidence() — NEW: browse text + screenshot for in_review
9.  assertQAGate() — QA PASS from non-assignee (refactored: accepts pre-fetched comments)
10. assertQABrowseEvidence() — NEW: browse evidence from QA PASS author for done
11. assertAgentCommentRequired() — mandatory comment on changes
```

## Key files modified

| File | What changed |
|------|-------------|
| `server/src/routes/issues.ts` | `BROWSE_EVIDENCE_PATTERN`, `actorHasBrowseEvidence()`, `actorHasImageAttachment()`, `assertEngineerBrowseEvidence()`, `assertQABrowseEvidence()`, refactored `assertQAGate()`, PATCH handler wiring |
| `server/src/__tests__/browse-evidence-gate.test.ts` | NEW: 14 tests (8 engineer + 6 QA) |
| `server/src/__tests__/qa-gate.test.ts` | Updated ~5 tests to include browse evidence for code issue → done |
| `server/src/onboarding-assets/default/AGENTS.md` | Server-enforced evidence gates section |
| `server/src/onboarding-assets/ceo/HEARTBEAT.md` | Evidence gate monitoring in fleet sweep |
| `CLAUDE.md` | Evidence gates docs, workspace policy, gate ordering |
