# Workflow QA And Lane State Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align workflow QA lane completion with the documented contract and make workflow summaries distinguish dependency waiting from actionable blocking.

**Architecture:** Keep the existing issue, lane, and heartbeat model. Reuse the existing Smart Review parsing logic for workflow QA lanes instead of inventing a second verdict parser, then tighten workflow summary derivation so the server computes lane phase and actionable blockers separately from future completion requirements. Update the workflow UI to render those derived fields instead of inferring meaning from raw status plus artifact gaps.

**Tech Stack:** TypeScript, Express, React, Drizzle/Postgres, shared contracts in `packages/shared`, Vitest, Testing Library.

---

## Scope Check

This plan fixes the two highest-confidence problems from the workflow map:

- workflow QA lane completion is looser in code than in `doc/SPEC-implementation.md`
- root workflow summaries currently conflate "waiting on upstream work" with "blocked right now"

This plan intentionally does **not** cover:

- full workflow-history timeline UI
- a broader workflow redesign
- changing the stored DB model
- forcing workflow QA lanes onto the canonical release-gate QA owner

That ownership-policy question is real, but it should be a separate decision after the contract drift is fixed.

## Working Rules

- Use `@test-driven-development` throughout.
- Use `@verification-before-completion` before claiming the work is done.
- Do not add new persisted workflow state if a derived field is enough.
- Keep changes company-scoped and route-safe.
- Update docs in the same change.

## File Structure

### Shared Contract

- Modify `packages/shared/src/constants.ts`
  - add workflow lane phase constants
- Modify `packages/shared/src/types/issue.ts`
  - add derived workflow lane phase fields and summary buckets
- Modify `packages/shared/src/index.ts`
  - export the new shared types/constants

### Server

- Create `server/src/services/workflow-qa-lane-gate.ts`
  - compute workflow QA completion from the latest lane verdict comment plus document presence
  - reuse Smart Review and verification parsing semantics from `qa-gate.ts`
- Create `server/src/services/workflow-lane-phase.ts`
  - derive lane phase and actionable blocker semantics from lane status, dependency status, ownership, and lane-local gate results
- Modify `server/src/services/qa-gate.ts`
  - export the minimal parsing helpers needed by workflow QA evaluation instead of duplicating regex logic
- Modify `server/src/services/issue-workflows.ts`
  - replace QA lane marker-only completion checks with the workflow QA lane gate
  - compute lane phase and root summary buckets
- Modify `server/src/routes/issues.ts`
  - return the updated workflow summary shape on detail and mutation responses
- Modify `server/src/__tests__/issue-workflows.test.ts`
  - cover lane completion, stale/missing verdict parts, and root summary semantics
- Modify `server/src/__tests__/issue-qa-gate-routes.test.ts`
  - cover workflow QA close behavior and regression cases
- Create `server/src/__tests__/workflow-qa-lane-gate.test.ts`
  - focused parsing/completion cases
- Create `server/src/__tests__/workflow-lane-phase.test.ts`
  - focused phase and blocker rollup cases

### UI

- Modify `ui/src/components/IssueWorkflowPanel.tsx`
  - render lane phase, waiting buckets, actionable blockers, and owner-needed buckets distinctly
- Modify `ui/src/components/IssueWorkflowPanel.test.tsx`
  - update expected copy/state rendering
- Modify `ui/src/pages/IssueDetail.tsx`
  - keep using the panel, but update any summary text assumptions if needed

### Docs

- Modify `doc/SPEC-implementation.md`
  - align documented workflow QA completion with the actual enforced rule
- Modify `doc/PRODUCT.md`
  - explain waiting-vs-blocked workflow summaries at operator level
- Modify `docs/api/issues.md`
  - document the expanded workflow summary payload
- Modify `doc/plans/2026-04-20-control-plane-workflow-map.md`
  - sync the “current behavior” section after implementation lands

## Implementation Strategy

### Product decision for this plan

Adopt this rule:

- a workflow QA lane closes only when the latest workflow QA verdict is complete and passing
- historical success markers elsewhere in the thread do not satisfy the current lane verdict
- downstream lanes that are merely waiting on upstream work should be visible as waiting, not counted as actionable blockers

