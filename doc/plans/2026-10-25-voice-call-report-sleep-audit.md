# Voice call-report scheduling sleep audit

Original baseline: voice history retention PR #17583 at
9c38ddfe5349ef1872306a91c7e4c5c1bc083259.
Current integrated parent: 68b62b6d13f28ac5f17f35b98adf5488752f9b97.
Branch: codex/sleep-25-voice-call-reports.
Status: implementation and local acceptance complete; publication and remote gates pending.

## The obligation

`voiceSessionService.reconcileReports` is the final voice duty called from the
chat maintenance cadence. It scans terminal sessions with a provider call ID and
endedAt within the last 24 hours. A missing report is immediately due; an existing
report uses nextCheckAt. The existing exponential retry is 30 * 2^attempts seconds,
capped at one hour. Its first post-fetch retry is 60 seconds.

The current policy deliberately revisits even available reports during that
24-hour window. Do not assume available means no future obligation: later provider
reports can update transcript and billing, and delivery diagnostics may still
need their final snapshot. The provider parser's complete flag only means the
response has a report object. It is not an explicit final-and-immutable promise.
Preserve this finite refresh window while replacing the repeated global scan.
No recording URL or provider metadata is stored; the provider parser allowlists
spoken turns and safe billing/duration values.

## Ownership and implementation direction

Existing chat_voice_sessions and chat_voice_reports remain durable truth. Keep
selection, refresh policy, fetch, result ordering and projection within the voice
owner. Use the scoped deadline helper for coalescing, fair batches, backoff, drain
and shutdown. Register a report topic on the existing voice-change composition;
do not add caller recovery wrappers or a queue table.

- Startup loads paged terminal-session candidates and actual nextCheckAt values.
- Missing reports are due at terminal transition. Future nextCheckAt remains
  unchanged across inspection/restart.
- A report entry also has a finite window end. Expire its cached obligation when
  the 24-hour window ends, even if its next attempt would be later. Define SQL
  timestamp precision and inclusive boundary consistently; do not spin at cutoff.
- Lock/recheck current session eligibility and report deadline before reserving
  an attempt. Save retry intent before network I/O. Provider GET remains outside
  database transactions. Inspect whether a concurrent manual reconciliation or
  callback can invalidate a result; use existing persisted fields for ownership
  where sufficient. Do not add speculative leases or schema without evidence.
- Preserve providerUpdatedAt ordering. An incomplete or older response must not
  replace a newer available report. Stale responses must still back off.
- Preserve the guest-task transcript projection, its advisory lock, low-trust
  quarantine check, owner access, and activity log. A saved report is not proof
  that projection completed. Preserve retry after a projection failure.
- Preserve bounded diagnostic attempts and never replay speech. Diagnostic
  failure must not prevent transcript/history reconciliation.
- Keep explicit one-shot diagnostic reconciliation compatible. Remove the
  recurring voice lane only after all report producers are covered.

## Producer audit

- `voice-inbound-service.ts` signed terminal and report callbacks call
  notifyVoiceChange before the session update and report upsert. Existing reports
  get nextCheckAt = now, which may advance a scheduled refresh.
- `voice-session-service.ts` close and inspect paths use withVoiceSessionChange.
- `voice-session-recovery.ts` uses full voice-change notification for terminal
  inspection results. Healthy inspection and error-only updates intentionally
  notify only recovery; do not make those trigger empty report scans.
- `voice-reply-push.ts` handles HTTP 409 by writing state=ended and endedAt. It
  currently notifies reply, recovery and inbound explicitly; report notification
  must be included before this terminal write.
- Configuration/authority/company changes use notifyVoiceChange composition.
- The existing report loop inserts and updates report rows without transaction
  notifications. Move that ownership into the new report service. Account for
  callbacks during an in-flight provider response and for any remaining direct
  writes discovered in the full source audit.

## Verification required

- Configured idle, live calls, old terminal history and calls without provider IDs
  are SQL/network quiet after startup.
- Real session end, signed callbacks, and reply call-ended results wake reports.
- Saved refresh deadlines survive restart; no early reads, bounded failures, and
  final window expiry disarm. Available reports retain the existing window.
