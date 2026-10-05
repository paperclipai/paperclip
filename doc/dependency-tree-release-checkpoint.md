# Dark tree release participant checkpoint

The supplied-transaction `releaseIssueTreeHoldInTransaction` is a narrow, unwired participant. It awaits the existing company lifecycle transaction fence before invoking the actual tree service release writer on that transaction. It snapshots company/root/hold/reason and each actor scalar before suspension, and projects only those fields. Arbitrary metadata/releasePolicy extras are not forwarded; the existing release policy is retained and release metadata is null. The ordinary `releaseHold` API is unchanged.

This is NOT permission to release a live hold, automatic recovery, authenticated actor validation, restoration wiring or common graph/tree serialization. There is no production caller. Ordinary create/release/cancel/resume/restore/tree-parent writers still do not participate in the fence. The new entry owns no transaction and publishes no wake or effects; the caller must own the supplied transaction and acquire the fence before any earlier domain reads/locks.

## Executed source/mock evidence

Actual `releaseHold` with strict synthetic rows and PgDialect predicate recording; no PostgreSQL/server/adapter. Initial missing export: 1 expected FAIL. First implementation: 1 PASS. Suspended-fence caller retargeting: 1 expected FAIL/1 PASS with other-hold/other-company predicates; scalar projection then 2 PASS. Expanded ten focused suites: 185 PASS, exit 0, 15.73s.

Temporary missing-await mutation: focused routing barrier 1 FAIL/7 skipped, domain release/read happened before the fence. Temporary actor-reference mutation: independent actor control 1 FAIL/7 skipped, wrong actor type/user/agent/run reached the release patch. Both mutants removed. Final results are recorded in the delivery issue/PR.

New controls: exact fence key/order and scoped hold/member queries, pending-fence zero writes, routing/actor/reason containment, fence rejection/no reads/writes, canonical wrong-root/released veto, runtime extra-field projection, unchanged ordinary metadata behavior and no nested transaction.

## Remaining prerequisites

Mock predicate recording does not execute company filters or locks; synthetic rows are not PostgreSQL exclusion/rollback. No test establishes concurrent hold insertion/release or parent changes. No missing-hold, all hold modes, restoration effect publication, runtime authentication or actor-policy contract is claimed. Existing release writer SELECT+UPDATE is unchanged and not CAS-protected from nonparticipating writers.

Other graph/tree/gate/owner/reblock/delete/checkout/native/finalize participants, ledger/statusVersion/effects/flush/legacy intent reconciliation and production restoration integration remain incomplete. The original route/writer REDs must remain visible. Queue admission/revalidation/orphan expiry/live 15-minute acceptance is not delivered. Keep queue_hygiene unchanged. PostgreSQL fixture scope still requires the existing human-only decision; merge/deploy/activation requires separate approval.
