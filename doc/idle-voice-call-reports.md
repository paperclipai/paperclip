# Voice call reports and idle work

Voice report reconciliation uses the shared delivery coordinator and scheduler.
It no longer runs from the chat maintenance interval. Existing
`chat_voice_sessions` and `chat_voice_reports` rows own its durable state; this
change adds no queue table, provider endpoint, or independent timer. A concurrent
partial index supports bounded reconstruction of the existing report window.

## Trigger and deadline

A terminal session with a provider call ID remains eligible for report refresh
for 24 hours after `ended_at`, inclusive. A missing report is due immediately.
An existing report uses its saved `next_check_at`. The retry starts at 60 seconds
and doubles to one hour, as before. Available reports remain refreshable during
this finite window: provider availability is not a promise that transcript or
billing data can no longer change.

Session transitions and signed callbacks notify the report worker before their
writes, inside the owning database transaction. The reply sender's `call_ended`
result does the same. Healthy active-session observations do not activate report
work. Nested transactions wait for the outer commit; rollback does not publish
new work. The existing work-signals protocol owns uncertain outcomes.

Startup reconstructs eligible sessions in pages ordered by `(ended_at, id)`,
yielding after at most 100 rows per scope refresh. Re-registering the same owner
resets partial scan cursors. The explicit one-shot inventory still loads every
page when requested.
A partial index selects terminal sessions with provider IDs. The query uses
its ended-at range to restrict reads to the current 24-hour window. The cursor retains PostgreSQL timestamp precision. Committed report hints reload the exact changed session. Configuration,
authority and connection metadata changes do not alter report eligibility or
saved retries, so they do not wake report reconstruction. Each cached entry carries the
saved report deadline or the first millisecond after the refresh window ends,
whichever comes first. Submillisecond PostgreSQL timestamps round in the safe
direction. Expiring the window removes the cached obligation without a provider
request. Configured idle endpoints, active calls, old terminal history, and
sessions without provider IDs do not cause recurring report SQL or requests.

## Claims, responses, and projection

The worker locks and rechecks the session and report, then saves its attempt and
next retry before contacting the provider. Network I/O happens outside that
transaction. Settlement compares the saved attempt and retry deadline. A newer
claim or callback that moves the deadline invalidates the older response.
Incomplete or older responses cannot overwrite a retained available report.
Eight failures can mark a pending report unavailable; failure cannot downgrade
an already available report.

Guest transcripts remain confined to the call's quarantined intake task. The
worker reads the retained report, keeps the task's source-trust metadata, and
uses the existing document revision contract. A document lock or conflicting
edit leaves the saved report and retry intact. After the lock clears, the next
successful refresh retries projection. The existing 24-hour eligibility policy
still applies; this PR does not add indefinite transcript repair or extend it.

Provider credentials, call-report parsing, and delivery diagnostics remain in
the voice integration. The shared scheduler receives only normalized work and
deadlines. No provider-specific policy is added to app startup.

## Lifecycle and limitations

The shared scoped worker coalesces notifications, processes fair company batches,
and retains dirty scopes across drain or failed reads. Shutdown joins in-flight
work. Restart reconstructs the persisted retry instead of immediately repeating
the provider GET. The explicit one-shot voice reconciliation method remains for
diagnostics; production maintenance does not call it periodically.

The supported deployment has one active server process writing voice session
and report state through its owning database client. Active-active servers and
out-of-band SQL writers are not supported by this worker. Process-local signals
do not reach another process; such a deployment needs a durable cross-process
wake contract before removing its reconciliation backstop. This PR neither adds
that transport nor asserts that startup reconstruction covers concurrent writers. This is worker quiet, not a claim of physical host sleep. Cloud alarm
coverage and conservative sleep eligibility are unchanged; a local deadline
cannot wake stopped compute.

## Verification

`voice-call-reports.test.ts` exercises real PostgreSQL claims, configured-idle
quiet, finite expiry, timestamp precision, retries and restart, committed writes,
rollback and nesting, drain/resume, callback races, concurrent claims, backlog
fairness, result ordering, and shutdown. The full voice integration suite checks
real hangup/callback/reply-error producers and transcript projection after a lock.
The app wiring suite protects removal of the voice maintenance lane.

The audit and evidence ledger is
[voice call-report scheduling](plans/2026-10-25-voice-call-report-sleep-audit.md).


The [historical parent acceptance](plans/2026-10-25-voice-call-report-sleep-audit.md#current-parent-reconstruction-and-migration-acceptance-october-28)
records the earlier 302 distinct passing cases, the bounded startup and same-owner restart
regressions, deterministic company fairness, generated migration 0396 and the
preserved failures. The report owner keeps its finite provider refresh obligation;
this is not an unconditional idle scan or proof of deployed suspension.


The subsequent [configuration-scope repair](plans/2026-10-25-voice-call-report-sleep-audit.md#configuration-scope-review-repair-october-28)
records the earlier 303-case acceptance at `9bf20467df`. Five real connection saves over 205 saved
reports select zero session rows, after reproducing 1,025 selected rows before
the repair. The notification helper accepts only an exact session scope.


The [landed-master acceptance](plans/2026-10-25-voice-call-report-sleep-audit.md#landed-master-migration-and-acceptance-october-28)
records the current 185-case acceptance and generated migration
`0397_known_madrox.sql`, after landed cleanup migration 0396. It preserves all
existing SQL and journal entries, retains snapshots 0393 through 0397, and checks
fresh application migration plus concurrent replay and invalid-index recovery.
The older 302/303-case sections above are historical evidence, not the current
migration filename or a claim that those full groups were rerun on this head.