- Nested commit/rollback, moved-earlier callback deadlines, concurrent writes,
  first work during drain, failed work entering drain, and shutdown keep work.
- Multi-page backlog and per-company fairness do not starve later calls.
- Provider failure, incomplete responses, older provider timestamps, guest
  transcript projection failures and diagnostic behavior retain correct data.
- Existing full voice integration/history/access tests pass on a fresh database.

No Cloud alarm coverage or sleep-eligibility expansion is authorized by this
migration. A future in-process refresh cannot wake stopped compute. Preserve
current external-wake limitations explicitly.

## Parent state

#17583 is published and attached. Its 218 selected tests, workspace types/build,
and final server typecheck pass locally; fresh CI/reviews are running.
#17580 migration-runner repair 4f0364d269 has fresh Greptile 5/5. At the last
inspection it had no failing checks and three pending checks. Its prior database
setup failure and regression/repair evidence remain in its audit.

The complete original recurring-server ledger, older #17490 E2E failure,
remaining PR reviews and final master/stack reconciliation remain required.

## Implementation and acceptance, 2026-10-25

The parent retention repair at `360e1253a0` is incorporated. The report owner now
loads scoped, paged obligations, claims each due attempt before network I/O, and
uses attempt/deadline ownership for settlement. Report writes notify the same
shared coordinator. Existing voice-change producers and the explicit reply
`call_ended` path activate it. App startup registers it once and the final voice
lane is removed from the chat interval. No schema or Cloud eligibility change.

The saved report worker suite passed 13 tests. Initial full integration acceptance
had 136 passes and one failure: an unlocked existing transcript still could not
update because the copied projection omitted the document's base revision ID.
The repair supplies the observed `latestRevisionId`, preserving document locks
and conflict checks. A focused rerun against the already-used full-suite database
verified the document update but failed its global provider-call count because
133 retained fixture calls were eligible; this is not accepted as a clean run.
Final full acceptance uses a new database migrated through the application
migrator. Results are recorded below when terminal.

Earlier worker fixture failures (assignedAgentId vs agentId) and the production
missing `or` import were repaired before the 13-case worker pass. Source wiring
assertions still expecting reconcileMaintenance were updated to require its
removal. Full-suite tests remain Vitest coverage; server tsconfig excludes tests,
so production typecheck is not described as test typechecking.

Parent #17583 at `360e1253a0` has a failed server shard: the Discord rollback/drain
quiet test observes one scoped select after its nextWakeAt becomes null. The job
log is retained at `/tmp/sleep24-review-ci-failure.log`. This needs investigation
at its owning earlier slice and propagation; it is not silently retried or
claimed green. Parent #17580 also has two review findings about cleanup latency
and deletion with unconfirmed provider cleanup. These remain open. The older
#17490 E2E failure and final master reconciliation remain part of completion.

Final local acceptance after the revision fix: 137 full voice/app wiring cases
passed on `paperclip_sleep25_projection_fixed_20261025_test`; 37 report/cleanup/
retention worker cases passed serially on the isolated worker database. Workspace
`pnpm -r typecheck` and `pnpm build` passed. Logs: `/tmp/sleep25-voice-fixed-acceptance.log`,
`/tmp/sleep25-voice-workers-acceptance.log`, `/tmp/sleep25-workspace-types.log`,
and `/tmp/sleep25-workspace-build.log`. These 174 selected cases do not claim the
entire `pnpm test:run` suite passed locally. This host's embedded PostgreSQL test
initialization limitation remains; CI must run the complete relevant gates.

## Publication and parent repairs

Published as #17586. The Discord quiet-test settlement repair is propagated from
#17557 and passes all 41 command ownership tests at the report branch. The inbound
denial latency fix is also propagated; its held-provider regression is included.
After both merges, all 138 full voice/app cases pass on a fresh migrated database
(`/tmp/sleep25-denial-acceptance.log`). The earlier 37 worker cases remain valid;
those worker implementations are unchanged by the parent repairs. Remote checks
and reviews are required for the final pushed head. Parent #17580's company
deletion finding remains unresolved; denial latency finding is resolved.


