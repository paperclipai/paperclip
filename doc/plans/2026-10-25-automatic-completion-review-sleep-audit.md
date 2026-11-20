# Automatic completion-review retirement

Date: 2026-10-25; current integration: 2026-10-29. Parent: obsolete policy
reviews #17679 at actual squash `dfd5b1ac6205b6ec8f56752dfc5d3f9c02c26b6d`.
The original draft parent was `e671c66bba6e9a42aa570826e6f3420dba199399`.

## One reason and its owner

The native finalization pass calls `dismissAutomaticCompletionReviews` globally,
or per issue when run-scoped. `finalizeNativeRun` also calls it for the active
issue before resolving status. This slice preserves that direct call and its
ordering and migrates only periodic discovery to a dedicated deadline worker.
The service in `native-runtime/automatic-completion-reviews.ts` retains the
historical predicate, withdrawal, chat publication, and audit ownership.

This duty is separate from obsolete policy reviews and subsequent reassessment.
A retired card's existing cancelled result reason is the durable trigger that
`decisionHasRetiredAutomaticReview` checks. Retirement is not finalization
completion. Reassessment and workspace barriers remain with their owners.

## Exact obligation and producers

The existing candidate query identifies:

- A pending system confirmation with no user or agent creator.
- An applied in-review decision with completion_claim_incomplete,
  completion_claim_conflict, or external_verification_required.
- Matching effect target, company, issue, source run and assessment.
- A low-risk agent_claim_policy contract with no assessment attention requests.
- The exact native-review idempotency key, native_completion_review target,
  decision revision, and historical prompt first line.

Current arbitration no longer creates completion-claim reviews by default.
Explicit attention uses actionable_attention_pending and keyed requests, which
this query excludes. The typed committer still supports historical input; it
registers the new company/issue notification before its decision/effect writes
inside its existing transaction. The notification serializes only those IDs.
Outer commit, rollback, and uncertain writes use the existing shared protocol.

The production inserter of decisions and status effects is
`commitNativeStatusDecision`. No production updates of completion contracts or
work assessments were found; these records are immutable inputs. Existing
decision updates adjust lineage or applicationState within the committer.
Interaction response, dismissal, expiry, summary, and connection-intent updates
do not create this historical decision/effect lineage or reopen answered native
reviews. A generic authored card also fails the system-card predicate.
Startup covers historical rows. Independent SQL writers or concurrent older
controllers require explicit integration; process-local signals do not cover them.

## Worker and invariants

The existing scoped deadline helper reconstructs 100-row keyset pages, stores
interaction/company/issue IDs and deadlines, and processes fair batches of
20. Normal commit hints inspect only their company/issue. Settled history leaves
no recurring SQL or deadline. No table, migration, separate timer, or provider
branch is added.

Discovery now has a raw internal path that propagates SQL errors. The public
manual lookup retains its logging/empty-list compatibility. The worker must not
mistake a failed lookup for successful reconstruction and discard a dirty scope.
The shared helper retains failed discovery with backoff.

Each attempt rereads the exact candidate. Withdrawal retains the existing
coordinator/issue locks and additionally matches the selected kind, source run,
idempotency key, system author fields and payload in its conditional update.
A changed or answered card is not withdrawn from stale discovery. The existing
durable withdrawal reason, terminal chat publication and activity remain in the
same transaction. A failed withdrawal leaves a matching card pending and retains
its 30-second retry; another candidate can still settle. A removed or completed
obligation disarms. No age or retry-count cutoff discards a card.

The worker shares admission, drain and standby gates. Startup while paused and
writes during pause retain a request without passive database reads. Shutdown
joins admitted transactions and removes registration. Only periodic orphan
reaping passes the new skip flag through the finalization options. Startup,
manual reconciliation and the direct active finalizer call remain compatible.

## Evidence and limits

The previous slice's owner/consumer corpus is the pre-change baseline. The
first server typecheck and the typecheck with lifecycle additions passed.
The complete owner/startup/timing selection passed all 135 tests without skips:
72 status-authority corpus cases, 60 startup cases and three timing cases.
The corpus includes its existing 53-fixture native/legacy matrix test.

