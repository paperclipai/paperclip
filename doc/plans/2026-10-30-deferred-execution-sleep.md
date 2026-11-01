# Deferred execution receipt ownership

This slice removes the periodic `resumeQueuedRuns` sweep after queue dispatch migrated separately. It also delegates native status wake intents out of the periodic orphan reaper. Existing queue admission, authorization, task recovery, cancellation, resource and controller checks remain the mutation authority.

| Duty | Durable pending truth | Committing producers | Deadline and exit |
| --- | --- | --- | --- |
| Task Retry | deferred task_retry wake with certified actor/generation | requestTaskRetry through execution control; execution, issue, agent, company and budget eligibility | immediate; current admission links canonical intent to one dispatch/run, supersession or terminal policy retires it; blocked input awaits its actual gate mutation |
| Saved comments and interaction responses | deferred wake carrying saved comment IDs or interaction mutation | wake admission insert; merge only genuinely new comment IDs or interaction identity; issue/lock/assignment/dependency and execution eligibility | immediate after terminal source; original release owner revalidates comment/card authority, process/cleanup evidence and issue claim |
| Execution wait | deferred wake with executionWait | original admission/restored source receipt; actual recovery action, execution and eligibility changes | original updatedAt + 30 seconds, then current owner revalidation; unchanged blocked receipt carries no recurring scan |
| Interrupt retry | deferred wake with queuedCommentInterrupt | authorized route persists interrupt marker; cancellation lifecycle and cleanup/eligibility transitions | original updatedAt + 30 seconds; cancelled legacy run naming exact queue bypasses initial grace as before; owner retains explicit interrupt and stop evidence |
| Cancelled legacy queue | cancelled legacy run result names exact still-deferred queue | run lifecycle terminal/control commits; original interrupt intent | immediate restart reconstruction; original release/admission owner settles or leaves saved input behind its actual blocker |
| Task chat receipt settlement | deferred task_retry with taskRetry.chatActionId | failed chat retry action settlement | immediate settlement-only pass folds linked action result; it cannot restage its own processed-but-deferred chat action. Startup/actual eligibility retains normal re-admission policy |
| Native status wake intent | system/native-status-committer wake queued/claimed without run | status committer transaction; actual execution/issue/agent/company/budget eligibility | immediate queued intent; claimedAt + 60 seconds for crash recovery; error updatedAt + 30 seconds. Existing deterministic dispatcher identity/claims preserve per-intent crash recovery; original intent becomes linked/coalesced/skipped while a separate blocked dispatch receipt owns saved admission |

Three scoped owners reconstruct only their actual durable receipt predicates, with keyset pages of 100. Normal signals contain normalized company/request identity. Instance scheduler settings alone may request instance-wide reconstruction. Repeated source changes coalesce reconstruction for 30 seconds; already-known stored deadlines preempt that cooldown. Pending checks read memory only. Shutdown uses the existing coordinator and physical execution tracking; task drain reconciles producer transactions and releases the settled intent hold while retaining work for resume. Warm standby and disabled registration do not execute domain work.

The generic run-dispatch notifier and broad issue review-state notifier deliberately do not fan out deferred eligibility. Queue bookkeeping may write them while processing its own saved input. Separate eligibility commits and settlement-only chat notifications avoid a self-restaging loop.

C2 remains separate and mandatory: active output silence deadlines, remaining orphan/process/controller/remote authority and resource debts, legacy shutdown settlements, stranded agent status, and final aggregate chain removal. Retained workspace and migrated native finalization workers remain their existing owners.

Review controls cover queue edits that move an already loaded grace deadline. Each due check re-reads current stored grace or claim time before admission. Subtree hold release, subtree restore, and member archival publish eligibility inside their own transactions. Member archival preserves the cancelled Retry tombstone created by an earlier user reassignment.

