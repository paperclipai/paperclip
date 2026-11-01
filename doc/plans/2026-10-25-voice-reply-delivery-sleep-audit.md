# Voice reply delivery sleep migration audit

Parent: live-session recovery #17576 at 8f5e861dbd6ea5c2b45684dff970ea27723a84cb.
Branch: codex/sleep-22-voice-reply-delivery.
Status: owner audit and implementation in progress; recurring reply scan remains.

## Obligation

`voice-session-service.reconcileMaintenance` invokes `pushReplies` every chat tick.
The reply owner first reads settings, quarantines dispatch intents older than 30
seconds, and scans up to 25 active phone sessions. Each session can dispatch up to
eight chunks. A live phone call with no published reply still repeats this work.
Browser calls retrieve updates through their own request path and do not use push.

Existing `chat_voice_replies`, `chat_publications`, `chat_voice_sessions` and
`chat_actions` are the durable truth. The action kind `speko_voice_reply_push`
records per-chunk dispatch and outcome. No new queue table is needed. Use one
coordinator worker for this delivery obligation, preserving the existing ledger,
provider authority, multipart ordering and uncertainty policy.

## Policy that must not be duplicated or weakened

- Only active, unexpired phone sessions can receive proactive speech.
- The first eligible published undelivered reply controls ordering. An empty text
  or blocked earlier reply must not be silently skipped to speak later answers.
- Synthetic progress is excluded unless it carries an authorized question.
- A question notification is a barrier until authorized get_updates marks the
  reply presented. Accepted notification is not permission to speak later replies.
- Multipart acceptance is recorded per part. A changed publication digest cannot
  append a different suffix to a partly delivered answer.
- A dispatching/unknown outcome is never permission to resend. A dispatch intent
  becomes unknown only at its existing 30-second stale threshold. A known 429
  retries at its saved retryAt. Failed or uncertain historical actions alone must
  not create repeated empty delivery scans.
- Accepted by the provider is not spoken playback. Preserve both distinctions.
- Session authorization remains before claim and immediately before provider I/O.
  Do not move provider calls inside the transaction or invent a second claim owner.

Extract the existing multipart decision into a voice-owned pure policy before
implementing deadline selection. The dispatcher and scheduler must share that
policy rather than reproduce partially overlapping JSON/status predicates.

## Producers and the publication timing gap

The Speko publication transport calls `enqueuePublication` while the publication
can still be streaming. It schedules a direct `pushReplies`, then the publication
worker commits `state = published`. Therefore signaling only the reply insertion
is insufficient: that wake can run before publication settlement and miss the
reply becoming deliverable. Signal the published-state write in its transaction,
with a normalized voice publication scope routed by the owning transport/service
boundary. Audit the resolution/recovery published-state writer as well.

Other producers are live phone-session creation/promotion, missed-reply collection,
reply retrieval/presentation, explicit repeat, session termination, action claim,
retry/unknown/accepted settlement, and feature/configuration changes. Browser
retrieval may unblock the next phone reply and needs a committed hint. Startup
must reconstruct both deliverable replies and abandoned dispatch intents, including
intents for sessions that are already terminal. Prior-call delivery barriers and
missed-publication catch-up must remain with their existing voice-store owner.

## Required lifecycle and acceptance

The worker must become quiet for no sessions, active calls with no replies,
terminal history, accepted speech, unknown/failed outcomes and presented question
barriers. It must wake from each supported producer, retain exact retry/claim
expiry deadlines, and preserve changes during refresh/drain. Verify transaction
rollback/outer commit, restart, unfair backlogs, failures and shutdown joins with
real PostgreSQL and controlled provider operations.

Keep live-session recovery, inbound admission cleanup, inbound history retention
and call reports separate. Do not remove the outer maintenance call until each
remaining reason has migrated. Keep manual push entry points compatible where
needed, but route normal committed work through the coordinator.

## Parent verification record

#17576 is published and attached. Its 837 selected tests, workspace typecheck and
build pass. CI run 40176142139 and review run 40176142016 were live at publication.
The full local test command was deliberately stopped (session 77073, exit 143)
after repeated embedded PostgreSQL initialization failures prevented suites from
executing. It is not a full local pass; the PR description records this. Affected
database suites did execute against separate disposable PostgreSQL databases.
Receiver #17572 has passing latest-head checks and Greptile 5/5 at 1604a9fcba;
its second Paperclip reviewer stopped before completion, so do not invent a fresh
completed review result. No stack PR was merged. The complete original inventory,
older #17490 failure and final master reconciliation remain outstanding.


