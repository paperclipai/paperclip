# Delivery Review Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the delivery review model so all companies use one canonical execution-policy review flow with issue-scoped reviewer memory and automatic repair of invalid review ownership.

**Architecture:** Extend the existing pooled-QA routing work instead of adding another review system. Persist the selected QA reviewer on the issue as routing memory, route standalone review failures back through the existing execution-policy handback path, and teach heartbeat reconciliation to repair delivery `in_review` rows into canonical review state instead of only swapping assignees.

**Tech Stack:** TypeScript, Express, Drizzle/Postgres, shared contracts in `packages/shared`, Vitest.

---

## Scope

- Persist `qaReviewerAgentId` as issue-scoped reviewer memory.
- Replace standalone QA self-fix loops with execution-policy handback to the implementation owner.
- Repair invalid delivery `in_review` rows into canonical execution-policy review state during heartbeat reconciliation.
- Update tests and docs for the new invariants.

Out of scope for this slice:

- introducing a second workflow template or risk-based delivery mode resolver
- full historical inference for builder ownership when legacy data has already lost it
- broad execution-workspace policy redesign outside delivery review paths

## File Map

- Modify `packages/db/src/schema/issues.ts`
  add nullable `qaReviewerAgentId`
- Modify `packages/shared/src/types/issue.ts`
  expose `qaReviewerAgentId`
- Modify `packages/shared/src/validators/issue.ts`
  validate `qaReviewerAgentId`
- Modify `server/src/services/issue-execution-policy.ts`
  keep execution-policy transitions as the single review engine
- Modify `server/src/routes/issues.ts`
  persist reviewer memory, hand back standalone failing review comments, retire QA self-fix for canonical delivery review
- Modify `server/src/services/qa-reviewer-pool.ts`
  prefer sticky reviewer memory from `qaReviewerAgentId`
- Modify `server/src/services/issue-qa-finalization.ts`
  authorize finalization from issue reviewer memory plus execution state
- Modify `server/src/services/workflow-qa-lane-gate.ts`
  trust the selected reviewer memory when evaluating workflow QA ownership
- Modify `server/src/services/heartbeat.ts`
  repair invalid delivery review rows into canonical execution-policy state
- Modify tests:
  - `server/src/__tests__/issue-qa-gate-routes.test.ts`
  - `server/src/__tests__/issue-execution-policy.test.ts`
  - `server/src/__tests__/issue-qa-finalization.test.ts`
  - `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
  - `server/src/__tests__/issue-workflows.test.ts`
- Modify docs:
  - `doc/PRODUCT.md`
  - `doc/SPEC-implementation.md`

## Task 1: Persist Issue-Scoped Reviewer Memory

**Files:**
- Modify `packages/db/src/schema/issues.ts`
- Modify `packages/shared/src/types/issue.ts`
- Modify `packages/shared/src/validators/issue.ts`
- Modify `server/src/routes/issues.ts`
- Modify `server/src/services/qa-reviewer-pool.ts`
- Test `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] Write a failing route test that entering standalone `in_review` persists `qaReviewerAgentId`.
- [ ] Write a failing workflow test that QA lane promotion keeps or reselects `qaReviewerAgentId`.
- [ ] Add the schema column and generate the migration.
- [ ] Persist `qaReviewerAgentId` when delivery issues enter review and when workflow QA lanes are assigned.
- [ ] Re-run the focused tests.

## Task 2: Replace Standalone QA Self-Fix With Handback

**Files:**
- Modify `server/src/routes/issues.ts`
- Modify `server/src/services/issue-execution-policy.ts`
- Test `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test `server/src/__tests__/issue-execution-policy.test.ts`

- [ ] Write a failing comment-route test where the active QA reviewer leaves a failing review comment and the issue is handed back to the builder.
- [ ] Write a failing test proving the old `[AUTO-FIX ATTEMPT]` wakeup is no longer emitted for canonical standalone delivery review.
- [ ] Implement standalone failing-review handback through `applyIssueExecutionPolicyTransition`.
- [ ] Skip QA self-fix wakeups for canonical delivery review issues.
- [ ] Re-run the focused tests.

## Task 3: Repair Invalid Delivery Review Rows In Heartbeat

**Files:**
- Modify `server/src/services/heartbeat.ts`
- Modify `server/src/services/issue-qa-finalization.ts`
- Modify `server/src/services/workflow-qa-lane-gate.ts`
- Test `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- Test `server/src/__tests__/issue-qa-finalization.test.ts`

- [ ] Write a failing heartbeat test for an engineer-owned delivery `in_review` issue with no execution review state; expect canonical reviewer assignment plus repaired execution state.
- [ ] Write a failing heartbeat test for a QA-owned delivery `in_review` issue with missing reviewer memory; expect either repaired reviewer state or safe demotion when no valid review owner can be reconstructed.
- [ ] Implement heartbeat repair so delivery `in_review` rows are normalized through execution-policy semantics, not only assignee swaps.
- [ ] Use `qaReviewerAgentId` as sticky reviewer memory during repair and finalization.
- [ ] Re-run the focused tests.

## Task 4: Docs And Verification

**Files:**
- Modify `doc/PRODUCT.md`
- Modify `doc/SPEC-implementation.md`

- [ ] Update docs to state that delivery review uses execution-policy state plus issue-scoped reviewer memory.
- [ ] Update docs to state that standalone QA failures hand back to the builder instead of requesting QA self-fix.
- [ ] Run focused verification:
  - `pnpm exec vitest run server/src/__tests__/qa-reviewer-selection.test.ts server/src/__tests__/issue-execution-policy.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-workflows.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- [ ] Run broader verification:
  - `pnpm --filter @paperclipai/server typecheck`
  - `pnpm build`
  - `pnpm test:run`