Both review owners run the same lifecycle contract against real PostgreSQL:
genuine/settled quiet, real committer activation, outer commit and rollback,
restart, drain, standby, paused startup, isolated cleanup failure, retry after
pause, concurrent card edits, concurrent answers, shutdown join, and 103-card
paging. Automatic cleanup additionally uses the raw failure path. The injected
discovery failure leaves a pending deadline and repairs after resume. Existing
manual tests preserve explicit attention, stronger authority, later task edits,
newer contracts, workspace failure and unread child-completion obligations.

A rolled-back fixture added 10,000 completed interactions on the same issue and
restored one pending automatic review. The scoped lookup used existing indexes,
returned one candidate, and took 0.080 ms locally. SQL and plan are retained in
`/tmp/sleep45-query-plan.sql` and `.log`. This supports the access path, not a
production latency promise. Global startup reconstruction still scales with
historical data and joins.

Affected consumer suites, final workspace checks and exact-head remote gates
remain required until their results are recorded. The host uses fresh disposable
PostgreSQL 17 test databases because its embedded harness is unavailable.

Other finalization duties, earlier stack CI/review findings and final master
reconciliation remain in scope. This slice makes no claim about Cloud alarm
coverage, host/database suspension, or measured fleet savings.

Final affected-consumer verification passed all 235 tests without skips; together
with the owner/startup/timing selection, 370 local tests passed. Workspace
typecheck and build passed. The two initial typechecks and final checks all
passed; no failed selection was discarded. Remote gates are pending.


## Earlier parent and acceptance (2026-10-29)

A normal merge adopts the verified obsolete-policy cleanup parent and current
recovery source. All substantive owned edits and unrelated upstream blobs are
preserved. The complete database source tree equals the parent: no migration,
table or executable history change is added, and the parent 0407 history with
five newest snapshots remains. No new code comments are added.

Source `0d9087775b54dc7272bcae51345ff690e3407235` passes **462 cases across seven complete
files, no skips**, in 49.57 seconds. The status-authority corpus runs both review
workers against the lifecycle contract. Fixtures nested inside its matrix case
are not counted again. Exact file counts:

| Complete file | Passing cases |
| --- | ---: |
| src/services/native-runtime/external-chat-wait.integration.test.ts | 234 |
| src/__tests__/native-status-arbiter-corpus.test.ts | 72 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/__tests__/chat-run-milestone-governed-work.test.ts | 16 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/__tests__/server-startup-feedback-export.test.ts | 63 |
| src/services/native-runtime/native-finalization-reconciler-timing.test.ts | 3 |

Five separate fresh PostgreSQL 17 databases are migrated before corpus, recovery,
finalizer, external-chat and governed-milestone fixture setup. All selected suites
use their supported external URL path; none is skipped because this host cannot
allocate another embedded cluster. Database build, server typecheck/build, module
boundaries, target migration order and all five fresh parent-0407 migrations pass.
The previous slice's circular-scope-payload failure remains recorded in its
owning audit and is not erased by these passes.

These checks establish current cleanup, authority and affected-consumer behavior,
not deployed host/database suspension or external alarms. Actual landed parent
ancestry and fresh published-head review and CI remain required.


## Current migration409 parent and complete acceptance

Normal integration `27378007cd64c308f41940097a999d51201b8ba8` preserves the
complete original runtime patch and all unrelated upstream blobs. The entire
database source tree equals the current parent, with 0409 history and five
newest snapshots unchanged. No migration or table is added.

All **462 cases across seven complete files pass without skips**, in 49.75
seconds. The selection and per-file counts match the preceding table. Five
separate fresh PostgreSQL 17 databases migrate through 0409 before setup.
Database build, server types/build, module boundaries and exact-head migration
order pass. All suites use their supported external-database fixture path; no
source adaptation or skipped suite is required. Earlier failures remain recorded.

