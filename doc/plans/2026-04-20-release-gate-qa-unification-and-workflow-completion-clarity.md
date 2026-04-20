# Release-Gate QA Unification And Workflow Completion Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify release-gate QA ownership across standalone and workflow delivery, make workflow QA completion policy declarative, and separate steady-state workflow blockers from root-close blockers.

**Architecture:** Keep the current issue, workflow, and heartbeat model. Tighten release-gate ownership around one canonical QA policy, move workflow QA completion dispatch onto explicit lane completion policy metadata instead of lane-role special-casing, and add a dedicated root completion summary so operator-visible workflow state stops doubling as the close gate.

**Tech Stack:** TypeScript, Express, React, Drizzle/Postgres, shared contracts in `packages/shared`, Vitest, Testing Library.

---

## Scope Check

This plan covers the three remaining workflow issues that are still real after the recent workflow QA fix:

1. standalone delivery issues still allow non-canonical single-QA fallback while workflow QA lanes are canonical-only
2. workflow QA completion still depends on a lane-role special case instead of declarative lane policy
3. root workflow summaries expose actionable-now blockers, but the root close gate still rebuilds a broader set of completion blockers ad hoc

This plan intentionally does **not** cover:

- workflow history timeline UI
- stale-artifact next-action hints
- DB schema changes
- board-picked QA override flows beyond existing `forceDone`
- a broader workflow redesign

## Product Decision For This Plan

Adopt one release-gate QA rule everywhere:

- release-gate QA requires exactly one eligible canonical release-gate QA owner
- non-canonical `single_fallback` is no longer valid for release QA entry points
- if canonical ownership is missing or ambiguous, the issue stays unshippable and the system surfaces an explicit ownership blocker

If the product later wants more flexibility, add an explicit configured release-gate owner concept as a separate feature. Do not keep implicit fallback semantics.

## Working Rules

- Use `@test-driven-development` throughout.
- Use `@verification-before-completion` before claiming the work is done.
- Keep all new state derived at read time; do not add a migration for this slice.
- Keep changes company-scoped and preserve existing workflow handback behavior.
- Update docs in the same change.

## File Structure

### Shared contract and policy helpers

- Modify `packages/shared/src/release-gate-qa.ts`
  - add an explicit canonical-only release-gate resolver or tighten the existing helper without leaving ambiguous semantics
- Modify `packages/shared/src/types/issue.ts`
  - add explicit root workflow completion summary types
- Modify `packages/shared/src/index.ts`
  - export the new shared helper and type

### Server

- Modify `server/src/routes/issues.ts`
  - use the canonical-only release-gate resolver for standalone delivery routing, release QA gating, and root close handling
- Modify `server/src/services/heartbeat.ts`
  - use the same canonical-only resolver for heartbeat-driven QA routing behavior
- Modify `server/src/services/issue-qa-finalization.ts`
  - keep same-issue QA finalization aligned with the canonical-only release-gate rule
- Modify `server/src/services/issue-workflows.ts`
  - add lane completion policy metadata
  - derive and expose root completion summary separately from actionable-now workflow summary
  - route workflow lane evaluation through explicit completion policy instead of `workflowLaneRole === "qa"`
- Modify `server/src/services/workflow-qa-lane-gate.ts`
  - keep the latest-authorized-verdict gate, but make it a named lane completion policy target instead of a role special case

### Tests

- Modify `server/src/__tests__/issue-qa-gate-routes.test.ts`
  - cover canonical-only release-gate ownership on standalone delivery issues
- Modify `server/src/__tests__/issue-qa-finalization.test.ts`
  - cover canonical-only QA auto-close behavior
- Modify `server/src/__tests__/issue-workflows.test.ts`
  - cover declarative workflow QA completion policy and root completion summary behavior
- Modify `ui/src/components/IssueWorkflowPanel.test.tsx`
  - update fixtures if the shared workflow summary shape grows

### Docs

- Modify `docs/api/issues.md`
  - document canonical-only release QA and explicit workflow completion summary fields
- Modify `doc/PRODUCT.md`
  - align operator-level workflow and QA ownership behavior
- Modify `doc/SPEC-implementation.md`
  - make standalone and workflow release-gate ownership rules match
- Modify `doc/plans/2026-04-20-control-plane-workflow-map.md`
  - sync the “current behavior” map after implementation lands

## API Shape To Ship

Extend `IssueWorkflowSummary` with a dedicated close-state block instead of overloading `blockingReasons`:

```ts
issue.workflowSummary = {
  templateKey: "engineering_delivery_v1",
  isBlocked: boolean,              // actionable-now blockers only
  blockingReasons: string[],
  activeRoles: IssueWorkflowLaneRole[],
  waitingRoles: IssueWorkflowLaneRole[],
  ownerNeededRoles: IssueWorkflowLaneRole[],
  completion: {
    canClose: boolean,
    incompleteRoles: IssueWorkflowLaneRole[],
    blockingReasons: string[],     // full root-close blockers
  },
  lanes: [...],
};
```

Semantics:

- `blockingReasons`: what the board or lane owners can act on now
- `completion.blockingReasons`: why the root still cannot transition to `done`
- `completion.incompleteRoles`: which lanes are still not `done`

## Task 1: Introduce Canonical-Only Release-Gate QA Resolution

**Files:**
- Modify: `packages/shared/src/release-gate-qa.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test: `server/src/__tests__/issue-qa-finalization.test.ts`

- [ ] **Step 1: Write failing ownership-policy tests**

Add or update tests to prove:
- a standalone delivery issue does **not** auto-route to a non-canonical solo QA agent
- a standalone delivery issue cannot close from QA comments authored by a non-canonical solo QA agent
- a canonical QA owner still works for routing and closure

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
```

Expected:
- FAIL because standalone delivery still accepts `single_fallback`.

- [ ] **Step 2: Add a canonical-only resolver**

In `packages/shared/src/release-gate-qa.ts`, either:
- add a new explicit `resolveCanonicalReleaseGateQaAgent()` helper, or
- tighten `resolveReleaseGateQaAgent()` everywhere in one controlled change

Requirements:
- exactly one eligible canonical QA owner resolves successfully
- zero canonical QA owners returns `resolution = "none"`
- multiple canonical QA owners returns `resolution = "ambiguous"`
- do not silently fall back to a non-canonical solo QA owner

- [ ] **Step 3: Export the policy helper**

Update `packages/shared/src/index.ts` so all server entry points consume the same canonical-only helper.

- [ ] **Step 4: Re-run the focused tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
```

Expected:
- still FAIL, but now in server behavior rather than shared policy helper shape.

- [ ] **Step 5: Commit the shared policy slice**

```bash
git add packages/shared/src/release-gate-qa.ts packages/shared/src/index.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
git commit -m "refactor: make release gate qa canonical only"
```

## Task 2: Migrate Standalone Delivery QA Entry Points To The Canonical Policy

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/issue-qa-finalization.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test: `server/src/__tests__/issue-qa-finalization.test.ts`

- [ ] **Step 1: Wire standalone QA routing onto the canonical-only helper**

Update `server/src/routes/issues.ts` so:
- entering `in_review` only auto-routes to the canonical release-gate QA owner
- QA assignment-required comments describe missing or ambiguous canonical ownership accurately
- `done` transitions enforce canonical-only release-gate ownership

- [ ] **Step 2: Align heartbeat-side QA routing**

Update `server/src/services/heartbeat.ts` so any release-gate QA routing or reassignment logic uses the same canonical-only rule.

- [ ] **Step 3: Align same-issue QA finalization**

Update `server/src/services/issue-qa-finalization.ts` so QA-pass auto-close and auto-merge only proceed when the author is the canonical release-gate QA owner.

- [ ] **Step 4: Expand route/finalization regression tests**

Cover:
- no canonical QA owner
- multiple canonical QA owners
- one non-canonical solo QA agent
- exactly one canonical QA owner

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
```

Expected:
- PASS for the new canonical-only behavior.

- [ ] **Step 5: Commit the standalone QA migration**

```bash
git add server/src/routes/issues.ts server/src/services/heartbeat.ts server/src/services/issue-qa-finalization.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
git commit -m "feat: unify standalone qa ownership policy"
```

## Task 3: Make Workflow QA Completion Policy Declarative

**Files:**
- Modify: `server/src/services/issue-workflows.ts`
- Modify: `server/src/services/workflow-qa-lane-gate.ts`
- Test: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Write failing workflow-policy tests**

Add or update tests to prove:
- the QA lane uses an explicit workflow QA completion policy
- non-QA lanes still use standard artifact completion
- changing lane role strings alone is not what selects the QA gate anymore

Run:

```bash
pnpm vitest run server/src/__tests__/issue-workflows.test.ts
```

Expected:
- FAIL because lane evaluation is still role-special-cased.

- [ ] **Step 2: Add lane completion policy metadata**

