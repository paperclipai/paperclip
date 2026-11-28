# Chat receiver discovery sleep migration audit

Parent: Discord command registration #17557, head d3187f76a4.
Master refreshed during this continuation: e6ec781a1a.
Branch: codex/sleep-20-chat-runtime-discovery.
Status: implementation and focused lifecycle verification; publication and final acceptance pending.

## One reason for this PR

Remove recurring inventory discovery for leased chat receivers from the aggregate
chat maintenance timer. Preserve receipt projection, credential fencing, runtime
initialization, takeover, and stop semantics. Discord command registration belongs
to the parent; voice reconciliation, publication maintenance, milestones, Teams,
and GitHub recovery remain separate migration reasons.

`server/src/app.ts` currently invokes `chatChannels.reconcileProviderRuntimes()`
and `chatChannels.voice.reconcile()` in the same recurring maintenance lane.
The receiver method in `services/chat-channels.ts` queries every eligible Discord
or iMessage Photon endpoint, stops local ownership missing from that inventory,
then calls `runtimeFor` and `reconcileDiscordRuntime` for each eligible endpoint.
This query runs even when there are no receivers. Separating voice is necessary
before removing this callback from the maintenance lane; removing both would lose
an unmigrated obligation.

## Durable truth and owner boundaries

Existing `chat_endpoints`, `tool_connections`, and `chat_endpoint_leases` contain
the necessary configuration and ownership. No additional durable queue table is
needed. The receiver owner must retain the current eligibility policy: supported
leased provider; verifying/active/attention endpoint; active, enabled connection;
and exclusion of attention plus failed connection health.

The receiver provider policy currently lives in `leasedChatProvider` in
`chat-channels.ts` and the lease-key selection inside `runtime/ownership.ts`.
Centralize that existing policy with the chat provider/receiver owner before
adding another independent Discord/Photon switch in scheduling. Shared delivery
coordination should consume normalized receiver identities and deadlines, not
provider protocols, credentials, or command-registration rules.

`runtime/ownership.ts` owns acquisition, renewal, token fencing, and stop order.
Acquisition uses insert or expired-token CAS; background acquisition attempts once.
Foreground configuration can wait up to twenty seconds, checking every 100 ms.
That bounded active-operation wait is separate from idle inventory polling.
The current default live lease lasts fifteen seconds and renews every five
seconds while owned. These renewals are required active transport work and are
not removed in this slice. Existing inbound admission reclaims the exact token
after expiry before accepting buffered callbacks; preserve that safety boundary.

## Proposed wake contract to verify in code

- Reconstruct eligible receiver obligations at startup with bounded UUID pages.
- Notify before supported endpoint/connection eligibility or credential changes
  in their existing transactions. Decode scoped hints only at the notification
  boundary; narrow normal refreshes to an endpoint or connection.
- Keep locally owned healthy receivers in the inventory cache even when they have
  no discovery deadline. Otherwise later removal cannot identify the runtime that
  must stop. A cache of only future deadlines is insufficient for this duty.
- A locally healthy unchanged receiver needs no periodic rediscovery query. Its
  active lease renewal and socket lifecycle remain owned by the receiver runtime.
- On a concrete foreign lease, schedule the saved expiry as the next takeover
  attempt. Reload current authority at that time; a renewed foreign lease yields
  its new expiry. This is a configured receiver's takeover obligation, not proof
  that a standby with such an obligation can sleep indefinitely.
- Initialization/credential/database failures retain scoped retry/backoff. One
  failed receiver must not starve independent companies or a healthy due backlog.
- After ownership loss, finish listener fencing/stop and lease release, then wake
  discovery for that endpoint. Do not reinitialize before the old listener stops.
  Avoid a callback cycle on shutdown or a permanent retry after disable/removal.
- Preserve a change arriving during refresh, drain, or stop. Use the existing
  coordinator's settled hints and memory-only pending predicate; no passive SQL
  during drain. Join admitted work before returning from shutdown.
- Retain the explicit/manual reconciliation entry point used by current callers,
  or update those callers and their assertions deliberately. Do not leave a
  second automatic periodic entry point invoking the old full inventory query.

## Producer audit still required before implementation is accepted

Existing helpers are starting points, not proof of complete coverage:

1. `chat-work-notifications.ts:notifyChatEndpointWork` already covers shared
   connection-origin delivery/command wakes. Inspect its callers individually.
2. `chat-channels/configuration.ts`: configure, reconnect, resume, pause, remove,
   activation and rollback, including foreground acquisition and ownership waits.
3. `chat-channels/setup-probes.ts`, `provider-effects.ts`, resource reconciliation,
   publication failures, and inbound activation: eligibility/health transitions.
