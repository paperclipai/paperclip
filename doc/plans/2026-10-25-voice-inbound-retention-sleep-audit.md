# Inbound voice history retention sleep audit

Original baseline: inbound cleanup PR #17580, head
4b4bf2d8af6e08d3859ada4b720e7fbd3ea27e24.
Branch: codex/sleep-24-voice-inbound-retention.
Current integrated parent: b8b12199b9185e6318319cceb9511f5285734e41.
Status: implementation and local acceptance complete; current-head CI/review and parent landing remain required.

## One reason

Remove the remaining recurring inbound history delete. Keep call reports in the
next separate slice. `voiceInboundService.pruneHistory` currently runs from
`voiceSessionService.reconcileMaintenance` in chat's periodic maintenance lane.

The existing retention policy deletes only denied, expired or ended admissions
with no session or intake task, confirmed provider cleanup, and both expiresAt
and updatedAt at least seven days old. Preserve that policy. The actual deletion
deadline is max(expiresAt, updatedAt) + seven days. Never treat unconfirmed cleanup
or a terminal UI label as deletable history.

## Owners and producer boundary

The existing admission rows and cleanup confirmation remain truth. No new table
or row fields are needed. Reuse the scoped deadline worker and register a separate
retention queue. Keep state selection, deadline calculation and deletion in the
voice owner. Startup/app wiring only registers the owner.

All supported admission mutations already use notifyVoiceInbound directly or the
voice-change composition. Extend that boundary to signal the separate retention
queue before writes. This includes signed terminal callbacks, cleanup confirmation,
legacy binding repair, approval/session handoff, expiry and rejection. Bound rows
remain ineligible; their history belongs to their other owners. Company deletion
can remove confirmed unbound history within its existing transaction.

At deletion time, lock and recheck the row and deadline. A cached candidate must
not delete a row that acquired a binding, lost confirmation, or had its updatedAt
moved by a committed write. Preserve fair paging, coalescing, backoff, drain and
shutdown through the existing shared mechanism. Own deletes should retire their
cached entries without starting another periodic scan.

## Required verification

- Configured idle and no eligible history become SQL-quiet.
- Confirmed retained history schedules the exact seven-day deadline and does not
  query before it; restart reconstructs that same deadline.
- Real cleanup confirmation and signed callbacks register retention through their
  transaction boundary; rollback/outer commit behave correctly.
- Unconfirmed cleanup and bound history are never deleted.
- A changed deadline/binding between discovery and deletion is rechecked.
- Paged backlog, first write during drain, failures, and shutdown retain work.
- Existing voice, cleanup, deletion and startup consumers pass.
- Remove only history pruning from recurring maintenance; call reports remain.

No Cloud wake or sleep eligibility expansion is included. The external scheduler
must cover a deadline before that deadline can justify stopping the host.

## Stack state

#17580 is published and attached; 205 selected tests, workspace types/build and
migration checks passed locally. Initial CI run 40181994295 and review run
40181994134 are live on its exact published head. It is mergeable and had no
failures at inspection. Fresh checks/reviews remain required; no merge authority
is implied. #17578 at 90caaf3fa9 has passing checks and exact-head Greptile 5/5;
its latest Paperclip reviewer stopped before completion.

The full original recurring-server ledger, older #17490 E2E failure and final
stack/master reconciliation remain required.

## Implementation and initial evidence

The dedicated voice retention owner now loads eligible deadlines, rounds SQL
submillisecond dates up, and locks/rechecks before deletion. The existing producer
helper signals both voice admission cleanup and retention. App wiring registers
the owner; voice maintenance no longer calls `pruneHistory`. Reports remain in
that lane, and manual diagnostic reconciliation remains compatible.

The initial ten PostgreSQL lifecycle cases had one invalid assertion: an open
transaction was expected to have no coordinator deadline. Intent reconciliation
correctly retains a deadline until settlement. The test now checks invisible
uncommitted state and the row still present within its owning transaction; it
requires deletion only after commit and quiet after rollback. All ten then passed.
An additional real concurrent binding-lock regression and production service
confirmation tests are being verified. Full voice acceptance uses a fresh database
created through the repaired application migrator, not direct SQL replay.

Parent #17580 required repair 4f0364d269: register migration 0388 as top-level
because of its concurrent index. A new migration-runner regression reproduced the
failure, then proved fresh setup, invalid-index repair and concurrent/repeat
replay after the fix. This parent repair was merged into this branch; its fresh
CI is running. See the parent's audit for preserved failure evidence.

## Acceptance evidence

