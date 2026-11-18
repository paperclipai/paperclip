# Historical unsafe workspace export recovery

Current integration: 2026-10-29. Prepared parent: automatic completion-review
retirement #17680 at actual squash `73d24aa5acfcf17b3f676b4da7cd05eb70b60b99`.
Earlier draft parent: `be668fb975f119efeb4830405d4bb1ab65791f87`.
Startup registers the worker when maintenance is enabled. The periodic reaper
skips this duty. Explicit/manual recovery remains available. Fresh published-head
CI and review gates remain required; older parent scores do not prove them.

## Problem and owner

`native-runtime/native-workspace-export-recovery.ts` recovers old controllers'
`native_workspace_sync_out_unsafe_archive` failures. It does not retry an unsafe
archive or launch another provider turn. It can retire stale repair notices and
readmit an already accepted result after recording an explicit workspace omission.

The old caller in `native-finalization-reconciler.ts` visits 25 terminal failure
rows per pass. Ineligible historical rows remain in that set forever. Merely
putting those same rows on a 30-second deadline would preserve idle polling.

The new scoped worker uses the existing delivery coordinator, transaction-aware
notifications, scoped deadline helper, and scheduler. No table, provider branch,
independent timer, or host-sleep exemption is added. One partial index supports
scoped discovery without scanning completed history. The existing recovery owner
still performs all mutations and validates current state under its original
physical-owner and database-lock boundaries. The manual/startup scan still uses
that owner; extraction alone does not remove its existing behavior.

## Work predicate

Discovery joins the coordinator, exact native run, issue, and accepted result.
Company, issue, run, completion-contract, and result identities must agree.
The coordinator must still have the historical unsafe terminal failure.
One of two obligations must exist:

1. A stale unsafe action for this run is active/escalated, or resolved with the
   old `new_source_execution_path` note. Retire that notice even if later work
   prevents result readmission.
2. The existing readmission conditions hold: no explicit action settlement,
   no newer run or other queued/running run for this issue, no competing active
   recovery action, the latest contract matches, the issue is blocked/in-review
   and assigned to this run's agent, the run is failed/succeeded with terminal
   native failure, and checkout/execution ownership is absent or belongs to it.

A cancelled recovery action is an explicit veto. A resolved action with a null
or other non-automatic resolution note is also a veto. These are preserved.
Only the old automatic-resolution notes permit readmission.

A coordinator lease or physical owner can delay an actual obligation. The worker
retains its retry; it does not infer that the owner stopped because time elapsed.
Dormant history has no retry. Relevant committed state changes must rediscover
it. The producer audit below records the supported local writers.

Discovery uses 100-row keyset pages. Dispatch uses the shared fair company batch
with a five-entry limit. Exact pending work retries after 30 seconds; exceptions
use the shared bounded backoff. The check reads the exact run again before
calling the owner, then retains a deadline only if the work predicate still
holds. Successful recovery leaves an omission barrier, never a copyback receipt.

## Producer coverage checkpoint

Implemented:

- The real finalization-failure writer signals before committing an unsafe
  terminal failure. It does not signal unrelated failure codes.
- `issueService.update` signals changed status, assignee-agent, execution-run,
  and checkout-run fields in its existing transaction.
- Recovery-action insertion, identity supersession, and relevant cause/run
  identity changes signal in their existing transactions.
- Recovery-action resolution checks for a matching active action before
  registering an intent. Repeated resolution of an already-settled action does
  not wake this worker. Operator-guidance/attempt metadata alone does not wake it.
- The shared heartbeat run-status writer signals changed status, using the
  already-loaded native issue and context issue identities. No extra lookup is
  needed to identify those issues. Both distinct issue references are covered.

Additional producer coverage:

| State that changes eligibility | Existing owner paths now signalling before their writes |
| --- | --- |
| Task status, assignment, or stale ownership | Task update, terminal checkout/execution release, admin force release, task-tree restoration, archived-member reassignment, chat conversation settlement, queued-comment release, status-decision effects, queue dependency blocking, stale-lock recovery |
| Competing queued/running run becomes terminal or leaves that set | Lifecycle status writes, queue cancellation, dispatch suppression/stale-run cancellation, retry deferral, active-run watchdog, execution-control recovery, orphan recovery, legacy settlement, native finalizer, finalization reconciler, restart recovery, and session executor |
| Recovery action status or lineage | Recovery-action service, issue repair routes, execution/legacy recovery resolution, workspace reconstruction, safe replacement, explicit continuation |
| Historical unsafe failure first appears | Finalizer failure, interaction bridge finalization error, coordinator-store retry marking |
| Deletion removes a competing run | Agent and company deletion signal the company before deleting runs |

Signals carry only company and optional issue IDs. Run writers use their already
loaded native issue and legacy context issue; both distinct references are sent.
Signals do not pass service contexts, provider data, or database objects through
JSON. Existing transaction owners remain authoritative. The few root writes
without a transaction now wrap only their database mutation and signal, not
provider calls. No caller gains new recovery authority.

The writer inventory inspected issue status/assignment/ownership, run status/
native phase/context, and action status/cause/evidence writes, including variable
patches. Metadata-only writes do not create eligibility. Monitor patches change
only monitor policy/state/deadlines. Workspace-binding patches change workspace
fields. Ordinary checkout/adoption moves to in-progress, and ordinary release
clears assignment; neither enables this accepted-result path. New-run ownership
also introduces a newer or active run, which prevents old-result readmission.
Queued-run suppression restores queued state, which remains a competing run.
Run coalescence retains the admitted task scope; ordinary context enrichment adds
comments, routing, session, or delivery metadata. Accepted result identity and
completion-contract history are immutable in supported service paths. The raw
SQL audit found no additional relevant state mutation.

Independent SQL writers and another server process are outside the existing
process-local notification contract. Startup reconstructs committed work. This
slice adds no cross-process listener or provider wake contract.

The heartbeat facade supplies admission state. Startup registers only in the
enabled-maintenance branch. The periodic reaper passes
`skipUnsafeWorkspaceExports`; direct/manual calls default to the old scan.
Shutdown stops the shared coordinator and joins its work. Ownership contention
keeps a concrete retry; stopped/drained execution cannot silently discard it.

## Query cost and migration

The measured SQL was captured from the actual worker through the PostgreSQL
client debug callback. A rolled-back fixture retained 10,000 completed native
results/coordinators and one stale unsafe notice. Without an index, the startup
query visited 10,074 result rows and took 9.827 ms. Scoped discovery removed
10,075 coordinator rows by filter and took 2.625 ms. LIMIT alone did not bound
history work.

The partial index on `(company_id, issue_id, run_id)`, restricted to the exact
unsafe terminal-failure state, reduced these measurements to 0.105 ms and
0.046 ms. The plans selected one coordinator from the partial index. These are
local fixture timings, not deployment latency or fleet cost claims. Dormant
unsafe history still requires eligibility evaluation when its scope changes.

Current migration `0410_freezing_kinsey_walden.sql` creates the index concurrently with
`IF NOT EXISTS` through the existing top-level migration runner. Fresh database
application, migration replay, direct SQL replay, and ready/valid index inspection
passed. The current generated snapshot set retains 0406–0410. Historical SQL and journal
entries remain intact. The index adds write/storage cost only for matching rows.

## Evidence and preserved failures

Baseline: 51 existing export tests passed on fresh PostgreSQL in
`/tmp/sleep46-baseline.log`.

Initial worker run: 65 passed, four failed (`/tmp/sleep46-owner-v1.log`). The new
producer fixture incorrectly inserted a preexisting unsafe action with a
non-production fingerprint. The actual failure writer superseded it with a
cancelled record. The existing explicit-settlement veto correctly prevented
readmission. The fixture now starts before that recovery action exists. No
production veto was weakened. The failed database remains available as
`paperclip_sleep46_owner_v1_20261025_test` on the local test Postgres instance.

