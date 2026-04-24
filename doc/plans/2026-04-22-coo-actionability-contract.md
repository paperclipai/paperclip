# COO Actionability Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for any company to have open actionable work while COO reports `wakeupCount=0` and selects no target.

**Architecture:** Replace the current mix of routing heuristics, repair branches, and recovery suppression rules with one canonical issue-actionability engine. Every open issue must resolve to exactly one control-loop state before COO routing: `needs_repair`, `needs_assignment`, `ready_owned`, or an explicit blocked state with a concrete reason. COO, board summaries, reconciliation, and diagnostics must all consume that same engine.

**Tech Stack:** TypeScript, Drizzle ORM, Express services/routes, Vitest, embedded PostgreSQL integration tests.

---

## Why We Failed Again

- We fixed parts of runtime drift and review repair, but we did **not** establish one platform-wide contract for “is this issue actionable right now?”
- Existing company rows were still legacy-shaped: `workIntent=null`, invalid `in_review` state, dead owners, and QA-owned rows with no canonical review state.
- COO still uses multiple overlapping filters and rankers. A ticket can be normalized by one path and still be invisible to another path.
- The control loop has almost no per-issue explainability. We can see aggregate counts like `assignedOpenCount=6` and `wakeupCount=0`, but not the exact reason each issue was skipped.
- That is how the system reached the current state: open queue, zero active runs, repeated successful COO timer sweeps, and `targetIssueId=null`.

## Non-Negotiable End State

- Every open issue is always in exactly one derived control state:
  - `needs_repair`
  - `needs_assignment`
  - `ready_owned`
  - `blocked_dependency`
  - `blocked_capability`
  - `blocked_cooldown`
  - `blocked_policy`
  - `waiting_external`
- COO must never complete a sweep with open issues, zero active runs, zero queued wakeups, and zero actionable issues **unless every open issue is explicitly blocked with a visible reason**.
- Delivery review must never exist without canonical execution-policy review state.
- Non-delivery work must never remain in `in_review`.
- Dead owners and run/owner mismatches must be repaired before routing.

## File Map

- Create: `server/src/services/issue-actionability.ts`
  - Canonical per-issue classification and explanation engine.
- Create: `server/src/__tests__/issue-actionability.test.ts`
  - Unit coverage for all control states and edge cases.
- Create: `server/scripts/explain-company-actionability.ts`
  - Dry-run company report showing why each open issue is or is not actionable.
- Modify: `server/src/services/heartbeat.ts`
  - Call the actionability engine before any target selection or wake suppression.
- Modify: `server/src/services/delivery-integrity.ts`
  - Narrow responsibility to normalization/repair primitives used by actionability.
- Modify: `server/src/services/issues.ts`
  - Backfill and persist `workIntent` consistently on create/update.
- Modify: `server/src/services/qa-gate.ts`
  - Consume canonical `workIntent` and canonical review state only through the shared engine or shared predicates.
- Modify: `server/src/services/issue-qa-finalization.ts`
  - Use the shared actionability/review predicates so finalization cannot diverge from routing.
- Modify: `server/src/routes/issues.ts`
  - Use shared actionability/review classification in comment routing and review transitions.
- Modify: `server/src/services/board-brief.ts`
  - Surface blocked/actionable counts from the shared engine instead of ad hoc inference.
- Modify: `packages/db/src/schema/issues.ts`
  - Only if a minimal extra persisted field is required after implementation review. Prefer derived state over more columns.
- Modify: `server/src/__tests__/operations-heartbeat-routing.test.ts`
  - Regression for “open queue, no target” and per-state routing precedence.
- Modify: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
  - DB-backed regressions for idle QA-owned review, invalid review repair, and capability-blocked queues.
- Modify: `server/src/__tests__/board-brief-service.test.ts`
  - Board visibility for explicit blocked states.
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`

## Task 1: Freeze The Failure As Tests

**Files:**
- Create: `server/src/__tests__/issue-actionability.test.ts`
- Modify: `server/src/__tests__/operations-heartbeat-routing.test.ts`
- Modify: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`

- [ ] **Step 1: Add a pure unit fixture for the exact current failure**

