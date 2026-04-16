# Exceptional Reissue Recovery Design

## Context

Issue recovery currently allows a successor issue to replace an in-flight issue through
`recovered_by_reissue` / `superseded` transitions. That mechanism exists in the server
data model and issue services, and the board issue list hides blocked recovery-source
issues when an open successor exists.

The result is that work can appear to disappear and reappear under a new identifier,
even when the real situation is just "this task is stuck". That undermines the board's
ability to reason about progress and makes churn look like forward motion.

The desired policy is stricter:

- a task should stay on the same issue by default, even when a fresh runtime session is needed
- successor issues should be exceptional, not routine
- only the board should be able to create successor/recovery transitions
- board views should not silently hide recovery-source issues by default

## Goals

1. Make "fresh session on the same issue" the default recovery path.
2. Make successor issue creation a board-only exceptional action.
3. Keep stuck work visible to the board instead of replacing it with hidden churn.
4. Align onboarding `AGENTS.md` files with the new workflow rule.

## Non-Goals

- removing the recovery relation model from the database
- deleting existing recovery links or repairing historical data
- redesigning issue status semantics beyond this recovery policy
- introducing a new approvals workflow for board-created successor issues

## Approved Product Decision

### Canonical work object

The issue remains the canonical unit of work. Session rotation is allowed. Issue
replacement is not normal recovery.

### Default stuck-work handling

When a task is stuck because of context overflow, poisoned runtime state, or similar
execution failures:

- keep the same issue
- rotate to a fresh runtime session
- post recovery truth on that same issue
- continue execution from the same issue identifier

### Exceptional successor handling

Creating a successor issue is still allowed in the model, but only as an explicit
board action. Agents, operations flows, and plugins acting as agents must not be able
to create or apply recovery transitions on their own.

## Design

### 1. Backend enforcement

Add actor checks in the issue routes so recovery transitions are board-only:

- `POST /companies/:companyId/issues`
  - reject `recoveryFromIssueId` and `recoveryDisposition` unless `req.actor.type === "board"`
- `PATCH /issues/:id`
  - reject `recovery` unless `req.actor.type === "board"`

This keeps the underlying service-layer recovery logic intact while removing autonomous
access to it. It is the smallest enforcement change that matches the desired policy.

### 2. Preserve same-issue recovery

Do not remove fresh-session rotation. The runtime can still rotate sessions on the same
issue when execution state is poisoned. That behavior already exists independently from
successor issue creation and should remain the primary recovery mechanism.

### 3. Board visibility

Stop hiding blocked recovery-source issues by default in board issue lists.

Current board list behavior opts into
`excludeRecoverySourcesWithOpenSuccessors=true` by default. That should be reversed for
board views so the operator can see:

- the original issue that got stuck
- the successor issue if one exists
- the explicit recovery relation between them

The recovery relation pill in Issue Detail remains useful and should stay.

### 4. Agent guidance updates

Update onboarding prompts so agents no longer normalize continuation issues as routine:

- `server/src/onboarding-assets/coo/AGENTS.md`
  - remove instructions that tell COO to create continuation issues for context overflow
  - replace with "keep the same issue, request board recovery if a successor is truly needed"
- `server/src/onboarding-assets/engineer/AGENTS.md`
  - remove the assumption that a continuation issue is the normal active path
- `server/src/onboarding-assets/default/AGENTS.md`
  - align generic recovery guidance with same-issue-first recovery
- root `AGENTS.md`
  - add or update the authoritative invariant so future contributors do not reintroduce
    normal recovery-by-reissue behavior

## File Impact

### Backend

- `server/src/routes/issues.ts`
  - board-only guard for recovery create/update payloads
- `server/src/__tests__/issue-comment-reopen-routes.test.ts`
  - no change expected unless route validation helpers need coverage nearby
- `server/src/__tests__/issues-service.test.ts`
  - keep existing service-level recovery coverage
- add or update route-level tests covering board-only enforcement

### UI

- `ui/src/api/issues.ts`
  - stop defaulting board issue list requests to hidden recovery-source filtering
- `ui/src/pages/Issues.tsx`
  - remove the explicit default opt-in to hidden recovery-source filtering
- `ui/src/pages/ProjectDetail.tsx`
  - same change for project issue lists
- `ui/src/components/IssueProperties.tsx`
  - keep recovery relation display
- add/update UI API tests for default list query behavior

### Agent prompts / docs

- `AGENTS.md`
- `server/src/onboarding-assets/coo/AGENTS.md`
- `server/src/onboarding-assets/engineer/AGENTS.md`
- `server/src/onboarding-assets/default/AGENTS.md`
- relevant product/developer docs if they mention normal continuation/reissue recovery

## Test Strategy

Write failing tests first for:

1. agent cannot create an issue with `recoveryFromIssueId` / `recoveryDisposition`
2. board can still create an issue with recovery payload
3. agent cannot patch an issue with `recovery`
4. board can still patch an issue with `recovery`
5. `issuesApi.list()` no longer excludes recovery-source issues by default
6. main board issue list no longer forces `excludeRecoverySourcesWithOpenSuccessors=true`

Keep existing service-level recovery tests intact so the exceptional board-only path
still has coverage.

## Risks

1. Board lists may feel noisier because both source and successor issues become visible.
   This is acceptable because visibility is the point, but if needed we can later add an
   explicit filter or badge rather than hiding them silently.
2. Some existing agent prompts may still talk about "fresh session" in a way that
   implies successor issue creation. Those prompts need careful wording review.
3. External plugin callers using agent credentials may currently rely on recovery fields.
   After this change they will receive explicit rejection and must escalate to the board.

## Rollout Notes

- This is intentionally a tightening change, not a refactor.
- Keep the data model and relation rendering intact.
- Enforce the new rule at the route boundary and in agent instructions first.
- If further churn remains after this, the next step is auditing which board-side flow
  still chooses recovery transitions too often.