## Initial implementation checkpoint

The existing multipart selection now lives in voice-reply-policy.ts. The dispatcher
uses that pure policy for chunk identity, digest consistency, question barriers,
retry deadlines and no-resend outcomes. Its claim, authorization and provider I/O
remain in the existing owner. Twelve selected real-database reply integration
cases and server typechecking pass after extraction. This is a foundation only:
no recurring reply scan has been removed, and no reply PR is published yet.

Next implement the shared voice reply-state reader and deadline selection, audit
all session/reply/action and published-state producers, register the worker, and
prove quiet/reactivation before retiring the recurring and direct normal dispatch
paths. Preserve the public/manual push API and all adjacent voice maintenance.

The ordered reply-state reader is now also shared inside the voice owner. It
preserves the caller's session lock, published-only first reply, question barrier,
prior action locks and multipart policy. It exposes a saved dispatch-expiry
boundary without replaying a dispatch. The same 12 delivery cases and server
typechecking pass after this second extraction.

Implementation direction for the next step:

- Scoped reconstruction pages identities of active unexpired phone sessions and
  outstanding dispatching actions. A changed session may receive one immediate
  inspection; this is a startup/committed-write wake, not a recurring deadline.
- Check each session independently: authorize and collect missed replies under
  the existing session transaction, then use readVoiceReplyState. No reply or a
  permanent barrier disarms it. A retry or in-flight intent keeps its real deadline.
  Provider dispatch remains outside the transaction, using the existing claim.
- Keep action-expiry entries independent of session eligibility so terminal calls
  do not strand old dispatch intents. Use the existing strict 30-second threshold
  and atomic dispatching-to-unknown update. Never resend an unknown action.
- A session check that fails must retain its own backoff and not block successful
  checks for other companies. Do not move all authorization/catch-up into one
  full-inventory load that fails as a unit.
- Add a session scope to manual push execution so the worker cannot rediscover all
  calls per selected item. Retain the existing manual API for explicit callers.
- Route published-state notification in both publications/worker.ts and
  publications/resolution.ts through a narrow owner helper. Their endpoint identity
  is already available. Avoid adding voice policy to the shared coordinator.
- Notify before reply creation, presentation and action mutation. Wire session and
  configuration changes without giving reply delivery its own active-call polling
  deadline. Reconstruct on startup/resume; explicit feature changes invalidate it.

## Worker and producer implementation checkpoint

Implemented scoped session/action reconstruction, per-entry reply execution,
commit-aware producer notifications, and coordinator registration. The normal
periodic push and the pre-publication direct push are removed; manual one-shot
entry points remain. Abandoned dispatch recovery pages independently of session
state and atomically quarantines only still-expired dispatching actions. Passive
live-call inspection does not wake healthy empty reply queues. Previously denied
reply checks can reactivate through the already-required successful live-call
authorization boundary; no notification fan-out across every authority table.
See ../idle-voice-reply-delivery.md for the owned contract.

Evidence so far: the first three scheduling integration cases passed. A fixture
name collision (pushFixture exposes publication as a row, not the factory method)
failed one added producer test; corrected to create the publication inside the
actual transaction. All 15 selected producer/delivery cases then passed. A fresh
PostgreSQL full voice run passed 102 tests and parent recovery passed 11. Server
typechecking passed after producer changes and again after final startup wiring.

The first final wiring command accidentally matched the whole suite through its
"voice" describe title while using a retained-fixture database. Eight existing
startup recovery assertions observed unrelated saved deadlines; 98 tests passed.
That is not acceptance evidence. A fresh isolated database full run is now required
and its result must be inspected before a PR-ready claim.

Remaining before publication: final full voice/startup result, direct published-state
producer coverage through the actual shared publication worker/operator resolution,
reply worker scope/backlog/failure lifecycle tests, relevant shared consumers,
workspace verification, PR template/body and latest-head CI/reviews. The entire
remaining stack inventory and older #17490 failure remain outstanding.

The corrected final wiring run passed all 120 tests: 104 full voice integration
cases and 16 startup/hostname wiring cases, against a newly created PostgreSQL
database. It includes seven new reply lifecycle cases: publication gating and
quiet acceptance, saved retry reconstruction across coordinator restart, abandoned
intent after call termination, nested producer rollback/commit, real question
retrieval, authority restoration, and drain/resume without passive SQL. Final
server typechecking also passed. The earlier retained-fixture failures remain
recorded above; shared publication-path and broader acceptance work remains open.

## Publication-path and broader verification