Cover these live shapes as explicit fixtures:
- `COMA-1242`: dead QA owner, invalid standalone `in_review`
- `COMA-1260`: non-delivery audit/ticket-authoring issue stranded in `in_review`
- `COMA-1250` / `COMA-1251` / `COMA-1290` / `COMA-1310`: QA-owned standalone review rows with no live run
- `COMA-1262` / `COMA-1322`: workflow root / QA lane states
- `COMA-1321`: security lane with no security specialist

Expected:
- at least one issue resolves to `needs_repair`, `needs_assignment`, or `ready_owned`
- dead-owner and invalid-review rows do **not** resolve to silent “skip”
- security-only unowned work resolves to `blocked_capability`

- [ ] **Step 2: Add a heartbeat regression for the queue-wide invariant**

Scenario:
- company has open issues
- no active runs
- no queued wakeups
- owner has free slot

Expected:
- COO must either enqueue at least one wakeup or emit explicit all-blocked reasons
- `targetIssueId=null` is only legal if every open issue is classified into explicit blocked states

- [ ] **Step 3: Run focused tests and confirm red**

Run:
- `pnpm exec vitest run server/src/__tests__/issue-actionability.test.ts`
- `pnpm exec vitest run server/src/__tests__/operations-heartbeat-routing.test.ts --testNamePattern "open queue|no target|actionability"`

Expected:
- current code fails on at least one “queue idle but no target” case

## Task 2: Build One Canonical Actionability Engine

**Files:**
- Create: `server/src/services/issue-actionability.ts`
- Create: `server/src/__tests__/issue-actionability.test.ts`
- Modify: `server/src/services/delivery-integrity.ts`

- [ ] **Step 1: Define the actionability result shape**

Implement a discriminated union like:

```ts
type IssueActionability =
  | { kind: "needs_repair"; reason: string; repair: "normalize_non_delivery_review" | "repair_delivery_review" | "clear_dead_owner" | "cancel_run_owner_mismatch" }
  | { kind: "needs_assignment"; reason: string; candidateRole?: string | null }
  | { kind: "ready_owned"; reason: string; assigneeAgentId: string }
  | { kind: "blocked_dependency"; reason: string }
  | { kind: "blocked_capability"; reason: string; missingRole: "security" | "qa" | "engineer" }
  | { kind: "blocked_cooldown"; reason: string; until?: Date | null }
  | { kind: "blocked_policy"; reason: string }
  | { kind: "waiting_external"; reason: string };
```

- [ ] **Step 2: Make this engine the only place that decides**

Inputs must include:
- persisted issue fields
- derived review state
- current assignee/run state
- specialist availability
- queued/running wakeups
- recent successful run timestamps
- structured truth summary

- [ ] **Step 3: Move existing scattered logic behind the engine**

Remove or delegate these classes of ad hoc checks:
- delivery vs non-delivery review eligibility
- review repair detection
- run-owner mismatch detection
- capability-blocked security lane detection
- idle-owned wake eligibility
- cooldown suppression

- [ ] **Step 4: Run focused tests and confirm green**

Run:
- `pnpm exec vitest run server/src/__tests__/issue-actionability.test.ts`

Expected:
- all actionability cases pass with explicit reasons

## Task 3: Reconcile Before Routing, Every Time

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/delivery-integrity.ts`
- Modify: `server/src/services/issues.ts`

- [ ] **Step 1: Add a pre-routing reconciliation pass**

Before COO selects a target:
- classify every open issue
- apply all safe same-issue repairs first:
  - normalize non-delivery `in_review`
  - reconstruct canonical delivery review state
  - clear dead owners
  - cancel run/owner mismatch
  - recompute/persist missing `workIntent`

- [ ] **Step 2: Make reconciliation exhaustive, not opportunistic**

Do not rely on “if we happen to touch this issue in this branch.”
The sweep must inspect **every** open issue and return a complete per-issue classification snapshot.

- [ ] **Step 3: Add the queue-level invariant**

After reconciliation:
- if actionable issues exist, COO must select one
- if none exist, COO must log/export every blocking reason bucket

- [ ] **Step 4: Run focused heartbeat tests**

Run:
- `pnpm exec vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts --testNamePattern "idle queue|invalid review|run owner mismatch|capability blocked"`

Expected:
- invalid legacy rows are repaired or explicitly blocked before routing

## Task 4: Replace Silent Scheduling With Deterministic Routing

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/operations-heartbeat-routing.test.ts`

