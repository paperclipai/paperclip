# COO Flow Allocation Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make COO orchestration maximize valid work allocation while preserving specialist handoff contracts for PM, CTO, engineering, security, and QA.

**Architecture:** Treat COO as a flow allocator with a hard postcondition: every open ready issue is either assigned/woken to eligible capacity, waiting for occupied capacity, blocked by a real dependency, capability-blocked with a visible missing role, or escalated as an invariant breach. Move workflow completion and typed QA ownership checks into shared guardrails so status movement, comments, typed actions, heartbeat, and AGENTS.md role instructions all describe the same contract.

**Tech Stack:** Express services in `server/src/services`, route integration in `server/src/routes/issues.ts`, shared contracts in `packages/shared`, Drizzle schema already present in `packages/db`, React presentation in `ui/src/components`, role instruction bundles in `server/src/onboarding-assets`.

---

## Core Design Decisions

1. **COO allocation invariant**
   - If there is ready work and an eligible agent has a free execution slot, the COO heartbeat must assign and wake until either ready work or free eligible slots are exhausted.
   - A ticket is allowed to remain idle only when it has a concrete reason: active dependency, missing specialist, no eligible capacity, active cooldown, explicit human ownership, recovery pause, or terminal/cancelled state.
   - Residual idle ready work after a sweep is a broken control-plane state, not normal operation.

2. **No false ownership**
   - A workflow lane may not be assigned to a role that cannot complete its gate.
   - QA lanes require QA. Security lanes require security. CTO lanes, once introduced, require CTO.
   - If the right role is missing, the lane must be capability-blocked and visible to the board instead of routed to a generic worker.

3. **Typed actions are the primary workflow API**
   - Role AGENTS already instruct agents to prefer typed actions over raw comments/status patches.
   - Server-side typed actions must therefore work for the actual lane owner, not only for a company-level fallback.

4. **Handoff artifacts are contract truth**
   - PM: `plan`
   - Designer: `design`
   - CTO, planned v2: `technical-plan` or `architecture-review`
   - Engineer: `implementation-summary` or implementation work product
   - Security: `threat-review`
   - QA: non-stale `qa-verdict` plus non-stale authorized QA verdict comment markers

5. **CTO is a first-class long-term architecture role**
   - The current role system has `cto`, but `engineering_delivery_v1` has no CTO lane.
   - Add CTO as a versioned workflow template, not a breaking mutation of existing v1 workflows.
   - Recommended lane graph for v2: `PM -> Design -> CTO -> Build -> Security + QA`.

---

## File Map

### Server Services
- Modify: `server/src/services/issue-actions.ts`
  - Authorize workflow QA typed verdicts by active lane owner.
- Modify: `server/src/services/issue-routing-heuristics.ts`
  - Make workflow lane role routing strict when the lane role is governed.
- Modify: `server/src/services/issue-capability-blocks.ts`
  - Generalize specialist requirements beyond security.
- Modify: `server/src/services/workflow-qa-lane-gate.ts`
  - Require QA comment evidence to be fresh after `workflowInvalidatedAt`.
- Modify: `server/src/services/issues.ts`
  - Service-boundary completion guard that rejects generic guarded `done` transitions unless a domain path has already checked workflow artifacts, QA evidence, or an explicit board override.
- Modify: `server/src/services/heartbeat.ts`
  - Enforce post-sweep allocation invariant and never assign governed lanes to incapable roles.
- Modify: `server/src/services/issue-board-state.ts`
  - Surface missing-role and residual-idle reasons.
- Modify: `server/src/services/issue-workflows.ts`
  - Phase 1: align artifact logic.
  - Phase 2: add optional `engineering_delivery_v2` CTO lane.

### Shared Contracts
- Modify: `packages/shared/src/constants.ts`
  - Phase 2: add `engineering_delivery_v2` and `cto` workflow lane role.
- Modify: `packages/shared/src/types/issue.ts`
  - Extend lane role/status summaries if needed for CTO and allocation reason metadata.
- Modify: `packages/shared/src/validators/issue-action.ts`
  - Add/adjust typed action validation only if new guard inputs are needed.

### Routes and UI
- Modify: `server/src/routes/issues.ts`
  - Replace duplicated completion checks with `issue-transition-guard`.
- Modify: `ui/src/components/IssueWorkflowPanel.tsx`
  - Display CTO lane and missing-role allocation states.
- Modify: `ui/src/components/IssueBoardStatePanel.tsx`
  - Explain capability blocks and residual allocation failures clearly.
- Modify: `ui/src/lib/issue-board-state-presentation.ts`
  - Add precise copy for `missing_qa`, `missing_security`, `missing_cto`, and `ready_capacity_leak`.