## Paperclip review: report window index and writer scope

Review findings 4370594150 and 4370594357 identified deployment-contract clarity
and expensive report reconstruction. The supported writer model is now explicit:
one active server process owns voice writes through its DB client. Active-active
servers and independent SQL mutation are unsupported without a separate durable
wake contract. This is a documented scope restriction, not enforcement added by
this PR, and not a claim that startup recovers concurrent foreign writers.

The query finding reproduces on fresh PostgreSQL with 20,001 old sessions and
205 eligible sessions: an actual reconstruction query filters 20,001 historical
rows. The repair adds partial `(ended_at, id)` index 0389 and uses that order and
keyset cursor. The cursor retains PostgreSQL text timestamp precision, so sessions
100 microseconds apart do not repeat or disappear across a page. All 14 report
lifecycle cases pass after the migration; the query-plan regression checks all
three pages and each stays below 1,000 rows removed by filtering. Report scope,
24-hour policy, and provider behavior are unchanged.

The generated migration is concurrent and idempotent and registered with the
application's top-level migration runner. It applies and a second application is
a no-op. Migration numbering/safety checks pass. The generator retained exactly
five snapshots, 0385 through 0389, pruning 0384 per repository policy.

Retained failures: the first probe reused a database with two unrelated eligible
fixture sessions and failed its exact fixture count. It is not performance proof.
A fresh database reproduced the 20,001-row filtering problem. The first migration
invocation used unsupported top-level await in tsx eval and did not apply; its
subsequent test still failed without the index. The corrected chained invocation
applied/replayed successfully and all 14 cases passed. No assertion was relaxed.
Logs: /tmp/sleep25-report-index-before.log (fixture contamination),
/tmp/sleep25-report-index-clean-before.log (cost reproduction),
/tmp/sleep25-report-index-apply.log (invalid invocation),
/tmp/sleep25-report-index-after.log (unapplied index),
/tmp/sleep25-report-index-apply-fixed.log (application/replay),
/tmp/sleep25-report-index-fixed-tests.log (14 pass).
Workspace typecheck and build pass. Fresh full voice integration and app wiring
pass all 138 cases after the index repair. Logs:
/tmp/sleep25-report-review-{types,build,acceptance}.log.
Publish and propagate through Teams #17590/#17592 after acceptance. Fresh remote
review/checks and all prior full-stack requirements remain open.


## Current-parent reconstruction and migration acceptance, October 28

The report branch normally integrates retention `68b62b6d13` and its cleanup,
recovery and reply foundations. The retention repair prevents configuration saves
from rescanning history. Its real 205-admission, five-save regression is retained
and passes in the complete voice suite here. Both report and retention tests were
preserved when their additions conflicted at the same point in that suite.
The original 20 owned paths remain the complete report slice. Shared scheduler,
workflow and lockfile changes are inherited context, not additions by reports.

### Bounded discovery, restart and fair dispatch

The old report `load` executed every page before yielding. A new 105-session
fixture with saved future report deadlines selected 105 rows in its first pass,
failing the 100-row startup budget. The registered worker now returns one page
per scope refresh through the existing shared `{ rows, complete }` contract.
The domain owner retains full explicit `load` and one-shot reconciliation APIs.
The keyset cursor still stores PostgreSQL timestamp text, not a truncated Date.
Only successful, non-aborted reads advance a cursor, and registration resets it.

The real same-owner restart case stops after 100 of 105 saved deadlines,
re-registers the service, reconstructs the original deadline, and refreshes each
of the 105 reports once at that time. It observes no SQL/provider activity before
the deadline or between saved retries afterward. Removing the cursor reset fails
at five rows instead of 100 on restart. This measures selected rows, not physical
tuple visits or instance cost.

Fairness applies to discovered work. The prior test demanded that a company
beyond the first page run in the initial batch; that assumes an eager inventory.
The revised test puts that company deterministically on page two and requires
it in the next 25-work batch as soon as it is discovered. It also verifies all
105 calls run and the failing provider retains one saved attempt without
starving the backlog. Bypassing company rotation makes the next-batch assertion
fail. Both guarded mutations restore the exact original source afterward.

