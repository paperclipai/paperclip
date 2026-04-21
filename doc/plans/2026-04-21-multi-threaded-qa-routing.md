# Multi-Threaded QA Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the company-wide single-owner QA gate with pooled per-issue QA routing so multiple QA agents can review delivery work concurrently while each issue still has one accountable reviewer at a time.

**Architecture:** Keep the existing single-assignee issue model. Add an issue-scoped `qaReviewerAgentId` that records the selected reviewer for the current or most recent QA cycle, introduce a shared QA pool selector that chooses an eligible reviewer via sticky reuse plus load-aware fallback, and make all QA gate/finalization logic trust the issue-level reviewer instead of a company-wide exclusive owner. Preserve `companies.releaseGateQaAgentId` in this slice as an optional routing preference rather than renaming the database column immediately.

**Tech Stack:** TypeScript, Express, React, Drizzle/Postgres, shared contracts in `packages/shared`, Vitest, Testing Library.

---

## Scope Check

This plan covers one coherent subsystem change:

1. pooled QA reviewer selection for standalone and workflow delivery issues
2. issue-level reviewer ownership for QA verdicts, auto-close, and heartbeat recovery
3. contract, UI, and docs alignment for the new pooled semantics

This plan intentionally does **not** cover:

- multiple simultaneous reviewers on the same issue
- generalized execution-policy refactoring
- automatic hiring/autoscaling of new QA agents
- renaming `releaseGateQaAgentId` in the database
- non-delivery review flows unrelated to the delivery QA gate

## Product Decision For This Plan

- Multiple eligible QA agents are valid capacity, not an ambiguity error.
- Entering `in_review` selects exactly one QA reviewer for that issue from the pool.
- That issue's selected reviewer is the only QA agent whose verdict can close or hand back the issue during that review cycle.
- If the issue leaves QA and later re-enters `in_review`, reuse the previous reviewer when still eligible; otherwise choose a new reviewer from the pool.
- `companies.releaseGateQaAgentId` becomes an optional preferred-reviewer hint or tie-breaker, not the sole authorized release-gate owner.
- Heartbeat may reassign a QA-owned issue only when the selected reviewer is missing or ineligible, not just because another QA agent is globally preferred.

## Working Rules

- Use `@test-driven-development` throughout.
- Use `@verification-before-completion` before claiming the work is done.
- Start implementation in a clean worktree or isolated branch. The current repo already contains overlapping QA-related edits, so this slice should not be mixed into unrelated local changes.
- Preserve the single-assignee issue invariant and company-scoped access rules.
- Keep same-issue recovery semantics. Do not reintroduce successor-issue style QA handoff.
- Update docs and onboarding prompts in the same change.

## File Structure

### Database and shared contracts

- Modify `packages/db/src/schema/issues.ts`
  - add nullable `qaReviewerAgentId` referencing `agents.id`
- Modify `packages/shared/src/types/issue.ts`
  - expose `qaReviewerAgentId` on issue payloads
  - add reviewer provenance to `IssueQaGate` if needed for UI/debugging
- Modify `packages/shared/src/validators/issue.ts`
  - validate `qaReviewerAgentId`
- Create `packages/shared/src/qa-routing.ts`
  - pure types and selection helpers for pooled QA routing
- Modify `packages/shared/src/index.ts`
  - export the new QA routing helper/types

### Server routing and policy

- Create `server/src/services/qa-routing.ts`
  - load the company QA pool
  - compute open-load counts for eligible QA agents
  - choose a reviewer using sticky reuse plus least-load fallback
- Modify `server/src/routes/issues.ts`
  - route `in_review` transitions through pooled reviewer selection
  - persist `qaReviewerAgentId`
  - enforce reviewer-owned `done` and handback transitions
- Modify `server/src/services/qa-gate.ts`
  - trust issue-level reviewer ownership instead of a company-wide exclusive owner
- Modify `server/src/services/issue-qa-finalization.ts`
  - align QA auto-close/auto-merge with issue-level reviewer ownership