### Agent Instructions and Docs
- Modify: `server/src/onboarding-assets/engineer/AGENTS.md`
  - Require `implementation-summary` document/work product before marking build lane complete.
- Modify: `server/src/onboarding-assets/coo/AGENTS.md`
  - Replace one-ticket stop rule with bounded batch allocation rule.
- Modify: `server/src/onboarding-assets/qa/AGENTS.md`
  - Keep typed QA action language, but clarify lane-owner authorization.
- Modify: `server/src/onboarding-assets/default/AGENTS.md`
  - Align generic workflow wording with typed actions and artifacts.
- Modify: `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`
  - Document allocation invariant, capability-block semantics, and CTO v2 workflow.

### Tests
- Modify/add tests in:
  - `server/src/services/issue-actions.test.ts`
  - `server/src/__tests__/issue-workflows.test.ts`
  - `server/src/__tests__/issue-qa-gate-routes.test.ts`
  - `server/src/__tests__/issue-board-state-service.test.ts`
  - `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
  - `server/src/__tests__/default-agent-instructions.test.ts`
  - `ui/src/components/IssueWorkflowPanel.test.tsx`
  - `ui/src/components/IssueBoardStatePanel.test.tsx`

---

## Task 1: Lock the COO Flow Contract in Tests

**Files:**
- Modify: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- Modify: `server/src/__tests__/issue-board-state-service.test.ts`

- [ ] Add a test where three ready unassigned issues and three free eligible agents exist.
- [ ] Run the heartbeat once.
- [ ] Assert all three issues are assigned.
- [ ] Assert all three agents receive wakeups.
- [ ] Assert the sweep reports zero residual `actionable_unassigned`.
- [ ] Add a test where ready work exists but no eligible role exists.
- [ ] Assert the ticket remains unassigned and board state is `capability_blocked`.
- [ ] Assert the ticket is not assigned to a generic fallback worker.

Run:

```sh
pnpm --filter @paperclipai/server test -- heartbeat-comment-wake-batching issue-board-state-service
```

Expected before implementation: at least one new test fails because QA-like or governed work can still fall back to non-specialists and allocation residuals are only logged.

---

## Task 2: Generalize Specialist Capability Blocks

**Files:**
- Modify: `server/src/services/issue-capability-blocks.ts`
- Modify: `server/src/services/issue-board-state.ts`
- Modify: `server/src/services/heartbeat.ts`
- Test: `server/src/__tests__/issue-board-state-service.test.ts`

- [ ] Replace `EligibleSpecialistRoleIds = { security: string[] }` with a role-indexed capability map for governed roles.
- [ ] Include at least `security`, `qa`, and future-compatible `cto`.
- [ ] Make `resolveSpecialistLaneRequirement()` return a requirement for governed workflow lanes.
- [ ] Keep security auto-provision behavior.
- [ ] For QA and CTO, do not silently auto-provision unless an existing provisioning path supports it; produce a visible capability block.
- [ ] Update heartbeat to pass all eligible governed-role IDs into capability checks.
- [ ] Update board state copy so missing QA says "No healthy QA reviewer available", missing CTO says "No CTO available", and missing security keeps the current security wording.

Run:

```sh
pnpm --filter @paperclipai/server test -- issue-board-state-service
```

Expected: capability-block tests pass for security and new QA/CTO cases.

---

## Task 3: Make Governed Lane Assignment Strict

**Files:**
- Modify: `server/src/services/issue-routing-heuristics.ts`
- Modify: `server/src/services/heartbeat.ts`
- Test: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`

- [ ] Add a helper that detects strict governed lanes from `workflowLaneRole`.
- [ ] For `workflowLaneRole === "qa"`, return only QA candidates, even when the candidate list is empty.
- [ ] For `workflowLaneRole === "security"`, return only security candidates.
- [ ] For future `workflowLaneRole === "cto"`, return only CTO candidates.
- [ ] Keep text-signal fallback behavior for ordinary non-workflow issues.
- [ ] Ensure heartbeat treats "no strict candidate" as capability-blocked, not assignable.

Run:

```sh
pnpm --filter @paperclipai/server test -- heartbeat-comment-wake-batching
```

Expected: QA workflow lanes are never assigned to engineer/general candidates.

---

## Task 4: Authorize Typed QA Verdicts by Workflow Lane Owner

**Files:**
- Modify: `server/src/services/issue-actions.ts`
- Test: `server/src/services/issue-actions.test.ts`

- [ ] Add a workflow QA lane test where company release-gate QA is `qa-agent-1`, pooled lane owner is `qa-agent-2`, and `qa-agent-2` calls `submit_qa_verdict`.
- [ ] Assert `qa-agent-2` succeeds.
- [ ] Assert `qa-agent-1` cannot submit for that lane unless it is also the lane owner.
- [ ] Keep standalone delivery issue behavior using release-gate QA.
- [ ] Implement an authorization branch:
  - If `issue.workflowLaneRole === "qa"`, require actor agent to match `issue.assigneeAgentId ?? issue.qaReviewerAgentId`.
  - Require that the authorized agent role is `qa`.
  - Otherwise use existing release-gate resolution for standalone delivery issues.