Both real chat-service paths now have a commit-boundary regression: normal
publication and operator mark-delivered. The tests hold the real final transaction
before its voice notification, wait until the early enqueue wake is fully idle,
and then verify one send after publication. Disabling only the final notification
made both tests fail with zero sends; restoring it passed both. A 105-action real
PostgreSQL case also proves startup inventory paging and bounded action recovery.

Workspace typechecking passed. Seven shared access/connection/settings suites
passed all 651 tests. A combined full voice/startup/parent-recovery run used one
external database: voice/startup passed 123 tests, but ten parent recovery tests
observed the voice suite's intentionally retained sessions and failed their global
quiet assertions. This is a test invocation isolation error, not accepted evidence
for parent recovery. The parent suite is being rerun against its separate database.
Do not combine these two suites under one external database URL.

The 107 full voice cases now include real publication and operator producers,
105 abandoned sends, restart, rollback/outer commit, drain, authority restoration,
question barriers and no-resend outcomes. Full workspace build and current-head
PR CI/reviews remain required. The local all-suite command has the previously
recorded embedded-PostgreSQL initialization limitation; targeted database suites
run on real isolated PostgreSQL instead. Do not count skipped or uninitialized
database tests as passes.

The parent recovery suite passed all 11 tests on its isolated database. The new
reply-state read failure case also passed: the worker keeps its retry, performs
no SQL during backoff, and sends once after recovery. Together with the full run,
this verifies 108 voice cases, 16 startup cases, 11 parent recovery cases, and 651
shared-consumer cases (786 selected tests). Workspace typecheck and build passed.
The final added failure case changed tests only after the typecheck; the workspace
build compiled the current tree. No production changes followed the full run.
Remote CI/review remains pending until this branch is published.


## Review follow-up: shared scheduling and real authority restoration

Paperclip review at `439d0a86eb` requested one scheduling implementation and a
production-wiring regression. `scoped-deadline-work.ts` now owns coalescing,
scoped reconstruction, bounded fair batches, per-entry/scope backoff and drain
retention for both voice workers. The adapters retain their own scope matching,
load/check contracts, eligibility and provider operations. The helper has no SQL,
provider knowledge, or feature flags; absent consumers register no work.

The restoration test now registers the real voice service's reply and live-call
recovery workers. It first lets the reply encounter suspended membership, restores
membership before the next live-call authority inspection, and verifies exactly
one send through the production authorization callback. Healthy inspections do
not resend; confirmed hangup leaves both workers SQL-quiet. This deliberately
preserves the documented window: if recovery observes denied authority first,
it closes the call rather than waiting indefinitely for access to return.

A mutation probe removed only the production `authorityAvailable` invocation.
The new test failed with zero sends instead of one. The production line was
restored in a finally block; the unmodified case passes. This replaces the older
test that called the notification directly.

Full voice/startup/coordinator/batching selection passed 180 tests on a fresh
PostgreSQL database. Initial parent recovery verification passed nine and failed
two: the extraction captured load methods at registration, bypassing the tests'
later injected refresh failures and concurrent-write barriers. Adapters now call
the service methods at dispatch time, preserving the original boundary. All 11
parent lifecycle tests pass on their separately isolated database. These failures
are retained here rather than counted as successful initial verification.

The optional review suggestion to cache the feature flag across a batch is not
applied: current checks retain authority/configuration checks at dispatch, including
changes while earlier provider calls are in flight. Any optimization must preserve
that behavior. Workspace checks and fresh remote acceptance are recorded below
when complete; the prior 5/5 Greptile score does not cover this follow-up yet.

Workspace `pnpm -r typecheck` and `pnpm build` pass after the review repairs.
The 191 selected tests above are overlapping consumer verification, not an
additional 191 unique cases on top of the earlier 786. Remote acceptance remains
required on the published follow-up head.


## Current-parent paging contract acceptance, October 27

This slice normally integrates bounded voice recovery #17576 at `712f3862b5`,
including receiver `6e88ca0201` and the landed foundations. The original 30-file
reply scope adds one shared contract path, `scoped-deadline-work.ts`. No database
file changes. The existing helper could represent only a complete inventory;
using that contract for the repaired parent would erase its bounded-pass guarantee.

The real 205-call parent regression fails before the integration repair: startup
executes three inventory queries (100, 100, 5 rows) instead of one 100-row query.
The shared helper now accepts either its existing complete array or a normalized
page result. It retains page generations and seen identities, keeps existing
entries until reconstruction completes, limits dirty scopes per pass, and replays
writes received during reconstruction. It owns no SQL or voice/provider policy.
Recovery delegates to its owner refresh and resets partial owner state on worker
registration. Existing complete-array consumers keep their public calls.
Connection observations retain the parent's separate receiver/command notification
path; actual configuration wakes both voice owners.

