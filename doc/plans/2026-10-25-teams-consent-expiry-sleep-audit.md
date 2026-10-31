# Teams unused-consent expiry sleep audit

Baseline: voice call-report PR #17586 at 250fca6cff.
Branch: codex/sleep-26-teams-consent-expiry.
Status: implemented and locally verified; publication and remote gates pending.

## Separate reasons

The Teams maintenance callback in microsoft-teams/file-delivery.ts runs from
processPublicationMaintenance and repeats a database selection every 30 seconds.
It combines two obligations. This slice owns only unused consent expiry:
consent_pending, awaiting_consent and upload_pending rows become expired at their
existing expiresAt. Abandoned consent_sending/uploading/file_info_sending attempts,
and conflict rows with a retained attempt expiry, belong to the next slice.
Unknown outcomes without a live deadline are passive operator-review evidence;
expiry must not convert them into retries or manufacture delivery receipts.

## Owner and persistence

chatTeamsFileTransfers already owns the phase, expiry, company, endpoint,
publication, version, authority digest and encrypted private state. No schema or
new queue table is needed. teamsFileTransferService is the only production insert
and update owner found by the initial writer search. Its issue() insertion and
central update() helper are the two notification boundaries. Caller-owned
resolveInTransaction uses that helper; its signal must wait for outer commit.
Deletion should simply remove a cached entry on the next owned deadline; it must
not retain a perpetual scan.

The existing lock order is publication -> transfer -> projection policy/source
locks. Expiry rechecks eligibility after those locks and performs no provider
I/O. Integrity checks and projection in the same transaction must remain intact.
Maintenance lock waits are bounded to 250ms, with no-wait publication/transfer
locking. A bad or locked row must not starve other companies or later rows.
Never log private envelopes, SQL parameter errors, provider capabilities or tokens.

## Intended migration

- Reuse scoped deadline work, with paged startup reconstruction and transfer-ID
  hints from committed writes. Register the worker through the Teams owner;
  app wiring only supplies shared lifecycle and admission gates.
- Load only the three unused phases, with ceil(expiresAt milliseconds) so a
  PostgreSQL submillisecond expiry cannot be executed early or spin.
- Recheck and expire one transfer through its owning protocol method, preserving
  atomic publication projection and no-provider-I/O semantics. Result loading
  removes settled/changed rows; failed reconstruction or expiry retains retry.
- Keep explicit manual expireAndRecover compatibility for tests/diagnostics.
  Production aggregate maintenance must select and execute only abandoned
  attempts after this slice. It must not keep expiring unused consent as a hidden
  second owner. That remaining attempt scan is intentionally still pending.
- Preserve configured idle, completed history, unknown outcome and active-attempt
  quiet for this worker. Real outstanding consent remains a future obligation.
- Do not change authority-on-use checks, transport execution, Cloud wake coverage
  or whole-instance sleep eligibility.

## Verification plan

Use the existing real-PostgreSQL Teams protocol fixture, and exercise real issue,
process/consent and cancellation/resolution writers. Cover saved expiry and
restart, first committed transfer, nested commit/rollback, no early reads,
changed phase at claim, provider-call absence, atomic projection rollback,
private-error redaction, lock contention/fair backlog, drain/resume, shutdown,
and submillisecond deadlines. Existing protocol, publication and consent tests
must continue to pass. Exercise production registration and ensure old maintenance
cannot expire consent. Full stack checks and master reconciliation remain required.

## Other outstanding gates

#17586 is published, attached, and locally verified; remote CI/reviews are pending.
#17580's company deletion policy finding and #17490's E2E cancellation failure are
still unresolved. No original recurring-server obligation is removed from scope.

## Implementation and acceptance

The Teams owner now registers a scoped deadline worker. The existing service
signals before issue/update writes, including caller-owned resolution transactions.
Startup pages eligible rows; transfer hints reload only that primary key. The
owner rechecks expiry with the original publication/transfer lock order and
atomic projection. The old periodic selection and execution now cover attempts
only. No schema or external wake contract changes are included.

