# Aggregate maintenance interval integration

## Delivery boundary

Remove the catch-all heartbeat maintenance interval only after its domain duties
have replacement owners. Keep existing routine, agent-timer and issue-monitor
scheduling, feature toggles, plugin readiness, environment cleanup, idle tracking,
hot-restart shutdown, and conservative sleep-safety checks. This work does not
qualify actual database or host suspension, Cloud alarms, or cost savings.

The preceding domain migrations retain the aggregate interval. This change
removes its enabled and disabled paths after those owners are assembled. The
acceptance harness first calibrated its observation boundary against the original
recurring SQL, then verified the final source without that interval.

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

The original pre-migration positive control recorded recurring maintenance SQL
during a real 31-second observation after actual startup settlement. Its baseline
receipt is retained; the obsolete recurring-SQL expectation is replaced by the
final enabled cases. The real-socket raw/prepared execution calibration remains
in the suite. The two enabled cases are prepared to observe 90 real seconds each
and two further hours using child-local Date/setTimeout/setInterval control.
Both cases pass on the final cutover tree. They also require every application
database connection to close at the existing default 60-second idle timeout. Boot, ordinary HTTP/service producer phases and graceful shutdown advance at real speed. The
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

The recorded acceptance source is `6ccd1ed3e661e086b793de32b809ff8d3799eb69`,
with C2 predecessor `b29334feafd5bf1740aa74e2ff0649c6b4cefc20`. It passes all
41 cases with no skips: the original 34 (16 actual boot, three passive observer,
seven runtime-status and eight single-flight cases), plus seven focused harness
support and artifact-ownership cases. All 26 PostgreSQL decision-target controls,
121 startup contracts and the scoped test TypeScript graph also pass. These
receipts qualify that recorded executable source; later parent changes need
their affected-source verification.
Startup contracts retain independent registration, failure isolation and shutdown
tracking. Required CI and exact-head review remain PR gates; these measurements
do not qualify deployment or host suspension.

The assembled routine proof also uses ordinary subtree cancel and restore APIs.
It requires the same persisted routine run to return to `issue_created`, clears
its terminal projection, and retains zero agent executions while suppression
remains active. The passive PostgreSQL observer records connection opens, closes
and byte counts separately from SQL frames so final quiet receipts can expose
connection housekeeping without hiding it in a zero-query total.

The saved-execution receipt case uses ordinary task Retry and subtree release
HTTP endpoints. A pause retains the accepted receipt without a run; the saved
wait reason receives its existing one-time 30-second grace, then remains quiet
for 30 real seconds. Releasing the hold with `wakeAgents: false` launches exactly
one actual local process with the expected stdout. This phase uses real elapsed
time through PostgreSQL controller-lease ownership. Clock acceleration begins
only after the process is terminal and its task is closed.

## Final enabled idle measurements

Both fixtures start the actual server and use its default application database
idle timeout. The independent fixture client stays outside the passive proxy.
The real observation follows readiness and complete work settlement.

| Fixture | Real observation | Application SQL | DB connections opened / closed at end | DB bytes during real window | Further qualified clock |
| --- | --- | --- | --- | --- | --- |
| Empty | 90,003 ms | 0 | 7 / 7 | 30 frontend, 0 backend | 7,200,000 ms |
| Configured terminal history | 90,002 ms | 0 | 7 / 7 | 30 frontend, 0 backend | 7,200,000 ms |

Each fixture had already closed one startup connection before observation. The
remaining six connections each sent one five-byte PostgreSQL Terminate frame.
No Query, Parse, Bind, Execute or Sync frame occurred during either real window.
Neither fixture opened another database connection or changed either byte count
across the following two qualified hours. Both windows also retained zero new
outgoing HTTP requests, non-database TCP connections and non-database bytes.
The test requires zero active tracked work throughout the settled boundaries.
These are application-level observations, not a host or Neon suspension test.

## Portable harness and receipt ownership

When no external database is supplied, the PostgreSQL suites use the repository's
embedded support probe and skip only on an unsupported environment. An explicit
acceptance database bypasses that probe and runs every case. The passive protocol
unit cases still run without PostgreSQL. Dedicated acceptance requires all 44
cases to execute with no skips.

The harness owns its temporary directory, proxy, port reservation, log and child
from setup through stop. Stop is idempotent. It finishes child shutdown before
releasing the proxy and files, and it removes owned files on startup failure too.
By default, configuration, logs, session state and measurement receipts are deleted.
Set `PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS=1` for an explicit proof run. Stop then
prints `[maintenance-test] retained artifacts: <directory>` and exposes the same
path as `retainedDirectory` on the harness result. This mode retains receipts on
failure as well. The caller owns removal of explicitly retained proof artifacts.