- 11 retention lifecycle tests and 13 parent cleanup tests pass (24 total).
  The added concurrent-binding test holds the real row lock, commits a task
  binding while deletion waits, and proves retention rechecks and keeps the row.
- Full voice integration and app wiring pass 131 cases on a fresh database.
  Two new service tests start retention while the admission is unconfirmed, then
  use a signed terminal callback or real rejection/provider cleanup to establish
  confirmation. Each observes its saved seven-day deadline, SQL quiet before it,
  deletion at it, and quiet afterwards.
- The first acceptance run waited 120 seconds before rejection, exceeding the
  original call's approval window. That correctly rejected the test operation and
  left an unconfirmed fixture affecting two later global cleanup assertions. The
  corrected test checks pre-confirmation quiet for ten seconds and the full suite
  passes on a newly migrated database. Production expiry policy did not change.
- Workspace typecheck and build pass. A final server typecheck covers the last
  added concurrent-binding test. Shared deletion/startup and parent recovery
  checks are tracked below when their current processes finish.
- No repository-wide `pnpm test:run` success is claimed: the local embedded
  PostgreSQL initialization limitation from earlier slices remains. The selected
  database suites use isolated real PostgreSQL; fresh remote CI is required.

Logs: `/tmp/sleep24-retention-cleanup-final.log`,
`/tmp/sleep24-voice-acceptance.log` (preserved initial failure),
`/tmp/sleep24-voice-acceptance-fixed.log`, `/tmp/sleep24-workspace-types.log`,
`/tmp/sleep24-workspace-build.log`, `/tmp/sleep24-final-server-types.log`.

Final local consumer checks pass: 52 company-deletion/startup tests, 11 parent
voice recovery tests, and final server typecheck. Selected nonoverlapping test
coverage totals 218 passing cases. The implementation and local verification are
complete; remote PR CI/review and the rest of the original stack remain pending.

## Review repairs

The first published head 9c38ddfe53 passed all CI and Greptile 5/5. Paperclip
Review found unnecessary endpoint-wide retention refresh on every new call and
missing behavioral coverage of removal from the maintenance lane.

Pre-call admission now allocates its ID before insertion and registers the
existing intent for that admission only. Retention lookup uses the primary key;
new calls no longer scan the endpoint's retained history. Cleanup receives the
same precise hint. Existing endpoint/company configuration changes retain their
scope, and startup still reconstructs eligible history. No schema change.

Two service regressions verify the actual signed pre-call scope and drive the
real chat coordinator/voice maintenance path with due, confirmed history. The row
survives maintenance and is deleted by the retention worker. Temporarily restoring
pruning to voice maintenance makes this latter test fail with the row missing;
restoring the implementation passes. All 133 full voice/app wiring tests and
server typecheck pass after the repair. Logs are /tmp/sleep24-review-acceptance.log,
/tmp/sleep24-review-types.log, /tmp/sleep24-maintenance-mutation.log and
/tmp/sleep24-maintenance-restored.log. Typecheck covers production sources; the
server tsconfig excludes the test directory, whose behavior is verified by Vitest.
Fresh remote checks/review are required on the repaired head.

Parent #17580 has all checks terminal and Greptile 5/5 at 4f0364d269. Its final
Paperclip review added two findings: unresolved cleanup can block deletion, and
rejection awaits provider calls. These require explicit disposition/repair at the
parent; green checks do not resolve them. An arbitrary retry cap or credential
failure is not proof that a provider call ended and must not silently discard the
cleanup obligation. Preserve that requirement while assessing the deletion path.

## Denial worker propagation

The parent denial-latency fix is incorporated. Retention's real cleanup-receipt
producer case now registers the cleanup worker and waits for its confirmed result,
instead of assuming the decision request itself performs provider I/O. Both
retention and denial regression cases are retained. The initial merge verification
failed to parse unresolved conflict markers; no voice cases ran. After preserving
both sides and completing the merge, all 134 voice/app cases passed on that still
unused voice database. Logs: `/tmp/sleep24-denial-acceptance.log` (parse failure),
`/tmp/sleep24-denial-acceptance-fixed.log` (134 pass).


## Current-parent paging and restart acceptance, October 28

This revision normally merges cleanup parent `b8b12199b9185e6318319cceb9511f5285734e41`.
It retains that parent's generated migration 0395, cleanup paging and approval
repairs. The 13 original owned paths remain the complete slice. No database,
shared worker, workflow, lockfile or provider protocol change belongs to retention.
The plan merge preserved both dated histories. The automatic source merge added
a duplicate DELIVERY_QUEUES test import; the first combined voice suite failed
to parse before running any case. Removing only the duplicate import lets all
126 full voice cases run and pass on the still-empty dedicated test database.
That parse failure remains `/tmp/sleep24-final-voice-consumers.log`.

