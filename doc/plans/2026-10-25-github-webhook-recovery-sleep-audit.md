# Direct GitHub webhook recovery scheduling

Parent: slice 37 at `0a25cae9ef10a8714801d72ac798823de335e050`.
Branch: `codex/sleep-38-github-webhook-recovery`.
Inspected mainline: `5a28f7acf8` (2026-10-25). Final stack reconciliation is
still required; this slice does not incorporate every subsequent master change.

## Obligation and stop condition

A failed GitHub callback can leave no local inbox row. Direct App integrations
therefore require the existing bounded external history reconciliation. This is
an explicit exception to event-only dispatch, not proof that configured direct
GitHub endpoints become network-idle. Cloud relay registrations are excluded:
Cloud owns their transport retry. No eligible direct endpoints, including an
instance with only Cloud registrations or disabled endpoints, means no recurring
SQL or HTTP from this worker after reconstruction and notification settlement.

Previously the app called the due-endpoint selector every second. This slice
reconstructs deadlines at startup, reloads affected scopes on committed changes,
and dispatches only at those deadlines. It removes the final production chat
reconciliation interval and its unused lane coordinator. Other existing chat
workers remain independently registered with the delivery coordinator.

Durability already exists:

- `chat_sdk_state`, key `paperclip:github-webhook-recovery:v1`, stores the
  versioned runtime epoch, App identity, callback URL, floor, and `nextScanAt`.
- `chat_actions` recovery receipts store immutable source fences, attempts,
  cancellation decisions, and unknown transport outcomes.
- The genuine authenticated GitHub callback owns inbox admission. Provider
  history is never admitted directly or transformed into a locally signed event.

No table, migration, Cloud alarm, or host-sleep exemption is added.

## Ownership and policy

State parsing, eligible endpoint selection, credential fingerprint comparison,
recovery execution, and notification scopes stay under `chat-channels/github/`.
The existing recovery owner retains signature, current authority, source-body,
resource, runtime-generation, lease, and claim-version checks. Recovery I/O stays
outside database transactions. A small provider-owned checkpoint transaction
notifies before its existing compare-and-set; generic SDK persistence does not
learn the meaning of GitHub keys.

The per-endpoint recovery core is shared by the explicit/manual bounded API and
the worker. The worker independently reloads current eligibility and epoch before
execution. It does not call the manual selector with cached early deadlines:
that selector's legacy due predicate does not detect credential-only epoch
changes. The worker recognizes those changes immediately, even during a saved
24-hour backoff, and establishes a new floor without adopting historical events.

Preserved policy:

- One-minute normal external reconciliation; five-minute claim and failure
  backoff; bounded provider rate-limit backoff up to one day.
- One-hour lookback, three provider-history pages, five inspected eligible
  envelopes per endpoint, and three maximum redelivery attempts.
- Successful sibling deliveries suppress replay. Ambiguous redelivery outcomes
  remain durable and are not blindly retried without a distinct failed attempt.
- Five endpoints per dispatch batch, fairly rotated between companies.

The shared scoped-deadline helper gains only an optional batch limit. Its default
remains 25 for every existing caller. It still owns no provider SQL or policy.
The new owner loads at most 100 rows per query and retains all pages' deadlines;
it does not silently discard endpoints after the first page.

Every recovery HTTP call checks dispatch admission and the worker abort signal
before starting. A call already in flight keeps the existing bounded provider
request timeout and is joined during shutdown. Its result/uncertainty settlement
may finish; stopping does not erase a committed attempt. Other registered queues
continue while a provider call is held. Drain and standby preserve dirty scopes,
failed reconstruction, and saved deadlines without passive SQL.

## Producer inventory