### Behavioral target

After this plan lands:

- a QA lane with `qa-verdict` plus `[QA PASS]` and `[RELEASE CONFIRMED]` but **without** a full Smart Review summary cannot close
- a QA lane with a full Smart Review summary but failing verification cannot close
- a root workflow issue with downstream lanes not yet activated shows those lanes as waiting, not blocking
- root `blockingReasons` only describe work the board or current lane owner can act on now

## API Shape To Ship

Extend workflow summaries with derived phase/bucket fields, without changing the persisted schema:

```ts
type IssueWorkflowLanePhase =
  | "missing"
  | "waiting"
  | "ready"
  | "active"
  | "done";

issue.workflowSummary = {
  templateKey: "engineering_delivery_v1",
  isBlocked: boolean,
  blockingReasons: string[],      // actionable now
  activeRoles: IssueWorkflowLaneRole[],
  waitingRoles: IssueWorkflowLaneRole[],
  ownerNeededRoles: IssueWorkflowLaneRole[],
  lanes: [
    {
      role: "qa",
      phase: "waiting" | "ready" | "active" | "done" | "missing",
      ready: boolean,
      blockedByRoles: IssueWorkflowLaneRole[],
      unresolvedOwnership: boolean,
      blockingReasons: string[],  // current blockers only
      artifactStatuses: IssueWorkflowArtifactStatus[],
    },
  ],
};
```

Semantics:

- `phase=waiting`: upstream dependencies are still active
- `phase=ready`: lane can start now, not yet active
- `phase=active`: lane owner is actively working or reviewing
- `blockingReasons`: current actionable blockers only
- artifact gaps remain visible in `artifactStatuses`, but do not automatically become root blockers while the lane is still waiting on dependencies

## Task 1: Add Shared Workflow Phase Contract

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `ui/src/components/IssueWorkflowPanel.test.tsx`
- Test: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Write failing contract-driven tests**

Add assertions that the workflow panel and workflow summary fixtures can express:
- lane `phase`
- root `waitingRoles`
- root `ownerNeededRoles`

Run:

```bash
pnpm vitest run ui/src/components/IssueWorkflowPanel.test.tsx server/src/__tests__/issue-workflows.test.ts
```

Expected:
- FAIL because the shared issue workflow types do not yet include the new fields.

- [ ] **Step 2: Add shared constants and types**

Define:
- `ISSUE_WORKFLOW_LANE_PHASES`
- `IssueWorkflowLanePhase`

Extend:
- `IssueWorkflowLaneSummary`
- `IssueWorkflowSummary`

Keep existing fields for compatibility. Add, do not replace, in this task.

- [ ] **Step 3: Export the new shared contract**

Update `packages/shared/src/index.ts` so server and UI consume the same new fields.

- [ ] **Step 4: Re-run the focused tests**

Run:

```bash
pnpm vitest run ui/src/components/IssueWorkflowPanel.test.tsx server/src/__tests__/issue-workflows.test.ts
```

Expected:
- still FAIL, but now in server/UI logic rather than missing types.

- [ ] **Step 5: Commit the shared contract slice**

```bash
git add packages/shared/src/constants.ts packages/shared/src/types/issue.ts packages/shared/src/index.ts ui/src/components/IssueWorkflowPanel.test.tsx server/src/__tests__/issue-workflows.test.ts
git commit -m "refactor: add workflow lane phase contract"
```

## Task 2: Build A Workflow QA Lane Gate From The Latest Verdict

