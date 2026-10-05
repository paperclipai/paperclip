# Dependency-ready wake repair: diagnostic checkpoint

This is a known-red, mock-only regression checkpoint, not a production fix or a merge-ready change.

## Reproduction

Run with Node 24.11+:

    pnpm install --frozen-lockfile
    pnpm --filter @paperclipai/plugin-sdk run build
    pnpm exec vitest run server/src/__tests__/issue-dependency-wakeups-routes.test.ts

The new test exercises the real issue PATCH route with recording service mocks. A final blocker changes to done. The dependent has a single completed dependency and an agent owner. The test observes the dependent status at the wake dispatch boundary, not merely the existence of a wake call. On upstream base a386a599983519eb1d399f8b770bfccdb2a74762, the observed value is blocked. Existing eight tests pass; the new regression fails on the expected assertion. No database, adapter execution or production API mutation is part of this test.

The first attempt incorrectly mutated the route's pre-update snapshot in the mock. The corrected mock returns a new blocker row, matching the service contract. It records dependent updates without synthesizing a restore. The fixture also supports the existing orderBy read so unrelated handoff logging does not obscure the defect.

## Source paths requiring a single reviewed restoration contract

- services/issues.ts listWakeableBlockedDependents computes readiness including workspace finalization, but only returns candidates; it does not restore blocked status.
- routes/issues.ts emits dependency wakes after the issue update, in a detached asynchronous continuation. A status patch in that continuation would not establish atomic last-blocker resolution.
- services/native-runtime/status-decision-committer.ts collects dependents and persists wake intents inside its transaction. Its status projection and publication contract must be preserved.
- services/recovery/service.ts dependency-ready backstop emits another wake; it checks pending interactions and pause holds, but cannot be taken as proof that every emitter handles pending approvals.
- heartbeat.ts has admission, queued selection and execution paths. Both newly admitted and previously queued work need validity checks; existing blocked recovery wakes must not be indiscriminately discarded.

## Required next tests and implementation

Restore a legitimate non-blocked execution path atomically with last unresolved blocker resolution, respecting the canonical status writer and transactional wake intent. Test partial resolution, done versus cancelled blockers, workspace finalization, dependency removal and re-block cycles. Mock-only tests can establish ordering and guard decisions; they cannot prove PostgreSQL concurrency or production behavior.

Empty dependencies are not permission to perform a human-gated action. Add fixtures carrying pending request_confirmation (human_only, original addressee and target), pending/revision_requested formal approvals, and explicit fresh production consent waits. Preserve those rows and do not replace, accept or infer authorization from historical trust. Include ordinary work controls so human-wait handling is not a blanket ban on recovery.

For queue hygiene, cover issue-less intentional system work separately from orphaned task work, bounded orphan expiration, admission races and already queued blocked work. Do not create unbounded retry loops or claim provider termination from ledger cancellation alone.

Keep the external queue hygiene safety net until separately approved activation and real live-runs plus single-issue measurement prove the 15-minute bound. This branch does not alter runtime configuration, jobs, policy, sessions, permissions or live evidence issues. No merge or deployment is authorized.