| Owner | Mutation and notification |
| --- | --- |
| `configuration.ts` | Configure/reconnect, pause, resume, removal and failure paths already call `notifyChatEndpointWork` in their owned transactions; that now includes the connection-scoped GitHub topic. |
| `setup-probes.ts` and chat task admission | Successful activation already notifies through `notifyChatEndpointWork` or endpoint configuration. |
| `credentials.ts` | Credential reference replacement and clearing notify endpoint configuration before writes. |
| `resource-reconciliation.ts`, `provider-effects.ts`, interaction callbacks and publication failures | Eligibility/status changes use existing configuration notifications. |
| `github/installation-lifecycle.ts` | New explicit endpoint notification precedes revocation, legacy identity upgrade, runtime generation/availability settlement, and failed-inventory transitions. |
| `chat-github-wizard.ts` | Setting `cloudRegistrationId` now notifies inside its short owned setup transaction; unrelated wizard metadata does not signal this worker. |
| `github/webhook-ingress.ts` | Claim and final recovery-window CAS writes notify before writing, including manual recovery. |
| Tool connection configuration/health and company deletion | Existing connection/company notification fan-out now carries this topic; removal invalidates cached deadlines. |
| `github/app-setup.ts` | Initial identity claim is restricted to incomplete setup; later credential persistence and activation are covered. Stage/management URL metadata alone does not change recovery eligibility. |
| Webhook authentication, ordinary activity, review settings, endpoint display/task settings | Do not change recovery eligibility, runtime epoch, callback origin, or recovery checkpoint; no added signal. |

Supported writes share the database owner's process-local transaction signals.
Independent SQL writers and another server process need a separate integration;
this change does not claim they are observed. Nested savepoints still settle at
the outer transaction. Unknown transaction outcomes retain the shared intent
hold until the database protocol resolves them.

The callback base URL comes from configured startup URLs or the live canonical
Cloud identity. `applyCloudRuntimeIdentityAssertion` allows one durable claim
and identical retries, and rejects replacement with another assertion. Warm
standby defers reconstruction until admission opens, so the worker sees the
claimed identity. Ordinary self-hosted URL configuration changes restart the
process. No permanent URL-discovery poll is introduced.

## Evidence and retained failures

- Initial server typecheck passed (`/tmp/sleep38-first-types.log`).
- First selection: 27 passed, four failed (`/tmp/sleep38-worker-first.log`).
  One assertion confused a numeric scheduler deadline with a Date. Two lifecycle
  cases created real timers before installing fake timers. The resume fixture
  forced active status without complete setup. Corrected fixture/clock ownership;
  no production timing change. All 31 selected cases then passed in 15.87 seconds
  (`/tmp/sleep38-worker-fixed.log`).
- The first installation producer test passed while startup checkpoint signals
  were still pending. Waiting for their actual future deadline exposed the missing
  notification: deletion left the deadline armed. This regression failed in
  `/tmp/sleep38-lifecycle-settled-regression.log` before the lifecycle writer fix.
  It now passes through real signed deletion and reinstall behavior.
- Wired acceptance passed all integration cases but failed two obsolete source
  assertions about the removed timer. Updated them to assert shared worker
  registration and absence of the coordinator/interval.
- Final bounded selection: 41 passed in 26.55 seconds
  (`/tmp/sleep38-bounded-tests.log`). Includes quiet unconfigured/Cloud/disabled
  states, no SQL before a saved deadline, real callback-only admission, real
  resume/pause, restart/drain/standby, nested rollback/outer commit, credential-only
  epoch change, reconstruction failure across drain, held HTTP with independent
  queue progress and joined shutdown, 106 deadlines across companies with an
  initial five-item batch, and the prior review-projection default-batch consumer.
  The backlog fixture then replaced timing-derived App IDs with random identities
  to avoid a possible fixture uniqueness collision; final acceptance follows.
- Final workspace typecheck and build pass (`/tmp/sleep38-workspace-types.log`
  and `/tmp/sleep38-workspace-build.log`). Voice session/retention acceptance
  passes all 122 cases in 26.48 seconds (`/tmp/sleep38-voice.log`). Complete chat
  acceptance and remote CI/review remain required. This is not a full-stack
  readiness claim.

## Review repair: a claimed redelivery that never reached transport

