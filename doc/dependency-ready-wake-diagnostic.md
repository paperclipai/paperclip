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

## Recorder review follow-up

The verbose suite name now says characterization, not safety. The double records the tables passed to `from`, `innerJoin` and `leftJoin`; it still does not interpret predicates, joins or authorization. Nine fixture-only sensitivity controls cover each of those three methods for interactions, approvals and issue-approval links. Before the recorder fix, the six join controls failed while the three from controls passed; afterward all nine controls plus the original seven selector characterizations passed.

A temporary mock-only selector mutation added ``leftJoin(approvals, sql`true`)`` to the blocker lookup. The four human-gate characterization cases then failed on the recorded approvals table instead of silently passing. The mutation was removed before delivery; no production service change is included. This demonstrates sensitivity to a direct gate-table join in this selector, not complete SQL dependency tracking or human-gate enforcement.

## Independent boundary review and follow-up characterization

The independent review reproduced the pinned route RED and requires one shared transactional writer, called with the existing transaction by REST status/dependency mutations and the native status committer. Preserve native decision/statusVersion/effect-ledger semantics, canonical status metadata cleanup and execution leases. Finalize and recovery reconcile through that same writer; never add independent detached repairs. Readiness includes workspace finalization, not just done status. Serialize relation mutation, owner change and re-block with restoration; capture the blocked cycle before canonical metadata cleanup and use the cycle-aware state key across emitters.

The follow-up route contract checks the exact recovery reason and dependent/blocker payload, preserves the before snapshot, and rejects closed/backlog statuses as restoration. It still intentionally fails because the observed dependent is blocked.

`issue-dependency-human-gates.test.ts` executes the actual candidate selector with a recording query double. Seven characterization tests cover ordinary recovery, unresolved/cancelled blocker controls, human-only confirmation with none/on-accept continuation, and pending/revision_requested approvals. They establish that the selector does not even read human gate tables and leaves synthetic rows unchanged. This is NOT a human-gate safety PASS, a PostgreSQL test, or proof of the live observed cases. The double does not execute SQL predicates; gate snapshots are synthetic inputs, not server-verified consent. An initial no-candidate assertion was rejected as the wrong abstraction: the selector is not the future authorizing writer. Keeping that assertion green by adding a router/selector-only guard would contradict the reviewed shared boundary.

Command on Node 25.8.1: `env -u PAPERCLIP_API_KEY -u DATABASE_URL pnpm exec vitest run server/src/__tests__/issue-dependency-human-gates.test.ts server/src/__tests__/issue-dependency-wakeups-routes.test.ts` gave 15 passed / 1 known-red failed (`todo,in_progress` does not contain `blocked`). No production implementation is included. Remaining acceptance needs writer-level human-gate regressions, concurrency/rollback evidence, cross-emitter idempotency, orphan admission/expiry, and queued-run revalidation. The current board scope expressly permits mock-only tests: disposable PostgreSQL tests need an explicit scope change before execution. Production activation remains a separate approval regardless of that test-scope decision.