### Bound reconstruction without changing retention policy

The old retention reader performed all 100-row queries inside one load. A new
105-row future-history fixture showed it selected 105 rows in startup's first
pass, failing the 100-row budget. The worker now uses the parent's existing
`{ rows, complete }` contract. It returns at most 100 rows per scope refresh and
preserves the full explicit `load` API. It changes no seven-day calculation,
submillisecond rounding, confirmation requirement or binding exclusion.

Per-scope cursors advance only after successful reads and reset on registration.
The new case stops after the first 100 of 105 future records, starts the same
service owner, checks another initial 100 rows, reconstructs the original deadline,
and deletes all 105 rows at that deadline. It observes SQL quiet before the
actual deadline and after settlement. Removing just the reset makes restart read
five rows and fails the budget assertion. The guarded mutation was restored
before the complete lifecycle acceptance. Row measurements are selected rows,
not PostgreSQL tuple visits or deployed costs.

The external retention fixture also assumed a pre-existing schema. Its first
empty-database run failed on missing companies/admission tables. It now applies
the application migrations with the standard setup timeout. The first-pass
budget then failed at the intended 105-versus-100 assertion before the reader
repair. Both failures are retained in `/tmp/sleep24-empty-fixture-red.log` and
`/tmp/sleep24-page-budget-red.log`.

### Final evidence and limits

280 distinct cases pass on the combined source:

- All 126 voice-session integration cases, including actual signed ingress,
  cleanup confirmation, scoped retention wake and maintenance-lane behavior.
- All 154 cases in ten full retention, cleanup, parent recovery, company removal,
  shared deadline/coordinator/batching, startup and hostname suites. This includes
  12 retention and 14 cleanup lifecycle cases. Voice integration, parent recovery
  and company removal use separate initially empty databases and migrate themselves.
  Retention uses its dedicated database after the fresh-setup repair. Cleanup
  uses its already-migrated dedicated database. These suites do not share fixture
  state with a live application.

Server typecheck, build and the module-boundary check pass. Logs:
`/tmp/sleep24-final-voice-consumers-fixed.log`,
`/tmp/sleep24-final-lifecycle-consumers.log`,
`/tmp/sleep24-final-current-types.log`, `/tmp/sleep24-final-current-build.log`, and
`/tmp/sleep24-final-module-boundaries.log`. The passing initial 12-case retention
run is `/tmp/sleep24-bounded-retention-first-green.log`; it is included in the
154, not counted twice. The guarded restart failure is
`/tmp/sleep24-cursor-reset-mutant-red.log`.

Older 218/133/134-case and workspace-wide results apply to their stated heads.
No new complete local repository suite, live provider, Cloud wake, host/database
suspension or savings claim is made. Independent writers still need an explicit
wake integration. Call reports remain their own duty. Current-head reviews,
all CI and earlier stack landing remain required; an older passing score or
inherited local acceptance cannot replace these gates.


The prior published head `daca270a99` had a failed server (4/12) check in run
40557790710, job 122386307340. Its actual log records a runner shutdown signal
and operation cancellation before the suite completed. This is incomplete
acceptance, not a passing run or an established product flake. The trusted runner
selection also had a cancelled check. The source failure log is preserved at
`/tmp/sleep24-daca-server4-failed.log`. New-head CI must complete independently.


## Configuration rescan review repair, October 28

Ponytail's current-head 4/5 review of `ffe9d47b7f` identified that completed
connection/company/endpoint scans restarted after every configuration save.
Paging bounded each burst but did not remove total repeated work. A real
producer regression seeds 205 future confirmed admissions and performs five
separate `toolAccessService.updateConnection` saves, allowing each scan to settle.
It selected 1,025 admission rows before the repair and selects zero afterward.
All original retention deadlines remain armed and unchanged.

`notifyVoiceInbound` still notifies cleanup for every supported scope. Retention
now receives only admission-scoped writes. Startup retains its complete paged
reconstruction. Configuration, authority and voice-session changes do not modify
admission eligibility or its timestamps. Admission creation, confirmation,
expiry, approval/binding and signed lifecycle writes retain their exact hints.
The schema uses restrictive session/task foreign keys, not implicit SET NULL
transitions that could create eligible history behind this boundary. Cascading
endpoint/company removal creates no retained work. A previously cached deadline
may expire once after a row has been removed; it cannot recreate history or start
recurring reconciliation. Arbitrary SQL and other processes still require their
own explicit wake contract.

