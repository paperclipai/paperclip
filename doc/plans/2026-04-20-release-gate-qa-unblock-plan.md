# Release-Gate QA Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the QA gate operable again by introducing one shared release-gate owner resolver that supports explicit company configuration, safe fallback for single-QA companies, and identical behavior across standalone and workflow delivery.

**Architecture:** Add a company-level `releaseGateQaAgentId` setting and a single shared resolver used by all release QA entry points. Resolution order is: configured owner if eligible, otherwise one canonical `QA and Release Engineer`, otherwise one eligible QA fallback, otherwise blocked with an explicit reason. Keep the existing latest-verdict QA semantics and workflow handback behavior; this slice is about ownership resolution and unblockability, not a workflow redesign.

**Tech Stack:** TypeScript, Express, React, Drizzle/Postgres, shared contracts in `packages/shared`, Vitest, Testing Library.

---

## Scope Check

This plan directly addresses the current operational problem:

- workflow QA can be completely blocked when no single canonical QA owner resolves
- standalone and workflow release QA still use different ownership rules
- there is no explicit board-managed company setting for "who owns the release gate"

This plan intentionally does **not** cover:

- workflow history timeline UI
- root workflow completion-state cleanup
- stale-artifact next-action hints
- changing latest-verdict QA semantics

Those are follow-on improvements after QA is no longer deadlocked.

## Product Decision

Use one release-gate QA resolver everywhere with this precedence:

1. `companies.releaseGateQaAgentId` if it points to an eligible QA agent in the same company
2. exactly one eligible canonical `QA and Release Engineer`
3. exactly one eligible QA agent as fallback
4. otherwise block and surface the reason

Why this is better than the prior plan:

- it unblocks multi-QA companies via explicit configuration
- it unblocks single-QA companies even if the QA agent is not canonically named
- it preserves the current canonical path when it exists
- it removes the current standalone vs workflow policy split

## Working Rules

- Use `@test-driven-development` throughout.
- Use `@verification-before-completion` before claiming the work is done.
- Keep ownership resolution company-scoped and agent-eligibility checked.
- Preserve existing latest-authorized-verdict QA behavior.
- Update docs in the same change.

## File Structure

### Database

- Modify `packages/db/src/schema/companies.ts`
  - add nullable `releaseGateQaAgentId`
- Modify `packages/db/src/schema/index.ts`
  - ensure schema export remains current
- Generate migration with `pnpm db:generate`

### Shared contracts and validators

- Modify `packages/shared/src/types/company.ts`
  - add configured and resolved release-gate QA fields
- Modify `packages/shared/src/types/company-portability.ts`
  - add portable release-gate QA manifest field
- Modify `packages/shared/src/validators/company.ts`
  - allow updating `releaseGateQaAgentId`
- Modify `packages/shared/src/validators/company-portability.ts`
  - validate the portability field
- Modify `packages/shared/src/release-gate-qa.ts`
  - expose one shared resolver with source and failure metadata
- Modify `packages/shared/src/index.ts`
  - export the updated helper and types

### Server

- Modify `server/src/services/companies.ts`
  - select, validate, persist, and expose company release-gate QA configuration
- Modify `server/src/routes/companies.ts`
  - accept board updates to `releaseGateQaAgentId`
- Modify `server/src/routes/issues.ts`
  - use the shared release-gate resolver for standalone QA routing and gating
- Modify `server/src/services/issue-qa-finalization.ts`
  - use the shared resolver for QA pass auto-close / auto-merge
- Modify `server/src/services/heartbeat.ts`
  - use the shared resolver for heartbeat-side QA routing
- Modify `server/src/services/workflow-qa-lane-gate.ts`
  - stop using a canonical-only local resolver; use the shared release-gate resolver
- Modify `server/src/services/issue-workflows.ts`
  - assign workflow QA lanes from the shared resolver on template apply and unblock