**Files:**
- Create: `server/src/services/workflow-qa-lane-gate.ts`
- Modify: `server/src/services/qa-gate.ts`
- Modify: `server/src/services/issue-workflows.ts`
- Create: `server/src/__tests__/workflow-qa-lane-gate.test.ts`
- Modify: `server/src/__tests__/issue-workflows.test.ts`
- Modify: `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] **Step 1: Write the failing workflow QA gate tests**

Cover these cases in `workflow-qa-lane-gate.test.ts`:

- verdict missing Smart Review summary
- verdict missing verification line
- verdict includes failing Smart Review dimension
- verdict includes failing verification token
- verdict includes old success markers in history but failing latest verdict
- passing latest verdict with all required parts

Run:

```bash
pnpm vitest run server/src/__tests__/workflow-qa-lane-gate.test.ts
```

Expected:
- FAIL because the service does not exist.

- [ ] **Step 2: Export minimal parsing helpers from `qa-gate.ts`**

Refactor `qa-gate.ts` so workflow QA logic can reuse:
- Smart Review summary parsing
- verification parsing
- fail detection

Do not duplicate the regexes in a second file.

- [ ] **Step 3: Implement `workflow-qa-lane-gate.ts`**

The service should accept:
- lane issue metadata
- latest relevant QA verdict comment
- document presence for `qa-verdict`

It should return:
- `canComplete`
- `blockingReasons`
- derived artifact-like statuses for:
  - `qa-verdict`
  - Smart Review summary completeness
  - verification completeness/pass
  - `[QA PASS]`
  - `[RELEASE CONFIRMED]`

Critical rule:
- evaluate the **latest** relevant verdict comment, not any matching marker anywhere in history.

- [ ] **Step 4: Route workflow QA lane completion through the new gate**

Update `issue-workflows.ts` so `evaluateLaneCompletion()`:
- still uses generic artifact evaluation for non-QA lanes
- uses `workflow-qa-lane-gate.ts` for `workflowLaneRole === "qa"`

Update `issue-qa-gate-routes.test.ts` so workflow QA close behavior now fails when the latest verdict is incomplete or failing.

- [ ] **Step 5: Re-run the focused QA tests**

Run:

```bash
pnpm vitest run server/src/__tests__/workflow-qa-lane-gate.test.ts server/src/__tests__/issue-workflows.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts
```

Expected:
- PASS for the new workflow QA completion rules.

- [ ] **Step 6: Commit the workflow QA slice**

```bash
git add server/src/services/workflow-qa-lane-gate.ts server/src/services/qa-gate.ts server/src/services/issue-workflows.ts server/src/__tests__/workflow-qa-lane-gate.test.ts server/src/__tests__/issue-workflows.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts
git commit -m "fix: enforce workflow qa verdict contract"
```

## Task 3: Separate Waiting From Actionable Blocking In Workflow Summaries

**Files:**
- Create: `server/src/services/workflow-lane-phase.ts`
- Modify: `server/src/services/issue-workflows.ts`
- Create: `server/src/__tests__/workflow-lane-phase.test.ts`
- Modify: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Write failing lane-phase tests**

Cover:
- dependency-blocked downstream lane reports `phase=waiting`
- dependency-free `todo` lane reports `phase=ready`
- `in_progress` or `in_review` lane reports `phase=active`
- `done` lane reports `phase=done`
- root summary includes waiting roles separately from actionable blockers
- root summary does not count future downstream artifact gaps as active blockers
- root summary includes `ownerNeededRoles` only for lanes that are ready/active but unowned

Run:

```bash
pnpm vitest run server/src/__tests__/workflow-lane-phase.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- FAIL because phase derivation and root rollups do not exist yet.

- [ ] **Step 2: Implement `workflow-lane-phase.ts`**

Give the file one job:
- turn lane-local facts into derived phase and actionable blocker semantics

Inputs should include:
- issue status
- `blockedByRoles`
- unresolved ownership
- current lane gate result

Rules:
- dependency waiting is not an actionable blocker
- artifact gaps on downstream waiting lanes are not root blockers
- current security/QA fail states are actionable blockers
- missing lane issue is an actionable blocker

- [ ] **Step 3: Rework workflow summary rollups**

Update `issue-workflows.ts` to:
- assign `phase` per lane
- populate `waitingRoles`
- populate `ownerNeededRoles`
- keep `activeRoles` as "actionable now" roles
- limit `blockingReasons` to current actionable blockers

Do not remove artifact status detail from lane issues.

- [ ] **Step 4: Re-run the focused server tests**

Run:

