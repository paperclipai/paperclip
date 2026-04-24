# Stalled Delivery Recovery Platform Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stalled delivery work impossible to hide from the control loop by unifying review integrity, QA finalization, workflow completion, and specialist-capability handling for all companies.

**Architecture:** Introduce one shared delivery-integrity layer used by routes, heartbeat, QA finalization, and workflow orchestration. Routes must only create canonical delivery-review state; heartbeat must repair drift instead of skipping it; QA finalization must work for both standalone and workflow issues; capability mismatches must be detected at issue-creation time instead of surfacing later as stranded lanes.

**Tech Stack:** TypeScript, Express, Drizzle/Postgres, Vitest.

---

## Why This Plan

Current failures are not one bug. They are four interacting platform defects:

- Execution-policy review issues are filtered out of COO recovery targeting in `server/src/services/heartbeat.ts`, so stalled review work becomes invisible.
- Workflow QA completion is excluded from automatic finalization in `server/src/services/issue-qa-finalization.ts`, so workflow roots and QA lanes can remain open after QA is effectively done.
- Missing issue-comment recovery stops permanently after one retry in `server/src/services/heartbeat.ts`, which turns comment-policy failures into orphaned work.
- Specialist availability is checked too late, so companies can create delivery paths that cannot actually be staffed.

This plan fixes the model, not just the current company data.

## Scope

- One canonical integrity model for delivery `in_review` issues.
- COO and timer reconciliation must see and repair review-stage issues, including execution-policy review rows.
- QA finalization must be shared across standalone and workflow issues.
- Missing comment recovery must degrade into a durable repair state, not a dead end.
- Specialist-capability mismatches must be blocked or downgraded at issue creation time.
- Existing broken rows must be reconciled automatically.
- Board/operator views must surface integrity-blocked and capability-blocked work truthfully.

Out of scope:

- new multi-stage approval products beyond the current execution-policy model
- broad non-delivery issue scheduling redesign
- staffing automation that creates missing agents automatically

## File Map

- Create `server/src/services/delivery-integrity.ts`
  shared evaluator/repair helpers for delivery review state
- Modify `server/src/services/heartbeat.ts`
  stop hiding review issues from recovery; call delivery-integrity repair paths; rework comment-recovery exhaustion behavior
- Modify `server/src/routes/issues.ts`
  enforce canonical review-state creation and shared finalization/handback rules on comments and status transitions
- Modify `server/src/services/issue-execution-policy.ts`
  keep execution-policy state authoritative for review and handback
- Modify `server/src/services/issue-qa-finalization.ts`
  support workflow issues and durable non-terminal recovery outcomes
- Modify `server/src/services/issue-workflows.ts`
  choose only capability-safe workflow paths at issue creation and lane promotion time
- Modify `server/src/services/workflow-qa-lane-gate.ts`
  align workflow QA ownership and completion checks with canonical reviewer state
- Modify `server/src/services/qa-reviewer-pool.ts`
  keep pooled reviewer selection compatible with repair/reassignment flows
- Modify `server/src/services/issue-board-state.ts`
  surface integrity-blocked and capability-blocked states explicitly
- Modify `server/src/services/board-brief.ts`
  keep board counts truthful for root work vs workflow-lane work and expose blocked categories
- Add or modify reconciliation script(s)
  backfill existing broken issues
- Modify tests:
  - `server/src/__tests__/operations-heartbeat-routing.test.ts`
  - `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
  - `server/src/__tests__/heartbeat-process-recovery.test.ts`
  - `server/src/__tests__/issue-qa-finalization.test.ts`
  - `server/src/__tests__/issue-qa-gate-routes.test.ts`
  - `server/src/__tests__/issue-workflows.test.ts`
  - `server/src/__tests__/board-brief-service.test.ts`
- Modify docs:
  - `doc/PRODUCT.md`
  - `doc/SPEC-implementation.md`
  - `doc/plans/2026-04-21-multi-threaded-qa-routing.md` if implementation changes its assumptions

## Task 1: Centralize Delivery Integrity Rules

**Files:**
- Create `server/src/services/delivery-integrity.ts`
- Modify `server/src/services/issue-execution-policy.ts`
- Test `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test `server/src/__tests__/heartbeat-process-recovery.test.ts`

- [ ] Write failing tests for each invalid delivery state:
  - engineer-owned `in_review` with no execution state
  - QA-owned `in_review` with dead/ineligible reviewer
  - workflow QA lane with reviewer memory but missing canonical execution state
  - `retry_exhausted` review issue with no pending wake
- [ ] Implement a shared `classifyDeliveryIntegrity` helper that returns one of:
  - `canonical`
  - `repair_review_state`
  - `handback_required`
  - `finalization_ready`
  - `capability_blocked`
  - `operator_recovery_required`
- [ ] Implement a shared `repairDeliveryIntegrity` helper that can:
  - rebuild canonical execution-policy review state
  - reassign to an eligible pooled reviewer
  - hand back to the stored `returnAssignee`
  - demote out of `in_review` when no valid reviewer can exist
- [ ] Re-run focused tests and keep the helper free of route/heartbeat-specific behavior.