The next export run passed all 70 cases (`/tmp/sleep46-owner-v2.log`). Real issue
and recovery-action producers then replaced the direct-hint fixture; all 71
export cases passed. A combined command also ran one non-database recovery test
but skipped 88 PostgreSQL cases because their separate environment variable was
unset (`/tmp/sleep46-owner-v3.log`). Those skips are not acceptance evidence.
With its dedicated database explicitly set, all 89 recovery-action tests passed
(`/tmp/sleep46-recovery-v1.log`).

Server typechecks passed after the worker, producer, and no-op notification
changes. The final combined run passed all 161 tests with no skips: 72 export-owner
cases and 89 recovery-action cases, including the no-op notification regression,
with separate explicit databases (`/tmp/sleep46-producers-v4.log`).

Current tests establish empty/history quiet, explicit settlement fences, stale
notice retirement without result replay, real failure creation, outer transaction
commit/rollback, restart, drain/resume, coordinator-lease retry, failed discovery,
and real task/recovery-action reactivation. The post-wiring selection below adds startup, ownership, and direct-producer
coverage beyond this initial checkpoint.

Post-wiring verification:

- The first expanded selection passed 226 cases and failed one new physical-owner
  assertion (`/tmp/sleep46-owner-v5.log`). It inspected the next deadline while a
  worker attempt was in flight. The test now waits for that attempt to settle;
  no production ownership or scheduling rule was weakened.
- The next selection passed 229 cases. After adding real queued-run cancellation
  and the index migration, all 230 owner/recovery-action/startup cases passed on
  fresh databases (`/tmp/sleep46-owner-v7.log`). This includes physical ownership,
  task cancellation during contention, admin and stale-lock release, shutdown/
  restart, and 103 stale notices across discovery pages.
- Ten affected consumer suites passed 374 cases and skipped 22 lifecycle database
  cases because embedded PostgreSQL was unavailable. The lifecycle suite now
  accepts the validated explicit external-database option. Its 31 cases then all
  passed, including those 22. Combined with the owner selection, this establishes
  626 distinct passing cases across 13 files. Logs: `/tmp/sleep46-consumers.log`
  and `/tmp/sleep46-lifecycle.log`.
- Query-plan fixture setup first violated the existing unique active-action rule;
  the fixture now settles its old active action before inserting the owed notice.
  All fixture data is rolled back. The capture script initially used a missing
  root runner and then the wrong module format; using the database package runner
  with an ES module captured the real SQL successfully.

Workspace typecheck and build passed. Exact-head remote CI/review remain required
before this slice is accepted. Other stack gates and migration reconciliation with
master remain outstanding.

## Notice-retirement follow-up

Retiring an older run's stale unsafe-export notice can make a newer accepted
result on the same issue eligible. The owner now registers an issue-scoped
notification in its existing transaction before that retirement, using the
already-loaded action rows to avoid signalling an unchanged notice. The next
pass rediscovers the issue, rather than only rechecking the older run. Existing
physical ownership and eligibility fences are unchanged.

A real PostgreSQL regression first reproduced the newer result remaining in
terminal failure after the older notice resolved. It now proves automatic
readmission without another write or restart, preservation of both accepted
results, no extra run or provider call, and quiet after settlement. All 80
export-owner tests and 63 startup tests passed. The first combined rerun failed
export fixture setup because the reused database retained its fixed company
prefix; the complete export suite subsequently passed on a fresh dedicated
database. Final integrated typecheck, build, and remote checks remain required.


## Current migration410 integration and complete acceptance

