# Gateway credential expiry and idle behavior

Gateway sessions and named gateway tokens already persist their expiry times.
`cleanupExpiredSessions` remains the owner of physical deletion. Authentication
continues to check expiry, revocation, company scope, run ownership, and active
run state on use. No table, authorization rule, or external alarm is added.

## Producer inventory

- `createSession` registers intent before inserting a run-bound session in a
  transaction. Its existing audit and returned credential remain unchanged.
- `createNamedGatewayToken` registers intent before inserting an expiring token
  in a transaction. A token without an expiry owes no expiry cleanup and does
  not notify this worker.
- Last-use updates do not change expiry. Token/session revocation, including
  heartbeat completion and connection removal, also leaves the saved expiry
  intact. Revoked rows retain the same physical deletion deadline.
- Gateway/company deletion removes dependent rows and can leave one harmless
  stale deadline. It cannot create overdue work. No supported service changes
  a saved credential expiry after creation.

The database signal layer owns outer commit, rollback, savepoints, and uncertain
outcomes. The worker supports producers sharing that signal owner. Independent
SQL writers and another process need a separate live ingress contract. Startup
reconstructs existing rows but does not provide continuous replica discovery.

## Worker contract

`nextCredentialExpiryAt` reads one earliest non-null expiry from each table using
expiry-first indexes, then compares those at most two values. The migration adds
the session expiry index; the token expiry index already exists.
An empty credential store or retained non-expiring tokens returns no deadline.
`registerGatewayCredentialExpiryWork` supplies cleanup and deadline selection to
the shared `registerDeadlineWork` helper. Provider and authentication behavior
stay in the gateway service; startup only registers the worker.

The worker starts where the old startup cleanup ran. With heartbeat scheduling
enabled, committed changes and actual expiry times replace the recurring cleanup
call. With heartbeat scheduling disabled, the existing startup-only cleanup is
preserved. Tool action-review recovery is a separate obligation and is unchanged.

Token and session deletion are each bounded to 500 rows per pass. Session
selection orders by expiry and rechecks expiry when deleting the selected IDs.
A remaining overdue expiry schedules another pass after 30 seconds. Failed reconciliation also
retries at that bound. No unfinished reconciliation or future expiry means no
recurring SQL. A generation retains writes arriving during reconciliation.
Startup restores deadlines; drain retains first writes without passive SQL;
resume completes overdue cleanup. The coordinator owns shutdown and waits for
in-flight work.

Sequential committed writes are coalesced for up to 30 seconds after a
successful cleanup pass, matching the former heartbeat cleanup cadence. A
previously loaded expiry can preempt that window. A newly reported credential
may physically remain until that bounded follow-up; authentication still rejects
it immediately at expiry. A successful pass with no future expiry and no new
notifications creates no timer. This uses the shared optional notification
coalescing capability, promoted from the later plugin/decision recovery slices;
workers that omit it retain their existing behavior.

## Evidence and limits

The concurrent session index runs through the migration executor's existing
per-file top-level path. Initial application and repeat application were tested.
A PostgreSQL plan with 20,000 sessions and 20,000 tokens, including 19,000
non-expiring tokens, used both expiry indexes and read one row from each.
This establishes bounded lookup on that fixture, not production latency.

The new PostgreSQL suite exercises real session/token creation, configured idle
state, non-expiring history, expiry ordering, revoked-token cleanup, outer commit
and rollback, startup reconstruction, a backlog larger than one cleanup batch,
and drain/resume. It tests expired authentication before deferred physical
cleanup, through both session and named-gateway entry points. Existing gateway
acceptance and server-startup tests cover the changed integration boundaries.

Use only disposable migrated databases for the test URL overrides. Their names
must end in `_test`; the suites delete their fixtures. Ordinary CI uses embedded
PostgreSQL. Test credentials are synthetic and no external provider is contacted
by the expiry suite.

The migration proves worker behavior, not host suspension. Existing Cloud idle
proof remains conservative. An in-process deadline cannot wake stopped compute;
external wake coverage must be verified before changing sleep eligibility.

## Related unmerged token-lifetime work

At implementation time, PRs #17221 and #17274 change run-scoped token lifetime
and cleanup eligibility. This slice preserves the current master policy and
changes scheduling only. When combining those changes, the deadline query and
producer signals must use the same token eligibility as cleanup: run-token idle
markers must not schedule the operator-token expiry worker. Keep the run-liveness
reaper with its own owner and retain both regression suites. A conflict-free
text merge alone does not prove this integration.

## Notification amplification review repair (2026-10-27)

Ten sequential real session/token creation transactions reproduced ten extra
instance-wide cleanup passes. With coalescing they cause one follow-up pass.
A separate 501-session fixture reproduced the unbounded delete, then passed
with 500 removed initially and the remaining overdue row removed at the saved
30-second retry. A still-valid session survives both passes. The tests also
preserve an already loaded expiry only 500 milliseconds away and verify that a
new one-second session is rejected while physical cleanup waits for coalescing.

The initial full run exposed four outer-transaction tests whose fake-clock wait
expected the intent hold to release before the new coalescing follow-up. Their
settlement helper now advances the clock through that window while preserving
the original commit/rollback assertions. The complete gateway expiry, gateway
acceptance, custom-image deadline, and startup suites pass: 147 tests in four
files. Server typechecking also passes on the owning branch. This is local
behavioral evidence; combined-stack and fresh remote checks remain required.
The full local test:run remains unverified because of embedded PostgreSQL
startup/capacity limits; the two real gateway suites used separate migrated,
task-owned disposable PostgreSQL databases.

A later combined run exposed a test-clock overshoot: repeated blind 30-second
advances could expire the future session before its intermediate assertion.
The settlement helper now lets real SQL settle and advances only to an actually
armed follow-up within the coalescing window. All 12 credential expiry tests pass
on the owning gateway branch with the existing exact-deadline and transaction
assertions intact. This follow-up changes the test fixture only.


## One-shot cleanup preserves complete backlog removal

Review found that bounding worker passes also truncated startup cleanup when the
heartbeat scheduler was disabled. That path calls cleanup only once, so it could
leave every expired token or session after the first 500 rows indefinitely.

`cleanupExpiredSessions` now drains the existing backlog in 500-row SQL batches
by default, using one fixed expiry cutoff for the invocation. The deadline worker
opts into `singleBatch: true` and retains its existing coalescing and next-page
deadline. Future and nonexpiring credentials survive both paths. The return value
still counts deleted sessions, as before. No periodic fallback was added.

Three real-PostgreSQL regressions reproduced the truncation with 1,001 expired
sessions, tokens, or both, without registering a worker. They pass after the fix.
All 55 expiry/startup cases pass, including the existing worker's 501-row bounded
pass and commit/rollback tests. The original explicit-cleanup compatibility case
and server typecheck also pass. Evidence is in `/tmp/sleep-master-gateway-manual-`
logs: `red`, `green`, `compatibility`, and `types`. This fixes one-shot behavior;
it does not establish provider suspension or complete the stack's CI acceptance.