Greptile identified a valid P1 at initial head `936e132c01`: drain/shutdown
could start after the recovery receipt committed and before the POST began.
The guard correctly prevented HTTP, but the catch marked the receipt uncertain,
and the next scan refused that same failed delivery. Four real-PostgreSQL cases
reproduced the lost callback for drain/shutdown with both a first claim and a
previous receipt (`/tmp/sleep38-unsent-regression.log`, four failures).

The owner now distinguishes transport admission from a persisted claim. If the
request did not start, it restores the prior receipt or removes the new receipt
inside a short notifying transaction. If transport may have started, it retains
`delivery_unknown`. Settlement and restoration use the exact attempt identity
(id, processing status, count, provider delivery, and requested timestamp), so
an older attempt cannot overwrite a successor. Lease failure before HTTP follows
the same known-unsent path. Neither database transactions nor the provider POST
are replayed automatically. A crash between commit and transport, or failure to
persist restoration, still requires conservative durable uncertainty handling.

- Server typecheck and 59 selected integration/publication/startup cases passed
  after the repair (`/tmp/sleep38-unsent-types.log`,
  `/tmp/sleep38-unsent-fixed.log`, 28.91 seconds).
- Two additional cases replace the receipt timestamp while preserving its
  processing status and attempt count. All six stop-before-transport cases pass;
  restoration leaves the newer receipt intact and restart does not replay it
  (`/tmp/sleep38-unsent-cas.log`, 10.27 seconds).
- The initial full command passed 1,586 tests across two files in 571.36 seconds
  (`/tmp/sleep38-full-chat.log`). It misspelled the standalone publication suite
  filename, so it did not run that suite and is not three-suite acceptance.
  The corrected complete command includes `chat-interaction-publications.test.ts`.
- Final workspace typecheck/build passed. Corrected three-suite acceptance on
  `paperclip_sleep38_final_20261025_1837_test` passed 1,605 cases and failed one
  resume timing assertion in 571.32 seconds (`/tmp/sleep38-final-chat.log`).
  The test observed the newly committed checkpoint before `check` reloaded its
  deadline and the coordinator scheduled it. It now waits for idle tracking to
  settle and a deadline more than 30 seconds in the future, then verifies pause
  disarms it. Production code is unchanged by this assertion repair.
- All 37 selected lifecycle/publication/startup cases pass with that assertion
  (`/tmp/sleep38-settlement-fixed.log`, 23.10 seconds). This is focused repair
  evidence, not a claim that the earlier full run passed. The latest commit still
  requires all remote CI and fresh review. The production repair at `491a7e1eef`
  received Greptile 5/5 and its P1 thread is resolved.

## Remaining boundaries

The idle-safety proof still blocks unsupported active channel obligations. A
registered in-process timer is not an acknowledged Cloud alarm and cannot wake a
suspended host. These tests establish worker behavior, not provider suspension or
fleet savings. GitHub connection discovery/replay, credential continuity, and
merged-PR confirmation are separate remaining duties.

All earlier stack CI/review findings, remaining original inventory items, final
master reconciliation, and each latest-head PR gate remain required. No merge is
authorized or performed by this migration stack.


## Current-parent acceptance (October 28)

The existing branch was merged normally with published review-projection parent
`1453a4447c0d4d33f713ae3e00734c7950f95426` at
`3d7f163bc5259b60f9bd19b7fc90b402f0a6e925`. Both complete added/removed patches
and every unrelated parent blob were preserved. This slice adds no migration;
the entire parent database tree, including migration history through 0403, is
byte-identical. The batch-size option already exists in the current parent;
this slice selects five without changing other consumers' default bound.

At that integration, 751 distinct cases passed:

- 274 complete GitHub review workflow cases.
- 294 other GitHub-named provider, installation, recovery, attachment, and
  publication cases, including all 19 new recovery worker cases and all six
  stop-before-transport variants.