Successful deletion now uses its returned row identity to settle the cached
entry directly. A changed, bound or not-yet-due row still reloads current state
so its deadline is preserved. The new real-delete case observes no post-delete
SELECT. Guardedly removing that fast path reproduces the extra SELECT; the
original source was restored. There is no new helper, queue, schema or scheduler
contract.

All 282 distinct cases pass after this repair: 127 complete voice integration
cases and 155 cases in ten full retention/cleanup/recovery/company-removal/shared/
startup suites. These include 13 retention cases. The complete voice suite uses
a fresh dedicated database; the lifecycle suites use their existing separate
isolated databases. Server typecheck and build pass. The earlier 280 count belongs
to `ffe9d47b7f`; these cases include that coverage and are not added to it.

Logs: `/tmp/sleep24-config-amplification-red.log` (1,025 rows),
`/tmp/sleep24-review-final-voice-consumers.log` (127 pass and zero-row budget),
`/tmp/sleep24-review-final-lifecycle-consumers.log` (155 pass),
`/tmp/sleep24-review-final-types.log`, `/tmp/sleep24-review-final-build.log`, and
`/tmp/sleep24-deleted-reload-mutant-red.log`. Fresh exact-head reviews and CI remain
required after publication; the prior green CI and 4/5 review are not reused for
the new commit. No complete local repository suite, live provider, Cloud wake or
physical suspension claim is added.

## Current-master CI repair — October 28

After normal integration of landed cleanup, head `768c650365362b12b75ca6481f44468132cf599a`
received exact-head Greptile 5/5 and Ponytail 5/5, but CI run `40697141057`
failed. This is not accepted as green evidence. Server shard 7/12 job
`122846941793` reported 1 failed test, 1,750 passed and 6 skipped: cleanup's
backlog fairness case expected the other company in the first 25 provider
calls even when its random admission ID placed it after the first 100-row
inventory page. The secondary afterEach error retained the deliberately
injected provider failure because the assertion interrupted settlement.

Giving the second company a fixed final UUID reproduced the same first-batch
assertion on unchanged production scheduling. The fixture now uses its supplied
ID for both the inserted row and transaction notification. The corrected case
controls fake time, places that company on the second inventory page, checks it
is absent before discovery and served within the next 25-call batch, completes
all 105 successful calls before the failed provider's saved retry, and checks
that failed provider runs exactly once again when its deadline arrives. It also
checks idle SQL after settlement. No production worker, policy, deadline,
assertion timeout, or workflow changes are made.

The first controlled-time repair run passed 23 cases but failed the fairness
case by demanding idle active=0 between inventory passes. An unresolved
transaction intent can legitimately retain that hold while the next pass is
scheduled. The final test waits for the next scheduled pass or actual idle
settlement while advancing one second at a time, then requires actual idle
settlement after the backlog. This failure is retained rather than counted as
a pass. A guarded mutation bypassing company rotation fails the corrected
fairness assertion with missing second-company delivery; the original shared
helper was restored byte-for-byte before final acceptance.

The same CI run's Canary Dry Run job `122846941357` independently failed
installing the standalone Kubernetes plugin: npm returned 404 for the exact
`rollup-4.66.0.tgz` requested by Vite through Vitest. At 13:39:46 UTC both that
version metadata and exact tarball returned HTTP 200. No dependency pin,
workflow exception, or blind CI retry was introduced. New-head CI, including
the canary, must pass independently; the original 404 remains recorded.

Final local acceptance after restoring the guarded shared helper: both complete
cleanup (24) and retention (13) lifecycle suites pass, 37 distinct cases total.
Retention starts from a new empty dedicated PostgreSQL database and applies the
application migrator; cleanup uses its isolated already-migrated database.
The earlier 282-case evidence belongs to unchanged retention source at its
stated head and is not added to 37. No new full local repository suite, live
provider, Cloud wake, suspension, or cost-saving result is claimed.

Logs: `/tmp/sleep24-768-server7-job.log`, `/tmp/sleep24-768-canary-job.log`,
`/tmp/sleep24-cleanup-fairness-red.log`,
`/tmp/sleep24-cleanup-fairness-green.log` (the 23/24 failed intermediate run),
`/tmp/sleep24-cleanup-fairness-final.log` (24 pass),
`/tmp/sleep24-cleanup-fairness-mutant-red.log`,
`/tmp/sleep24-ci-fairness-final-consumers.log` (37 pass), and
`/tmp/sleep24-rollup-registry-probe.json` (current HTTP availability only).