Preserved test failures distinguish this contract change from production defects.
The first bounded full run failed the old first-batch assertion. The first
controlled-clock revision allowed random UUID order to put the other company
on page one; a fixed final key now makes page placement deterministic. An
intermediate revision expected zero active intent holds before all dirty scopes
settled. The test now uses 20 controlled one-second scheduler turns, retaining
those holds until reconciliation completes, and finishes before the provider's
60-second retry. It still checks fair dispatch, all 105 calls, one failed attempt,
and quiet after settlement. It does not advance time in every assertion retry.

The external fixture first failed on missing tables. It now applies the actual
application migrations with the standard setup timeout before creating data.
The failed setup and 105-versus-100 budget remain recorded. No test is skipped
and no eligibility or provider assertion was removed to repair setup.

### Generated migration lineage

The old unmerged report migration 0393 conflicts with the landed checkpoint and
cleanup lineage. The complete retention parent migration tree and client were
restored, then the unchanged report-index schema edit was regenerated with
`pnpm db:generate`. The result is `0396_careful_blindfold.sql`. It creates the
existing proposed partial `(ended_at, id)` index concurrently and replayably,
through the application's top-level migration runner. No table or field is added.

All 394 parent SQL files and the journal prefix are preserved byte-for-byte.
Snapshots 0392 through 0396 are the five retained snapshots. The generator's
required deletion of 0391 is included; no retained snapshot or ID was hand-edited.
Generation used parent `ffe9d47b`; retention review head `68b62b6d13` has the exact
same database tree. The snapshot/schema drift regression passes. The report
fixture boots through the application migrator, and two later complete migration
invocations succeed with the report index valid. The existing query-plan case
still tests 20,001 old sessions, 205 eligible sessions and all three precision-safe
pages; each query removes fewer than 1,000 rows by filtering.

### Final local evidence

302 distinct cases pass on this combined source:

- 131 complete voice integration cases, including real hangup, callback and reply
  terminal producers, transcript projection after a document lock, and the parent
  retention amplification regression. This suite uses an initially empty DB.
- 170 cases across 11 complete report, retention, cleanup, recovery, company
  removal, shared deadline/coordinator/batching, startup and hostname suites.
  This includes 15 report, 13 retention and 14 cleanup lifecycle cases. Recovery,
  company removal, retention and cleanup use separate initially empty DBs and
  migrate themselves. Reports use their dedicated DB after the setup repair.
- One complete snapshot/schema drift case. The schema and migration tree are
  identical to the checked generation after the final retention merge.

Database and server typechecks/builds, migration numbering/safety and the module
boundary check pass. Earlier 174/138-case and workspace-wide claims apply only to
their stated heads. No new full local repository suite, live provider, Cloud wake,
physical suspension or savings claim is made. The 24-hour mutable-report window,
retry, confirmation, callback ownership and quarantined transcript policy remain.

Evidence logs are `/tmp/sleep25-final-voice-consumers.log`,
`/tmp/sleep25-final-lifecycle-consumers.log`,
`/tmp/sleep25-final-snapshot-drift.log`,
`/tmp/sleep25-final-integrated-{types,build}.log`,
`/tmp/sleep25-current-migration-{check,replay}.log`, and
`/tmp/sleep25-current-migration-lineage-proof.json`. Failed setup, eager paging,
and the three fairness-clock attempts are in `/tmp/sleep25-empty-fixture-red.log`,
`/tmp/sleep25-page-budget-red.log`, `/tmp/sleep25-bounded-report-first-full.log`,
`/tmp/sleep25-bounded-report-green.log` and
`/tmp/sleep25-bounded-report-fairness-green.log`. The passing initial full report
run is `/tmp/sleep25-bounded-report-final-green.log`; its 15 cases are included
in the final 170 and not counted twice. Negative probes are
`/tmp/sleep25-{cursor-reset,company-fairness}-mutant-red.log`.

