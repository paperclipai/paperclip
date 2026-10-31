# Aggregate maintenance interval integration

## Delivery boundary

Remove the catch-all heartbeat maintenance interval only after its domain duties
have replacement owners. Keep existing routine, agent-timer and issue-monitor
scheduling, feature toggles, plugin readiness, environment cleanup, idle tracking,
hot-restart shutdown, and conservative sleep-safety checks. This work does not
qualify actual database or host suspension, Cloud alarms, or cost savings.

The dependency base currently retains the interval while residual run recovery
is being completed. The assembled acceptance harness is implemented first so
that its observation boundary has a positive control before interval removal.

## Duty ownership

| Former interval duty | Owning replacement |
| --- | --- |
| Attention retention | Attention eligibility, committed source notifications and actual archive deadlines |
| Run/task recovery | Run dispatch, issue recovery, watchdogs, locks, residual live/orphan obligations |
| Routine execution projection | Routine execution-status notifications and projection debt |
| GitHub discovery/credentials | Durable supported event ingress, enrollment and credential continuity |
| Merged PR confirmations | Actual unresolved cards, provider ingress and scoped fallback |
| External objects | Supported source/configuration producers, exact refresh and retry deadlines |
| Status cards | Feature-owned scheduled/reactive evaluation, claims and assignment sequencing |
| Native backup expiration | Existing backup/session/file records and source-owned retention deadlines |
| Ephemeral runtime status | Expiry on read, explicit terminal clear and time-gated cleanup on output writes |

The in-memory runtime-status store performs at most one expired-entry scan per
strictly more than 90 seconds of continuing writes. It has no maintenance timer.
An otherwise inactive process can retain its last unread abandoned cohort until
its next read/write or process exit; those entries are never returned after TTL.

## Assembled acceptance boundary

`server/src/__tests__/maintenance-server-routes.test.ts` starts the real exported
`startServer` in a child with its real app, services, coordinator and PostgreSQL.
The suite prepares shared/SDK/Runner TypeScript artifacts, uses the existing
owned embedded PostgreSQL helper by default, and accepts validated disposable
external database overrides for constrained hosts. The file name places this
expensive suite in the existing serialized route lane. It does not skip merely
because an external database environment variable is absent.

The test-only PostgreSQL proxy observes all frontend simple Query messages and
extended Parse/Bind/Execute messages. It counts prepared executions that reuse
an earlier parse, raw tagged SQL, transaction commands and rollback. SQL
parameters and result values are not written to measurement receipts. Receipts
contain fingerprints, static table names and separate protocol frame counts.
The observer issues no database queries and has a real-socket calibration test.
Setup and independent result inspection use another bounded client outside the
application's measured connection boundary.

Child-local diagnostics observe outbound HTTP requests and non-database TCP
connections/bytes. A controlled GitHub HTTP endpoint is explicitly simulated;
its request log independently records provider activity. The Cloud standby case
uses actual managed bootstrap validation, an S3 HTTP guard and generated
Ed25519 signing keys, without a deployed Cloud service or real bucket.

The absent-feature fixture disables telemetry, announcements, scheduled database
backups and UI serving. It supplies no provider secrets or configured external
channels. Other maintenance registrations remain on their production paths.
Those exclusions are fixture conditions, not a claim that configured periodic
backups, live operation keepalives or authorized external reconciliation disappear.

## Clock and settlement

One positive control uses a real 31-second observation after actual startup
settlement. Longer windows use only child-local Date/setTimeout/setInterval
control. Boot and ordinary HTTP producer phases advance at real speed. The
clock freezes after readiness and real socket settlement, then advances at most
30 seconds per step, settling real I/O between steps. Parent deadlines,
setImmediate and database sockets remain usable. Receipts distinguish real
elapsed time from simulated elapsed time. PostgreSQL's server clock is not
advanced; this window does not replace owner-specific durable deadline tests.

The final enabled-mode claim still requires a separate real 90-second quiet
window after interval removal. A fake clock alone is insufficient.

## Evidence and remaining gates

Before removal, empty enabled boot issued 325 startup SQL statements and another
26 executions in the next real 31-second window: 24 extended executions and two
simple queries, covering residual heartbeat/native/resource/wake recovery.
This establishes that the observer sees the legacy interval's actual effect.
The obsolete-positive assertion will be replaced when the interval is removed;
the raw/prepared real-PostgreSQL calibration remains.

Current assembled cases cover:

- Disabled-heartbeat empty boot across two simulated hourly windows.
- Ordinary HTTP company/settings/completed-task creation, independent durable
  inspection, drain/resume and two additional hourly windows without owner work.
- An ordinary HTTP issue insertion held by an isolated PostgreSQL lock while
  idle drain starts, followed by its actual commit and external-object source
  ingestion. Provider work waits during drain, then resume fetches the simulated
  merged PR, persists terminal state and settles for two hourly windows.
- A real HTTP 503 from the controlled provider, durable retry deadline, no
  SQL/provider retry during drain, successful resume and quiet after settlement.
- Actual Cloud warm standby, signed identity claim and durable canonical identity.

Warm standby retains exactly one identified startup intent: the committed
`companyTransferRunService.recoverStrandedApplyingRuns` notification to import
spool cleanup. The Cloud coordinator deliberately disables both dispatch and
reconciliation before claim, so the hold remains even with zero transfer rows.
The test qualifies SQL/network quiet with that explicit deferred intent, then
requires the ordinary signed claim to release it to zero active work at the
existing bounded 30-second retry deadline. It does not call standby sleep-eligible
while this hold exists. Temporary diagnostic begin/end tracing used to identify
this owner is not part of the production change.

Remaining acceptance before a removal PR: final recovery integration, all owner
first-producer paths through assembled wiring, enabled empty/configured/history
quiet including the real 90-second window, scheduling suppression, startup and
shutdown races, relevant contracts across the combined tree, current-head
Greptile 5/5 and required CI. No aggregate-removal acceptance or deployment claim
is made by the preliminary harness checkpoint.