4. Generic tool access, removal, health observations, credential/binding changes,
   membership removal, and company deletion: these can change a receiver without
   calling the endpoint configuration service.
5. `runtime/ownership.ts`: renewal failure, token loss, failed initialization,
   runtime invalidation, lease release, and shutdown. A direct callback is suitable
   for process-local completion; do not invent a SQL row for that callback.
6. Photon runtime callbacks and configuration: independently verify these paths;
   the Discord parent producer audit is not evidence of Photon coverage.
7. Existing live replica/independent-writer assumptions: process-local transaction
   hints cannot discover another process's arbitrary configuration writes. Retain
   or explicitly integrate the supported cross-process wake contract rather than
   silently removing its only recovery path.

## Required evidence

Start with a failing empty-instance regression proving that the aggregate chat
cadence repeatedly queries receiver inventory. Then verify:

- empty, disabled, and retained-history states have no discovery SQL after startup;
- actual first configure/reconnect/disable/remove producers wake or cancel work;
- healthy local ownership adds no inventory scan beyond explicit mutations;
- foreign lease expiry, extension, and takeover preserve single ownership;
- renewal failure triggers bounded recovery only after fencing the old runtime;
- old buffered messages remain fenced after token or credential generation change;
- Photon and Discord preserve their existing distinct transport behavior;
- scoped changes, company deletion, nested transaction commit/rollback, uncertain
  commit, page boundaries, failure isolation, concurrent changes, restart,
  drain/resume, and shutdown retain obligations;
- shared coordinator behavior without this worker remains unchanged;
- the existing command-registration cases retain saved verification deadlines.

Use real PostgreSQL for lease CAS and transaction ownership, and controlled local
runtime/provider fixtures for lifecycle effects. Existing chat integration tests
exercise manual reconciliation, foreign ownership, credential rotations, and
Photon restart. Inspect those cases before designing fixtures. SQL silence must
be measured after both tracked work and scheduler settlement; a null next-wake
value alone can occur during an admitted reload.

## Sleep limits and remaining stack gates

Active receiver sockets and lease renewals remain physical sleep blockers. Cloud
alarm coverage and admission/sleep-safety proof do not change. This migration
removes idle discovery activity, not the receiver's live transport obligation.
The full original recurring-server inventory remains in scope in the stack ledger.

At audit creation, health #17554 has a passing security scan on 9ef6e4f4c8 but
other current-head checks remain running. Company cleanup #17561 is e8febb30eb.
Discord #17557 is d3187f76a4 with fresh checks required after its failure-path and
CI fixture repairs. The older #17490 E2E cancellation failure, final reconciliation
with master, and all fresh review/check gates remain outstanding. No stack PR was
merged and no new merge authority is implied.


Follow-up acceptance snapshot: health #17554 at 9ef6e4f4c8 now has no pending or
failed checks, passing security, and fresh Greptile 5/5. Its three reviewed findings
(fair batching, real producer coverage, inventory amplification) are implemented,
verified, and their threads resolved. This is acceptance of that current head,
not a claim that the full stack is complete or reconciled with moving master.
Company cleanup and Discord still have live current-head checks.


## Implementation and verification update

The aggregate chat lane now calls voice reconciliation only. Receiver discovery
registers with the existing delivery coordinator. The receiver owner loads UUID
pages of 100, keeps owned identities with no discovery deadline, and processes
25 due receivers per fair company batch. Configuration hints refresh only their
endpoint, connection, or company. A foreign owner schedules its saved lease
expiry; a changed lease is reread before another attempt. Failures retain scoped
30-second exponential backoff capped at five minutes. Dirty scopes suppress their
cached deadlines until refresh succeeds; otherwise an old takeover deadline could
cause repeated useless dispatch while the required refresh is in backoff.

The generic configuration notifier replaces the misleading command-only helper
name. Existing producers now notify both relevant owners. Shared delivery code
still receives only a queue topic and scope hint. Provider selection and lease
keys remain in the chat receiver owner. No schema or new per-worker table exists.

Audited producer groups:

| Owner | Receiver-relevant changes and integration |
| --- | --- |
| Configuration and setup probes | Existing connection helper covers configure, rotation, resume, pause, removal and completed setup before transaction writes |
| Credential persistence and removal | Configuration notifier before reference changes, including Photon |
| Inbound activation and resource reconciliation | Endpoint/connection notifier before status and health transitions |
| Publication, interaction and provider-effect failures | Endpoint configuration notifier before attention/failed-health writes |
| Discord Gateway lifecycle | Receiver hints before recovery/failure transitions; metadata-only writes do not create discovery work |
| Photon transport failure and runtime recovery | Failure callback now signals before attention/disable; existing assert-owned recovery uses the shared endpoint helper |
| Generic tool update/removal, manual health and access revocation | Existing chat connection helper, broadened configuration dispatch, and SDK transport filter |
| Company deletion | Company hint precedes endpoint removal in the owning deletion transaction |
| Ownership loss / invalidation | Local completion callback after listener stop and lease release; suppressed during shutdown |