In `server/src/services/issue-workflows.ts`, extend internal lane definitions with explicit completion policy, for example:
- `artifacts_only`
- `authorized_workflow_qa_verdict`

Keep `requiredArtifacts` for UI/status display, but stop using `workflowLaneRole === "qa"` as the evaluator switch.

- [ ] **Step 3: Dispatch lane completion through policy**

Update workflow lane evaluation so:
- ordinary lanes use standard artifact evaluation
- QA lanes use `evaluateWorkflowQaLaneGate()` because their declared completion policy says so

- [ ] **Step 4: Re-run the focused workflow tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-workflows.test.ts
```

Expected:
- PASS with no behavior change except the removal of the role-name special case.

- [ ] **Step 5: Commit the declarative workflow policy slice**

```bash
git add server/src/services/issue-workflows.ts server/src/services/workflow-qa-lane-gate.ts server/src/__tests__/issue-workflows.test.ts
git commit -m "refactor: declare workflow lane completion policy"
```

## Task 4: Add Explicit Root Workflow Completion State

**Files:**
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `server/src/services/issue-workflows.ts`
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/issue-workflows.test.ts`
- Test: `ui/src/components/IssueWorkflowPanel.test.tsx`

- [ ] **Step 1: Write failing completion-state tests**

Add or update tests to prove:
- `workflowSummary.blockingReasons` remains actionable-now only
- `workflowSummary.completion.blockingReasons` includes non-`done` lane reasons
- root close logic reuses the explicit completion state instead of rebuilding it ad hoc

Run:

```bash
pnpm vitest run server/src/__tests__/issue-workflows.test.ts ui/src/components/IssueWorkflowPanel.test.tsx
```

Expected:
- FAIL because the shared type and summary shape do not yet expose completion state.

- [ ] **Step 2: Extend the shared workflow summary contract**

In `packages/shared/src/types/issue.ts`, add a dedicated root completion summary type and wire it into `IssueWorkflowSummary`.

Export the new type from `packages/shared/src/index.ts`.

- [ ] **Step 3: Derive completion state in `issue-workflows.ts`**

Compute:
- `completion.canClose`
- `completion.incompleteRoles`
- `completion.blockingReasons`

Rules:
- include missing lanes
- include non-`done` lanes
- include any current lane-close blockers
- do not mutate the meaning of `blockingReasons`

- [ ] **Step 4: Reuse the new completion state in the route close gate**

Update `evaluateWorkflowRootCompletion()` in `server/src/routes/issues.ts` to consume the derived completion block instead of rebuilding the close gate inline.

- [ ] **Step 5: Re-run focused workflow tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-workflows.test.ts ui/src/components/IssueWorkflowPanel.test.tsx
```

Expected:
- PASS with stable separation between summary blockers and close blockers.

- [ ] **Step 6: Commit the root completion-state slice**

```bash
git add packages/shared/src/types/issue.ts packages/shared/src/index.ts server/src/services/issue-workflows.ts server/src/routes/issues.ts server/src/__tests__/issue-workflows.test.ts ui/src/components/IssueWorkflowPanel.test.tsx
git commit -m "feat: expose workflow root completion state"
```

## Task 5: Sync Docs And Verify End-To-End

**Files:**
- Modify: `docs/api/issues.md`
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/plans/2026-04-20-control-plane-workflow-map.md`

- [ ] **Step 1: Update docs**

Document:
- canonical-only release-gate QA ownership across standalone and workflow release QA
- declarative workflow QA completion policy
- `workflowSummary.completion`

- [ ] **Step 2: Run focused verification**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-workflows.test.ts ui/src/components/IssueWorkflowPanel.test.tsx
pnpm -r typecheck
pnpm build
```

Expected:
- PASS for the targeted suites, typecheck, and build.

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm test:run
```

Expected:
- PASS.

If there are unrelated pre-existing failures, document them explicitly in the final handoff instead of claiming the full repo passed.

- [ ] **Step 4: Commit docs and final verification slice**

```bash
git add docs/api/issues.md doc/PRODUCT.md doc/SPEC-implementation.md doc/plans/2026-04-20-control-plane-workflow-map.md
git commit -m "docs: sync workflow qa and completion semantics"
```

## Follow-On Work Explicitly Deferred

After this plan lands, the next worthwhile workflow/UI slice is:

1. workflow history timeline UI
2. stale-artifact next-action hints
3. optional explicit company-configured release-gate owner if canonical naming proves too rigid