This proves current worker and affected consumer behavior, not deployed
host/database suspension or Cloud alarms. Publication stays held until the
actual prerequisite merge and squash ancestry reconciliation. Fresh current-head
CI and reviews remain required before merge.


## Published obsolete-review parent and actual preservation ancestry

Normal merge `c0f3ada4c018943982731635c26d37c7bb4b9ad9` adopts published parent
`45cb0d9ccc9b0c37068f56a709f16572bd7b7ddc`. It carries the actual cancelled-preservation
squash ancestry and parent audit only. Complete server, package, UI and test
trees remain identical to accepted source `27378007cd64c308f41940097a999d51201b8ba8`,
including the whole 0409 database tree. The 462-case acceptance retains its
original scope. Publication remains held until the actual obsolete-review merge
and ancestry reconciliation. Fresh current-head CI and review remain required.


## Inherited corpus repeatability correction

Published obsolete-review parent `9aa67199da64d700fd6230829d38f2ef522a07fe`
carries the verified two-value fixture prefix correction. Normal integration
`3f4d35ac0154aedc76cc39486d3758c73b1e6ff4` changes only those two corpus
fixture values and parent documentation/ancestry. All production source, other
test files and the complete 0409 database tree remain unchanged. The parent's
audit retains the collision reproduction and rejected foreign-key cleanup
attempt. No assertion, timing limit, teardown or worker behavior changes.

All **462 distinct cases in seven complete files pass without skips**, in
49.31 seconds. The full 72-case corpus then passes again on the same database
in 12.95 seconds. Three preexisting PSC/OUT/sentinel rows remain unchanged in
the inspected ID/name/prefix fields after both runs. Each invocation appends
only its two fixture companies with distinct prefixes. The repeat is not added again
to the distinct case count. Five fresh PostgreSQL 17 fixtures migrate through
0409; database build, server types/build, boundaries and migration order pass.

The actual prerequisite must still merge before publication. Fresh published-head
CI and reviews remain required. No deployed sleep or external-alarm claim is made.


## Actual obsolete-review squash ancestry

Parent #17679 landed as `dfd5b1ac6205b6ec8f56752dfc5d3f9c02c26b6d`. Its whole tree
equals reviewed parent `9aa67199da64d700fd6230829d38f2ef522a07fe`, already present
in this child history. Normal merge `8c5c5da563e32b9a5520a4f8ddefc38c29b4755e`
resolves inspected duplicate squash-ancestry conflicts and preserves the entire
accepted child tree. Complete server, package, UI and test trees remain
identical to the 462-case source and same-database 72-case repeat. The complete
0409 database source remains exactly parent-identical. Fresh published-head
CI and reviews remain required.


## Current-head chat CI correction

The published 40f head fails the initial passive native-presentation idle
observation in chat shard 1. The owner audit records the original failure,
unchanged local baseline, controlled red/green comparison and its limits:
[Native presentation startup observation](2026-10-25-github-terminal-response-sleep-audit.md#ci-native-presentation-startup-observation).
The permanent correction changes one observation from the default one-second
window to the existing five-second settlement bound. Production code and
business/worker deadlines do not change. All quietness, rollback and committed
settlement assertions remain. With the probe removed, all 274 selected GitHub
agent-review cases pass in 232.06 seconds. The earlier 462-case selection and
72-case repeat retain identical production and selected test sources. Fresh
CI and review are required on the updated published head.


## Independent master cleanup assertion preserved

Master advanced from the actual obsolete-review squash to
`49fe8b87a49aa5a8985a08dd3d5ce57bdd24756c`. The sole change is an assertion
that company cleanup removes company skills. Normal merge
`4dbec260d36cae02bd73281bbdaac406ee989010` preserves both complete binary
patches: this PR's full fix and the independent upstream assertion. All production
source and the accepted GitHub integration file remain unchanged. The complete
cleanup-removal service suite passes all six cases in 8.16 seconds on a fresh
0409 PostgreSQL 17 fixture. The whole database source is unchanged. Current-base
migration order and fresh published-head CI/reviews remain required.