Local verification at the slice-26 implementation:

- 65 transfer protocol cases pass on a fresh external PostgreSQL database.
  These include 102-entry paging/fairness with one corrupt row, shutdown joining
  a held projection, the three consent phases, precision, rollback, restart,
  drain/resume, private-error redaction and the remaining maintenance boundary.
- The earlier five-suite run passed 206 cases: then-63 transfer cases and 143
  publication, consent, consent-runtime and app-wiring cases. The final transfer
  run adds two cases. The latest app-wiring assertions pass all 16 cases again.
- 14 selected real production integration cases pass. This includes registration
  before an actual Board publication, post-commit wake, saved deadline, pre-expiry
  SQL quiet, atomic expiry/publication cancellation, no extra provider requests,
  and the existing Teams current-authority/Board-transfer group. The other 1,411
  integration cases were skipped, not passed.
- Together these are 222 unique selected cases. Workspace `pnpm -r typecheck`
  and `pnpm build` pass. Server typechecking excludes test files; it is not proof
  that the test files were statically checked.
- Local full `pnpm test:run` remains unclaimed because this host's embedded
  PostgreSQL setup failed earlier in the stack. Full remote gates are required.
  No live Teams tenant or deployed host-suspension qualification is claimed.

Failure ledger: the first protocol run had two invalid fixtures. A direct phase
mutation set attempt expiry without its required paired attempt ID; another
assertion treated the public ISO expiry string as a Date. Both were corrected,
then all five suites passed on a fresh database. The first production expiry
assertion expected a failed publication; the existing correct expiry projection
is cancelled. The corrected test and the authority group pass. These were test
expectation/setup errors, not weakened production contracts or hidden retries.

Evidence logs: `/tmp/sleep26-teams-tests.log` (initial two fixture failures),
`/tmp/sleep26-teams-fixed-tests.log` (206 pass),
`/tmp/sleep26-teams-final-tests.log` (65 pass),
`/tmp/sleep26-producer-tests.log` (initial projection-state assertion),
`/tmp/sleep26-production-acceptance.log` (14 pass),
`/tmp/sleep26-final-wiring.log` (16 pass), and
`/tmp/sleep26-workspace-{types,build}.log` (pass).

Parent #17586 at 250fca6cff has passing Actions, security and Greptile checks;
Paperclip Review is still running at the latest inspection. This does not clear
older stack findings or imply merge authority. Refreshed master is b7dc594bfa;
final whole-stack reconciliation is still required.


## Bounded reconstruction and current-parent acceptance — October 28

The published Teams head `aa082e4679` was inspected after the report parent was
prepared on landed master. Its worker's registered load still looped through
all pages in one scheduler pass. This acceptance repairs that existing slice;
it does not introduce another queue, scheduler, database change or duty.

A local normal merge prepares the slice on report candidate `c28de398`. The
explicit-base merge had one stack-plan append conflict. The complete report
plan and complete Teams appendix are both preserved; all source blobs match
the clean explicit-base composition. An initial literal patch comparison
rejected shifted queue line numbers (47 to 49) and blob IDs, then an overly
broad merge whitespace check flagged an inherited runner report-lock patch.
The actual patch content and owned-scope whitespace check pass; inherited
upstream files were not altered. Actual landed-parent reconciliation and fresh
remote gates are required before publication and merge.

The new 105-transfer PostgreSQL regression failed against the original reader:
startup selected 105 rows instead of yielding after 100. The worker now splits
one-page selection from complete explicit inventory reads. Registered refresh
returns the existing shared `{rows, complete}` contract and retains per-scope
cursors; registration clears them. Restarting the same service halfway through
a scan reconstructs all 105 saved deadlines, expires them at the original time,
and leaves no recurring SQL before the deadline or after settlement. No consent
card or upload is sent. Removing only cursor reset makes the restart read five
rows instead of 100; original source was restored before final acceptance.