## Task 2: Make COO Recovery See Review Work Again

**Files:**
- Modify `server/src/services/heartbeat.ts`
- Test `server/src/__tests__/operations-heartbeat-routing.test.ts`
- Test `server/src/__tests__/heartbeat-process-recovery.test.ts`
- Test `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`

- [x] Write a failing operations-heartbeat test showing canonical execution-policy review issues remain eligible for repair/recovery targeting instead of being filtered out.
- [ ] Write a failing test showing `retry_exhausted` comment-policy runs create a recoverable integrity target on the issue instead of disappearing from the queue.
- [x] Replace the blind `!isExecutionPolicyReviewIssue(issue)` exclusion with integrity-aware targeting:
  - canonical healthy review issues can still be suppressed
  - invalid or stranded review issues must stay visible to COO
- [ ] Change missing issue-comment exhaustion so it produces a durable recovery signal that the COO can act on in later sweeps.
- [ ] Ensure dead-owner review issues trigger repair before unrelated contradictory-truth targets monopolize the sweep.
- [ ] Re-run focused heartbeat suites.

## Task 3: Unify QA Finalization For Standalone And Workflow Issues

**Files:**
- Modify `server/src/services/issue-qa-finalization.ts`
- Modify `server/src/routes/issues.ts`
- Modify `server/src/services/workflow-qa-lane-gate.ts`
- Test `server/src/__tests__/issue-qa-finalization.test.ts`
- Test `server/src/__tests__/issue-workflows.test.ts`
- Test `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [x] Write failing tests for:
  - standalone issue with valid QA verdict auto-closing correctly
  - workflow QA lane with valid QA verdict completing correctly
  - workflow root promotion/finalization after all required lanes complete
  - failing QA verdict handing back to engineering/lane predecessor instead of looping in QA
- [x] Remove the current workflow early-return from QA finalization for QA lanes.
- [x] Split finalization into shared primitives:
  - choose authoritative reviewer
  - compute QA gate from reviewer comments
  - finalize lane/root/standalone depending on issue kind
- [x] Make workflow QA completion update root/lane state through the same canonical completion path rather than comment-only side effects.
- [ ] Re-run focused QA and workflow suites.

## Task 4: Enforce Capability-Safe Delivery Paths

**Files:**
- Modify `server/src/services/issue-workflows.ts`
- Modify `server/src/routes/issues.ts`
- Modify `server/src/services/issue-board-state.ts`
- Modify `server/src/services/board-brief.ts`
- Test `server/src/__tests__/issue-workflows.test.ts`
- Test `server/src/__tests__/board-brief-service.test.ts`

- [ ] Write failing tests for company/project delivery modes that require security when no security specialist exists.
- [ ] Decide and encode the policy:
  - if the chosen workflow requires a missing specialist, block creation with a clear capability error
  - if a lower-capability delivery path is valid for that issue type, choose it explicitly at creation time
- [ ] Ensure unstaffable lanes surface as `capability_blocked` board state, not silent `todo` drift.
- [ ] Update board brief/counting so operators can distinguish:
  - root delivery backlog
  - workflow lane backlog
  - integrity-blocked work
  - capability-blocked work
- [ ] Re-run focused workflow and board suites.

## Task 5: Backfill And Continuous Reconciliation

**Files:**
- Create or modify reconciliation script under `server/scripts/`
- Modify `server/src/services/heartbeat.ts`
- Test `server/src/__tests__/heartbeat-process-recovery.test.ts`

- [ ] Write a failing reconciliation test fixture that mirrors the live broken patterns:
  - dead QA assignee
  - engineer-owned `in_review`
  - workflow QA lane with `retry_exhausted`
  - unstaffable security lane
- [ ] Add a reconciliation entrypoint that applies `repairDeliveryIntegrity` across existing open issues.
- [ ] Ensure timer-driven COO/heartbeat runs keep applying the same repair logic continuously after backfill.
- [ ] Re-run focused reconciliation and heartbeat suites.

## Task 6: Documentation And Full Verification

**Files:**
- Modify `doc/PRODUCT.md`
- Modify `doc/SPEC-implementation.md`
- Modify `doc/plans/2026-04-21-multi-threaded-qa-routing.md` if needed

- [ ] Update docs to state that delivery review issues are always canonical execution-policy issues with automatic repair.
- [ ] Update docs to state that workflow QA uses the same finalization contract as standalone QA.
- [ ] Update docs to state that impossible specialist paths are blocked or downgraded at creation time.
- [ ] Run focused verification:
  - `pnpm exec vitest run server/src/__tests__/operations-heartbeat-routing.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/__tests__/heartbeat-process-recovery.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts server/src/__tests__/board-brief-service.test.ts`
- [ ] Run full verification:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Execution Order

Implement in this order:

1. delivery-integrity classifier and repair helpers
2. COO visibility and retry-exhaustion repair
3. shared QA finalization for standalone and workflow
4. capability-safe workflow selection and board visibility
5. reconciliation/backfill
6. docs and full verification

This ordering matters. It fixes the control-plane blind spots first, then the completion path, then company-safe creation rules, then existing bad data.
