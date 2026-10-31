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
control. Boot, ordinary HTTP/service producer phases and graceful shutdown advance at real speed. The
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

- A fixture-only goal-control INSERT error that previously aborted actual boot.
  With owner isolation, the goal row stays pending, a new real residual lease
  obligation is discovered within one second of child time and is cleaned by its
  separate owner, and ordinary attention ingestion still archives its source.
  Native classification remains fail-closed.
- Actual readiness while a fixture-owned PostgreSQL lock holds the real startup
  retention INSERT. Health becomes ready with active work and pending SQL;
  releasing the lock produces the archive and zero active work. Readiness alone
  therefore does not stand in for idle eligibility.
- Disabled-heartbeat empty boot across two simulated hourly windows.
- Actual worktree suppression with a committed residual obligation and no
  recurring SQL over two minutes of child time. A normal operator settings
  activation reconstructs that obligation and produces a durable cleanup result.
  Activation uses the stored instance identity and timestamp; no direct worker
  wake or safety-gate bypass is used.
- Ordinary HTTP company/settings/completed-task creation, independent durable
  inspection, drain/resume and two additional hourly windows without owner work.
- An ordinary HTTP issue insertion held by an isolated PostgreSQL lock while
  idle drain starts, followed by its actual commit and external-object source
  ingestion. Provider work waits during drain, then resume fetches the simulated
  merged PR, persists terminal state and settles for two hourly windows.
- Actual shutdown during an in-flight provider HTTP read, cancellation and
  durable claim release without a false terminal result, followed by a fresh
  server reconstructing and completing the retained object.
- A real HTTP 503 from the controlled provider, durable retry deadline, no
  SQL/provider retry during drain, successful resume and quiet after settlement.
- Actual Cloud warm standby, signed identity claim and durable canonical identity.
- Ordinary interaction creation with a disclosed fixture-only activity timestamp
  older than 90 days, followed by actual retention archive and system audit.
- Cloud routine creation/run through HTTP, actual issue-service completion held
  across drain, and registered projection after resume. Service ingress avoids
  counting the HTTP route's existing redundant direct projection hook as worker
  proof. Production worktree suppression prevents agent execution.
- Ordinary connection activation followed by a simulated Cloud broker's actual
  Ed25519-verified request and X25519/AES-GCM sealed event. The real runtime
  decrypts it, persists a processed receipt, acknowledges it and stays quiet
  across two minutes of child clock before the real credential deadline.
- Ordinary merge-confirmation creation, actual provider HTTP observation,
  persisted acceptance and system actor audit.
- Status-card creation and authorized query/summary writes through real HTTP
  authentication, then an ordinary blocked-task source write, debounce,
  generation and persisted result. Agent key, responsible user, membership and
  execution rows form an explicitly controlled summarizer boundary; no model
  provider runs and no card result is seeded.
- Actual native backup publication with the runtime-owned database, ordinary
  task closure, physical backup deletion and resume-pointer cleanup while run
  history remains. File modification time and closure timestamp are fixture-aged
  ten days; cleanup results are created only by the production owner.

Warm standby retains exactly one identified startup intent: the committed
`companyTransferRunService.recoverStrandedApplyingRuns` notification to import
spool cleanup. The Cloud coordinator deliberately disables both dispatch and
reconciliation before claim, so the hold remains even with zero transfer rows.
The test qualifies SQL/network quiet with that explicit deferred intent, then
requires the ordinary signed claim to release it to zero active work at the
existing bounded 30-second retry deadline. It does not call standby sleep-eligible
while this hold exists. Temporary diagnostic begin/end tracing used to identify
this owner is not part of the production change.

An assembled admitted completion exposed a separate decision-target idle hold:
its owner retained a reconciled write hold while drain prevented its sweep.
The owner now reports pending dispatch only when admitted, retains service
scopes and parks a 30-second deadline only for those scopes. The generic
coordinator still holds unresolved transactions. PostgreSQL regressions cover
committed and uncommitted changes, failed expiry, zero SQL/active work during
drain, exactly-once resume and existing shutdown/restart behavior.

Remaining acceptance before a removal PR: final recovery integration, final recovery
first-producer paths through assembled wiring, enabled empty/configured/history
quiet including the real 90-second window, startup failure isolation and
remaining final-recovery lifecycle races, relevant contracts across the combined tree, current-head
Greptile 5/5 and required CI. No aggregate-removal acceptance or deployment claim
is made by the preliminary harness checkpoint.

The assembled routine proof also uses ordinary subtree cancel and restore APIs.
It requires the same persisted routine run to return to `issue_created`, clears
its terminal projection, and retains zero agent executions while suppression
remains active. The passive PostgreSQL observer records connection opens, closes
and byte counts separately from SQL frames so final quiet receipts can expose
connection housekeeping without hiding it in a zero-query total.