- [ ] **Step 1: Implement strict routing precedence**

COO sweep order:
1. `needs_repair`
2. `needs_assignment`
3. `ready_owned`
4. explicit blocked buckets only

- [ ] **Step 2: Tighten cooldown semantics**

Cooldown may suppress a specific issue only when one of these is true:
- same issue already has queued/running work
- same issue just completed and there is explicit evidence we are waiting for external output

Cooldown must **not** suppress all owned review work when:
- active runs are zero
- queued wakeups are zero
- owner has free slot

- [ ] **Step 3: Add the “no silent null target” assertion**

If COO produces:
- `targetIssueId=null`
- `wakeupCount=0`
- open issues exist

then its context snapshot must also include non-empty blocked counts by reason.

- [ ] **Step 4: Run focused routing tests**

Run:
- `pnpm exec vitest run server/src/__tests__/operations-heartbeat-routing.test.ts`

Expected:
- queue idle + open work always yields either a wakeup or explicit blocked-state accounting

## Task 5: Backfill Existing Companies Safely

**Files:**
- Create: `server/scripts/explain-company-actionability.ts`
- Create: `server/scripts/reconcile-company-actionability.ts`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/PRODUCT.md`

- [ ] **Step 1: Add a dry-run explain script**

Output per company:
- open issue count
- counts by actionability kind
- per-issue reason, owner, workIntent, repair action

- [ ] **Step 2: Add an apply-mode reconciliation script**

Apply-mode must:
- backfill `workIntent`
- normalize invalid `in_review`
- clear dead owners
- repair canonical review state
- mark capability-blocked issues explicitly in the derived report

- [ ] **Step 3: Run dry-run and apply across all companies**

Run:
- `pnpm --filter @paperclipai/server exec tsx server/scripts/explain-company-actionability.ts --json`
- `pnpm --filter @paperclipai/server exec tsx server/scripts/reconcile-company-actionability.ts --apply --json`

Expected:
- no open issue remains both unblocked and invisible

## Task 6: Make Blocked State Visible To Operators

**Files:**
- Modify: `server/src/services/board-brief.ts`
- Modify: `server/src/__tests__/board-brief-service.test.ts`
- Modify: `doc/PRODUCT.md`

- [ ] **Step 1: Surface counts by reason**

Board brief must show:
- actionable owned work
- actionable unassigned work
- needs repair
- capability blocked
- dependency blocked
- cooldown blocked

- [ ] **Step 2: Surface the issue-level reason**

For each blocked issue, show the primary reason:
- dead owner
- missing security specialist
- invalid review state
- waiting on dependency
- cooldown

- [ ] **Step 3: Run focused board tests**

Run:
- `pnpm exec vitest run server/src/__tests__/board-brief-service.test.ts`

Expected:
- operators can distinguish “queue is blocked” from “scheduler is broken”

## Task 7: Final Verification And Rollout Gate

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `doc/SPEC-implementation.md`

- [ ] **Step 1: Add a control-loop invariant check**

At the end of COO sweep, emit a structured warning/error when:
- open issues > 0
- active runs = 0
- queued wakeups = 0
- actionable count > 0

This should be treated as a platform bug, not normal state.

- [ ] **Step 2: Run full verification**

Run:
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

Expected:
- green, or only known unrelated retry-only flakes explicitly documented

- [ ] **Step 3: Validate against the original failure after deploy**

Success criteria:
- `COMA-1242` is repaired or explicitly blocked
- `COMA-1260` is normalized out of invalid review
- `COMA-1321` is explicitly capability-blocked
- at least one of the QA-owned review issues is either active, queued, or explicitly blocked with a visible reason
- COO no longer emits repeated `targetIssueId=null` sweeps without blocked-state accounting

## Rollout Notes

- Do **not** ship only the new actionability engine without the reconciliation script.
- Do **not** ship only the reconciliation script without the canonical engine.
- Do **not** declare success based on “COO woke one or two tickets.” The pass condition is queue-wide: no silent actionable backlog.

## Definition Of Done

- No open issue can remain in silent limbo.
- COO either wakes work or explains, in machine-readable terms, why every open issue is blocked.
- Existing company data is reconciled, not left waiting for future edits to backfill intent.
- The exact current Comandero state becomes a permanent regression test.
