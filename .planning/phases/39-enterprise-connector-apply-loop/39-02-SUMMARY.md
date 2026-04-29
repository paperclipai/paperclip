---
phase: 39-enterprise-connector-apply-loop
plan: 02
subsystem: ui
tags: [rt2, enterprise, sso, scim, react-query, vitest]
requires:
  - phase: 39-enterprise-connector-apply-loop
    provides: Plan 01 shared contracts and backend routes for persisted SSO evidence, SCIM preview, and SCIM apply
provides:
  - Existing EnterpriseRolloutPage renders persisted SSO evidence, callback-state checks, structured failure reasons, and audit evidence
  - SCIM preview-to-apply UI with candidate selection, deactivate acknowledgement, apply result counts, failed rows, and rollback candidates
  - UI API method for company-scoped SCIM apply using shared Phase 39 contracts
  - Fallback route-contract coverage for UI-facing SSO, SCIM preview, and SCIM apply response shapes
affects: [enterprise-rollout, rt2-connectors, rollout-readiness, route-contracts]
tech-stack:
  added: []
  patterns: [shared-contract UI API client, dense evidence-forward rollout panel, mutation invalidates rollout overview]
key-files:
  created:
    - ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx
    - .planning/phases/39-enterprise-connector-apply-loop/39-02-SUMMARY.md
  modified:
    - ui/src/api/rt2-enterprise.ts
    - ui/src/pages/rt2/EnterpriseRolloutPage.tsx
    - server/src/__tests__/rt2-v23-route-fallback.test.ts
key-decisions:
  - "Kept SCIM apply inside the existing EnterpriseRolloutPage instead of adding a separate dashboard."
  - "Used server-provided previewId and previewFingerprint directly; the UI does not recompute fingerprints."
  - "Deactivation is gated only when selected candidates include deactivate actions."
patterns-established:
  - "SCIM preview rows expose stable candidate IDs and local selection state before apply."
  - "Apply results remain local after mutation while rollout overview is invalidated for backend readiness refresh."
requirements-completed: [EXT-01, EXT-02]
duration: ~1h 35m
completed: 2026-04-29
---

# Phase 39 Plan 02: Enterprise Connector Apply UI Summary

**Existing enterprise rollout page now consumes persisted connector evidence and promotes SCIM preview records into acknowledged apply runs**

## Performance

- **Duration:** ~1h 35m
- **Started:** 2026-04-29T01:55:00Z
- **Completed:** 2026-04-29T03:30:06Z
- **Tasks:** 3/3
- **Files modified:** 5

## Accomplishments

- Added `rt2EnterpriseApi.applyScim(companyId, input)` using shared `Rt2ScimApplyRequest` and `Rt2ScimApplyResult`.
- Extended `EnterpriseRolloutPage` to render evidence IDs, checked timestamps, callback-state rows, structured failure reasons, SCIM preview IDs/fingerprints, selectable candidates, deactivate acknowledgement, apply results, failed rows, rollback candidates, and audit details.
- Added UI contract tests for persisted evidence rendering and deactivate acknowledgement gating.
- Strengthened fallback route-contract tests for SSO evidence, SCIM preview/apply response shapes, rollback candidates, failure reasons, and company access before mutation.

## Task Commits

1. **Task 1: Extend the UI API client for persisted connector evidence** - `6716ca67`
2. **Task 2: Render SSO evidence and SCIM apply loop on EnterpriseRolloutPage** - `2b8a5773`
3. **Task 3: Verify final route/UI contract and default suite** - `51cba848`

## Files Created/Modified

- `ui/src/api/rt2-enterprise.ts` - Added shared-contract SCIM apply client method.
- `ui/src/pages/rt2/EnterpriseRolloutPage.tsx` - Added persisted SSO evidence and SCIM preview/apply workflow on the existing rollout page.
- `ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx` - Added UI contract coverage for evidence rendering and deactivate acknowledgement gating.
- `server/src/__tests__/rt2-v23-route-fallback.test.ts` - Added final fallback route shape assertions and authz-before-mutation coverage.
- `.planning/phases/39-enterprise-connector-apply-loop/39-02-SUMMARY.md` - Execution summary and self-check.

## Verification

- `pnpm typecheck` - passed.
- `pnpm exec vitest run ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx server/src/__tests__/rt2-v23-route-fallback.test.ts` - passed; 2 files, 7 tests.
- `pnpm typecheck && pnpm test` - first attempt timed out at 300s during the full suite after `pnpm typecheck` passed; reran `pnpm test` with a longer timeout and it passed.

## Environment Notes

- Full suite logs documented Windows host skips for embedded Postgres tests, including `rt2-phase39-enterprise-connector-apply-loop.test.ts`; deterministic fallback and UI contract tests passed.
- Full suite also emitted pre-existing non-fatal logs for missing `ssh`, jsdom canvas `getContext`, and a duplicate mock key in `agent-live-run-routes.test.ts`.

## Decisions Made

- Kept apply evidence local immediately after mutation and invalidated `queryKeys.rt2Enterprise.rollout(companyId)` so backend readiness/audit evidence refreshes through the existing overview path.
- Default SCIM selection includes create/update candidates but not deactivate candidates; deactivate apply requires explicit row selection plus acknowledgement.
- Did not add full SSO login, live IdP calls, a separate dashboard, or an automatic rollback engine.

## Deviations from Plan

None - plan scope was executed as written.

## Known Stubs

None. Stub scan hits were existing input placeholder attributes, test cleanup, and null checks, not unimplemented UI/data stubs.

## Threat Flags

None beyond the planned Phase 39 trust boundaries. The UI sends company-scoped requests through existing authenticated routes and keeps server-side validation as source of truth.

## TDD Gate Compliance

Plan tasks were marked `tdd="true"`, but execution used focused implementation commits with tests included rather than strict RED/GREEN split commits. Verification coverage was added and run successfully.

## Self-Check: PASSED

- Summary file exists: `.planning/phases/39-enterprise-connector-apply-loop/39-02-SUMMARY.md`
- Task commits found: `6716ca67`, `2b8a5773`, `51cba848`
- Created file found: `ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx`
- Modified files verified: `ui/src/api/rt2-enterprise.ts`, `ui/src/pages/rt2/EnterpriseRolloutPage.tsx`, `server/src/__tests__/rt2-v23-route-fallback.test.ts`
- No accidental tracked file deletions detected in task commits.

---
*Phase: 39-enterprise-connector-apply-loop*
*Completed: 2026-04-29*
