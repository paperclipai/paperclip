# Discord command registration while idle

Command registration uses the shared delivery coordinator and existing saved
registration deadlines. It no longer runs as a side effect of the recurring
Gateway runtime reconciliation. Foreground configure and resume still attempt
registration immediately under their existing credential lease.

## Existing obligations and authority

The registration store owns `chat_actions` records of kind
`discord_command_registration`. The existing `chat_discord_command_owners` table
retains the application namespace owner even after endpoint or company deletion.
No table, trigger, listener connection, or private timer is added.

A valid successful receipt has a five-minute remote verification deadline. Other
saved outcomes retain their existing retryAt, including Retry-After. An indefinite
retry remains parked. A genuinely unowned namespace is immediately due. Invalid
receipts, foreign owners, and orphaned ownership tombstones do not become new
registration work. The deadline reader is only a hint; the existing protocol still
checks authority, generation, credentials, identity, and receipt state before
provider operations and commits. An uncertain create is recovered by reading
remote state, never by blindly repeating a create.

Eligible endpoints are Discord, verifying/active/attention, with an active enabled
connection and a known bot/application ID and guild ID. Attention plus failed
connection health remains excluded. These are the old runtime discovery filters;
company status and unrelated endpoint metadata do not add new policy.

## Scheduling and lifecycle

Startup reconstructs eligible state in UUID keyset pages of 100. Committed hints
refresh only the affected endpoint, connection, or deleted company. Refresh and
retry passes have a 30-second minimum spacing when no already-due backlog
remains. A bounded batch with more due rows continues after one second. There is no periodic inventory
scan after all hints settle. Due dispatch rechecks persisted eligibility and the
saved deadline, invokes the command owner, and reloads its durable result.

Each pass admits at most 25 commands, taking turns across companies and preserving
oldest-first order within each company. A company cursor rotates between passes,
including when more companies are due than fit in one pass. A failed or no-progress
attempt backs off from 30 seconds to five minutes; a future stored deadline wins.
A returned promise alone does not prove registration settled.

Dirty scopes received during work remain pending. Drain and warm standby retain
requests without passive SQL. Discovery checks cancellation between rows/pages.
Shutdown stops the coordinator before the chat service and joins an already
admitted provider operation through settlement. A local Gateway is refreshed
through its existing owner after command work; command failure does not replace
or tear down a healthy listener.

## Producer coverage

| Producer | Wake contract |
| --- | --- |
| Registration store | Register intent before initial owner/action insert, state/receipt transitions, and retry-result updates in their existing transaction |
| Configure, reconnect, resume, pause, remove | Existing endpoint-work helper now also signals command scheduling by connection ID |
| Setup test completion | The same endpoint-work helper covers activation |
| Credential reference publication/removal | Signal before binding and reference writes, while retaining the credential lease |
| Gateway connecting, ready, availability and failure callbacks | Scoped endpoint signal when health/status can change eligibility; existing runtime generation fences remain |
| Provider availability reconciliation | Signal available/restored and disabled/removed endpoints |
| Provider-effect, publication and interaction failures | Signal before endpoint attention and failed-health writes |
| Accepted inbound task mutation | Signal the endpoint before its status/connection activation writes; message metadata-only writers stay exempt |
| Generic tool connection API | Existing chat connection transaction helper covers enable/disable and credential/configuration changes |
| Generic connection removal | Signal the SDK connection before archival |
| Generic manual health observation | Chat-owned dispatcher signals SDK connections; other transports do not wake this worker |
| Membership/credential revocation | SDK connections signal before reference removal or disablement |
| Company deletion | Signal the company before the company cascade; namespace tombstones survive |

Draft endpoint creation has no eligible identity and waits for configuration.
Endpoint display names, reach preferences, resource metadata, publication/event
timestamps, and capability-only runtime projection do not create a registration
obligation. Other providers' setup, OAuth, and registration protocols do not
become Discord work. Direct SQL and independent writers still require explicit
wake integration; process-local hints are not cross-replica notification delivery.

## Verification and limits

Selected local verification covers 40 real-PostgreSQL protocol/lifecycle cases,
three fair-batch cases, 93 Discord integration cases, 487 tool-access/access
consumers, and 20 chat-worker/startup consumers: 643 unique tests. Workspace
typechecking and build pass; the final small fairness addition also receives
server type/build verification before publication. The full local `pnpm test:run`
is not claimed: embedded PostgreSQL is unavailable on this host. Remote CI must
complete the full matrix before acceptance.

The large-backlog fairness regression failed before selection was repaired.
Other observed failures were fixture issues: duplicate live-bot IDs, uncertain
transactions retained by prior fault tests, installing a fake clock after creating
a real timer, pausing a connection still in setup, and removing a fixture twice.
Repeated broad runs on a reused database also found an unchanged hard-coded bot
ID and a global comment-body assertion reading earlier fixtures. The final broad
Discord run uses a fresh schema-only disposable database and passes all 91 cases;
production constraints and the unrelated assertions were not relaxed. See the
[dated audit](plans/2026-10-25-discord-command-registration-sleep-audit.md).

This migration proves the command worker's quiet periods. Runtime inventory,
receipt-to-runtime projection, active Gateway lease renewal, persistent sockets,
voice, Teams, and other chat maintenance remain separate obligations. The remaining
runtime poll can still read command receipts; it no longer initiates command
registration or remote verification. Cloud sleep eligibility and durable alarm
coverage are unchanged. A timer in this process cannot wake a stopped host.


