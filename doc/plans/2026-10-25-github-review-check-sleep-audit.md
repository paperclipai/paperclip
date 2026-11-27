# GitHub review-check scheduling audit

Baseline: `3d7c79c262f92563555b278d101de8240e6f011b`, parent
[#17661](https://github.com/paperclipai/paperclip/pull/17661).
Parent acceptance: 1,571 tests across complete chat, publication, and startup
suites passed in 517.41 seconds. All 53 remote checks passed on that commit;
Greptile reviewed the same head at 5/5 with no findings. The parent is unmerged.

## Scope and owner

This slice owns publication of the GitHub Review check derived from ordinary
chat admission, review binding, run state, and assessment ownership. Existing
`chat_actions.kind = github_review_check` rows remain durable truth. No new
queue table is needed. GitHub state interpretation belongs under
`chat-channels/github/`; the shared coordinator receives identifiers/deadlines.

Late stale-head projection repair is a separate duty. The manual combined
`processPending` API remains compatible. The legacy maintenance callback now
calls only `repairSupersededReviews`; removing that scan is the next slice.
Assessment publication remains owned by its existing governed outbox, including
its authorization, score, delivery receipts, and recovery guarantees.

## Actual external obligation

The old dispatcher checks the current remote PR head before publishing. A saved
nonterminal check receives a five-second `retryAt` even when its local state has
not changed. The current webhook parser accepts opened, synchronize, reopened,
and ready-for-review events, but receipt is not a proof that all future pushes
will arrive. A manual review can also exist without a new automatic admission.
This slice must not turn a missed webhook into a permanently active obsolete
check or authorize publication against an old head.

Retain the existing five-second remote-head reconciliation deadline only while
that particular check is received/nonterminal. Local state changes can make the
entry due immediately; a successful unchanged inspection does not rewrite the
provider check. Failure uses its saved exponential backoff and existing eight-
attempt exhaustion policy. Processed, cancelled, and exhausted history have no
worker deadline. This is not a claim that an active review needs no SQL/network
traffic: unresolved checks retain external reconciliation until they settle.
The startup global scan and committed scope rebuilds enumerate unfinished rows;
deadline dispatch rechecks only known entry IDs. No configuration-only timer.

## Producer and lifecycle boundary

- `githubReviewCheckService.enqueue`: automatic webhook and authorized manual
  creation use one awaited notification before insertion, inside a database
  transaction. Caller-owned/nested transaction settlement stays with `createDb`.
- `retainGitHubReviewReceipt`: task admission signals its repository/PR before
  inserting the queued review in the existing caller-owned transaction.
- `reviewForHead`: manual review insertion and binding an existing review to a
  run signal inside their short database transactions. Provider calls remain
  outside those transactions.
- Existing run/lineage and endpoint-configuration notification ownership fans
  out to the new topic by company. These hints conservatively rebuild that
  company's outstanding checks; they do not inspect completed history. Narrow
  repository/PR hints are used by check enqueue, review writes, and lease release.
- Assessment and publication receipts are serialized by the existing GitHub
  publication lease. Its transactional release wakes the affected repository/PR.
  A competing holder's saved expiry is a deadline if it dies without release.
- Delivery admission failures retain discovery through the outstanding check's
  remote reconciliation deadline. This does not claim every shared delivery
  mutation now emits a check-specific immediate signal.
- Restart reconstructs existing received/retryable-failed rows. Shared scheduling
  retains dirty scopes across drain/standby. HTTP admission is checked before each
  provider request; receipt fencing remains with the publication lease.
- Supported writers are the existing process-local database ownership boundary.
  Independent SQL writers and other replicas do not receive a new signal protocol.

Current provider-state reads preserve the prior latest-review/run selection,
legacy delivery provenance, current configuration checks, and completed-check
replacement behavior. Introducing a scheduler does not authorize changing those
product decisions or passing GitHub payloads into generic scheduling machinery.

## Evidence ledger

- Provider-state extraction: server typecheck initially found widened returned
  state literals. Explicit domain-state typing repaired the extraction.
- Three existing check/late-projection/manual-review acceptance cases passed after
  extraction. This was a targeted selection, not all GitHub coverage.
- First worker selection: 12 passed, one retry test failed. The fixture installed
  fake timers after a real 60-second timer had been armed, so fake advancement did
  not deliver that timer. Move fake timer installation before registration; keep
  the production deadline unchanged. Corrected selection pending.

Remaining acceptance: immediate producer transitions, scope/history pagination,
provider failure and drain boundaries, startup wiring, migration/index evidence,
full relevant acceptance, workspace checks, and remote PR review/CI. No deployed
host sleep, Cloud alarm coverage expansion, or fleet savings are claimed.

The corrected first selection passed all 13 cases. Expanded coverage added real
run-identity commit/rollback, a 101-row revoked prefix, and shutdown during HTTP.
It exposed a real stop-admission error: the HTTP boundary wrapped the stop as a
provider error and spent a retry attempt. Check admission in the catch boundary
as well; leave the durable action for resume. That regression then passed. The
next run passed 15 cases and failed the history fixture: fixed UUIDs collided
with intentionally retained rows from earlier tests. Use a per-fixture UUID
prefix while retaining deterministic before-candidate ordering. No database was
dropped and no production timeout was enlarged. Workspace typecheck passed
before the final shutdown guard change; final acceptance remains pending.

## Wired validation checkpoint

The fresh database selection passed 36 cases across chat integration and startup
wiring in 63.66 seconds. It includes eleven new worker cases plus selected existing
check and maintenance cases; the other 1,532 cases were filtered out. The complete
chat/publication/startup selection is now running separately in a fresh database.
Workspace typecheck and build passed after the shutdown repair.

Migration 0392 adds only `chat_actions_github_check_work_idx`, with the exact
received/retryable-failed predicate used by the worker. It uses concurrent,
idempotent creation and the existing top-level migration runner. Generation,
safety checks, application, replay, and index validity passed. Snapshot pruning
retains 0388 through 0392. A rollback-only plan inserted 10,000 processed actions
and one unfinished action; candidate selection used an index-only scan, read one
row and three shared buffers, and took 0.019 ms. This measures candidate selection,
not all provenance reads or fleet-wide performance.

The earlier source checkpoint is `219061a159`. No full local acceptance or remote
CI success is claimed for this slice until the running checks finish. Open parent
stack failures and review findings remain independent obligations; this slice does
not make the whole stack ready or authorize merging it.

## Full acceptance and CI repairs

Draft [#17662](https://github.com/paperclipai/paperclip/pull/17662) was published at
`c0d91f553994ba898edc2701c6879c10a46b8b50`. Its first full local run completed with
1,569 passes and 13 failures in 541.25 seconds. The first failure observed a final
terminal-response state read after the scheduler removed its deadline but before
the in-flight pass finished. `nextWakeAt() === null` does not prove quiescence.
That assertion also skipped restoring its SQL spies, causing cascading failures.
The affected quiet checks now require both zero tracked active work and no next
wake. Their spies also restore on test completion if an assertion fails. All 23
affected chat cases passed in a fresh database after this repair.

The same head's CI had 51 successes and the server 1/12 plus aggregate failure.
Server 1/12 failed the inherited setup-token consume fixture while it waited for
an idle hold. Cleanup can signal another generation during a sweep, leaving a
coalesced deadline beyond the fixture's single fake-clock jump. The fixture now
advances to actual registered deadlines while tracked work remains. It keeps the
existing observation timeout and all production intervals. All 16 login-cleanup
cases passed in a separate disposable database. Fresh full acceptance and new-
head CI/review remain required; the old head is not reported green.

An independent diagnostic replayed the earlier stack's two failing cancellation
browser cases three times each: all six passed on this head in 33.6 seconds.
Scoped lock observation did not capture a deadlock. A second minimal FK/row-lock
hypothesis also did not reproduce a cycle. These are negative diagnostic results,
not a fix for #17490 or #17572. An initial database-name collision stopped setup;
the existing database was preserved and a newly named disposable database was
used instead. No blind CI rerun was consumed.

The second complete local run finished with 1,581 passes and one failure in
541.48 seconds. The remaining assertion checked no deadline immediately after
`ready`, which awaits the first pass, not a later coalesced wake. Fixture teardown
already retires unfinished rows. Startup quiet now waits for both zero active
work and no deadline, matching the strengthened post-delivery assertion. The
complete GitHub workflow selection then passed all 211 tests in 187.16 seconds
in a new database. No production behavior changed. Head `59f8c8b3e5` has all 53
remote checks passing and fresh Greptile 5/5 with zero review threads. The new
fixture-only commit requires its own fresh remote checks; the two local full
runs are not reported as passes.

## Current-parent merge acceptance (October 28)

The earlier results above retain their stated revisions. They are not evidence
that an old review score applies to a repaired head.

The existing branch was merged normally with the updated terminal-response
parent. Only its unlanded `0396_charming_edwin_jarvis` migration artifacts were
removed before canonical generation. The domain and schema edits were preserved.
Migration `0402_ancient_malice.sql` now creates the same partial work index with
concurrent, idempotent creation. All parent SQL, journal entries, and retained
snapshot bytes remain unchanged. Generation retains snapshots 0398 through 0402.

At `6995f84b240a14a7b8660e1cf095b3aa1e1e3168`, 331 distinct cases passed:
264 complete GitHub workflow cases, 30 completion cases, eight real/unit issue-tree
producer cases, 16 login-cleanup cases, and 13 startup cases. The GitHub command
filtered 1,485 unrelated cases. Login cleanup used its real embedded PostgreSQL
fixture; the other database groups used separate, pre-migrated PostgreSQL fixtures.
Database build, server typecheck/build, module boundaries, migration safety, and
target-branch migration order passed.

The actual terminal-response parent landed as
`f8226b0515634f9c7c74e80bb6cf18f3c2634c12`. Its squash tree exactly matched its
verified merge composition. A normal merge then brought that actual parent and
current master into this branch at
`9c538aed1251fd7f7cecb829a0ecbce6110fb1ed`. Both complete added/removed patches
and every unrelated master blob were preserved. This includes the privacy-query,
remote native skill delivery, lockfile, and upstream Telegram fixture changes.

At that exact integration, all 264 complete GitHub workflow cases and all
13 startup cases passed again: 277 distinct cases, with 1,485 unrelated
GitHub cases filtered out. A new database received all migrations through 0402.
Database build, server typecheck/build, module boundaries, and migration order
against the actual landed parent passed. The earlier 331-case result retains
its earlier revision scope.

A populated parent database upgraded from 401 to 402 with all 400 previous
migration receipts unchanged and exactly one new receipt. Replay added none.
The index was valid and ready on both that database and a fresh database.
A rollback-only candidate probe added 10,000 processed actions and one received
action. The actual parameterized predicate selected one row through the partial
index with two shared buffers and 0.007 ms execution time. This measures candidate
discovery, not all provenance or lease reads. The first probe omitted the required
provider action ID and rolled back; the corrected fixture supplied unique IDs.
No production code changed for that fixture error.

The final audit commit changes documentation only. Source, tests, and migration
hashes match the accepted integration. Fresh current-head CI and Greptile review
remain required before merge. No host suspension, external alarm expansion, or
fleet cost reduction is claimed.
