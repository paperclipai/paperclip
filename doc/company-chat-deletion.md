# Company deletion with chat endpoints

Company deletion must remove chat endpoints before deleting their referenced issues or assigned agents.
The endpoint-to-agent foreign key uses RESTRICT, so waiting for the final company
cascade fails while deleting agents. This was reproduced by the Discord scheduling
producer test and by the owning company-removal suite.

The chat owner participates in the existing company-deletion transaction. It
removes only the requested company's endpoint rows before issue deletion and before the agent lifecycle
participant runs. Existing endpoint foreign keys remove their dependent records.
The lifecycle owner still requires completed agent termination. The transaction
still rolls back all SQL cleanup if a later participant fails. No external calls,
new scheduler, schema change, or relaxed constraint is introduced.

Discord command ownership tombstones have no cascading foreign keys and remain
unchanged. Deletion does not authorize a new endpoint to adopt an old application.
Other retained-history constraints, including voice-session restrictions, still
apply; this fix does not bypass them or change external provider teardown policy.

Both new PostgreSQL regressions failed before the change. All six cleanup-removal
cases pass afterward, including deletion ordering, another company's untouched
endpoint, preserved namespace ownership, and rollback after a later failure.
The suite accepts a validated dedicated external PostgreSQL test database because
embedded PostgreSQL cannot start on this host. Server typecheck/build and remote
CI/review are tracked separately; this is not evidence of deployed host sleep.


Review expanded the fixture to include a conversation and publication linked to
an issue. Both regressions then failed because cleanup ran after issue deletion.
The chat participant now runs immediately after the company row is locked, before
any referenced issue or agent is removed. The same transaction preserves history
on rollback. This supplements the original endpoint-only proof; it does not claim
to remove existing voice-session restrictions.

## Current-parent acceptance, October 27

This slice normally integrates health parent #17554 at
`8c1d293d1ae2b7db753ab20f5a2a2edec1fb0a62`. Only the four company-cleanup
files differ from that parent; no database, workflow, or provider change is added.
The parent must land before this prerequisite can merge into master.

The remaining Ponytail finding reproduced on an initially empty dedicated
PostgreSQL 17 database: the real endpoint-deletion case and its cleanup failed
with missing-table errors. The external fixture now applies pending migrations
before creating its client and uses the shared 90-second embedded-bootstrap setup budget. The six complete
cleanup-removal cases pass on that same initially empty database. Test teardown
also deletes the ownership tombstones it creates; an independent query after
the complete suite finds zero rows. This fixture cleanup does not change the
production rule that company deletion preserves those tombstones.

The failed fresh-database run remains part of the evidence. Server typecheck and
build pass with this repair. Fresh current-head CI/reviews remain separate gates. No full local
repository-suite or deployed suspension claim is made.

The final review identified that the previously suggested 30-second setup limit
was below the repository's documented bootstrap budget under runner contention.
The fixture now imports and uses EMBEDDED_POSTGRES_TEST_TIMEOUT_MS. It changes no
assertion or production behavior. The earlier fresh-database failure and six-case
acceptance remain recorded; the shared timeout addresses documented setup cost,
not a reproduced production defect or a claim of measured CI contention here.