- Modify `server/src/services/agent-heartbeat-model.ts`
  - align `ensureCompanyHasQaReleaseEngineer()` behavior with the new configured/fallback model
- Modify `server/src/services/company-portability.ts`
  - export/import the release-gate QA setting in a portable way

### UI

- Modify `ui/src/api/companies.ts`
  - allow updating the new company field
- Modify `ui/src/pages/CompanySettings.tsx`
  - add a release-gate QA owner picker and resolution status
- Modify `ui/src/pages/CompanySettings.test.tsx`
  - cover save behavior and visible resolution states

### Tests

- Modify `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Modify `server/src/__tests__/issue-qa-finalization.test.ts`
- Modify `server/src/__tests__/issue-workflows.test.ts`
- Modify `server/src/__tests__/company-portability.test.ts`
- Modify `ui/src/pages/CompanySettings.test.tsx`

### Docs

- Modify `docs/api/issues.md`
- Modify `doc/PRODUCT.md`
- Modify `doc/SPEC-implementation.md`
- Modify `doc/plans/2026-04-20-control-plane-workflow-map.md`

## API Shape To Ship

Add explicit release-gate QA ownership data to `Company`:

```ts
type ReleaseGateQaResolutionSource =
  | "configured"
  | "canonical"
  | "single_fallback"
  | "none"
  | "ambiguous"
  | "configured_unavailable";

company = {
  ...,
  releaseGateQaAgentId: string | null,           // board-configured owner
  resolvedReleaseGateQaAgentId: string | null,   // current effective owner
  releaseGateQaResolutionSource: ReleaseGateQaResolutionSource,
  releaseGateQaBlockingReason: string | null,
};
```

Rules:

- `releaseGateQaAgentId` is operator intent
- `resolvedReleaseGateQaAgentId` is what the server will actually use now
- `releaseGateQaResolutionSource` explains why that owner was chosen
- `releaseGateQaBlockingReason` explains why QA is blocked when no owner resolves

For portability, store the configured owner by stable agent slug or url key, not raw UUID.

## Task 1: Add Shared Release-Gate QA Resolution Metadata

**Files:**
- Modify: `packages/shared/src/release-gate-qa.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Write failing resolver-behavior tests**

Add coverage for:
- configured QA owner wins when eligible
- canonical QA owner wins when no configured owner is set
- single eligible QA fallback resolves when no configured/canonical owner exists
- multiple eligible QA agents with no configured/canonical owner stays blocked
- configured owner that is paused/terminated stays blocked with `configured_unavailable`

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- FAIL because the shared resolver does not expose configured/fallback metadata yet.

- [ ] **Step 2: Extend `release-gate-qa.ts`**

Return structured resolution data:
- `releaseGateQaAgent`
- `resolutionSource`
- `eligibleQaAgents`
- `canonicalQaAgents`
- `blockingReason`

Do not keep separate canonical-only and fallback-capable resolvers in different server files.

- [ ] **Step 3: Export the new helper**

Update `packages/shared/src/index.ts`.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- still FAIL, but now in server consumers rather than helper shape.

- [ ] **Step 5: Commit the shared resolver slice**

```bash
git add packages/shared/src/release-gate-qa.ts packages/shared/src/index.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-workflows.test.ts
git commit -m "refactor: add shared release gate qa resolution metadata"
```

## Task 2: Add Company-Level Release-Gate QA Configuration

