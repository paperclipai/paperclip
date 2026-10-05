# Dark tree release participant checkpoint

The supplied-transaction `releaseIssueTreeHoldInTransaction` is a narrow, unwired participant. It awaits the existing company lifecycle transaction fence before invoking the actual tree service release writer on that transaction. It snapshots company/root/hold/reason and each actor scalar before suspension, and projects only those fields. Arbitrary metadata/releasePolicy extras are not forwarded; the existing release policy is retained and release metadata is null. The ordinary `releaseHold` API is unchanged.

This is NOT permission to release a live hold, automatic recovery, authenticated actor validation, restoration wiring or common graph/tree serialization. There is no production caller. Ordinary create/release/cancel/resume/restore/tree-parent writers still do not participate in the fence. The new entry owns no transaction and publishes no wake or effects; the caller must own the supplied transaction and acquire the fence before any earlier domain reads/locks.

## Executed source/mock evidence

Actual `releaseHold` with strict synthetic rows and PgDialect predicate recording; no PostgreSQL/server/adapter. Initial missing export: 1 expected FAIL. First implementation: 1 PASS. Suspended-fence caller retargeting: 1 expected FAIL/1 PASS with other-hold/other-company predicates; scalar projection then 2 PASS. Expanded ten focused suites: 185 PASS, exit 0, 15.73s.

Temporary missing-await mutation: focused routing barrier 1 FAIL/7 skipped, domain release/read happened before the fence. Temporary actor-reference mutation: independent actor control 1 FAIL/7 skipped, wrong actor type/user/agent/run reached the release patch. Both mutants removed. Final results are recorded in the delivery issue/PR.

New controls: exact fence key/order and scoped hold/member queries, pending-fence zero writes, routing/actor/reason containment, fence rejection/no reads/writes, canonical wrong-root/released veto, runtime extra-field projection, unchanged ordinary metadata behavior and no nested transaction.

## Dark owning release opt-in

Canonical `releaseHold` now accepts the internal `lifecycleFence` opt-in. It captures reason/actor scalars synchronously before root transaction startup and delegates to the existing supplied-tx release participant. The callback fences before every canonical read. No production caller opts in. Ordinary omitted/false callers retain explicit policy/metadata behavior and do not open a transaction or acquire a fence.

This narrow dark owning contract rejects any non-null explicit releasePolicy or metadata, including explicit manual policy and empty metadata, with 422 before transaction/read/write. Absent/null keeps the existing stored policy and null metadata. It does not authenticate actor fields, authorize live hold release, restore dependent issues, or establish common serialization.

Executed server cwd, env without PAPERCLIP_API_KEY/DATABASE_URL/FORGEJO_TOKEN, profile scratch TMPDIR; `/opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts` with `--pool=forks --maxWorkers=1 --testTimeout=15000`. Initial owning root-reader test: 1 expected FAIL/8 skipped (root-read-before-transaction, 1.52s), implementation 9 PASS/1.33s. Unsupported-extra guard removed before expanding its tests: 4 expected FAIL/17 PASS (1.45s), restored guard gives 39 PASS across release/pause/unit (2.79s). Actor-reference mutant: 1 FAIL/20 skipped (1.39s), removed. Final twelve suites 219 PASS/17.43s, exit 0. Release suite has sixteen new controls (24 total).

Controls record startup capture, pending fence/no domain writes, startup/fence/owner-return rejection, wrong-root/released veto, unchanged defaults, null positives and delayed owner-return. Eager write remains in the owner-return rejection recorder: NOT rollback. Delayed result is a Promise ordering oracle, not a DB commit or event publication proof. Original route/writer/human-gate suites remain 27 PASS/2 known RED (10.52s): ordinary route still blocked, ordinary writer without intent. No timeout. No DB/server/adapter/SQL execution/typecheck/build/full gates.

## Remaining prerequisites

Mock predicate recording does not execute company filters or locks; synthetic rows are not PostgreSQL exclusion/rollback. No test establishes concurrent hold insertion/release or parent changes. No missing-hold, all hold modes, restoration effect publication, runtime authentication or actor-policy contract is claimed. Existing release writer SELECT+UPDATE is unchanged and not CAS-protected from nonparticipating writers.

Other graph/tree/gate/owner/reblock/delete/checkout/native/finalize participants, ledger/statusVersion/effects/flush/legacy intent reconciliation and production restoration integration remain incomplete. The original route/writer REDs must remain visible. Queue admission/revalidation/orphan expiry/live 15-minute acceptance is not delivered. Keep queue_hygiene unchanged. PostgreSQL fixture scope still requires the existing human-only decision; merge/deploy/activation requires separate approval.
