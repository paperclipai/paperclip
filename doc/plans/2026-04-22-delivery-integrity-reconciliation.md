# Delivery Integrity Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make invalid delivery/review states impossible to accumulate by persisting issue intent, reconciling broken open issues before COO routing, and surfacing capability-blocked/integrity-blocked work truthfully for all companies.

**Architecture:** Add a durable issue-intent field that distinguishes delivery work from ticket-authoring/audit work, then introduce a delivery-integrity service that classifies and repairs open issues before operations routing. Reuse the existing execution-policy review engine for valid delivery work, normalize non-delivery review drift back to actionable todo state, and make board/heartbeat surfaces reflect capability and integrity blockers explicitly.

**Tech Stack:** TypeScript, Drizzle, Express services/routes, Vitest, shared Zod validators.

---

### Task 1: Add Durable Issue Intent

**Files:**
- Modify: `/Users/seb/paperclip/packages/db/src/schema/issues.ts`
- Modify: `/Users/seb/paperclip/packages/shared/src/constants.ts`
- Modify: `/Users/seb/paperclip/packages/shared/src/types/issue.ts`
- Modify: `/Users/seb/paperclip/packages/shared/src/validators/issue.ts`
- Modify: `/Users/seb/paperclip/server/src/services/issue-routing-heuristics.ts`
- Test: `/Users/seb/paperclip/server/src/__tests__/qa-gate.test.ts`

- [ ] Write the failing tests that prove ticket-authoring/audit issues resolve to non-delivery intent while real engineering issues resolve to delivery intent.
- [ ] Run the targeted tests and verify they fail for the missing intent field / resolver behavior.
- [ ] Add `issueWorkIntent` shared constants/types plus the nullable `issues.work_intent` column.
- [ ] Implement intent resolution helpers that prefer persisted `workIntent` and fall back to text heuristics for legacy rows.
- [ ] Update validators and issue DTO typing to carry the new field.
- [ ] Re-run the targeted tests until they pass.

### Task 2: Reconcile Broken Open Review Rows

**Files:**
- Create: `/Users/seb/paperclip/server/src/services/delivery-integrity.ts`
- Modify: `/Users/seb/paperclip/server/src/services/heartbeat.ts`
- Modify: `/Users/seb/paperclip/server/src/services/issues.ts`
- Test: `/Users/seb/paperclip/server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- Test: `/Users/seb/paperclip/server/src/__tests__/operations-heartbeat-routing.test.ts`

- [ ] Write failing tests for:
  - non-delivery issues stuck in `in_review` with no execution review state
  - `in_review` issues owned by errored/terminated reviewers
  - issue/run ownership mismatches on active runs
  - security-required workflow lanes with no eligible security specialist
- [ ] Run those tests and capture the expected failures before implementation.
- [ ] Implement delivery-integrity classification with outcomes like `canonical`, `repair_delivery_review`, `normalize_non_delivery_review`, `clear_dead_owner`, `capability_blocked`, and `run_owner_mismatch`.
- [ ] Add reconciliation helpers that normalize invalid non-delivery review rows to `todo`, preserve healthy builders when possible, and clear dead owners when not.
- [ ] Add logic that treats missing-specialist workflow lanes as capability-blocked instead of normal assignable backlog.
- [ ] Add run/owner reconciliation so active runs cannot remain authoritative when they disagree with the issue’s canonical owner/state.
- [ ] Re-run the new tests until they pass.

### Task 3: Enforce Intent And Review Invariants At Route Time

**Files:**
- Modify: `/Users/seb/paperclip/server/src/routes/issues.ts`
- Modify: `/Users/seb/paperclip/server/src/services/qa-gate.ts`
- Test: `/Users/seb/paperclip/server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] Write failing route tests covering:
  - non-delivery issues cannot newly enter delivery-style review state
  - drifted non-delivery review rows do not auto-route to QA after completion comments
  - canonical delivery review rows still behave exactly as before
- [ ] Run the route tests and verify the red phase.
- [ ] Persist resolved `workIntent` on issue creation/update where the server has enough context.
- [ ] Enforce that only delivery-intent issues use the execution-policy QA review path.
- [ ] Keep standalone delivery review transitions and workflow QA lanes on the canonical execution-policy model.
- [ ] Re-run the route tests until they pass.

### Task 4: Surface Integrity And Capability Truthfully

**Files:**
- Modify: `/Users/seb/paperclip/server/src/services/issue-board-state.ts`
- Modify: `/Users/seb/paperclip/packages/shared/src/constants.ts`
- Modify: `/Users/seb/paperclip/packages/shared/src/types/issue.ts`
- Modify: `/Users/seb/paperclip/ui/src/lib/issue-board-state-presentation.ts`
- Test: `/Users/seb/paperclip/server/src/__tests__/issue-board-state-routes.test.ts`
- Test: `/Users/seb/paperclip/ui/src/components/IssueBoardStatePanel.test.tsx`

- [ ] Write failing tests for board-state presentation of capability-blocked and integrity-blocked issues.
- [ ] Add shared board-state reason codes and server-side board-state derivation for those cases.
- [ ] Update UI copy so blocked-by-capability and invalid-state issues are distinguishable from ordinary review wait states.
- [ ] Re-run the board-state server/UI tests until they pass.

### Task 5: Migration, Verification, And Docs

**Files:**
- Create: `/Users/seb/paperclip/packages/db/src/migrations/0068_<generated>.sql`
- Modify: `/Users/seb/paperclip/doc/SPEC-implementation.md`
- Modify: `/Users/seb/paperclip/doc/PRODUCT.md`
- Modify: `/Users/seb/paperclip/doc/plans/2026-04-22-delivery-integrity-reconciliation.md`

- [ ] Generate the DB migration after schema changes.
- [ ] Run targeted verification:
  - `pnpm exec vitest run /Users/seb/paperclip/server/src/__tests__/qa-gate.test.ts /Users/seb/paperclip/server/src/__tests__/issue-qa-gate-routes.test.ts /Users/seb/paperclip/server/src/__tests__/heartbeat-comment-wake-batching.test.ts /Users/seb/paperclip/server/src/__tests__/heartbeat-operations-recovery-logic.test.ts`
  - `pnpm exec vitest run /Users/seb/paperclip/server/src/__tests__/operations-heartbeat-routing.test.ts`
  - `pnpm --filter @paperclipai/server typecheck`
  - `pnpm --filter @paperclipai/server build`
- [ ] If the embedded-Postgres suite is skipped on this host, document that explicitly rather than claiming full repo coverage.
- [ ] Update product/spec docs to describe durable issue intent, delivery-integrity reconciliation, and capability-blocked board behavior.