**Files:**
- Modify: `packages/db/src/schema/companies.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/shared/src/types/company.ts`
- Modify: `packages/shared/src/validators/company.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `server/src/services/companies.ts`
- Modify: `server/src/routes/companies.ts`
- Modify: `ui/src/api/companies.ts`
- Test: `ui/src/pages/CompanySettings.test.tsx`

- [ ] **Step 1: Write failing company-settings tests**

Cover:
- board can save `releaseGateQaAgentId`
- invalid company-external agent id is rejected
- non-QA or ineligible configured owner is rejected

Run:

```bash
pnpm vitest run ui/src/pages/CompanySettings.test.tsx
```

Expected:
- FAIL because the company contract and UI do not expose the new field.

- [ ] **Step 2: Add DB column and migration**

Add nullable `releaseGateQaAgentId` to `companies`.

Run:

```bash
pnpm db:generate
```

Expected:
- new migration generated successfully.

- [ ] **Step 3: Extend shared company contract**

Add:
- `releaseGateQaAgentId`
- `resolvedReleaseGateQaAgentId`
- `releaseGateQaResolutionSource`
- `releaseGateQaBlockingReason`

Extend `updateCompanySchema` to accept `releaseGateQaAgentId`.

- [ ] **Step 4: Persist and validate company setting**

Update `server/src/services/companies.ts` and `server/src/routes/companies.ts` so:
- configured owner must belong to the company
- configured owner must be a QA agent
- configured owner must be eligible or the save is rejected, depending on chosen UX

Recommended UX:
- allow saving any same-company QA agent
- compute `configured_unavailable` when status later becomes ineligible

- [ ] **Step 5: Extend company API client**

Update `ui/src/api/companies.ts` to send and receive the new field.

- [ ] **Step 6: Re-run focused tests**

Run:

```bash
pnpm vitest run ui/src/pages/CompanySettings.test.tsx
pnpm -r typecheck
```

Expected:
- types compile, UI tests still fail until the settings page is updated.

- [ ] **Step 7: Commit the company-config slice**

```bash
git add packages/db/src/schema/companies.ts packages/db/src/schema/index.ts packages/shared/src/types/company.ts packages/shared/src/validators/company.ts packages/shared/src/index.ts server/src/services/companies.ts server/src/routes/companies.ts ui/src/api/companies.ts ui/src/pages/CompanySettings.test.tsx
git commit -m "feat: add company release gate qa configuration"
```

## Task 3: Unify Standalone And Workflow QA On The Shared Resolver

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/issue-qa-finalization.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/workflow-qa-lane-gate.ts`
- Modify: `server/src/services/issue-workflows.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Test: `server/src/__tests__/issue-qa-finalization.test.ts`
- Test: `server/src/__tests__/issue-workflows.test.ts`

- [ ] **Step 1: Write failing unified-policy tests**

Cover these cases for both standalone and workflow delivery:
- configured owner wins over canonical/fallback
- canonical owner works with no configured owner
- single eligible fallback works when there is no configured/canonical owner
- multiple QA agents with no configured/canonical owner blocks QA

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- FAIL because workflow and standalone still resolve ownership differently.

- [ ] **Step 2: Replace workflow-local owner resolution**

Update `server/src/services/workflow-qa-lane-gate.ts` and `server/src/services/issue-workflows.ts` to consume the shared resolver.

This includes:
- QA lane completion
- QA lane apply-template assignment
- QA lane unblock reassignment

- [ ] **Step 3: Replace standalone release-gate resolution**

Update:
- `server/src/routes/issues.ts`
- `server/src/services/issue-qa-finalization.ts`
- `server/src/services/heartbeat.ts`

Use the same shared resolver for:
- auto-routing into QA
- `done` gate checks
- QA pass auto-close / auto-merge

- [ ] **Step 4: Align QA coverage auto-creation**

Update `server/src/services/agent-heartbeat-model.ts` so `ensureCompanyHasQaReleaseEngineer()` still makes sense with the new resolver.

Minimum expectation:
- keep creating a canonical QA-and-Release agent when the company has no QA coverage at all
- do not let this helper silently fight an explicit configured owner

- [ ] **Step 5: Re-run focused QA tests**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-workflows.test.ts
```

Expected:
- PASS with identical release-gate ownership semantics across standalone and workflow delivery.

- [ ] **Step 6: Commit the unified QA resolver slice**