A resume that first records a new execution-wait reason arms its existing 30-second grace once. Writing the same closed-gate reason again does not publish another hint. A clock obligation, an eligibility change, and an infrastructure failure therefore retain separate exits: stored deadline, owning committed producer, and bounded failure backoff. Refreshing a diagnostic timestamp alone does not create permanent polling behind a deliberate pause.

Persisted budget and agent refusals are normalized by the existing deferred-wait owner. The wait writer reports whether its locked conditional update saved the receipt, and only that successful path can produce the internal `PersistedExecutionWaitRefusal` subtype. It remains an HTTP409 with the original message and details. Receipt recovery parks that outcome instead of creating failure debt; the committed first/changed reason still grants its one stored30-second grace. Unrelated409s, failed writes and unexpected provider/infrastructure errors retain failure backoff. This adds no admission policy and changes no native/task-chat ownership.

Production-path controls use actual task Retry, heartbeat, PostgreSQL budget/lifecycle services and a child process writing saved stdout. The lifecycle host completion boundary is controlled explicitly. One set of real budget/agent refusal fixtures consumes its finite grace and becomes quiet for25 minutes of timer advancement with zero driver SQL and no execution. Independent warm-worker fixtures keep the real PostgreSQL clock throughout admission, actual gate-producer release, controller authority and child-process exit, proving exactly one saved execution. Long-idle and provider-release evidence are separate; no clock reset or restart is used to claim warm recovery. A PostgreSQL trigger fault proves failed wait persistence retains recovery backoff, and an unrelated unbranded409 remains a failure.

Project budget admission locks and re-reads the company-scoped project before publishing pause intent. An already-paused project emits no new eligibility hint and preserves its pause reason and timestamp, including a manual pause. The actual transition still publishes dispatch and deferred eligibility intent before updating the project in the accounting transaction. Concurrent admission checks serialize through that authority. Project-scoped saved Retry controls cover its one grace followed by25 minutes with zero driver SQL, plus a separate real-clock budget increase through one succeeded process with saved stdout.


Native receipt checks share an opaque dispatcher created by the existing queue owner for exactly one bounded worker pass. Its canonical company/agent/issue/review scope map is the same map used by the manual dispatcher; the native worker explicitly admits at most100due entries per pass, matching the existing default batch while retaining company fairness. The next pass creates a fresh map. This restores same-pass grouping without introducing global or cross-invocation deduplication, changing claim authority, or consuming later notices. Each receipt still re-reads its own moved claim/error deadline before dispatch.

Actual PostgreSQL controls reconstruct two saved native intents into one dispatch and shared run with real process stdout, cover the100-intent boundary, and keep another issue and company separate. A real issue-row lock holds the first admission while a separate transaction commits a new notice whose requestedAt is explicitly older than admission. The fixed current batch cannot consume that new identity; a fresh pass creates a distinct run, preserving the late notice even though its ordering metadata is old. Once all executions and stored deadlines settle,25virtual minutes produce zero driver SQL. The canonical dispatch body, including parsing, claims, deterministic receipt recovery and error handling, is unchanged apart from moving its map into the owner-created batch closure.


### Browser fixture producer boundary

The legacy recovery browser fixture used to insert a deferred request through a
separate SQL connection after server startup, then wait for the removed poll.
That is neither saved startup history nor a supported in-process producer. The
automatic browser case now seeds while the company is paused, verifies the saved
request and sole failed source run, and reactivates through the ordinary company
API. No Retry or duplicate message is sent. It requires exactly one new run,
one persisted agent response, the original queued comment in the process prompt,
and the response after page reload. Startup reconstruction remains covered by
the PostgreSQL case that persists history before worker registration.

The corrected automatic path passes three consecutive built-UI/browser runs
(2.1 minutes total). All six legacy continuation browser paths pass together
(1.6 minutes), including task/inbox Retry, Retry after reload, ordinary message,
queued Retry and automatic reactivation. The fixture also reads the configured
external PostgreSQL connection when present, so local proof can reuse a dedicated
test database instead of starting another database process.