All 445 distinct targeted cases pass: 18 complete parent recovery lifecycle
cases, 108 complete voice-store/reply integrations, 224 complete tool-gateway and
secret-proposal cases, and 95 shared dispatcher/coordinator/batching/startup/
hostname cases. The helper's single existing test also ran in the initial
19-case green group; it is counted only in the 95-case group. The 224 cases
exercise the four other production consumers of the shared helper, including
complete-array empty/expiry/recovery/projection, transaction and drain behavior.
Server production typecheck and server build pass. The voice fixtures self-migrate
separate initially empty databases. The two other database suites use separate
migrated clones. Expected injected provider/wakeup failures and listener warnings
remain in logs. Only documentation edits follow these passing production checks.

This acceptance preserves the parent's startup paging, restart, behind-cursor
insert, concurrent feature change, health-only quiet, true disablement, current
authority, failure, drain and shutdown contracts. Existing real publication,
operator resolution, uncertain send, multipart/question ordering, authority
restoration and 105-abandoned-dispatch tests remain in the 108-case suite.
Fresh exact-head reviews and all CI remain required. No full local matrix,
live provider acceptance, Cloud wake, deployed suspension or savings is claimed.

The whole-merge whitespace check flagged literal context whitespace inside an
inherited `tests/runner-e2e/report-lock.patch` fixture. That fixture matches the
parent and is outside this PR delta. The 31-file delta against the pinned parent
passes the whitespace check; the inherited fixture is not edited to hide it.


## Publication inventory and paging acceptance, October 28

The security review correctly found an endpoint-wide read per publication.
Two real publication-path regressions seed 105 unrelated active phone calls and
105 future dispatch intents on the same endpoint. Five normal publications select
1,065 inventory rows; five operator resolutions select 1,060. Both exceed the
125-row total budget. The corrected paths pass that same budget and deliver each
answer once. These measurements count selected row results from executed queries,
not physical PostgreSQL tuple visits or a deployment cost benchmark.

Normal publication completion and operator resolution now notify their actual
conversation inside the existing transaction. The voice owner handles that
normalized conversation scope. Its reader returns at most 100 total session and
action headers per refresh, with a saved phase/cursor for the next pass. Startup,
configuration changes and abandoned actions retain finite reconstruction. The
shared dispatcher retains generations and observed IDs across pages; it also
preserves the parent wildcard-failure isolation. SQL and provider decisions stay
inside the voice owner. No schema, table, provider-specific shared branch or
per-route recovery wrapper is introduced.

The abandoned-dispatch case now proves a 100-row startup cap, restart of the same
owner before its scan completes, restoration of all 105 saved deadlines, no SQL
before the deadline, and quarantine without resending. A separate owner-level
real-database case reproduces a new denied call behind an older scan cursor:
completion of the old scan must not erase the later restoration obligation.
Denial revisions fence that cleanup. The case confirms a real 403, then observes
the committed wake. The existing actual-service authority-restoration case still
verifies the complete production callback path; the new cache test is not a
replacement for that integration coverage.

Guarded mutations broaden publication hints back to endpoints, omit owner reset,
and omit the denial revision fence. All fail the corresponding row-budget,
100-versus-5 restart, or missing committed-wake assertion, with source restored.
An earlier reset probe using already-due actions did not detect the missing reset
because its own action writes rediscovered the backlog. That incomplete probe is
retained as such; future deadlines make the strengthened regression deterministic.
The first amplification fixture also used a shadowed publication function name;
that fixture failure preceded the actual 1,065/1,060-row baseline.

The final branch normally integrates voice parent `ad79c7e805`. Its original
30-file scope plus the existing shared dispatcher remains 31 files, with no DB
changes. All 449 distinct targeted cases pass: 111 complete voice-store/reply,
19 complete parent recovery, and 319 complete shared/legacy-consumer/startup cases.
Both voice fixtures self-migrate separate initially empty databases; the two
legacy DB suites use separate migrated clones. Production server typecheck and
build pass. The current policy checker and its Node tests pass. Only evidence
edits follow these checks. Older 445/786-case totals belong to their stated source
revisions and are not added here. Current exact-head reviews and all CI remain
required. No full local matrix, live provider, external wake, deployed suspension,
physical query-cost or savings result is claimed.