Review follow-up: a 300-command regression failed under the old 25-per-30-second
limit. Bounded one-second continuations now drain the controlled due backlog
within 15 seconds, then remain quiet until real verification deadlines. An unknown
scope hint also reproduced loss of a later valid wake. Parsing now occurs inside
the recovery boundary; an invalid scope requests full reconstruction rather than
dropping queued scopes or retrying a poison hint forever. Both regressions and
all 62 combined command/health/batching cases pass.

The real producer integration covers credential rotation and company deletion in
addition to configure/removal. The deletion test first lacked a configured agent
lifecycle worker; after adding the controlled host driver it exposed an existing
restrictive endpoint-to-agent foreign key failure. Prerequisite #17561 fixes the
deletion order in its own PR. The command intent is now registered before endpoint
cleanup in the owning transaction. The test verifies deadline cancellation, SQL
silence, and retained ownership tombstones. All seven automatic-registration
integration cases pass; 1,413 deselected cases are not counted as executed.

A test invocation during prerequisite merging failed before execution because an
import conflict was unresolved. The conflict was repaired preserving both imports,
then the test ran successfully. Final server typecheck/build pass. Fresh CI and
reviews are still required after publication; prior-head Greptile 5/5 and Actions
results do not establish acceptance of this head.


The prerequisite's history review moved cleanup ahead of issue deletion as well.
The dependent signal moves with it, before the first endpoint delete. All seven
producer integrations and six expanded deletion cases pass after propagation;
rollback restores conversation/publication history. The finding remains recorded
in the prerequisite document rather than treating the earlier endpoint-only
fixture as sufficient evidence.


## Failure-path capacity and CI isolation repair

Required CI at 58a1ac7595 found one command-inventory select after the removal test
had observed `nextWakeAt() === null`. That scheduler observation can occur during
an admitted reload; it does not prove notification settlement. The assertion then
threw before restoring DB spies and contaminated a later Slack grant-transaction
test with recursive spies. The quiet-window tests now wait for both no tracked
active work and no deadline, and restore spies in `finally`. The downstream Slack
test is included in verification. The CI failure, rather than a local reproducer,
is the evidence for the original race; no timeout or SQL-quiet assertion was relaxed.

Review also identified a genuine failed-item throughput bug: the shared
coordinator ignored `nextRunAt` after a thrown sweep and always waited its fallback
retry. A controlled 300-command regression with one persistent credential failure
reproduced only 25 attempted commands within 15 seconds. The coordinator now keeps
its fallback scheduled, then allows an explicitly future worker deadline to
preempt it while dispatch is admitted. An overdue/null/unreadable deadline cannot
cause a tight error retry loop; drain retains the ordinary fallback. A failed
deadline reader is reported together with the original failure. Workers without
a deadline keep their existing behavior. Domain retry/backoff remains owned by
the worker; no provider policy enters the coordinator.

After repair, all 300 commands are attempted within 15 seconds, the failed entry
is attempted once in that window, and its later retry does not recheck the 299
healthy entries. Five coordinator cases verify future deadlines and fallback
behavior for overdue, later, unreadable, and drain states. All 87 command,
coordinator, and health cases pass; eight real automatic-registration/Slack cases
pass (1,412 other integration cases deselected); 57 delivery/warm-standby/startup
cases pass. Server typecheck/build pass. The health parent is propagated through
company cleanup, retaining both notification paths in the three overlapping
producer sites. The six prerequisite cleanup cases pass. Remote acceptance of
the new Discord head remains required.

## Updated parent acceptance, October 27

A normal merge at `5b50224785252fe49a4501d9695063cf9621e528` includes
company-cleanup parent #17561 at `21be75d2b0` and health #17554 at `8c1d293d1a`.
Only the original 26 Discord-owned paths differ from that parent. The shared
producer sites preserve both health and command notifications; no provider
behavior, schema, or coordinator contract changes in this integration.

The four complete command-store, company-batching, coordinator, and startup
suites pass 119 cases. Eight real Discord automatic-registration and Slack
held-transaction cases pass separately; 1,581 other chat integration cases are
not counted as executed. These 127 distinct targeted cases use separate isolated
PostgreSQL 17 databases cloned from the migrated health test schema, not an
unmigrated-database fixture proof. The first name filter selected only the Slack
case; the corrected verified group selector then executed all eight cases.
Server typecheck and build pass. Startup tests still emit the recorded
SIGINT/SIGTERM listener-count warnings without assertion failures.

The earlier failed baselines and remote CI history above remain evidence for
their stated revisions. Fresh current-head reviews and all CI are required, and
both prerequisites must land before this child can merge into master. This does
not establish host suspension, external Cloud alarms, or provider cost savings.


## Acceptance after the company-deletion parent landed, October 27

The branch integrates master at `f8563d25077b17681ab6ef5949f7b07415a58ede`,
including the landed health and company-deletion repairs. Squash ancestry caused
merge conflicts. Resolution applies only this slice's exact 26-file patch from
its recorded parent `21be75d2b0` to that pinned master. Every other file matches
master. The migration 0394 and current lockfile remain unchanged by this slice.

All 141 distinct targeted cases pass: 78 command-store, batching, coordinator and
startup-timing cases; 8 real automatic Discord and held-transaction Slack cases;
and 55 complete startup/export and company-deletion cases. The company-deletion
fixture starts on an initially empty isolated database and applies migrations.
The two Discord fixtures use separate migrated database clones. The remaining
1,581 chat integration cases were deselected. Server typecheck and build pass.
The startup suite retains the existing signal-listener warnings without an
assertion failure. Source files did not change after these results; subsequent
edits record this acceptance. No full local matrix or deployed sleep is claimed.
Fresh exact-head reviews and CI remain required before merge.
