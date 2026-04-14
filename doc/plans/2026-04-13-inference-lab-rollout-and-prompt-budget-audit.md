# Inference Lab Rollout And Prompt-Budget Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make merge-on-QA a clear project-level control that can be enabled for Inference Lab, and produce a written audit of the archived prompt-budget snapshot without porting stale code blindly.

**Architecture:** This work splits into two independent tracks. The rollout track is intentionally thin: keep merge behavior in the existing server contract and add a clear project configuration control that writes `executionWorkspacePolicy.pullRequestPolicy.mergeOnQaPass`. The audit track is read-only: inspect the archived tag, write a recommendation report, and identify only the prompt-budget pieces that are worth a fresh forward-port on top of current `master`.

**Tech Stack:** React 19, TypeScript, TanStack Query, Vitest with jsdom, shared project policy types, git diff/log/show.

---

## File Map

- Modify: `ui/src/components/ProjectProperties.tsx`
  Responsibility: surface a clear merge-on-QA control and write the correct nested project-policy patch.
- Create: `ui/src/components/ProjectProperties.test.tsx`
  Responsibility: lock the UI copy, visibility rules, and patch payload.
- Reference only: `ui/src/pages/ProjectDetail.tsx`
  Responsibility: existing per-field save-state wiring; touch only if the new field key needs explicit handling.
- Reference only: `packages/shared/src/types/workspace-runtime.ts`
  Responsibility: existing `pullRequestPolicy.mergeOnQaPass` contract; no change expected.
- Reference only: `server/src/services/issue-merge.ts`
  Responsibility: existing backend auto-merge behavior; no rollout change expected.
- Reference only: `server/src/routes/issues.ts`
  Responsibility: existing QA-comment trigger path; no rollout change expected.
- Create: `report/2026-04-13-inference-lab-prompt-budget-audit.md`
  Responsibility: capture archive scope, prompt-budget candidates, and the keep vs rebuild recommendation.
- Inspect only: `packages/adapter-utils/src/prompt-utils.ts`
  Responsibility: archived shared prompt-budget helper candidate; do not modify in this plan.
- Inspect only: `packages/adapter-utils/src/server-utils.ts`
  Responsibility: archived prompt assembly integration point; do not modify in this plan.
- Inspect only: `packages/adapters/*/src/server/execute.ts`
  Responsibility: archived adapter-level telemetry and budgeting adoption; do not modify in this plan.
- Inspect only: `server/src/services/heartbeat-run-summary.ts`
  Responsibility: archived before/after prompt telemetry surface; do not modify in this plan.
- Inspect only: `server/src/services/heartbeat.ts`
  Responsibility: archived budget/summary integration context; do not modify in this plan.

## UX Decisions Locked In

- New control label: `Merge validated branch on QA pass`
- Primary explanatory copy: `When QA leaves [QA PASS] and [RELEASE CONFIRMED], PrivateClip will try to merge the issue branch into the target branch before closing the issue.`
- Secondary prerequisite copy: `Requires an execution workspace with persisted branch metadata. If the merge is blocked, the issue stays in QA and PrivateClip leaves a blocker comment.`
- Placement: inside `Execution Workspaces`, visible whenever execution workspaces are enabled, and not hidden behind the advanced checkout accordion.
- Data rule: preserve any existing `pullRequestPolicy.deleteBranchAfterMerge` value and all unrelated execution workspace policy fields when toggling `mergeOnQaPass`.
- Rollout boundary: this plan ships the control and enables it for the existing Inference Lab project if that project already exists in the target instance. This plan does not special-case the project name in product code.
- Audit boundary: this plan produces a report only. Do not port archived prompt-budget code in the same branch without a separate approval.

### Task 1: Lock The Merge-On-QA UI Contract With Tests

**Files:**
- Create: `ui/src/components/ProjectProperties.test.tsx`
- Reference: `ui/src/components/NewIssueDialog.test.tsx`
- Reference: `ui/src/components/ProjectProperties.tsx`

- [ ] **Step 1: Create the component test scaffold**

Mirror the jsdom + mocked query/api setup used in `ui/src/components/NewIssueDialog.test.tsx` so `ProjectProperties` can render without real network calls.

- [ ] **Step 2: Write the failing visibility-and-copy test**

Render a project with:

```ts
executionWorkspacePolicy: {
  enabled: true,
  defaultMode: "shared_workspace",
  pullRequestPolicy: { mergeOnQaPass: false },
}
```

Assert that `ProjectProperties` shows:

- `Merge validated branch on QA pass`
- the primary explanation about `[QA PASS]` and `[RELEASE CONFIRMED]`
- the secondary explanation about persisted branch metadata and blocked merges

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:run -- ui/src/components/ProjectProperties.test.tsx`

Expected: FAIL because the merge-on-QA control and copy do not exist yet.

- [ ] **Step 4: Write the failing payload-preservation test**

Toggle the new control on and assert `onFieldUpdate` receives an `executionWorkspacePolicy` patch shaped like:

```ts
{
  executionWorkspacePolicy: {
    enabled: true,
    defaultMode: "shared_workspace",
    allowIssueOverride: true,
    pullRequestPolicy: {
      mergeOnQaPass: true,
      deleteBranchAfterMerge: false,
    },
  },
}
```

Use an initial project policy that already contains `deleteBranchAfterMerge: false` so the test proves the nested object is preserved rather than replaced destructively.

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test:run -- ui/src/components/ProjectProperties.test.tsx`

Expected: FAIL because no control emits the nested patch yet.

- [ ] **Step 6: Write the failing hidden-state test**

Render the component with execution workspaces disabled and assert the merge-on-QA control is not present.

- [ ] **Step 7: Run the test to verify it fails or stays red for the right reason**

Run: `pnpm test:run -- ui/src/components/ProjectProperties.test.tsx`

Expected: at least one of the new tests is still red for the missing implementation, not because of broken test scaffolding.

- [ ] **Step 8: Commit the red tests**

```bash
git add ui/src/components/ProjectProperties.test.tsx
git commit -m "test: cover merge-on-QA project controls"
```

### Task 2: Implement The Clear Project-Level Merge-On-QA Control

**Files:**
- Modify: `ui/src/components/ProjectProperties.tsx`
- Modify if needed: `ui/src/pages/ProjectDetail.tsx`
- Test: `ui/src/components/ProjectProperties.test.tsx`

- [ ] **Step 1: Add a dedicated field key for the new control**

Extend `ProjectConfigFieldKey` in `ui/src/components/ProjectProperties.tsx` with:

```ts
"execution_workspace_merge_on_qa_pass"
```

Only touch `ui/src/pages/ProjectDetail.tsx` if the new field key needs explicit handling beyond the existing generic map.

- [ ] **Step 2: Add a small helper for nested pull-request policy updates**

In `ui/src/components/ProjectProperties.tsx`, derive:

- current `mergeOnQaPass` boolean
- existing `pullRequestPolicy`

Then add a helper that returns:

```ts
pullRequestPolicy: {
  ...executionWorkspacePolicy?.pullRequestPolicy,
  mergeOnQaPass: nextValue,
}
```

Do not overwrite `deleteBranchAfterMerge`.

- [ ] **Step 3: Render the control in the visible execution-workspace section**

Add a new row inside the `executionWorkspacesEnabled` block, before the advanced checkout accordion, using:

- `ToggleSwitch`
- `SaveIndicator`
- the locked copy from the UX section above

The operator should not need to open the Git worktree settings to discover this rollout toggle.

- [ ] **Step 4: Keep the control hidden when execution workspaces are off**

Do not render the new row outside the `executionWorkspacesEnabled` branch. Merge-on-QA without persisted execution workspaces is misleading.

- [ ] **Step 5: Run the targeted component tests until they pass**

Run: `pnpm test:run -- ui/src/components/ProjectProperties.test.tsx`

Expected: PASS for the three new cases plus any existing colocated tests.

- [ ] **Step 6: Run UI typecheck**

Run: `pnpm --filter @paperclipai/ui typecheck`