```bash
git add server/src/routes/issues.ts server/src/services/issue-qa-finalization.ts server/src/services/heartbeat.ts server/src/services/workflow-qa-lane-gate.ts server/src/services/issue-workflows.ts server/src/services/agent-heartbeat-model.ts server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-workflows.test.ts
git commit -m "feat: unify release gate qa resolution across workflows"
```

## Task 4: Surface Release-Gate QA Status In Company Settings

**Files:**
- Modify: `ui/src/pages/CompanySettings.tsx`
- Modify: `ui/src/pages/CompanySettings.test.tsx`
- Possibly modify: `ui/src/api/agents.ts`

- [ ] **Step 1: Add failing Company Settings UI tests**

Cover:
- current resolved QA owner is shown
- resolution source is shown
- blocking state is shown when no owner resolves
- board can choose a QA agent and save it

Run:

```bash
pnpm vitest run ui/src/pages/CompanySettings.test.tsx
```

Expected:
- FAIL because the UI does not render a release-gate QA section.

- [ ] **Step 2: Add QA owner picker**

In `CompanySettings.tsx`:
- fetch company QA agents
- render a board-only selector for release-gate QA owner
- show current resolved owner and resolution source
- show blocking warning when no effective owner resolves

- [ ] **Step 3: Re-run UI tests**

Run:

```bash
pnpm vitest run ui/src/pages/CompanySettings.test.tsx
```

Expected:
- PASS.

- [ ] **Step 4: Commit the settings UI slice**

```bash
git add ui/src/pages/CompanySettings.tsx ui/src/pages/CompanySettings.test.tsx ui/src/api/agents.ts
git commit -m "feat: add release gate qa owner settings ui"
```

## Task 5: Keep Company Portability And Docs In Sync

**Files:**
- Modify: `packages/shared/src/types/company-portability.ts`
- Modify: `packages/shared/src/validators/company-portability.ts`
- Modify: `server/src/services/company-portability.ts`
- Modify: `server/src/__tests__/company-portability.test.ts`
- Modify: `docs/api/issues.md`
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/plans/2026-04-20-control-plane-workflow-map.md`

- [ ] **Step 1: Make the company setting portable**

Persist configured release-gate owner in portability manifests by stable agent reference:
- recommended: agent slug or url key
- not raw UUID

- [ ] **Step 2: Update portability tests**

Run:

```bash
pnpm vitest run server/src/__tests__/company-portability.test.ts
```

Expected:
- PASS with the new company manifest field preserved.

- [ ] **Step 3: Update docs**

Document:
- unified release-gate QA resolution order
- explicit company release-gate QA owner
- fallback semantics for single-QA companies

- [ ] **Step 4: Run focused verification**

Run:

```bash
pnpm vitest run server/src/__tests__/issue-qa-gate-routes.test.ts server/src/__tests__/issue-qa-finalization.test.ts server/src/__tests__/issue-workflows.test.ts server/src/__tests__/company-portability.test.ts ui/src/pages/CompanySettings.test.tsx
pnpm -r typecheck
pnpm build
```

Expected:
- PASS for focused tests, typecheck, and build.

- [ ] **Step 5: Run full verification**

Run:

```bash
pnpm test:run
```

Expected:
- PASS.

If unrelated existing failures remain, report them explicitly rather than claiming full green.

- [ ] **Step 6: Commit docs and verification**

```bash
git add packages/shared/src/types/company-portability.ts packages/shared/src/validators/company-portability.ts server/src/services/company-portability.ts server/src/__tests__/company-portability.test.ts docs/api/issues.md doc/PRODUCT.md doc/SPEC-implementation.md doc/plans/2026-04-20-control-plane-workflow-map.md
git commit -m "docs: sync release gate qa ownership model"
```

## Follow-On Work Explicitly Deferred

After this plan lands:

1. declarative workflow lane completion policy cleanup
2. root workflow completion-state API cleanup
3. workflow history timeline UI
4. stale-artifact next-action hints