The additional direct-writer audit found publication-resolution, publication
success, provider-effect success, inbound filtering, and Discord root-thread
writes that only update timestamps. Endpoint display/reach preferences do not
change receiver eligibility or the runtime generation. Photon configuration
invalidates the runtime, writes allocation metadata, and proceeds through the
credential/configuration owner; its allocation metadata is not an independent
receiver identity. Slack/GitHub-only setup writers do not create leased receiver
work. Capability projection in Discord reconciliation retains its existing owner.

A real token-loss regression found a concurrent configuration wake could acquire
another lease while the old listener was still stopping. The ownership map now
retains the stopping owner until listener shutdown and lease release complete.
Acquisition joins that owner's existing stop promise. Current-authority checks
still reject stopping owners. The test uses real timing and holds listener stop;
an earlier fake-clock observation returned before async SQL completed and did not
prove absence of overlap. The strengthened test failed before the ownership fix.

Current passing evidence: 32 receiver/startup cases, 90 selected Discord
integration cases, all 20 Photon channel cases, and server typechecking. The
Discord selection includes configuration, credential rotation, pause/resume,
company deletion, token-loss stop ordering, and existing takeover/admission fences.
The dedicated real-DB worker takeover test also passes, as do 75 command/delivery/
standby consumer cases and full workspace typechecking. This is 218 unique selected
passing cases. Workspace build passes. Remote review/check gates remain pending.
The full local test matrix is not claimed: embedded PostgreSQL is unavailable
on this host, so these database suites use validated disposable external URLs.
Remote CI must run the full matrix before acceptance.

Recorded failures remain part of acceptance: initial receiver teardown omitted
agent deletion; initial Discord pause used incomplete onboarding; failed-scope
backoff initially selected the blocked cached takeover deadline; the real-timing
stop race reproduced overlapping listeners. The first two were fixture defects;
the latter two required implementation repairs. An initial backoff test expected
zero idle holds during failed intent recovery; the correct contract retains the
intent hold until reconciliation succeeds, so the test now checks the retry
deadline and SQL silence rather than weakening that hold.

## Writer and sleep boundaries

Notifications cover the active database owner and its transaction-sharing clients.
Warm standby does not run discovery; activation reconstructs its pending startup
inventory. An already known foreign receiver remains recoverable from lease expiry,
with real token CAS and callback fences. Arbitrary new configuration written by
an independent process or direct SQL is not discovered by process-local hints;
that deployment needs an explicit wake integration. This follows the existing
single active writer contract and must not be described as multi-writer support.
The manual reconciliation method remains available for explicit callers.

Active sockets and lease renewals remain required work, and no Cloud admission
exemption is added. Voice, Teams, publication maintenance, milestones and other
inventory reasons remain separate PRs. The full stack is not complete.

Master was fetched again at 0d73505098. Company prerequisite #17561 at e8febb30eb
and Discord parent #17557 at d3187f76a4 now have no failed or pending checks;
Paperclip Review is skipped. Fresh review-content reconciliation and final stack
rebasing/verification remain distinct from these check results.


## Receiver review repair

The real company-removal producer regression reproduced two inventory reads for
one observed removal. Discovery-initiated stops now suppress their own completion
wake; independent token loss still wakes discovery after listener retirement.
A full reconstruction also covers its already-pending scoped hints. Hints that
arrive during the load remain dirty, and narrower writes cannot bypass a failed
full reconstruction's retry deadline.

Both redundant-load regressions failed before repair. All 45 selected receiver,
startup and real Discord producer tests pass after repair, including the added
full-refresh failure/backoff case. Server typecheck and build pass. Prior broad
consumer/workspace verification remains recorded above; these 45 overlap that
coverage and are not an additional unique total. Publication requires fresh
remote CI and review. The full migration inventory remains outstanding.

## Healthy receiver progress after a slow failed batch

The receiver worker already stores a retry deadline for each failed receiver and
scope. It now supplies that deadline calculation through the coordinator's
`nextRunAtOnError` contract as well. A completed batch can take longer than the
one-second batching interval. When that batch contained an error, the coordinator
previously ignored an already-due healthy backlog and waited for its generic
30-second retry. The changed registration lets healthy due entries proceed while
the failed receiver retains its own exponential backoff.

