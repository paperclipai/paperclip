# Dark connection-intent ownership expiry checkpoint

Status: SOURCE/MOCK only. No production opt-in, rollout or acceptance claim.

## Boundary

The canonical expireConnectionIntentsForOwnershipChange method has a dark owned lifecycleFence option. It captures issue/company scalars before starting its transaction. The supplied participant captures the same routing before awaiting the existing company transaction fence. Both use one private canonical UPDATE and OAuth cleanup helper. Ordinary omitted/false callers retain their non-owning behavior and injected service clock (two calls, not one combined timestamp).

The UPDATE keeps company, issue, connection_intent and pending predicates. DELETE uses only interaction IDs returned by that UPDATE. Empty results skip DELETE. Neither entry resolves a human confirmation, approves a gate, changes issue ownership nor restores a dependent. Existing canonical issue update still uses the ordinary unfenced hook. A supplied caller must take this protocol fence before earlier row locks; late acquisition is not safe wiring. Captured routing is not authenticated authority.

## Execution

From server cwd, with PAPERCLIP_API_KEY, DATABASE_URL and FORGEJO_TOKEN removed and TMPDIR set to the profile scratch:

node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/interaction-lifecycle-ownership-expiry.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000

Initial ownership contract: 1 expected RED (no tx/fence), 4.92s. The first extraction lost the service-local clock: new contract and membership controls produced 3 FAIL/2 PASS (now undefined), 5.96s. Explicit forwarding restored the clock; 5 PASS/5.83s. Expanded new suite contains 21 controls. New suite plus membership/approve/reject regression: 97 PASS/7.41s. Temporary missing-await mutant: 2 FAIL/19 skipped/4.13s; removed before final validation.

Final 26 explicitly selected participant files: 609 PASS/28.50s. File set: approval-lifecycle-*, approval-comments-lookup, approvals-service, issue-approval-lifecycle-*, issue-update-lifecycle-*, issue-dependency-restoration*, issue-tree-lifecycle-*, issue-tree-control-service-unit, and interaction-lifecycle-ownership-expiry (all .test.ts). No route/listener or DB suites.

Original writer-boundary plus human-gates characterization: 19 PASS/1 known RED/6.16s. Ordinary blocker update still lacks durable dependency intent. The historic route RED was not replayed and is not a current-head measured result.

## Limitations and next step

PgDialect/recording rows demonstrate builder shape, Promise ordering and error propagation only. DELETE rejection follows an eagerly recorded expiry UPDATE; this is not rollback. No executed SQL filtering/isolation/CAS/FK/concurrency/authorization/commit/rollback proof. The injected clock is a service test dependency, not a transport option. No DB/server/listener/adapter/workflow, typecheck/build/full gates or activation.

Independent exact-head review must assess the shared extraction, clock/default parity, scoped UPDATE/returned-ID cleanup, owned/supplied capture and rejection ordering. Remaining interactions (creation, resolution, withdrawal, terminal expiry), hire effects and other lifecycle writers must participate before common serialization/restoration wiring. Native ledger/statusVersion/effects/flush/legacy intents, queue admission/revalidation/orphan expiry and approved live fifteen-minute evidence remain incomplete. Keep queue hygiene. Pending human DB-scope decision is not permission. Upstream conflict needs separate rebase and fresh-head validation/review.