- Modify `server/src/services/heartbeat.ts`
  - stop forcing every delivery issue onto one global QA owner
  - only reassign when the chosen reviewer is unavailable or invalid
- Modify `server/src/services/issue-workflows.ts`
  - select and persist pooled reviewers for QA lanes when they become actionable
- Modify `server/src/services/workflow-qa-lane-gate.ts`
  - trust the lane's selected reviewer for authorized verdict lookup
- Modify `server/src/services/companies.ts`
  - keep the existing company field but present it as a routing preference
- Modify onboarding prompts:
  - `server/src/onboarding-assets/qa/AGENTS.md`
  - `server/src/onboarding-assets/ceo/AGENTS.md`
  - `server/src/onboarding-assets/coo/AGENTS.md`

### UI

- Modify `ui/src/pages/CompanySettings.tsx`
  - rename copy from exclusive-owner language to preferred-reviewer language
- Modify `ui/src/lib/qa-gate-presentation.ts`
  - surface pool shortage vs reviewer mismatch accurately
- Modify `ui/src/lib/issue-update-errors.ts`
  - map new/updated QA routing failures
- Modify `ui/src/components/IssueWorkflowPanel.tsx`
  - show the selected QA reviewer for workflow lanes
- Modify `ui/src/pages/IssueDetail.tsx`
  - surface current QA reviewer when useful

### Tests

- Create `packages/shared/src/qa-routing.test.ts`
  - pure selection behavior: sticky reuse, preferred tie-breaker, least-load fallback
- Modify `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Modify `server/src/__tests__/issue-qa-finalization.test.ts`
- Modify `server/src/__tests__/issue-workflows.test.ts`
- Modify one heartbeat routing suite:
  - `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
  - or `server/src/__tests__/operations-heartbeat-routing.test.ts`
- Modify UI tests:
  - `ui/src/pages/CompanySettings.test.tsx`
  - `ui/src/lib/issue-update-errors.test.ts`
  - `ui/src/components/IssueWorkflowPanel.test.tsx`

### Docs

- Modify `doc/PRODUCT.md`
- Modify `doc/SPEC-implementation.md`
- Modify `doc/spec/agents-runtime.md`
- Modify `doc/spec/ui.md`
- Modify `docs/api/companies.md`
- Modify `docs/api/issues.md`

## API Shape To Ship

Add issue-level reviewer ownership instead of inferring everything from a company-wide resolver:

```ts
interface Issue {
  assigneeAgentId: string | null;
  qaReviewerAgentId: string | null;
  qaGate?: {
    isDeliveryScoped: boolean;
    canShip: boolean;
    missingRequirements: IssueQaGateReasonCode[];
    lastQaSummaryAt: Date | null;
    authorizedReviewerAgentId?: string | null;
  } | null;
}
```

Shared pooled-selection helper:

```ts
type QaReviewerSelectionReason =
  | "sticky_reuse"
  | "preferred_tiebreaker"
  | "least_loaded"
  | "none";

type QaReviewerSelection = {
  reviewerAgentId: string | null;
  reason: QaReviewerSelectionReason;
  eligibleAgentIds: string[];
};
```

Selection order:

1. reuse `issue.qaReviewerAgentId` if still eligible
2. otherwise sort eligible QA agents by open assigned review load ascending
3. break equal-load ties by configured preferred reviewer
4. break remaining ties by healthier runtime state (`idle` before `active`/`running`) and then stable ID

Important: the preferred reviewer is a tie-breaker, not a hard override. Otherwise the system recreates the bottleneck under a different name.

## Task 1: Add Issue-Scoped QA Reviewer State