Fresh exact-head review, CI and earlier stack landing remain required. Cleanup
parent `b8b12199b9` completed green CI after its single recorded E2E retry, but
lacks current Ponytail acceptance. Retention's earlier 4/5 review was repaired
in `68b62b6d13`; that new parent still requires its own fresh reviews and CI.
Neither parent state is a waiver for reports or for remaining stack duties.


## Configuration scope review repair, October 28

The earlier security thread correctly identified another source of repeated
report inventory. A voice connection save reached `notifyVoiceChange`, which
notified reports for connection, endpoint, company or global scopes. Bounded
paging controlled each burst but still reloaded the whole eligible set after
separate saves. A real producer regression seeds 205 terminal sessions with saved
future report deadlines, then performs five separate connection saves. It selects
1,025 session rows before repair and zero afterward. The original next deadline
is unchanged, and no provider GET occurs during the saves.

The composed notification now signals reports only for actual session changes.
The report-specific helper accepts only an exact session scope, preventing a
future configuration caller from reintroducing broad hints through that boundary.
Startup still uses the shared worker's initial paged reconstruction. Report claims,
receipts and signed callbacks keep exact session notifications. Existing terminal
hangup and reply-ended paths remain covered through their real producer APIs.
Live recovery, replies and inbound cleanup retain their own broader authority
and configuration signals; their eligibility can depend on those changes.

The report predicate depends on session terminal state, provider identity and
endedAt, plus saved report state. A configuration save changes none of them.
Previously such a save only reloaded nextCheckAt and did not advance a future
provider attempt; the repair retains that same saved retry. There is no new
credential policy, refresh cadence, schema or scheduler contract. Manual inventory
APIs remain complete. Unsupported external SQL still needs its own wake contract.

303 distinct cases pass after the repair: 132 complete voice integration cases,
170 complete lifecycle/shared/startup cases, and the unchanged schema/snapshot
case. The voice suite uses a fresh separate DB; the lifecycle suites use their
existing dedicated isolated DBs. Server typecheck/build and module boundaries
pass. The earlier 302 count applies to `80207ba6bb` and is not added to this count.
The current Ponytail 5/5 on that earlier head cannot be reused after this edit;
fresh exact-head review and all CI remain required.

Logs: `/tmp/sleep25-config-amplification-red.log`,
`/tmp/sleep25-scope-final-voice-consumers.log`,
`/tmp/sleep25-scope-final-lifecycle-consumers.log`,
`/tmp/sleep25-scope-final-types.log`, `/tmp/sleep25-scope-final-build.log`, and
`/tmp/sleep25-scope-final-module-boundaries.log`. No full local repository suite,
live provider, Cloud wake or physical suspension claim is added. The original
20-path report scope and the existing finite 24-hour obligation remain intact.

## Landed-master migration and acceptance — October 28

The normal merge uses actual master `980775e0e956eecdc28c73c9b4aca0407ad45e1a`
after cleanup and retention landed. The reviewed report head was
`9bf20467dfd50b81848e1c8dd7ddc905d206418f`, based on retention `68b62b6d13`.
An explicit-base composition preserved the complete non-database report patch
before the acceptance-test repair below. Only the shared client, journal, and
396 snapshot conflicted. Those metadata files were restored from actual master
before invoking the official `pnpm db:generate` workflow.

The generated report migration is now `0397_known_madrox.sql`. It retains the
reviewed partial `(ended_at, id)` concurrent, idempotent index SQL byte-for-byte.
The existing top-level migration registry adds only the new filename and keeps
landed cleanup migration 396 registered. All 395 existing SQL files and the
complete journal prefix match actual master byte-for-byte. Snapshots 393 through
397 remain, with the generated 397 snapshot pointing to actual parent 396.
No landed migration, snapshot contents, or journal entry was renumbered.

A new empty PostgreSQL database boots through the application migrator with a
valid report index. A deliberately failed unique concurrent index build under
the report index name leaves an invalid index; two concurrent invocations of
the application migrator repair it, restore the intended report index, and
record one migration history row. Another replay succeeds. This exercises the
new 397 registration and invalid-index recovery rather than assuming that a
successful Drizzle generation proves executable migration acceptance.