Run:

```sh
pnpm --filter @paperclipai/server test -- issue-actions
```

Expected: workflow QA lanes follow lane ownership; standalone issues continue to follow release-gate ownership.

---

## Task 5: Make QA Verdict Comment Evidence Fresh

**Files:**
- Modify: `server/src/services/workflow-qa-lane-gate.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] Add a test with:
  - old authorized QA pass comment
  - newer `workflowInvalidatedAt`
  - refreshed `qa-verdict` document
- [ ] Assert lane completion still fails because the latest authorized comment predates invalidation.
- [ ] Implement comment freshness:
  - `latestAuthorizedCommentFresh = !invalidatedAt || latestAuthorizedComment.createdAt >= invalidatedAt`
  - If stale, treat Smart Review, verification, `[QA PASS]`, and `[RELEASE CONFIRMED]` artifacts as unsatisfied.
- [ ] Make artifact detail say the QA verdict comment is stale after upstream changes.

Run:

```sh
pnpm --filter @paperclipai/server test -- issue-qa-gate-routes
```

Expected: post-handback QA must provide fresh document and fresh comment evidence.

---

## Task 6: Centralize Workflow-Aware Completion Guardrails

**Files:**
- Create: `server/src/services/issue-transition-guard.ts`
- Modify: `server/src/services/issue-actions.ts`
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/services/issue-actions.test.ts`
- Test: `server/src/__tests__/issue-actions-routes.test.ts`

- [ ] Extract root workflow completion checks from `server/src/routes/issues.ts`.
- [ ] Extract lane completion checks from `issueWorkflowsSvc.evaluateLaneCompletion`.
- [ ] Extract standalone delivery QA checks from `computeIssueQaGate`.
- [ ] Expose a single function:

```ts
assertIssueCanTransition(input: {
  issue: PersistedIssue;
  nextStatus: IssueStatus;
  actor: IssueActionActor;
  force?: boolean;
}): Promise<IssueTransitionGuardResult>
```

- [ ] Use this guard in typed `complete_issue`.
- [ ] Use this guard in `PATCH /issues/:id` before status moves to `done`.
- [ ] Add a grep-style test or focused unit test proving guarded paths reject direct workflow lane completion without artifacts.
- [ ] Leave low-level `issuesSvc.update()` as persistence, but document that workflow status movement must go through the guard.

Run:

```sh
pnpm --filter @paperclipai/server test -- issue-actions issue-actions-routes
```

Expected: route and typed action completion behavior remains equivalent, but duplicated logic is gone.

---

## Task 7: Align Engineer and COO AGENTS.md Contracts

**Files:**
- Modify: `server/src/onboarding-assets/engineer/AGENTS.md`
- Modify: `server/src/onboarding-assets/coo/AGENTS.md`
- Modify: `server/src/onboarding-assets/default/AGENTS.md`
- Test: `server/src/__tests__/default-agent-instructions.test.ts`

- [ ] Engineer instructions must say build lane completion requires an `implementation-summary` document or implementation work product.
- [ ] Keep `[READY FOR QA]` as handoff truth, not as the only completion artifact.
- [ ] COO instructions must say:
  - Maximize allocation across all ready work.
  - Batch assign and wake ready work until eligible free capacity or ready work is exhausted.
  - Keep destructive recovery bounded, but do not let one correction prevent safe allocation of unrelated ready work.
  - Every unallocated ready issue must have a concrete visible reason.
- [ ] Default AGENTS must keep typed workflow action preference.
- [ ] Update tests that assert onboarding bundle contents.

Run:

```sh
pnpm --filter @paperclipai/server test -- default-agent-instructions
```

Expected: role instructions match enforced workflow artifacts and COO allocation semantics.

---