**Files:**
- Modify: `packages/db/src/schema/issues.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/validators/issue.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Add or update tests to prove:
- entering `in_review` persists `qaReviewerAgentId`
- workflow QA lanes persist `qaReviewerAgentId` when they become actionable
- `qaReviewerAgentId` survives a QA handback and is available for sticky reuse

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- FAIL because issues do not yet persist any reviewer-specific QA ownership field.

- [ ] **Step 2: Add the schema column**

In `packages/db/src/schema/issues.ts`, add nullable `qaReviewerAgentId` as a foreign key to `agents.id`.

Then generate the migration:

```bash
pnpm db:generate
```

Expected:
- new migration file under `packages/db/src/migrations/`

- [ ] **Step 3: Wire shared contracts**

Update:
- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts`

Requirements:
- issue read shapes expose `qaReviewerAgentId`
- issue validation accepts `qaReviewerAgentId` in normalized server payloads
- QA gate payloads can expose reviewer provenance if the UI needs it

- [ ] **Step 4: Re-run focused tests and typecheck**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
pnpm -r typecheck
```

Expected:
- tests still FAIL, but now at routing logic rather than missing schema/contract fields
- typecheck PASS

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/db/src/schema/issues.ts packages/db/src/migrations packages/shared/src/types/issue.ts packages/shared/src/validators/issue.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
git commit -m "feat: add issue scoped qa reviewer state"
```

## Task 2: Introduce Shared Pooled QA Selection

**Files:**
- Create: `packages/shared/src/qa-routing.ts`
- Create: `packages/shared/src/qa-routing.test.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `server/src/services/qa-routing.ts`

- [ ] **Step 1: Write failing pure selection tests**

Add tests for:
- sticky reviewer reuse when `qaReviewerAgentId` is still eligible
- multiple eligible QA agents no longer produce an ambiguity failure
- preferred reviewer only wins on equal load, not by overriding a less-loaded agent
- least-loaded fallback is deterministic

Run:

```bash
pnpm vitest run packages/shared/src/qa-routing.test.ts
```

Expected:
- FAIL because pooled QA routing helper does not exist yet.

- [ ] **Step 2: Implement the shared selector**

Create `packages/shared/src/qa-routing.ts` with a pure function roughly shaped like:

```ts
selectQaReviewer({
  stickyReviewerAgentId,
  preferredReviewerAgentId,
  eligibleAgents,
  openAssignedIssueCountByAgentId,
}): QaReviewerSelection
```

Requirements:
- no `ambiguous` failure for healthy multi-QA rosters
- stable deterministic ordering
- preferred reviewer is only a tie-breaker

- [ ] **Step 3: Export the shared helper**

Update `packages/shared/src/index.ts` so server code imports one shared source of truth.

- [ ] **Step 4: Build the DB-backed server selector**

Create `server/src/services/qa-routing.ts`.

Responsibilities:
- list eligible QA agents for a company
- derive open assigned review counts
- call the shared selector
- return the chosen reviewer and selection reason

- [ ] **Step 5: Re-run focused tests**

Run:

```bash
pnpm vitest run packages/shared/src/qa-routing.test.ts
pnpm -r typecheck
```

Expected:
- PASS

- [ ] **Step 6: Commit the selector slice**

```bash
git add packages/shared/src/qa-routing.ts packages/shared/src/qa-routing.test.ts packages/shared/src/index.ts server/src/services/qa-routing.ts
git commit -m "feat: add pooled qa reviewer selection"
```

## Task 3: Rewire Standalone Delivery QA Routing And Closure

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/qa-gate.ts`
- Modify: `server/src/services/issue-qa-finalization.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test: `server/src/__tests__/issue-qa-finalization.test.ts`

- [ ] **Step 1: Write failing route/finalization tests**

Cover:
- entering `in_review` with three healthy QA agents chooses one reviewer instead of erroring as ambiguous
- the chosen reviewer becomes both `assigneeAgentId` and `qaReviewerAgentId`
- a different QA agent cannot close or hand back the issue
- re-entering `in_review` reuses the prior reviewer when still eligible

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
```

Expected:
- FAIL because standalone delivery still enforces company-wide release-gate ownership.

