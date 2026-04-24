# Issue Action Engine Design

Date: 2026-04-22
Status: Approved for implementation

## Goal

Make issue workflow mutations server-owned, typed, and centralized so invalid workflow writes become unrepresentable at the API boundary instead of being discovered later through comment parsing, route drift, or heartbeat reconciliation.

## Problem

The current issue workflow surface is split across multiple control paths:

- `server/src/routes/issues.ts` accepts raw `PATCH /issues/:id` status mutations and embeds transition rules inline.
- `server/src/routes/issues.ts` also accepts free-form `POST /issues/:id/comments` bodies and parses comment text to discover workflow intent such as QA verdict truth.
- `server/src/services/heartbeat.ts` and related integrity sweeps must reconcile false-complete or drifted control-plane state after the fact.
- `ui/src/api/issues.ts` and external callers can still construct route paths ad hoc, which leads to path drift such as `/workProducts` versus `/work-products`.

This architecture is functional but inherently brittle. It produces failure modes that are expensive to eliminate one by one:

- QA verdict comments fail with `422` because prose formatting diverges from the parser contract.
- `done` transitions fail with `422` because the status route and the QA route enforce overlapping rules in different places.
- clients guess nonexistent workflow routes like `/issues/:id/transitions`
- reconciliation code becomes responsible for normal correctness instead of exceptional repair

The missing contract is a canonical server-side issue action engine that owns workflow intent.

## Recommendation

Adopt a compatibility-first action engine migration:

- add one canonical server-side `IssueActionEngine`
- define a shared typed action contract in `packages/shared`
- expose typed action routes such as `POST /issues/:id/actions`
- keep legacy workflow-affecting routes temporarily, but make them thin adapters into the same engine
- move human-readable audit comments to server-generated artifacts from successful actions

This preserves backward compatibility while making one central engine the only authority for workflow transitions.

## Alternatives Considered

### 1. Parser hardening only

Rejected.

Adding more regexes, aliases, or tolerant comment parsing may reduce the current `422` rate, but it preserves the core problem: prose remains the control surface. Invalid states stay representable, and reconciliation stays part of ordinary operation.

### 2. Immediate hard cutover to typed workflow routes

Rejected for the first migration.

This is architecturally clean, but it would break active agents, UI flows, and any external callers immediately. The repo already has multiple legacy callers, so a flag day would be risky and operationally noisy.

### 3. Full event-sourced workflow rewrite

Rejected for V1.

An event-sourced workflow ledger may be a good future direction, but it is a larger persistence and operational redesign than needed to solve the current correctness failures. V1 should centralize decisions first while reusing existing issue, comment, activity-log, and QA services.

## Action Model

The shared contract should define:

- `IssueActionType`
- `IssueActionRequest`
- `IssueActionResult`
- payload types for each state-changing action

Initial high-value actions:

- `enter_review`
- `submit_qa_verdict`
- `complete_issue`
- `reopen_issue`
- `append_note`

Follow-on actions after the first migration slice:

- `record_blocker`
- `resolve_blocker`
- `handoff_issue`
- `assign_issue`
- `request_changes`
- `submit_execution_decision`

Boundary rule:

- `append_note` is informational only and cannot mutate workflow state.
- Every workflow-changing action is validated before any DB mutation.

## QA Verdict Contract

`submit_qa_verdict` should replace workflow intent encoded in free-form comments with structured input:

- review dimensions:
  - `codeQuality`
  - `errorHandling`
  - `testCoverage`
  - `commentQuality`
  - `docsImpact`
- verification dimensions:
  - `typecheck`
  - `tests`
  - `build`
  - `smoke`
- booleans:
  - `qaPass`
  - `releaseConfirmed`
- optional free-text:
  - summary
  - verification evidence

The server remains responsible for:

- validating the release gate from structured data
- applying any state transition implied by a passing verdict
- generating the canonical QA audit comment body
- preserving the existing QA activity and artifact side effects

This removes the current requirement that callers author exact marker syntax in comment prose to satisfy workflow rules.

## Route Shape

Add a new typed route:

- `POST /issues/:id/actions`

The request body should carry:

- `type`
- structured `payload`
- optional metadata only when the engine explicitly needs it

Route handlers should become adapters:

- `PATCH /issues/:id`
  - `status=in_review` maps to `enter_review`
  - `status=done` maps to `complete_issue`
  - reopening a closed issue maps to `reopen_issue`
  - non-workflow field edits stay as direct issue updates
- `POST /issues/:id/comments`
  - plain comments map to `append_note`
  - legacy QA marker comments map to `submit_qa_verdict`

This preserves compatibility while making the action engine the only place that enforces workflow rules.

## Persistence Strategy

Phase 1 does not require a new database table.

The engine can reuse existing persistence primitives:

- issue rows for workflow state
- issue comments for audit output
- activity logs for mutation visibility
- existing QA workflow services for routing/finalization side effects

If later needed, a dedicated `issue_actions` ledger can be added as a follow-up once the engine contract is stable and widely adopted.

## Centralization Rules

The action engine should own:

- allowed transition validation
- actor permission checks specific to workflow mutation
- QA gate evaluation
- canonical audit comment generation for workflow actions
- reusable action results for routes, UI, and future reconciliation

Routes should no longer own:

- duplicated transition logic
- comment-body parsing for state changes beyond compatibility translation
- route-specific QA gate decisions

Heartbeat and integrity sweeps should:

- consume the same engine outputs and helpers where practical
- treat reconciliation as exceptional repair for legacy drift or crash recovery, not the main correctness path

## Migration Plan

1. Build the action engine and shared action types.
2. Add typed `POST /issues/:id/actions` support for `enter_review`, `submit_qa_verdict`, `complete_issue`, `reopen_issue`, and `append_note`.
3. Convert `PATCH /issues/:id` and `POST /issues/:id/comments` workflow paths into compatibility adapters that call the engine.
4. Update UI issue APIs to use typed actions directly.
5. Update agents and automation prompts to stop encoding workflow control in prose.
6. Tighten legacy behavior so direct workflow status writes and workflow-affecting free-form comments are rejected once callers are migrated.

## Documentation Impact

Implementation must update:

- `doc/SPEC-implementation.md` to describe the canonical action-engine workflow control surface
- relevant developer or agent instructions that currently depend on comment-authored workflow truth
- any API documentation that currently implies free-form comments or raw status patches are the primary workflow control path

## Risks

### Compatibility adapter drift

During migration, legacy routes may still carry subtle workflow cases that are not yet mapped into typed actions. The first slice should focus on the highest-risk transitions only and add explicit tests around each mapped legacy behavior.

### Partial centralization

If routes continue to mutate workflow state directly in corner cases, the repo will retain two sources of truth. The implementation must keep the engine as the only owner for the selected action family, even if some secondary actions remain on legacy paths temporarily.

### Over-coupling to current comment format

Compatibility parsing should remain intentionally narrow and temporary. The design goal is to translate legacy inputs into structured actions, not to preserve unbounded comment parsing forever.

### UI and agent lag

Legacy callers will keep exercising adapters until they are migrated. Phase 1 therefore needs clear server-side metrics and test coverage around adapter translation so operational behavior stays visible while the cutover is in progress.