Only this slice's unlanded 0402 migration artifacts were deferred before a
normal merge of the current automatic-review parent. There are no conflicts.
The complete original runtime/schema patch and every unrelated upstream blob
are preserved. The migration directory and client matched the exact parent
before generation. `pnpm db:generate` generated
`0410_freezing_kinsey_walden.sql`. Its concurrent, idempotent SQL is byte-identical
to the original. All prior SQL, journal entries and retained snapshot bytes
remain unchanged, with five snapshots 0406 through 0410. Nine newly added
comment lines in two files were removed under CONTRIBUTING.md. The full
non-comment TypeScript token streams are identical. The explanations above
retain the notice-retirement, omission barrier and diagnostic ownership facts.

Source `2a13dd08a6cc52f0adab09e3df9ce31e97b746b9` passes **2188 cases across
24 complete files**, without skips. The main selection passes 2129 cases in
192.58 seconds; the independent safe-replacement suite passes 59 in 26.04
seconds. The selection covers real export and recovery-action producers,
workspace reconstruction, explicit continuation, interaction routing, Stop,
queue admission, Slack and all 968 native-session cases. Per-file counts:

| Complete file | Passing cases |
| --- | ---: |
| src/__tests__/issue-recovery-actions.test.ts | 89 |
| src/__tests__/native-finalization-recovery.test.ts | 32 |
| src/__tests__/native-interaction-bridge.test.ts | 7 |
| src/__tests__/native-workspace-sync.test.ts | 10 |
| src/__tests__/recovery-stale-issue-lock-sweep.test.ts | 40 |
| src/__tests__/server-startup-feedback-export.test.ts | 65 |
| src/__tests__/slack-conversation-lifecycle.test.ts | 41 |
| src/modules/run-dispatch/adapters/postgres.test.ts | 69 |
| src/modules/wake-queue/adapters/postgres.test.ts | 93 |
| src/modules/wake-queue/adapters/queued-comment-postgres.test.ts | 5 |
| src/services/execution-control-reconciliation.test.ts | 10 |
| src/services/explicit-native-continuation.test.ts | 335 |
| src/services/heartbeat/queue.test.ts | 32 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/services/heartbeat/run-control.test.ts | 51 |
| src/services/heartbeat/run-lifecycle.test.ts | 31 |
| src/services/heartbeat/upgrade-readiness.test.ts | 7 |
| src/services/legacy-execution-recovery.test.ts | 15 |
| src/services/native-runtime/native-restart-recovery.test.ts | 25 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/services/native-runtime/native-safe-replacement.test.ts | 59 |
| src/services/native-runtime/native-session-executor.test.ts | 968 |
| src/services/native-runtime/native-workspace-export-retry.test.ts | 80 |
| src/services/native-runtime/native-workspace-reconstruction.test.ts | 50 |

Twenty separate fresh PostgreSQL 17 databases migrate through 0410 before
setup. Destructive fixtures do not share databases. Four embedded-only test
imports temporarily use their own external database on this IPC-exhausted
host: interaction bridge, workspace reconstruction, Slack lifecycle and
wake-queue PostgreSQL. They are restored byte for byte. All assertions and
original timing limits remain unchanged. The lifecycle suite uses the supported
external URL already added by this slice. This is qualified external-database
acceptance, not an unmodified embedded CI reproduction. Actual database build,
server types/build, module boundaries and exact-head migration order pass.

A populated 0409-to0410 upgrade preserves all 408 prior migration receipts and
all 38 companies, appends exactly one receipt and adds none on replay. The
unsafe-export index is valid and ready on fresh and upgraded databases.

These checks preserve all earlier failures recorded above and verify current
worker, ownership and affected-consumer behavior. Publication remains held until
the actual prerequisite merges and its ancestry is reconciled. Fresh
current-head CI and reviews remain required. These tests do not establish
deployed host/database suspension, external wake delivery or fleet savings.


## Prepared parent carrying published cleanup ancestry