```bash
pnpm vitest run server/src/__tests__/workflow-lane-phase.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- PASS with distinct waiting vs blocking semantics.

- [ ] **Step 5: Commit the workflow summary slice**

```bash
git add server/src/services/workflow-lane-phase.ts server/src/services/issue-workflows.ts server/src/__tests__/workflow-lane-phase.test.ts server/src/__tests__/issue-workflows.test.ts
git commit -m "fix: separate waiting from blocking in workflow summaries"
```

## Task 4: Update Workflow UI To Match The New Summary Semantics

**Files:**
- Modify: `ui/src/components/IssueWorkflowPanel.tsx`
- Modify: `ui/src/components/IssueWorkflowPanel.test.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Write the failing UI expectations**

Add tests that expect:
- waiting lanes to render as waiting, not blocked
- root panel to show:
  - ready now
  - waiting on dependencies
  - needs owner
- actionable blocker text to be distinct from waiting text

Run:

```bash
pnpm vitest run ui/src/components/IssueWorkflowPanel.test.tsx
```

Expected:
- FAIL because the component still treats lane rows through raw status plus a single blocking summary.

- [ ] **Step 2: Render lane phase explicitly**

Update row badges and summary copy so:
- `waiting` is visually distinct from `blocked`
- `ready` is distinct from `active`
- only actionable blockers use warning copy

- [ ] **Step 3: Keep artifact visibility without implying immediate blockage**

Lane issue detail can still show missing/stale artifacts, but root summary copy should not imply that a downstream waiting lane is currently blocked on its own artifacts.

- [ ] **Step 4: Re-run the workflow UI test**

Run:

```bash
pnpm vitest run ui/src/components/IssueWorkflowPanel.test.tsx
```

Expected:
- PASS with the new phase-aware UI.

- [ ] **Step 5: Commit the UI slice**

```bash
git add ui/src/components/IssueWorkflowPanel.tsx ui/src/components/IssueWorkflowPanel.test.tsx ui/src/pages/IssueDetail.tsx
git commit -m "feat: show workflow waiting and blocking separately"
```

## Task 5: Update Docs To Match The Enforced Behavior

**Files:**
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/PRODUCT.md`
- Modify: `docs/api/issues.md`
- Modify: `doc/plans/2026-04-20-control-plane-workflow-map.md`

- [ ] **Step 1: Update the V1 spec**

Document that workflow QA lane completion now enforces:
- `qa-verdict`
- Smart Review summary completeness
- verification completeness and passing
- `[QA PASS]`
- `[RELEASE CONFIRMED]`

- [ ] **Step 2: Update product/operator docs**

Clarify:
- waiting lanes are dependency-gated, not actively blocked
- actionable blocking reasons are now separated from dependency waiting

- [ ] **Step 3: Update the API docs**

Document:
- lane `phase`
- `waitingRoles`
- `ownerNeededRoles`
- new `blockingReasons` semantics

- [ ] **Step 4: Sync the workflow map**

Update the workflow map note so its “current behavior” section matches the shipped implementation rather than the pre-fix state.

- [ ] **Step 5: Commit the docs slice**

```bash
git add doc/SPEC-implementation.md doc/PRODUCT.md docs/api/issues.md doc/plans/2026-04-20-control-plane-workflow-map.md
git commit -m "docs: sync workflow qa and lane summary behavior"
```

## Task 6: Full Verification Before Handoff

**Files:**
- Test only

- [ ] **Step 1: Run focused regression coverage**

```bash
pnpm vitest run \
  server/src/__tests__/workflow-qa-lane-gate.test.ts \
  server/src/__tests__/workflow-lane-phase.test.ts \
  server/src/__tests__/issue-workflows.test.ts \
  server/src/__tests__/issue-qa-gate-routes.test.ts \
  ui/src/components/IssueWorkflowPanel.test.tsx
```

Expected:
- PASS

- [ ] **Step 2: Run repo-required verification**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected:
- all pass

- [ ] **Step 3: Write handoff notes**

Summarize:
- workflow QA gate now keys off the latest verdict
- workflow summary separates waiting from blocking
- no DB migration was added
- canonical workflow QA ownership is still unresolved and should be handled in a follow-on plan

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: tighten workflow qa contract and lane state clarity"
```

## Follow-On Plan After This One

If this plan ships cleanly, the next plan should cover:

1. canonical QA ownership policy for workflow lanes
2. first-class workflow history timeline in the UI
3. server-computed workflow/delivery phase summary for non-expert operators