Expected: PASS with no new TypeScript errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add ui/src/components/ProjectProperties.tsx ui/src/components/ProjectProperties.test.tsx ui/src/pages/ProjectDetail.tsx
git commit -m "feat(ui): add merge-on-QA project control"
```

If `ui/src/pages/ProjectDetail.tsx` was not touched, omit it from the commit.

### Task 3: Roll The Setting Out On The Existing Inference Lab Project

**Files:**
- No repo file changes required
- Runtime target: the board instance containing the Inference Lab project

- [ ] **Step 1: Start or reuse the local dev server**

Run: `pnpm dev:once`

Expected: the board is available locally on the configured port.

- [ ] **Step 2: Open the Inference Lab project configuration page**

Navigate to the existing Inference Lab project and open the `Configuration` tab.

If no Inference Lab project exists in the target instance, stop here and ask whether to create one or rename an existing project. Do not special-case the product code to synthesize it.

- [ ] **Step 3: Enable the new merge-on-QA control**

Toggle `Merge validated branch on QA pass` on for Inference Lab.

- [ ] **Step 4: Verify the save persisted**

Refresh the page and confirm the toggle remains enabled.

Preferred verification:

- browser save indicator returns to idle after `Saved`
- the project still loads with the control on after refresh

Optional API verification once the project/company ids are known:

```bash
curl "http://localhost:3100/api/projects/<project-id>?companyId=<company-id>"
```

Expected JSON fragment:

```json
{
  "executionWorkspacePolicy": {
    "pullRequestPolicy": {
      "mergeOnQaPass": true
    }
  }
}
```

- [ ] **Step 5: Manually verify the copy is clear**

Read the control as an operator. If the wording still feels ambiguous about when merge happens or what blocks it, tighten the copy before continuing.

### Task 4: Audit The Archived Prompt-Budget Snapshot Without Porting It

**Files:**
- Create: `report/2026-04-13-inference-lab-prompt-budget-audit.md`
- Inspect only: `archive/inference-lab-prompt-budget-20260412`
- Inspect only: `packages/adapter-utils/src/prompt-utils.ts`
- Inspect only: `packages/adapter-utils/src/server-utils.ts`
- Inspect only: `packages/adapters/*/src/server/execute.ts`
- Inspect only: `server/src/services/heartbeat-run-summary.ts`
- Inspect only: `server/src/services/heartbeat.ts`

- [ ] **Step 1: Create the audit report skeleton**

Start the report with these sections:

- `Snapshot shape`
- `What is already on master`
- `Port-worthy candidates`
- `Do not port as-is`
- `Recommendation`

- [ ] **Step 2: Establish the archive divergence baseline**

Run:

```bash
git merge-base HEAD archive/inference-lab-prompt-budget-20260412
git log --oneline <merge-base>..archive/inference-lab-prompt-budget-20260412
git diff --stat <merge-base>..archive/inference-lab-prompt-budget-20260412 -- \
  packages/adapter-utils/src \
  packages/adapters \
  server/src/services/heartbeat-run-summary.ts \
  server/src/services/heartbeat.ts
```

Expected: confirm that the tag is a preserved worktree snapshot, not a clean, isolated feature branch.

- [ ] **Step 3: Read the archived design intent before judging the code**

Inspect:

```bash
git show archive/inference-lab-prompt-budget-20260412:doc/plans/2026-04-11-shared-prompt-budget-design.md | sed -n '1,220p'
git show archive/inference-lab-prompt-budget-20260412:doc/plans/2026-04-11-shared-prompt-budget-implementation-plan.md | sed -n '1,260p'
git show archive/inference-lab-prompt-budget-20260412:docs/superpowers/specs/2026-04-11-handoff-memory-design.md | sed -n '1,220p'
```

Capture the design goal separately from the stale implementation details.

- [ ] **Step 4: Inspect the prompt-budget candidate files**

Read the archived versions of:

- `packages/adapter-utils/src/prompt-utils.ts`
- `packages/adapter-utils/src/server-utils.ts`
- representative adapter execute files
- `server/src/services/heartbeat-run-summary.ts`

Classify each candidate into one of:

- `fresh-port candidate`
- `partially useful but needs redesign`
- `leave archived`

- [ ] **Step 5: Write the recommendation explicitly**

The report must answer:

- Is the archived tag worth cherry-picking? Expected answer: no.
- Which ideas are worth re-implementing fresh? Likely:
  - shared prompt section budgeting helper
  - prompt budget tests
  - before/after prompt telemetry
- Which parts are too stale or too entangled with older server state to port safely?

- [ ] **Step 6: Commit the audit report**

```bash
git add report/2026-04-13-inference-lab-prompt-budget-audit.md
git commit -m "docs: audit archived prompt-budget snapshot"
```

### Task 5: Run Full Verification Before Calling The Work Complete

**Files:**
- Verify the repo state after Tasks 2 through 4

- [ ] **Step 1: Re-run the targeted UI test**

Run: `pnpm test:run -- ui/src/components/ProjectProperties.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run repo-wide typecheck**

Run: `pnpm -r typecheck`

Expected: PASS.

- [ ] **Step 3: Run repo-wide tests**

Run: `pnpm test:run`

Expected: PASS.

- [ ] **Step 4: Run repo-wide build**

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 5: Review the outcome against the actual goals**

Confirm all of the following are true:

- the project configuration UI now exposes a clear merge-on-QA toggle
- toggling it preserves unrelated workspace policy fields
- Inference Lab has the setting enabled in the target board instance
- the prompt-budget archive audit exists as a written report
- no prompt-budget code was ported speculatively in this branch

- [ ] **Step 6: Create the final handoff commit if needed**

If Tasks 2 and 4 were committed separately and no further changes remain, skip this step.

Otherwise:

```bash
git add ui/src/components/ProjectProperties.tsx ui/src/components/ProjectProperties.test.tsx report/2026-04-13-inference-lab-prompt-budget-audit.md
git commit -m "feat: roll out merge-on-QA and audit prompt-budget archive"
```

## Success Criteria

- Operators can discover merge-on-QA from the project configuration page without opening advanced checkout settings.
- The new control writes `executionWorkspacePolicy.pullRequestPolicy.mergeOnQaPass` and preserves existing sibling fields.
- The existing Inference Lab project has the setting enabled after rollout.
- A dated audit report explains why the archived prompt-budget tag should not be cherry-picked wholesale and names the only pieces worth a fresh port.
- All required verification commands pass before the work is claimed complete.