The first regression fixture faked all timers before establishing its first
database connection and timed out, including teardown. That was not the intended
row-budget failure and is not accepted as regression evidence. Seeding now uses
real network timers with only Date frozen, then controls scheduler timers after
seeding. The corrected unchanged-reader run fails at 105 versus 100, and the
fixed worker passes. Both the failed setup and actual regression remain recorded.

Current acceptance: all 209 cases in the complete transfer (66), publication,
consent, consent-runtime and app-wiring suites pass on a new migrated fixture;
14 selected real Board-producer and Teams-authority integration cases pass on a
separate new migrated fixture (1,580 others skipped). Total 223 distinct cases;
the targeted red/green case is not added again. Server production typecheck,
build and module-boundary checks pass. The new source remains within the
existing Teams owner and existing test file. No schema, shared-worker contract,
workflow or lockfile change is introduced. The old 222-case evidence remains
historical. This does not claim a complete local repository suite, a live Teams
tenant, external Cloud wake, physical suspension or cost savings.

Logs: `/tmp/sleep26-bounded-reconstruction-red.log` (invalid timer setup),
`/tmp/sleep26-bounded-reconstruction-actual-red.log` (105 vs 100),
`/tmp/sleep26-bounded-reconstruction-green.log`,
`/tmp/sleep26-bounded-cursor-mutant-red.log` (5 vs 100 after restart),
`/tmp/sleep26-bounded-final-protocols.log`,
`/tmp/sleep26-bounded-final-producers.log`,
`/tmp/sleep26-bounded-final-types.log`, `/tmp/sleep26-bounded-final-build.log`,
and `/tmp/sleep26-bounded-final-boundaries.log`.

Current stack state supersedes the historical outstanding-gates paragraph:
cleanup and retention have landed, including the repaired legacy ownership case
and the explicitly accepted company-deletion ownership policy. The report parent
has a documentation-only follow-up after `c28de398` and still needs its own latest
CI/reviews. This local Teams preparation must preserve that actual landed parent
before publication; it is not authority to merge into an unmerged feature branch.


## Inherited retention CI fairness repair — October 28

Current Teams head `36f43922` received exact-head Greptile 5/5 and Ponytail 5/5,
but CI run `40708566195`, server shard 6/12 job `122887395220`, failed the existing
voice-retention case `pages through more than one batch of history across
companies`. The shard had 2,291 passed tests, one failed and one skipped. Its
initial assertion expected the other company's row already deleted after one
startup batch, even when its random ID put it beyond the first 100-row inventory
page. This CI failure is not accepted as green evidence.

Placing the other company at a fixed final UUID reproduces the exact assertion.
The fixture now uses a supplied ID for both insertion and its transaction hint.
The test controls scheduler time, requires that row to remain before discovery,
then requires its deletion in the next fair batch after page-two discovery. It
also checks the first 25 deletions leave exactly 80 eligible rows, drains all
remaining history, and verifies SQL quiet. The existing five-second assertion
wait budget and global test timeout are unchanged. This corrects the acceptance
expectation without changing retention, Teams, or shared scheduler behavior.

The complete 13-case retention suite passes. Its run spent 96.66 seconds in
module transforms but all actual cases completed successfully; no timeout was
increased and this was not counted as a failed test or silently retried. A
guarded mutation bypassing company rotation fails the new post-discovery fair
batch assertion. The original shared helper was restored byte-for-byte. The
previous 223-case Teams acceptance remains evidence for unchanged Teams source;
these 13 retention cases are a separate CI-repair acceptance group. Earlier
current-head Greptile/Ponytail scores become stale after publishing this test-only
follow-up, and fresh CI must pass independently. No old-job retry or waiver is
claimed.

Logs: `/tmp/sleep26-36f-server6-job.log`,
`/tmp/sleep26-retention-fairness-red.log`,
`/tmp/sleep26-retention-fairness-green.log`, and
`/tmp/sleep26-retention-fairness-mutant-red.log`.
