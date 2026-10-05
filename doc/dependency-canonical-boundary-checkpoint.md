# Dark opt-in canonical transaction preparation checkpoint

`issueService(rootDb).update(..., executor, publications, actions, { lifecycleFence: true })` now requires trusted `companyGuard`. The owned variant opens its transaction before canonical preparation; the supplied variant awaits the company fence before its first canonical SELECT. Preparation and patch derivation use the supplied executor, followed by the existing row-lock/write implementation. Root identity still owns transaction completion and post-commit flush decisions. Default callers retain their existing behavior. No production caller opts in, and restoration remains unwired.

Mock recording: initial pre-read assertion failed (`read:issues` instead of `lifecycle-fence`); final canonical file 22 PASS. Owned/supplied suspension and rejection controls perform no recorded domain effects while the fence is pending or failed. A temporary `void` instead of `await` mutation failed both suspension controls, and was removed. Company predicates and distinct root/tx identities remain checked. No SQL/DB/server/adapter execution; these tests do not prove rollback, isolation, authorization or concurrent locking.

Incomplete participant manifest / pre-wiring blockers:

- Canonical status preparation: opt-in entry implemented, only ordinary blocked-to-todo recording exercised. General owner/parent/re-block/relation replacement acceptance is NOT complete.
- Canonical settings and some user/workspace validators still close over root services. Migrate them to the executor and test those branches before claiming zero root reads for arbitrary patches. Neither passing fixture nor suspended fence control proves those branches. Caller data/routing must also be snapshotted before waits.
- Empty/full relation replacement and cycle validators: not yet independently fenced/exercised through this opt-in entry. Create, delete, checkout/release and other issue writers remain nonparticipants.
- Supplied callers must take the fence before their own earlier reads/row locks. This entry cannot repair existing ordering or an old isolation snapshot. Distinct root/tx identities remain mandatory.
- Tree hold/release, interaction/approval insert/link/resolve/expiry, native status coordinator/ledger, workspace finalization receipt and recovery writers remain nonparticipants.
- Actual post-commit publications/actions, native terminal gates/statusVersion/effects and legacy intent reconciliation require stronger recording controls and separately authorized real DB evidence.
- Queue admission/revalidation/orphan expiry and the live 15-minute bound are not implemented. Existing route/writer RED diagnostics remain relevant. queue_hygiene stays enabled.

This is a bounded source checkpoint, NOT common serialization, restoration activation or production acceptance. Pending human-only DB-scope decision does not authorize merge/deploy, and does not block further source/mock implementation.