The existing 105-receiver PostgreSQL regression now runs with both an immediate
failure and a controlled 1,100 ms elapsed interval in the failed provider call.
The latter failed before the repair: its next wake was 30 seconds away although
healthy receivers were due. Afterward, all 105 are attempted before retrying the
failed receiver, which is attempted once during the healthy drain. Recovery then
settles and two former poll periods add no SQL. The assertion helper advances its
own fake clock; the test no longer adds an extra second on every assertion retry.

All 20 receiver lifecycle cases and the server production typecheck pass on the
owning branch. This changes one coordinator registration and adds no provider
branch, queue, table, or independent timer. Current-head CI and combined-stack
verification remain separate gates.

## Current-parent and review acceptance, October 27

The branch normally integrates Discord parent #17557 at
`cedf2030c49c3650a41b76a4767176fd78170819` through `3e957d1204`. Only the
original 27 receiver-owned paths differ from that parent. Health #17554 is now
merged; company cleanup #17561 and Discord #17557 still precede this slice.
Older stack status above describes its recorded source revision.

The latest old review summaries still mention the delay and redundant-stop
findings, but the actual source already contains their repairs: stop-wake
suppression at `1604a9fcba` and the error-deadline registration at `ab56393acc`.
Both were revalidated on the integrated parent rather than duplicated. A guarded
mutation removing `nextRunAtOnError` fails the 1,100 ms slow-provider next-deadline
assertion. The expected error also remains visible in teardown after that early
assertion. A separate mutation reenabling discovery-initiated stop notification
fails the real company-removal producer assertion with two inventory reads
instead of one. Both source files are restored byte for byte after the checks.
Normal worker and real producer suites pass with the original fixes.

The two newly supported external-database fixtures initially skipped migrations.
Actual worker reconstruction and Photon transport-loss cases failed on separate
empty PostgreSQL 17 databases with missing-table errors. Both fixtures now apply
pending migrations before client use. On those same initially empty databases,
the complete receiver file passes all 20 cases and the complete Photon channel
file passes all 20 cases. Existing embedded setup and safety validation remain.

Current acceptance: five complete receiver/coordinator/batching/startup/GitHub
error-projection suites pass 99 cases. Twelve actual Discord automatic-command,
receiver configure/rotation/pause/resume/removal, ownership-loss/takeover, and Slack
held-transaction cases pass separately; 1,581 other chat integration cases are
not counted as run. With the 20 Photon cases this is 131 distinct targeted cases.
The large chat producer suite uses a separate migrated clone. Server production
typecheck and build pass on the integrated source; the later fixture-only changes
add migration setup and do not change production code. Startup listener-count
warnings and expected controlled provider failures remain in the logs.

Required CI at the older `ab56393acc` head failed server shard 12. GitHub's
check-run annotation says the self-hosted runner lost communication with the
server; its grouped-test step is marked cancelled. The retained log ends without
a failed assertion or final test summary. That annotation does not establish the
underlying host, resource, or network cause, and the interrupted job is not a
passing result. The new parent integration and fixture repairs require a fresh
full CI run; local passes do not replace it. Fresh exact-head Greptile and
Ponytail reviews remain mandatory. No deployed sleep or full local suite is claimed.


## Landed-foundation integration acceptance, October 27

This slice normally integrates Discord parent `547fdf2139`, which contains
master `f8563d2507` and landed company-deletion fixes. The original 27-file
scope is unchanged. All owned source matches its precise original patch applied
to that parent. The shared queue catalog also preserves master's task-drain and
native-checkpoint declarations. An initial whole-file identity assertion rejected
those expected parent additions; the corrected proof checks the actual owned
patch against the integrated parent. No failed verification is counted as a pass.

The complete five worker/shared-consumer suites pass 99 cases. Real Discord and
Slack producers pass 12 cases; the complete Photon suite passes 20. This is 131
distinct targeted cases, with 1,581 chat cases deselected. Receiver and Photon
self-migrate separate initially empty databases. The large chat fixture uses a
separate migrated clone. Server typecheck and build pass. Only documentation
changes follow the passing source. Expected controlled provider failures and
startup signal-listener warnings remain recorded. Fresh exact-head review and
all CI must pass before this child lands after Discord. No deployed sleep or
full local suite result is inferred from these checks.


## Compatibility after Discord squash merge, October 27

Discord #17557 landed at `5bf0142d45`. The normal merge of that master caused
ancestry conflicts in overlapping producer paths. Resolution applies only the
recorded 27-file receiver patch from Discord parent `547fdf2139` to actual landed
master. Every server and package production/test file is byte-identical to the
published `6e88ca0201` source that passes 131 cases, typecheck and build. No source
verification is rerun merely for unrelated upstream UI/eval/documentation changes.
The PR-owned delta passes its whitespace check. This integration records that
proof and requires fresh exact-head review and CI before merging into master.