The first complete four-suite run failed: 183 passed and one report integration
case failed, 184 total. `retains one safe report per call and rejects history
after access revocation` expected cost 240000 but retained 120000. The test used
a global one-shot transport response while reconciliation correctly visits
other due calls. An unrelated call could consume the target's newer response.
Adding an explicit earlier-ended competing call reproduced the same assertion
in isolation on unchanged production. The test now selects responses by the
target provider session ID, asserts the target accepts 240000, asserts the
other call independently keeps 120000, and then proves stale cost 1 cannot
overwrite the target. Existing access-revocation and one-report-per-call
assertions remain. No production report or provider behavior changed.

The isolated repaired case passes, followed by the complete 132-case voice
integration suite on a new empty database. The unchanged complete report (15),
cleanup (24), and retention (13) suites passed in the first combined run, each
on its separate empty database. These 184 distinct consumer cases plus one
complete schema/snapshot drift case yield 185 distinct passing cases for this
integration. The isolated case is not added again. Database build, server
build, final server typecheck, migration safety/numbering and module-boundary
checks pass. The earlier 303-case evidence belongs to the stated previous head;
it is not added to this acceptance count or claimed rerun here.

Logs: `/tmp/sleep25-landed-parent-db-generate.log`,
`/tmp/sleep25-landed-parent-db-build.log`,
`/tmp/sleep25-landed-parent-real-migration.log`,
`/tmp/sleep25-landed-parent-real-consumers.log` (the retained 183-pass/one-fail run),
`/tmp/sleep25-report-mock-isolation-red.log`,
`/tmp/sleep25-report-mock-isolation-green.log`,
`/tmp/sleep25-landed-parent-final-voice.log`,
`/tmp/sleep25-landed-parent-snapshot.log`,
`/tmp/sleep25-landed-parent-final-types.log`,
`/tmp/sleep25-landed-parent-server-build.log`, and
`/tmp/sleep25-landed-parent-module-boundaries.log`.

Fresh current-head CI and Greptile 5/5 remain required. Prior-head review scores
are stale after this normal merge. A stopped or paused Ponytail turn without a
verdict does not block under the user's authorization; an actual failing
verdict must be fixed. No new full local repository suite, live-provider test,
Cloud wake, host/database suspension, or cost-saving result is claimed.


## Review documentation and preserved remote timeout — October 28

Ponytail reviewed `c28de398` at 4/5 advisory, found no must-fix production defect,
and said to ship after correcting the design document's stale migration
reference. The design document now links the current 185-case acceptance and
migration `0397_known_madrox.sql`; the older 302/303-case paragraphs are marked
historical. Its two remaining suggestions are explicitly optional: one-shot
diagnostic `reconcile(limit)` still inventories the whole eligible window before
slicing, and some existing test helpers advance fake time during assertion
retries. They are not silently claimed fixed or treated as current idle polling.

CI run `40703490340`, server shard 8/12 job `122869422044`, failed one unchanged
approval-queue test: `resets consecutive failure backoff after a successful batch
with remaining debt` exceeded its existing 15-second timeout. Teardown then
reported a company foreign-key violation from activity-log work. The shard had
2,097 passed tests, one failed and one skipped. No report assertion failed in
that job, and the exact CI timing cause is not proven. The complete unchanged
28-case approval-queue suite passes on a new isolated PostgreSQL database. Its
test, worker, coordinator and transaction-signals source were checked byte-for-
byte against `c28de398` before that probe, which ran from the local child checkout.
No timeout, workflow, approval logic or production source was changed. The old
CI failure remains recorded and the new documentation head requires fresh CI;
no blind rerun of the failed old job or waiver is claimed.

Evidence: `/tmp/sleep25-c28-server8-job.log`,
`/tmp/sleep25-approval-timeout-local-probe.log` and its exit status 0. The 28 cases
are a separate investigation result, not added to the 185-case report acceptance.
Prior-head review scores are stale after this documentation commit.