- [ ] **Step 2: Route `in_review` through pooled selection**

Update `server/src/routes/issues.ts` so:
- `in_review` transitions call `qa-routing.ts`
- selected reviewer is written into both `assigneeAgentId` and `qaReviewerAgentId`
- “ambiguous QA owner” comments are removed or rewritten to only cover the zero-eligible case

- [ ] **Step 3: Make the QA gate trust issue-level reviewer ownership**

Update:
- `server/src/services/qa-gate.ts`
- `server/src/services/issue-qa-finalization.ts`

Requirements:
- the authorized QA verdict author is `issue.qaReviewerAgentId` (falling back to current QA assignee only where safe)
- `done` and QA auto-close no longer depend on a company-wide sole owner

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit the standalone QA routing slice**

```bash
git add server/src/routes/issues.ts server/src/services/qa-gate.ts server/src/services/issue-qa-finalization.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts
git commit -m "feat: route standalone qa through reviewer pool"
```

## Task 4: Rewire Heartbeat Recovery And Workflow QA Lanes

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/issue-workflows.ts`
- Modify: `server/src/services/workflow-qa-lane-gate.ts`
- Test: `server/src/__tests__/issue-workflows.test.ts`
- Test: `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
- or Test: `server/src/__tests__/operations-heartbeat-routing.test.ts`

- [ ] **Step 1: Write failing heartbeat/workflow tests**

Cover:
- heartbeat does not demote an `in_review` issue just because multiple QA agents are eligible
- heartbeat only reassigns when the chosen reviewer is now ineligible or missing
- workflow QA lanes choose a pooled reviewer when they become actionable
- workflow QA gate trusts the lane's selected reviewer comment

Run:

```bash
pnpm vitest run server/src/__tests__/issue-workflows.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts
```

Expected:
- FAIL because heartbeat/workflow still force a single company-wide QA owner model.

- [ ] **Step 2: Update heartbeat QA repair logic**

In `server/src/services/heartbeat.ts`:
- remove reassignment-to-global-owner behavior
- keep zero-eligible handling as a real blocker
- when current reviewer is ineligible, select a replacement from the pool and update both `assigneeAgentId` and `qaReviewerAgentId`

- [ ] **Step 3: Update workflow QA lane routing**

In `server/src/services/issue-workflows.ts`:
- when a QA lane becomes actionable, select a reviewer from the pool
- persist `qaReviewerAgentId` for the lane
- prefer sticky reuse on re-opened QA lanes when the previous reviewer is still eligible

- [ ] **Step 4: Update workflow verdict authorization**

In `server/src/services/workflow-qa-lane-gate.ts`:
- authorized QA comments come from the lane's selected reviewer
- do not use company-wide exclusive owner semantics

- [ ] **Step 5: Re-run focused tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-workflows.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit the workflow/heartbeat slice**

```bash
git add server/src/services/heartbeat.ts server/src/services/issue-workflows.ts server/src/services/workflow-qa-lane-gate.ts server/src/__tests__/issue-workflows.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts
git commit -m "feat: use pooled qa routing in workflows and heartbeat"
```

## Task 5: Update UI And Operator Copy