Normal merge `57ddb838cc93d5d8d0e7f8a0c2d1a2beed8b4394` adopts prepared parent
`790a27d28f23be0f436eb96a884dc7988ff10823`. Its source equals the prior accepted parent;
only parent documentation and ancestry change. Complete server, package, UI
and test trees remain identical to the accepted 2188-case source, including
the whole 0410 database tree. Publication remains held for the actual
automatic-review merge and fresh published-head CI and reviews.


## Inherited corpus repeatability fix and source-preserving acceptance

Normal integration `8f43c9f81fac23b50997e7f0e1d0d9cf383a8109` carries the
verified prefix correction through the updated automatic-review parent. The
only changed source file relative to the accepted child is the status-authority
corpus: its two fixed prefix values now use their own company UUIDs. All
production source, all packages including the complete 0410 database tree, and
all 24 files in the accepted 2188-case selection remain byte-identical to their
accepted source. No assertion, timing limit or teardown changes. The prior
2188-case evidence retains that precise source scope.

The additional complete 72-case status-authority corpus passes at this source
in 14.00 seconds, then passes again on the same fresh 0410 database in 13.08
seconds. Three retained PSC/OUT/sentinel company rows remain unchanged in the
inspected ID/name/prefix fields after both runs; each invocation appends two
distinct UUID-derived prefixes. Database build and exact-head migration order
pass. This adds one independently checked file to the previous selection; the
repeat is not counted again as distinct coverage. Previous collision and
rejected-deletion failures remain recorded in the parent audit.

The actual automatic-review prerequisite still must merge before publication.
Fresh published-head CI and review are required, with existing sleep and
external-wake limitations unchanged.


## Published automatic-review parent

Normal merge `6771a6c648c6ac1e9f0f73a91710d61bf5608aaf` adopts published parent
`40f84082526d6ba405f206475c919c3b4b67ec4c`. All server, package, UI and test trees
remain identical to the accepted child, including the 2188-case runtime/test
scope, the additional 72-case corpus with its same-database repeat, and the
complete 0410 database tree. Only parent documentation and ancestry change.
Publication stays held until the actual automatic-review squash and its
ancestry reconciliation. Fresh current-head CI and reviews remain required.


## Inherited CI observation correction and independent master assertion

Normal integration `4d51231abe8b68c21ce896d0d2ac16865978c8ab` adopts
published automatic-review parent `181bf800a79449961e09c995f2785dd7f8060bb3`.
The only source changes are the initial GitHub idle poll's established
five-second observation argument and master's company-skill cleanup assertion.
All production source, all packages including migration 0410, all 24 accepted
suite files and the additional 72-case corpus remain byte-identical. The
previous acceptance keeps that precise source scope; it is not rerun or
recounted here. The parent audit retains the original CI failure and controlled
comparison, including its inability to reconstruct the exact CI token timeline.

The two native-presentation GitHub idle variants pass in 15.14 seconds on this
runtime. All six cases in the complete cleanup-removal suite pass in 8.31 seconds.
Two separate fresh PostgreSQL 17 fixtures migrate through 0410. These suites
use supported external URLs with no source adaptation. The other 1779 cases
in the large chat file are outside the focused selection and are not claimed.
This does not claim the parent's full 274-case workflow was rerun on this slice.
Publication remains held for the actual prerequisite merge and fresh CI/reviews.


## Actual automatic-review squash ancestry

Parent #17680 landed as `73d24aa5acfcf17b3f676b4da7cd05eb70b60b99`. Its whole tree
equals reviewed parent `181bf800a79449961e09c995f2785dd7f8060bb3`, already present
in this child history. Normal merge `6eb13207800b85d00e74a9803278d52e7a9fd890`
resolves inspected duplicate squash-ancestry conflicts and preserves the entire
accepted child tree. Complete server, package, UI and test trees remain equal
to the accepted context source, including the entire 0410 database source.
All original upgrade and suite evidence retains its stated scope. Fresh
published-head CI and reviews remain required before merge.