## Task 8: Add Allocation Residual Reporting

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/issue-board-state.ts`
- Modify: `server/src/services/issue-review-items.ts`
- Test: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- Test: `server/src/__tests__/issue-review-items.test.ts`

- [ ] After assignment/wakeup processing, recompute open issue actionability.
- [ ] Count:
  - ready unassigned with eligible free capacity
  - ready assigned with eligible free capacity but no wake/run
  - capability-blocked by role
  - dependency-blocked
  - capacity-waiting
  - human-owned waiting
- [ ] If ready work remains with free eligible capacity, log `heartbeat.operations.allocation_invariant_broken`.
- [ ] Include the residual count in the sweep result.
- [ ] Surface residual allocation breaches as review items for the board.
- [ ] Keep existing `heartbeat.operations.invariant_broken`, but make this new allocation invariant more specific.

Run:

```sh
pnpm --filter @paperclipai/server test -- heartbeat-comment-wake-batching issue-review-items
```

Expected: every ready idle issue after heartbeat has either a capacity/capability/dependency explanation or a visible invariant breach.

---

## Task 9: UI Visibility for Flow Reasons

**Files:**
- Modify: `ui/src/components/IssueBoardStatePanel.tsx`
- Modify: `ui/src/components/IssueBoardStateSummary.tsx`
- Modify: `ui/src/lib/issue-board-state-presentation.ts`
- Modify: `ui/src/components/IssueWorkflowPanel.tsx`
- Test: `ui/src/components/IssueBoardStatePanel.test.tsx`
- Test: `ui/src/components/IssueWorkflowPanel.test.tsx`

- [ ] Add copy for missing QA/security/CTO capability states.
- [ ] Show "Ready but unallocated" only for true allocation invariant breaches.
- [ ] In workflow panel, show owner-needed versus capacity-waiting distinctly.
- [ ] Keep generic kanban columns status-based; do not replace them with workflow lanes.
- [ ] Ensure the root issue workflow panel remains the cross-functional handoff map.

Run:

```sh
pnpm --filter @paperclipai/ui test -- IssueBoardStatePanel IssueWorkflowPanel
```

Expected: operators can distinguish "blocked", "waiting for capacity", "missing specialist", and "allocator failed".

---

## Task 10: Add Optional CTO Workflow Template v2

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `server/src/services/issue-workflows.ts`
- Modify: `ui/src/components/IssueWorkflowPanel.tsx`
- Test: `server/src/__tests__/issue-workflows.test.ts`
- Test: `ui/src/components/IssueWorkflowPanel.test.tsx`

- [ ] Add `engineering_delivery_v2` without changing existing `engineering_delivery_v1` instances.
- [ ] Add workflow lane role `cto`.
- [ ] Define v2 lane graph:
  - PM produces `plan`
  - Designer produces `design`
  - CTO produces `technical-plan` or `architecture-review`
  - Engineer produces `implementation-summary`
  - Security and QA run in parallel after engineer
- [ ] Make CTO lane governed and strict-assigned to role `cto`.
- [ ] Add v2 tests for lane creation, dependency blocking, CTO artifact blocking, downstream invalidation, and root close gating.
- [ ] Keep company/project defaults on v1 unless explicitly configured.

Run:

```sh
pnpm --filter @paperclipai/server test -- issue-workflows
pnpm --filter @paperclipai/ui test -- IssueWorkflowPanel
```

Expected: v1 remains backward compatible; v2 supports CTO handoff as a first-class gate.

---

## Task 11: Documentation Update

**Files:**
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/DEVELOPING.md`
- Modify: `doc/DATABASE.md`
- Modify: `doc/plans/2026-04-23-coo-flow-allocation-guardrails.md` if implementation choices change

- [ ] Document COO allocation invariant.
- [ ] Document valid idle reasons.
- [ ] Document governed lane role requirements.
- [ ] Document QA typed action ownership split:
  - workflow QA lane owner for workflow QA
  - release-gate QA for standalone delivery
- [ ] Document `engineering_delivery_v2` CTO lane if Task 10 is implemented.
- [ ] Document any new board-state reason codes.

Run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: full repo verification passes before handoff.

---

## Recommended Implementation Order

1. Tasks 1-5 fix correctness bugs that can stall real QA flow.
2. Tasks 6-8 make the COO allocation invariant enforceable and observable.
3. Task 7 aligns the agents' actual operating instructions with the server contract.
4. Task 9 makes the new flow states legible to operators.
5. Task 10 introduces CTO as a versioned, opt-in workflow lane.
6. Task 11 closes documentation drift.

## Non-Goals

- Do not rewrite the kanban board into a workflow-lane board. Kanban remains status-based; workflow lanes remain child issues with a root workflow summary.
- Do not change existing `engineering_delivery_v1` semantics in place. Add v2 for CTO.
- Do not assign governed lanes to generic workers for the sake of apparent utilization. False ownership is worse than visible capability blocking.
- Do not create successor issues as routine recovery. Same-issue recovery remains the default.

## Definition of Done

- All ready work with eligible free capacity is assigned and woken in one COO sweep.
- Every unallocated open issue has a visible, specific reason.
- QA workflow lanes can be completed by the actual pooled QA owner through typed actions.
- QA lanes cannot be assigned to non-QA workers.
- QA evidence after handback must be fresh.
- Workflow completion uses one shared guard path.
- Engineer, COO, QA, and default AGENTS.md instructions match the enforced server behavior.
- CTO handoff is available through an opt-in v2 workflow template.
- `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass.