**Files:**
- Modify: `ui/src/pages/CompanySettings.tsx`
- Modify: `ui/src/pages/CompanySettings.test.tsx`
- Modify: `ui/src/lib/qa-gate-presentation.ts`
- Modify: `ui/src/lib/issue-update-errors.ts`
- Modify: `ui/src/lib/issue-update-errors.test.ts`
- Modify: `ui/src/components/IssueWorkflowPanel.tsx`
- Modify: `ui/src/components/IssueWorkflowPanel.test.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover:
- company settings label describes a preferred QA reviewer, not an exclusive release-gate owner
- issue/workflow UI can render selected reviewer ownership
- QA routing errors only mention missing QA capacity, not ambiguity from multiple healthy QA agents

Run:

```bash
pnpm vitest run ui/src/pages/CompanySettings.test.tsx ui/src/lib/issue-update-errors.test.ts ui/src/components/IssueWorkflowPanel.test.tsx
```

Expected:
- FAIL because current UI copy still describes a single authorized QA owner.

- [ ] **Step 2: Update settings and presentation copy**

Requirements:
- `releaseGateQaAgentId` copy becomes “Preferred QA reviewer” or equivalent
- issue/workflow surfaces show the reviewer actually selected for the issue
- error copy differentiates “no eligible QA reviewer” from “wrong reviewer attempted closure”

- [ ] **Step 3: Re-run focused UI tests**

Run:

```bash
pnpm vitest run ui/src/pages/CompanySettings.test.tsx ui/src/lib/issue-update-errors.test.ts ui/src/components/IssueWorkflowPanel.test.tsx
```

Expected:
- PASS

- [ ] **Step 4: Commit the UI slice**

```bash
git add ui/src/pages/CompanySettings.tsx ui/src/pages/CompanySettings.test.tsx ui/src/lib/qa-gate-presentation.ts ui/src/lib/issue-update-errors.ts ui/src/lib/issue-update-errors.test.ts ui/src/components/IssueWorkflowPanel.tsx ui/src/components/IssueWorkflowPanel.test.tsx ui/src/pages/IssueDetail.tsx
git commit -m "feat: update ui for pooled qa routing"
```

## Task 6: Update Onboarding Prompts And Docs

**Files:**
- Modify: `server/src/onboarding-assets/qa/AGENTS.md`
- Modify: `server/src/onboarding-assets/ceo/AGENTS.md`
- Modify: `server/src/onboarding-assets/coo/AGENTS.md`
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/spec/agents-runtime.md`
- Modify: `doc/spec/ui.md`
- Modify: `docs/api/companies.md`
- Modify: `docs/api/issues.md`

- [ ] **Step 1: Update agent-role prompts**

Requirements:
- QA prompt says the selected issue reviewer owns the `in_review` decision for that issue
- CEO/COO prompts stop implying a single company-wide QA closer
- prompts still preserve one accountable reviewer per issue

- [ ] **Step 2: Update product and API docs**

Document:
- pooled QA routing semantics
- issue-level `qaReviewerAgentId`
- company setting semantics as routing preference
- heartbeat/workflow behavior when a selected reviewer becomes unavailable

- [ ] **Step 3: Run doc-sensitive tests or snapshots if any fail locally**

Run any affected test subset first if doc/UI snapshots exist, then include these docs in the final verification pass.

- [ ] **Step 4: Commit the docs slice**

```bash
git add server/src/onboarding-assets/qa/AGENTS.md server/src/onboarding-assets/ceo/AGENTS.md server/src/onboarding-assets/coo/AGENTS.md doc/PRODUCT.md doc/SPEC-implementation.md doc/spec/agents-runtime.md doc/spec/ui.md docs/api/companies.md docs/api/issues.md
git commit -m "docs: describe pooled qa routing model"
```

## Task 7: Final Verification

**Files:**
- Verify the whole repo after all previous tasks land

- [ ] **Step 1: Run full typecheck**

```bash
pnpm -r typecheck
```

Expected:
- PASS

- [ ] **Step 2: Run full test suite**

```bash
pnpm test:run
```

Expected:
- PASS

- [ ] **Step 3: Run production build**

```bash
pnpm build
```

Expected:
- PASS

- [ ] **Step 4: Run a manual QA routing smoke**

Manual scenario:
- create or use a company with at least three healthy QA agents
- create two or more delivery issues and move them into `in_review`
- confirm different issues can be routed to different QA reviewers concurrently
- confirm only the selected reviewer can close each issue
- pause one selected reviewer and confirm heartbeat reassigns only that issue, not every in-review issue

- [ ] **Step 5: Record any blockers explicitly**

If any of the commands fail because of unrelated pre-existing changes in the worktree, record the exact failing command and why it is unrelated before hand-off.