- 30 complete terminal interaction publication cases.
- 145 complete voice-session integration and inbound retention cases.
- Eight current startup/hostname wiring cases.

The first workflow filter omitted the separate new recovery group. The saved
verbose case list exposed that gap before acceptance was declared. A second
selection in another fresh database ran all remaining GitHub-named cases while
excluding the already-tested review group. The two passed-name sets have no
overlap. The first command filtered 1,504 unrelated cases; the complementary
command filtered 1,484 cases. These are focused selections, not the full chat
suite or full repository suite. The original commands and results remain in the
verification record.

Coverage includes unconfigured/Cloud/disabled quiet, saved-deadline quiet,
authenticated callback-only admission, real installation and credential changes,
restart/drain/standby, nested commit/rollback, failed reconstruction, 106 saved
deadlines with five-item fair batches, held HTTP with independent queue progress,
joined shutdown, exact-attempt known-unsent restoration, and protection of a
newer receipt. Existing authority, signature, source, and replay checks also pass.

Database build, server production typecheck/build, module boundaries, and target
migration order passed. Five separate fresh PostgreSQL fixtures received the
unchanged parent migrations through 0403. The audit follow-up changes only this
document; accepted source, tests, and migration hashes remain unchanged.

The actual parent merge and fresh current-head CI/Greptile checks remain required.
Direct GitHub Apps retain their real one-minute external recovery obligation;
Cloud relay and disabled endpoints remain excluded. This does not expand Cloud
alarm coverage or prove deployed host/database suspension or fleet savings.


## Parent startup boundary correction

The parent stale-review PR received a valid required review finding: its legacy
maintenance source slice used a removed end marker. The parent reproduced that
with explicit bounds, then fixed the marker and passed all 13 startup tests.
This webhook-recovery slice removes that entire coordinator and timer. During
the normal parent merge, its obsolete boundary inspection conflicts with this
slice's existing assertions that both symbols are absent. Keep those absence
assertions: there is no remaining coordinator section to slice. All other parent
changes, including its audit and unrelated onboarding smoke coverage, are carried
unchanged. The complete server, package, and UI source trees still match the
751-case accepted revision; the eight startup cases are also rerun after resolving
this overlap. This is a superseded test for removed functionality, not a waiver
of an unresolved production finding. Fresh review and CI remain required.


## Orphan-assignment review investigation (2026-10-28)

Ponytail's review of `836acef0370d42323fdfdbd6d62a805b2469f1d4` required
preventing recovery from repeatedly loading an endpoint whose assigned agent
cannot resolve. Its reasoning correctly identifies that the loader does not
join agents, but the proposed orphan state conflicts with existing database
constraints. Investigation must establish that boundary before changing SQL.

The first attempted reproduction set `assigned_agent_id` to NULL. It failed
**during fixture mutation**, with PostgreSQL 23502, before the worker ran. This
is not a failing worker regression and is not described as one. The original
schema and a freshly migrated PostgreSQL catalog confirm:

- `chat_endpoints.assigned_agent_id` is NOT NULL.
- `chat_endpoints_assigned_agent_id_agents_id_fk` references `agents(id)` with
  ON DELETE RESTRICT.
- `chat_endpoints_company_agent_fk` references `(agents.company_id, agents.id)`.
- Both foreign keys are validated and nondeferrable.

Thus a supported writer cannot commit the missing, null, deleted or foreign-company
agent relationship described in that finding. A concurrent deletion cannot open
a committed orphan window. The application endpoint resolver joins those same
ID/company columns. Disabling constraints or corrupting a database would be a
different unsupported state; the tests do not weaken the schema to manufacture it.

Three new real-database cases verify the boundary: NULL assignment fails 23502,
assignment to a missing UUID fails 23503, and deletion of the assigned agent fails
23503. Each proves the original assignment remains, then runs real webhook
recovery, observes one redelivery and a saved future deadline, and advances
15 seconds with no SQL reads or extra transport. All **22 recovery-scheduling
cases** pass on a fresh database, including the previous 19 cases and these
three additions. The 1759 unselected cases are not counted as current passes.

