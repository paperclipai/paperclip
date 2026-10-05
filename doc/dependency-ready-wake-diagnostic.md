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

## Service writer checkpoint

`issue-dependency-writer-boundary.test.ts` now executes the real `issueService.update` rather than the route's mocked update. It records the owned transaction, update lock and canonical blocker projection. The commit snapshot contains only the blocker status write: the known-red assertion requires a durable dependency wake intent before the service transaction returns. The following restored-status assertion is not reached in that RED run. This is a service ordering diagnostic, not SQL, consent, rollback or concurrency acceptance.

Two fixture-only controls demonstrate that an issue predicate targets the dependent rather than changing the blocker before-snapshot, and that a post-commit mock restore cannot change the saved commit snapshot. The double compiles the simple issue write predicate using Drizzle only to identify its target; it does not execute arbitrary SQL. Synthetic readiness projections model one done dependency. Chat completion, terminal summary/status-card hooks, terminal interaction expiration and experimental settings are mocked; those integrations and human gates are not tested here. Unknown reads/writes fail rather than silently receiving a default result. The double must be extended alongside the future writer; its current RED must not be made green with a detached route patch or by fabricating intent rows.

The standalone service suite yields three PASS controls and one expected RED (missing `agent_wakeup_requests` intent). Initial failures on unmodeled unrelated hook reads were fixture setup errors, not product defects. No production source changed in that diagnostic checkpoint. Next executable slice is the shared canonical transaction writer and its veto regressions; do not repeat completed selector/recorder review work. PostgreSQL proof remains subject to the existing explicit test-scope decision, and runtime activation remains separately gated.

## Dark coordinator implementation checkpoint

`issue-dependency-restoration.ts` now provides an executable but UNWIRED coordinator using a supplied transaction, company-scoped dependent update lock, existing readiness selector, canonical `issueService.update(..., tx)` and durable intent insert. It captures the blocked cycle before canonical cleanup. Its mock-only tests bind the intent to company, agent, dependent, resolved blocker, full blocker set and the existing cycle-aware state key. The implementation initially failed its positive contract; then eleven veto/dedup cases failed before their guards were added. The final coordinator suite has eighteen passing tests. The combined diagnostic suites remain 45 PASS / 2 known RED: existing REST/service writers do NOT invoke the coordinator.

This is NOT the completed common writer boundary. Canonical update and readiness are service mocks in this new suite; predicate execution, row-lock behavior, canonical metadata/version updates, activity publication, DB rollback and concurrency are not established. Error propagation after failed intent insert is not rollback proof. No emitter imports this module. There is no new route, flag, callback bypass or production activation.

The dark guard deliberately refuses any pending interaction, pending/revision_requested formal approval, existing lease/conversation, or non-null execution policy/state/unblock descriptor. This over-conservative boundary must be reconciled with actual server-owned holds before wiring, not treated as a general runtime policy. Existing intent plus still-blocked state is left untouched, not claimed as repaired. Ancestor pause/hold checks, shared locks for relation/owner/re-block and gate insertion/revocation writers, blocker transition integration, native effect ledger/statusVersion, finalize/backstop and legacy intent reconciliation remain missing. The lookup is cycle-aware dedup only under the caller's transaction and lock discipline; this mock does not prove cross-emitter uniqueness. The earlier writer oracle remains RED and must be strengthened when wired rather than manufactured GREEN.

Queue admission/revalidation, orphan expiry and the live fifteen-minute bound remain unimplemented. Keep queue_hygiene unchanged. Full typecheck/repo-wide gates are not run in this bounded mock-only checkpoint; no database or adapter is started. The existing human-only question concerns DB test scope only, not permission to merge/deploy/activate.

## Caller-owned canonical writer follow-up

Independent review found a real ownership defect hidden by the canonical-update mock: constructing `issueService(tx)` made `update(..., tx)` select its owned-transaction branch. The coordinator now requires distinct root DB identity plus the caller's activity-publication and post-commit-action queues, and passes all three to the actual canonical writer. Only the caller may flush these queues after its outer commit. The coordinator remains UNWIRED; no production emitter or publication adapter is enabled.

`issue-dependency-restoration-canonical.test.ts` executes the actual canonical update with distinct root/tx sentinels. Readiness, experimental settings and unrelated chat-completion hook are mocked. Before the fix it fails specifically on `nested-transaction-not-owned`; afterward it records canonical blocked metadata cleanup followed by an exact two-blocker cycle-bound intent, with neither root nor nested transaction called. A second control propagates durable insert rejection after cleanup and produces no caller-return snapshot. Its recorder still contains the updated row: this explicitly does NOT prove database rollback. Root queue forwarding is also checked in the existing coordinator suite; real queued publication execution is not proven.

Combined five focused suites: 47 PASS / 2 original known RED (49 tests), exit 1. The route still observes blocked, and the real blocker service transaction still has no dependency intent. Vite's pre-existing `__dirname` warning remains. Direct server `tsc --noEmit` exceeded the 60-second command cap: timeout, not typecheck PASS; no retry of that command. Full repo gates, native ledger/statusVersion, shared writer fences, emitter integration, queue/orphan guards and live acceptance remain outstanding. No DB/server/adapter, merge, deploy or activation.

## Authoritative blocker checkpoint (still dark)

The coordinator now reads the resolved blocker under a same-company SHARE lock before locking the dependent, rejects a non-done or mismatched blocker, and requires readiness ownership to match the locked dependent. Routing input alone is not completion evidence. Five mock regressions first failed (`intent-1` instead of null), then passed after implementation. The lock is not a graph-wide serialization scheme: integration must establish consistent multi-row lock ordering across blocker, relation, owner, re-block and human-gate writers, including opposite graph traversal/deadlock behavior. Do not wire this helper on the strength of recording GREEN alone.

The canonical suite no longer mocks readiness or issueService: actual selector/readiness and canonical update execute over synthetic relation projections, with explicit issue-target resolution and root/nested transaction sentinels. Three controls keep the dependent unchanged while the second blocker is in_progress, blocked or cancelled. This is stronger source-execution coverage, not SQL joins/predicate semantics, workspace-finalize proof, authorization, rollback or concurrency evidence. Settings/chat hooks remain mocked.

Caller publication/action queue assertions now use reference identity. A temporary fresh-array mutant was caught by the focused test (`Object.is equality`, 1 failed / 22 skipped); it was removed. Actual production/flush of these queues is still untested. Pristine coordinator plus canonical suites: 28 PASS. Combined five suites: 55 PASS / 2 original known RED (57 tests), exit 1. No typecheck/full gates were rerun. Emitter wiring, ancestor holds, native ledger/statusVersion, intent reconciliation, queue admission/revalidation/orphan expiry and live 15-minute proof remain outstanding; the pending DB-scope decision does not block continued code/mock integration. No production activation or queue_hygiene change.
