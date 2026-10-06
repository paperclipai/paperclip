# Dark issue lifecycle fence checkpoint

This changes source, not deployed behavior. No production emitter calls the restoration coordinator. No approval, deployment or activation is implied.

The shared primitive acquires `pg_advisory_xact_lock(hashtextextended($1, 0))` on the supplied transaction, keyed by `paperclip:issue-lifecycle:<companyId>`. Company granularity avoids per-edge lock-order inversion across cyclic dependency graphs; hash collisions only reduce concurrency. This is a transaction lock, not a session lock. Exceptions propagate without fallback. The dark coordinator awaits it before its first domain read or row lock.

This is NOT yet a common writer fence. A PostgreSQL advisory lock is cooperative: every writer of relations, owner, status/re-block, parent/tree holds and human/formal gates must acquire this same key before their first relevant read/row lock. A caller transaction with earlier row locks cannot safely acquire it for the first time only inside the coordinator. Native status/effect ledger, finalization, recovery and delete paths must be audited too. Do not wire emitters until those participants and their order are migrated and verified.

Current source discovery: canonical issues.update reads before its owned runUpdate transaction (issues.ts around 10651, 11310). Relation writes are around 7460/7471; tree-control insert transactions around 753/831, release around 901 and issue updates around 995. A lock added only after canonical row locking would not establish the intended protocol. These existing paths remain untouched in this checkpoint.

Mock-only evidence: new first-operation regression was RED (`read:issues` instead of `lifecycle-fence`), then coordinator 27 PASS and actual canonical readiness/update recording 16 PASS. The recorder asserts parameterized transaction-lock SQL and exact company key, suspension before reads, and error propagation with no domain writes. A temporary un-awaited-fence mutant was caught by the suspension test (early `read:issues`/`lock:share`); mutant removed. One intermediate failure was recorder projection noise (`typings`), not a product defect.

Existing route/writer/selector diagnostics: 27 PASS / 2 original RED. Route still dispatches with blocked dependent; actual blocker writer still has no durable recovery intent. Nothing here fixes these production entry points. Vite's pre-existing __dirname warning remains. Typecheck/full gates were not repeated after the previous timeout.

No PostgreSQL, SQL execution, concurrency, lock release or rollback is proven. Pending human-only DB fixture scope stays pending. No queue admission/revalidation, orphan expiry or live 15-minute bound is implemented; queue_hygiene remains the external safety net.