Production source is unchanged. The earlier 751-case acceptance retains its
stated revision and scope; these 22 overlap 19 of those cases, so there are
754 distinct tested cases across the evidence, not 773. No deployed sleep claim
is made. The legacy manual recovery query remains an optional review follow-up.
The actual parent squash ancestry was merged normally with the entire result
tree identical to the previously validated branch, so already-landed parent
changes no longer inflate this PR's diff. Fresh current-head CI and review
must evaluate the constraint evidence before this slice can merge; an old
conditional verdict or neutral check is not treated as a pass.


## Repository comment rule follow-up

Apply CONTRIBUTING.md's prohibition on new code comments consistently to this
slice too. Seven newly added comment lines are removed: two in the constraint
regression and five explaining GitHub pagination guards. The database-constraint
evidence above and pagination/partial-window rationale in this audit remain the
durable explanation. TypeScript parsing proves both affected files retain the
exact non-comment token stream; no recovery predicate, guard, assertion, deadline
or transport call changes. The 22-case current recovery acceptance and earlier
751-case runtime evidence keep their stated revisions and scope. Fresh head CI
and review are still required; neither an old score nor comment-only equivalence
by itself satisfies the merge gates.


## Current CI test corrections (2026-10-29)

The cbe3fbea head failed two independent test boundaries. Neither changes the
production scheduler, database constraints, delivery state machine or deadlines.

The new deleted-agent probe expected PostgreSQL 17's 23503 foreign-key error.
CI PostgreSQL 18 correctly reports 23001 (restrict violation) for the same
forbidden delete. Running the original assertion against local embedded
PostgreSQL 18 reproduced that exact failure. The assertion now accepts only
those two integrity codes for deletion; NULL still requires 23502 and a missing
UUID still requires 23503. It also checks that the original agent row and
assignment both remain before testing healthy deadline-driven recovery. All
22 recovery-scheduling cases pass on embedded PostgreSQL 18. The three integrity
probes also pass against a fresh PostgreSQL 17 database. They are the same three
cases across two engines, not six distinct cases. The invalid-orphan premise
remains ruled out by validated nondeferrable constraints, not by changing SQL.

The attachment E2E failed waiting for a file chooser. Its screenshot and trace
showed an announcement appearing while the attachment menu was open. The global
locator handler tried to dismiss the announcement outside that modal menu, so
its own click could not complete and the original menu-item click could not run.
The unchanged failing journey passed naturally once locally; that pass did not
explain or erase the CI failure. A controlled delayed real announcement response
released after the menu opened reproduced the same 60-second filechooser and
intercepted-click failures. The handler now closes the menu through Escape,
dismisses the announcement through its visible button, and reopens the menu
so the original upload action can continue. The same first late-announcement
condition passes with this repair. The temporary fault is one-shot after that
first injection so a dismissed card is not incorrectly awaited for the second
attachment; the failing predecessor never reached a second injection.

The temporary delay/route fault was removed before final acceptance. All **11
complete attachment receipt journeys pass**, retries zero, in 38.7 seconds.
Every journey body, receipt/content assertion, 60-second test budget and
120-second startup budget is unchanged. The full run uses a fresh database on
the existing local PostgreSQL 17 test server and the canonical throwaway
Paperclip home, CLI onboarding, server, UI, storage and HTTP paths. An earlier
full-run attempt failed during embedded PostgreSQL initialization before any
browser test started; host semaphore usage was near capacity. That startup
failure is retained and is not counted as a test pass. No shared host resources
were deleted or unrelated databases stopped. PostgreSQL 18 coverage is provided
separately by the recovery suite and remains required in fresh CI.

Server typecheck passes. Production source and schema are unchanged from cbe3fbea;
only the two test files and this audit change. The prior 751-case runtime scope
remains exactly as recorded. Fresh current-head CI and reviews remain required
before merge; no previous failing result is erased by these passes.
