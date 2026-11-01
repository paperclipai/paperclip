# Zero-downtime web deployments

Date: 2026-10-31. Status (2026-11-01 15:39 UTC): existing-volume staging enrollment
and manual sleep/wake preserve saved files and read/save behavior. The full local
active-agent journey now passes on `cc23019691`; hosted browser continuity and
the ten-deploy staging campaign remain unqualified. Natural database autosuspension
passes after abandoned test-resource cleanup. No production canary yet.

Core #18543 merged as `7751fc3107` after 55 successful CI checks, Greptile 5/5
and no unresolved threads. It supplies runtime admission, immutable-cache
retirement, remote agent-file projection, and adoption using validated admitted
Runner instructions without rematerializing retired launch assets. The earlier
`67714af9ff` deleted-bundle failure is reproduced and fixed; the `cd690de4d3`
attempt was interrupted because the unrelated probe task blocked the business
all-tasks-done oracle. The probe now has a separate disposable company; the oracle
is unchanged. All test credentials, buckets and provider sandboxes were cleaned.

The complete retry at `f5915fdc33` exercised both replacements with 523 reads,
53 saves and 53 verified saves, zero probe failures. The original remote execution
survived with the same runner/session and completed once. Saved project tests,
file-reference continuity, and the later useful answer passed. The workflow still
FAILED: its later admission rotated native/provider sessions, and all four public
run records lacked the native terminal contract. These failures remain acceptance
blockers, not successful qualification.

The next slice owns those gaps at existing boundaries: instruction authority
exposes the committed entry digest without reading a disposable cache; heartbeat
session compatibility identifies immutable skill versions rather than their host
paths; the native receipt transaction publishes its accepted terminal contract
without depending on the originating adapter returning. Both regressions failed
before the changes. All 249 affected workspace/session, durable-file and control-
plane persistence tests pass, as does server typecheck. Assembled admission suites
ran 59 passing cases, but native resumption teardown closed every client on the
shared database host, including its fixture's admin connection. This reproduces
on clean master; limiting teardown to the owned database makes all 16 native
resumption cases pass. PR #18552 has a 5/5 review for the initial fix.

The next real attempt at `d2165dec5d` failed before B became ready: startup
recovery tried to lock a run still owned by A, hit a one-second PostgreSQL lock
timeout, and aborted startup. Its credential and bucket were cleaned; provider
cleanup is independently checked after the asynchronous stop/delete transition.
A three-case regression reproduces this for locked issue, run and coordinator
rows. The fix skips those locked rows, schedules the same concrete run through
the existing recovery retry, and avoids a diagnostic write that would wait on the
same lock. All 74 enabled restart recovery tests pass, including the assembled startup
caller; eight Docker-specific cases were not enabled in that run. Real content, skill-version,
model, credential and task boundaries remain compatibility checks.

The real retry at `aae8a53d01` reached a different startup failure: the readiness
gate treated a run still preparing its skill selection as an unmigrated skill
installation. Saved rows show committed version-backed skills and one admitted
run whose exact pins had not yet been published. The new PostgreSQL regression
fails before the fix. Startup now checks installation durability independently
of active run pinning; maintenance eligibility, migration and cache eviction
keep their conservative pin requirements. Missing durable versions still refuse
readiness. All 33 readiness, managed-skill and durable-file tests pass, with server
typecheck. The failed attempt remains failed evidence; its child credential,
bucket and all three provider sandboxes were cleaned and checked. Review also
replaced the whole agent-file manifest read with a scalar SQL digest projection.
PR #18552 merged as `c0550e7010` with all required CI green, Greptile 5/5,
and its scalar-query review findings resolved. The real `a15a12651c` attempt
passed both web replacements: 765 reads, 78 saves and 78 verified saves with
zero HTTP probe failures. The active execution survived once; the first three
turns retained the native/provider session and accepted terminal contract.
The fourth continuation FAILED: the retained Runner was safely suspended with
an empty outbox and no pending terminal, but warm recovery attempted live-idle
reattachment. Its provider state and diagnostics are preserved; all three owned
sandboxes were independently confirmed absent. The next bounded fix reuses the
existing per-turn suspended-receipt restoration for warm admission after cache
loss, preserving physical sandbox binding and ordinary admission fences.
A real PostgreSQL/Linux Runner regression reproduces the exact live error before
the fix. Recovery then exposed a second stale-cache read: source reconciliation
tried to stage new launch assets that the transport deliberately had not created.
The existing remote process launcher now passes its structured launch identity
to asset preparation, so reconciliation preserves the previous authority's
retained launch files. Both new regressions pass: three turns preserve one
provider thread after two cache deletions, including a failed remote state read
and retry. All ten Linux continuity scenarios and 1,067 surrounding boundary tests pass.
The exact `cc23019691` server build passes. PR #18554 has Greptile 5/5; CI and
its second review identified a narrower dispatch boundary: warm receipt
inspection must leave every non-suspended state to the existing live-adoption
checks. A new preliminary-read regression fails before that refinement. The
refinement plus both suspension regressions pass in a fresh Linux fixture, and
server typecheck passes. The first retry reused a container whose deliberately
failed pre-fix case left its live Runner on the ingress port; that infrastructure
failure is preserved. The local wrapper now creates and cleans one container per
invocation. This does not weaken the existing idle check or claim support for
adopting a persistently backpressured Runner.

The live Codex/Daytona attempt at that clean source PASSED on its first attempt,
with no automatic retries: 518 reads, 53 saves and 53 verified saves across both
replacements, zero probe failures, both complete predecessor homes deleted.
The active execution resumes under the replacement and completes once. All four
turns use the same native/provider session with accepted native terminal records.
The final turn runs the saved project and returns the independently checked
output. The original Git commit, untracked workspace reference, prior downloads
and revised files survive. Browser reconnection remains explicitly unqualified
in this API-led continuation case and must pass in the hosted campaign.
Child credential, bucket and local test-home cleanup passed. Independent provider
verification found two archived setup sandboxes left by the harness; those exact
owned residuals were deleted separately and independently confirmed absent,
preserving the failed automatic-cleanup verification. The product journey pass does not prove automatic fixture cleanup. The attempt's
reported-plus-estimated model/runtime cost is about $0.243. Its immutable evidence
is `zdt-live-2026-11-01T15-24-43-429Z` under the private live-evidence directory.

Review also identified save quotas incorrectly applied during cache recovery.
Recovery uses the existing inbound remote projection and preserves path/link
validation without enforcing save quotas on admission. Ordinary saves still reject
oversized changes. Related transport recovery tests passed 71 cases; directory
cleanup/cache-loss tests passed 20 cases after three timing failures in a broad
run. A separate CI attention-retention timeout reproduced on clean master: its
fixed clock fell behind database-assigned updatedAt. Advancing across the saved
deadline fixes it; all 53 tests in that file pass with original timeouts.

Cloud #1102 merged as `461c4aea28` and is serving on the staging controller.
The original enrollment completed using its original qualified image, a retained
detached volume, and the migrated decision key. The post-enrollment probe passed
20 reads and three saves with no HTTP/WebSocket failures and verified all 34 files.
The original browser tab reconnected and persisted a task title. Server logs later
showed old Agents chunks returned 404 and navigation recovered via a page reload:
this is migration continuity evidence, not uninterrupted old-tab asset loading.

Three eight-minute natural database-idle observations failed. A separate bounded SQL
attribution window saw no other app-database sessions; it is diagnostic stimulus,
not idle proof, and does not establish the source of provider activity. The third window, bracketed by closed SQL counter snapshots, recorded 36 transactions and small read deltas on environment setup, leases, environments and plugins; no app-row writes. A later scoped diagnostic found an abandoned ephemeral setup sandbox still
archived at the provider despite a historical cleanup-success row. The normal
verification worker revisited it every five minutes. After deleting that exact
owned sandbox, the product independently stamped its destroyed-resource proof;
no historical row or cleanup evidence was manually rewritten. The fresh provider-metadata-only observation passed: the same single volume-free
web deployment remained serving while Neon automatically suspended after its
five-minute idle timeout. No app HTTP or SQL was used during the observation. Automatic
idle sleep was correctly refused because this development fixture is not eligible
for the free/demo policy. Manual sleep with force disabled passed: the registry
reports sleeping, Railway has no active web deployment or attached volume, and
Neon is idle. The normal organization entry started wake, and Railway became healthy on the
same volume-free service. Post-wake proof passed 21 reads, three saves, a connected
WebSocket and all 34 file hashes. The browser displayed the retained task and saved
a new title, independently read back through the API. Automatic return from the
refreshing entry page was not verified; the browser navigated to the tenant after
readiness. Wake took several minutes while existing shared UI assets were checked.
Private receipts remain under the task's live-test, staging enrollment and hosted
probe directories; no credential or live target identity belongs here.

## Outcome and endpoint

Keep the main Paperclip web/API usable through an app-only Railway deployment.
A person saves or answers while an agent works, sees that execution finish once,
and continues with its saved result after both webserver replacements. Finish at
reviewed/merged changes and a verified forward deploy and compatible rollback on
one internal production canary. Fleet-wide production rollout and online schema
migrations are deferred. One-time maintenance for volume migration is allowed.

## Acceptance

| Case | Required evidence |
| --- | --- |
| Fresh and migrated data | Separate empty server homes share only Postgres, object storage and secrets; acknowledged bytes remain readable |
| A/B overlap | Continuous requests have no deploy-caused failures or lost acknowledged writes; no hidden client retries |
| Cross-process commands | Stop, answer and follow-up arriving at B reach execution owned by A through durable authority |
| Browser | Existing tab reconnects within five seconds and loads a previously unopened page after replacement |
| Agent | Same remote execution; one completion and accounting result; independently verified files |
| Later continuation | Another empty-home replacement after completion can continue the retained session |
| Failure and rollback | Unready B leaves A serving; compatible A/B/A rollback uses current shared data |
| Lifecycle | Repair and sleep/wake retain volume-free shape; idle database suspension remains possible |

Crash recovery is qualified separately from planned zero-downtime deployment.

## Delivery units and ownership

The lead in this chat owns integration and target deployment; no other deployment
owner has been assigned. Preserve the existing five storage workstreams and their
evidence. PR #18403 is merged; implementation starts from Core `34f8d25089` and
Cloud `936e23c8` in isolated `codex/zero-downtime-web-deploys` worktrees.

1. Extend existing controller replacement / Product E2E owners with a two-server
   proxy, disjoint writable roots, exact artifact identities and retained evidence.
2. Close remaining authoritative agent-file and provider-backup storage gaps using
   existing storage/authorization owners, Postgres manifests and immutable objects.
3. Add readiness and bounded HTTP/controller handoff; durable cross-process work
   hints, ownership and live update reconciliation; retained compatible UI assets.
4. Add persisted Cloud `single-ephemeral` shape, explicit eligibility, migration,
   rollout, rollback, repair and sleep/wake behavior through the existing provider
   and campaign owners. Defaults: readiness `/api/ready`, startup 600 seconds,
   overlap 5 seconds, draining 90 seconds, retained volume/assets 30 days.
5. Qualify locally, then ten consecutive successful staging deployments including
   rollback, then a production canary forward deploy and rollback.

Existing active work must not block replacement HTTP readiness. Shared queues and
row ownership remain durable truth; notifications only accelerate reconciliation.
No permanent idle polling or idle database listeners. Ineligible stacks keep their
current path. Migrated stacks cannot accept disk-dependent configurations. Rollback
never restores stale local volume state after shared state advances.

## Feedback and current state

First experiment: create and save through A, start empty-home B against the same
disposable Postgres/S3, read through B, switch traffic, then SIGTERM A under writes.
Qualify harness identifiers, evidence and cleanup before introducing live agents.
Next use the real Runner with deterministic provider, then Codex/Claude Daytona.
Measure one-time setup separately from repeated attempts. Keep failed evidence.

| Item | State | Next action |
| --- | --- | --- |
| Prior prerequisites | #18403 and all five storage workstreams merged | Retain the ephemeral filesystem contract |
| Core implementation | #18518, #18526, #18529, #18530, #18531, #18533, #18543 and #18552 merged; #18554 reviewed at 5/5 with CI pending; local packaged migration, browser overlap, cold restoration and durable command proofs recorded below | Publish and qualify the exact fixed release after CI/review merge |
| Cloud implementation | #1096, #1098, #1099, #1100, #1101 and #1102 merged; #1102 serving on staging | Verify repeated Railway overlap behavior after Core recovery qualification |
| Staging | Original enrollment complete; migrated data and signing key preserved; volume detached and retained | Sleep/wake and natural database idle pass; verify repair and ten app-only replacements with browser continuity |
| Production | No canary mutation performed | Proceed only after the staging and active-agent acceptance gates pass |

Keep PRs, tested revisions, artifact identities, evidence paths, deployment targets
and unresolved gates here. A green CI/build/deploy status alone is not acceptance.

### Local characterization, 2026-10-31

Current source `34f8d25089` with the new source-mode harness: A ready in 12.7s,
B in 10.9s, handoff including shutdown/deletion in 2.5s. 96 reads and 20
acknowledged comment writes passed across overlap; every acknowledged comment
survived once. A saved managed agent file was readable through B only while A's
directory remained; after deleting A's home the same B request returned 404.
The stored absolute path allowed B to read A's directory on the same host.
Overall result: **failed**, with agent-file durable authority a demonstrated
prerequisite. No browser, live agent, managed-cloud auth or packaged build proof.

Private evidence: `/private/var/folders/74/zhncxl_j05xb5_r6_vfbk73h0000gn/T/paperclip-runner-e2e-4Q7BmG/rolling-deployment-evidence.json`.
Setup failures are retained: host embedded Postgres could not initialize;
the first full-server boot lacked the fresh SDK build. Isolated Docker Postgres
and a built SDK resolved those setup failures. No product assertions were reached
in those attempts. The proxy's in-flight write handoff regression passed.

Owned temporary dependencies: Docker containers `paperclip-zdt-postgres-20261031`
and `paperclip-zdt-s3-20261031`, loopback only. Connection files under
`/private/tmp/paperclip-zdt-{database,storage}.json` are private and must never be
committed or uploaded. Each attempt cleans its own database and bucket. Retire
these containers and credential files when local qualification no longer needs them.

### Durable agent-file implementation

The agent-file service owns a current Postgres manifest and immutable S3 objects.
Managed roots are disposable projections; existing authorization, hash conflicts,
runtime directory merges and activity logging keep their owners. A durable head
remains authoritative if `PAPERCLIP_DURABLE_AGENT_FILES` is subsequently disabled.
Legacy local data must be adopted on its owning server before filesystem removal.
Separate bounded file-transfer connections protect ordinary HTTP and controller
renewals during S3 stalls. No idle polling or listeners were added.

Source-mode evidence (base `34f8d25089` plus uncommitted changes):

- `paperclip-runner-e2e-A05NfC`: 76 reads/16 acknowledged writes, deletion of A's
  full home, saved agent file recovered by B; all checks passed.
- `paperclip-runner-e2e-NcNG3F`: bidirectional A/B edits and stale-write 409 also
  passed. No browser or active-agent claim.
- `paperclip-runner-e2e-zQMAji`: both transfer connections deliberately held;
  unrelated task read completed in 20ms. A failed-write read unexpectedly returned
  200, so this expanded run failed and is retained for diagnosis. Fresh C did
  recover the primary saved file after deleting both previous homes.

Each directory above is under
`/private/var/folders/74/zhncxl_j05xb5_r6_vfbk73h0000gn/T/` and contains
`rolling-deployment-evidence.json`. All owned attempt databases/buckets were
cleaned. Exact lockfile dependencies were installed after initial characterization;
repeat affected qualification before relying on a final receipt.

The failed first write exposed rollback followed by re-import of dirty local
bytes. A private pre-mutation import receipt fixes that retry; committed heads
remain solely in Postgres. The harness also now explicitly seeds process-agent
instructions through the canonical API (agent creation ignores that field).
The corrected run `paperclip-runner-e2e-Xdn96H` passed all eight checks.

Latest source-mode receipt `paperclip-runner-e2e-eGJIqp` passed all nine checks:
114 reads, 23 acknowledged writes, 2,508ms handoff, 31ms unrelated task read while
both storage connections were held. An admitted file save finished after SIGTERM;
C restored both saved files after A and B homes were removed. Cleanup confirmed.
The receipt records the source patch and lockfile digests. No browser, managed
auth, distinct packaged releases or live-agent qualification is claimed.

An earlier passing drain receipt `paperclip-runner-e2e-iW2OCt` took 32 seconds:
Node's listener-close callback also waited for upgraded sockets. HTTP drain now
uses the existing request/promise tracker, while browser and agent sockets retain
their own shutdown owners. Readiness becomes unavailable immediately on SIGTERM.

Verification: full workspace typecheck passed; HTTP drain/idle/readiness 39 tests,
shutdown/WebSocket 28 tests, instructions service/routes 39 tests, and durable
authority/migration/retention six integration cases passed. The repository suite
is running with disposable external PostgreSQL for server tests. Broad storage
regressions initially had five race-fixture failures after the file pool moved;
the affected race cases were corrected to intercept that pool and passed.

Agent object cleanup is explicit bounded maintenance, retaining objects for at
least 30 days and preserving all objects while an agent has no durable head.
It checks current authority under the writer lock and removes all object versions.
This introduces no idle polling. Migration requires stopped writers and refuses
external roots, active runs, or missing legacy files. Every migration page must
pass; no partial page is an instance-wide eligibility report.

### Browser and overlap commands, 2026-11-01

Receipt `paperclip-runner-e2e-oYdmER` passed all ten checks using independent
compiled server/UI directories and workspace dependencies: 91 reads, 19 writes,
2,870ms handoff, 1,013ms browser reconnect and 23ms task read during the S3 outage.
The original tab opened Audit after A's entire home/build was deleted, loading
its old lazy chunk from S3 because that chunk was absent from B's directory.
Zero page errors; cleanup confirmed. The preceding `WWdWtO` attempt failed on
an outdated harness label (Activity versus Audit); it remains failed evidence.
This is local-trusted auth, not a released-container or active-agent proof.

Core now validates ephemeral configuration and existing durable data before
readiness, rejects future local-only execution/instructions, initializes new
agent manifests transactionally, and publishes/serves retained immutable UI
assets. PostgreSQL work hints listen only during handoff or active execution.
Durable Stop and runtime-response delivery use existing run authority; request
lifecycle, company membership and privileged approval access are rechecked at
consumption. A's command workers remain alive through controller handoff;
committing the released lease notifies B. Duplicate local Stops join cleanup.
Six PG command-delivery cases passed with a simulated provider; 33 targeted
Stop/recovery cases and 27 coordinator cases passed. Real A/B provider execution,
high-level question delivery and same-turn steering remain unqualified.

Cloud's full suite passed 4,778 cases with 129 gated skips before the latest fresh
canary selection change; its three affected provider cases also passed. Runtime
and direct-listener credentials use the same Neon application role in separate
vault refs. Persisted ephemeral shape survives repair/wake/rollback; explicit
fresh canary IDs leave fleet defaults and existing volumes unchanged. No stack
has been enrolled, detached, deployed or charged for a new hosted test.

The full Core build and typecheck passed before the newest command changes.
The broad suite is still running; it has reported two failures (native bootstrap
Stop's direct embedded-DB fixture, and a workspace-reference conflict assertion).
Do not claim a green full suite. The server has been rebuilt with the current
command changes; packaged maintenance entry is being verified separately.

Remaining gates: large cold directories, real Runner A/B overlap (including
Stop/answer/follow-up), complete bounded shutdown, packaged-release overlap,
existing-volume maintenance orchestration, exact staging/production targets,
review/merge, ten staging deploys and production forward/rollback. Draft PRs are
[Core #18518](https://github.com/paperclipai/paperclip/pull/18518) at `cf31fa7620` and
[Cloud #1096](https://github.com/paperclipai/paperclip-cloud/pull/1096) at `387ebb37`.
Cloud CI passed; Core CI and review corrections are underway. No merge or deployment yet. The same owned worktrees and acceptance remain.

Migration must preserve the original `decision-signing.key` as the stable
`PAPERCLIP_DECISION_SIGNING_SECRET` before removing the volume. Ephemeral startup
now refuses a missing/short value. Fresh Cloud provisioning must supply a stable
key too; the storage master key alone does not preserve decision signatures.

Review round 1 corrected missing decision-key admission, stale runtime answers,
and raw-versus-effective lifecycle policy. Local server typecheck passed using
the installed TypeScript binary (the pnpm shim could not reach its signature
registry in the sandbox). Runtime/config regressions passed 38 tests; startup
shutdown and OpenAPI regressions passed 152 tests. CI's response mock counts and
missing WebSocket mock were fixed; `/api/ready` now has explicit GET/HEAD OpenAPI
contracts. These receipts precede the next commit and do not qualify a live run.
Cloud review corrections cover partial-create retries, legacy shape preservation,
pre-allocation image qualification, actual extra-service detection and protected
storage settings. Fresh ephemeral stacks now initialize a decision key in the
vault before deployment; already-started stacks require their existing key.


### 2026-11-01 overlap workflow qualification

Core `0b8fcca44f42d9d43894e728e42fa55545cc3665` and Cloud
`bd772707a0f7398990d0d84a2b75bd242445ffaf` both received fresh 5/5 reviews.
All checks on those pushed heads pass. The Cloud local suite passed 4,795 tests
with 129 explicit skips. The superseded Core full local run was stopped after
three hours after its pushed head passed CI; its historical failures are not
relabeled. Fresh recovery-file verification passed all 75 tests.

The next Core commit adds the explicit Product E2E `rolling-web-deployment`
cell. It reuses the remote workspace, active execution and later retained-session
oracles, with a separate ready-before-handoff receipt. An independent home and
compiled build are used for A/B/C; Postgres, S3 and generated secrets are shared.
Read/save probes perform no HTTP retries. The old five-minute outage suites retain
their contract. The observer captures A before handoff so B cannot adopt before
the baseline is recorded. The normal recovery code owns all leases and replay.

Credential-free evidence: 143 affected harness tests, 120 catalog/fixture/report
tests, E2E typecheck, and map structure checks passed. Discovery selects one
explicit Codex Daytona cell, four expected admissions, one attempt, $10 company
budget and the existing 30-minute limit. This does not establish live execution.

The actual supervisor passed two replacements with no model calls, 436 ordinary
reads and 45 saved/read-back comments, zero request failures, old homes removed,
and owned database/bucket/process cleanup confirmed. B readiness was 18,694 ms;
C readiness was 109,182 ms. Receipt (private local):
`/private/var/folders/74/zhncxl_j05xb5_r6_vfbk73h0000gn/T/paperclip-runner-e2e-meJSIF/replacement-evidence.json`.
It is source/compiled-with-workspace-dependencies, not a released container.
The prior attempt `srF1rz` timed out on C and remains failed; its first replacement
had 107 reads and 11 saves without failures. The initial `Ro7sxQ` setup failed
because a partial TypeScript build had not copied the compiled Runner vendor;
the normal build vendoring step corrected it. All three attempts cleaned up.

Staging read-only discovery and authentication work with AWS `paperclip-dev`
(account `078455283791`); production `paperclip-prod` is also authenticated.
The existing shared `canary-staging` stack is `stack-pool-8fabb27531db`.
Do not assume it is exclusively owned: select a dedicated zero-downtime test
stack or acquire the existing stack operation lock before any hosted mutation.
No hosted mutation or paid model call has occurred for this task yet.

Remaining: live overlap proof; released artifacts; migration/enrollment and
compatible rollback; ten staging deployments; internal production canary.

The active-overlap harness is a separate stacked PR [#18526](https://github.com/paperclipai/paperclip/pull/18526)
on runtime PR #18518 to preserve the repository's review-size boundary. Its first
review found that the checkpoint observer lacked the disposable encryption key
and that forced process cleanup could pass graceful qualification. Both are
corrected; 22 focused tests passed, including actual child shutdown and shared
key decryption/restoration. The earlier model-free receipt remains evidence for
HTTP availability and cleanup, not active checkpoint recovery.

The full harness run at `0f122611a1` completed with 5,814 passes, 17 failures and
four skips. Preserve `/private/tmp/paperclip-zdt-e2e-unit-all-rolling.log`:
four onboarding mock expectations, four unchanged workflow security expectations,
one Pi profile version expectation, three date-expired accounting fixtures,
two report-command timeouts, two process-shutdown races and one host embedded
Postgres startup failure. The complete shutdown file passed in the focused run;
other failures still need base-revision classification. No blanket green suite
or live availability claim is made.

### Current delivery state, 2026-11-01 08:00 UTC

Runtime PR #18518 merged as `006d5691a6245d5a710e25ba3df6d609754e163a` after
all CI passed and a 5/5 review. The opt-in remains disabled on hosted stacks.
Qualification PR #18526 remains open; Cloud #1096 remains open. No hosted
mutation or paid model test has occurred yet.

Fresh browser receipt `paperclip-runner-e2e-tg3nel` passed all 11 checks:
246 reads, 50 acknowledged/read-back saves, zero failures, 1,058ms browser
reconnect and zero page errors. Both old homes were deleted; C restored saved
files with legacy adoption disabled. Unready B left A serving. The admitted
save and both handoffs now require a graceful exit, not successful forced cleanup.
Cleanup is confirmed. The receipt uses compiled local server/UI and workspace
dependencies at `59e6169af6` plus the smoke's strict-exit patch; it is not a
released-container or live-agent claim.

Qualification exposed an expired/released-lease Stop race: absent a local handle,
a new server could acknowledge a no-op before recovery attached the execution.
Stop now remains pending while an unsettled native execution exists, including
between leases. Three real-PostgreSQL delivery cases pass; the provider edge and
recovery claim are simulated. Server TypeScript compilation and vendoring pass.

The full harness's two report timeouts passed an isolated 42-test file rerun.
Onboarding, workflow-security, Pi and accounting files are unchanged by this
branch versus the inspected master; this is static classification, not a fresh
full baseline run. The qualification PR's CI has one access-service race failure
and is being checked in isolation. All other checks passed on `59e6169af6`.

Cloud now gates overlap on identical, provenance-bound package identities.
Changed or unknown packages use maintenance. Its 376 campaign/compatibility
cases passed; review identified that failed-deploy rollback also needs the same
pause. That correction is in verification. Existing-volume enrollment and the
hosted acceptance sequence remain required work, not deferred scope.


### Current delivery state, 2026-11-01 08:40 UTC

Runtime #18518 is merged at `006d5691a6245d5a710e25ba3df6d609754e163a`;
Cloud #1096 is merged at `23fdc849029e541355fa4e11234a3b5706b01e84`.
Both passed CI and final 5/5 reviews with comments resolved. Core's Docker and
readiness artifacts have published; its release workflow remains in progress.
No explicit hosted enrollment or stack deployment has been performed by this
chat; automatic release pipelines are separate and need deployed-revision checks.

Qualification #18526 at `f2bcb4c73b` passed all CI checks. Three review findings
are fixed in the next commit: explicit mock-call isolation; pending Stop permits
only fenced reattachment of the original remote execution for cleanup; and the
recovery observer advances its event floor after A is confirmed dead while
preserving the original owner/authentication baseline. Six focused executor cases,
three PostgreSQL delivery cases (provider edge simulated), 19 harness cases and
server/E2E typechecks pass. The fixture initially returned a mock from beforeEach,
which Vitest invoked as teardown; the corrected hook returns nothing.

Three live attempts failed before agent creation: missing built Daytona plugin,
missing development TypeScript loader in isolated controller copies, then invalid
provider credentials. The first two harness setup gaps are fixed. The third
Daytona preflight reported cleanup uncertain; the saved key returns 401, and the
staging manager found no sandbox with that exact attempt label. This does not
prove absence in an unknown old-key organization. The OpenAI key independently
returns 401. A user request to refresh the E2E credential is pending; do not
retry a paid attempt until authentication succeeds. No model execution is claimed.
Private receipts are under `/private/tmp/paperclip-zdt-live-evidence`.

A Linux Runner binary built from `0f122611a1` has SHA256
`681f9709f21abcc90f6e87fd1d0b263c158896b8fb3d30df6786d89723ddfdad`;
its source inputs are unchanged at the qualification head. The pinned Daytona
base image and dynamic library checks pass. The next launcher preflights OpenAI,
uses the authenticated staging manager to mint one attempt-specific Daytona key,
and revokes it during cleanup. No attempt key has yet been minted.

Enrollment implementation is isolated in Core
`/private/tmp/paperclip-zdt-enrollment-20261101` and the Cloud worktree, both on
`codex/zero-downtime-enrollment`. Core's dedicated maintenance process is being
verified: ordinary app writers never start; existing owner migrations verify
shared bytes; the original decision key exports only through a per-attempt
credential after full eligibility. Cloud's locked, audited provider transition
must stop all writers, run this process on the retained volume, preserve its key,
then detach only after a matching receipt and confirmed process exit.

Remaining acceptance is unchanged: live Stop/answer/follow-up and continuation,
packaged fresh/migrated overlap, ten staging deployments including rollback,
repair/sleep/wake and idle suspension, then one internal production canary.


### Current delivery state, 2026-11-01 09:15 UTC

Qualification #18526 merged as `16787e4167fa94bd968419cf6e6e9e8ebb2748c4`
with all checks green and a 5/5 review. Cloud enrollment #1098 merged as
`316163b28d4f9e811e810a3226ea46b33a273ce7` after 5/5 review and green CI.
Its review fixes explicitly reopen registry routing on completion and allow
same-attempt final-boot retry without reattaching the retained volume. No hosted
stack has yet been enrolled by this chat.

Core enrollment #18529 is at `6d31d1265d`. Twenty focused checks passed,
including a rebuilt plain-Node executable and real PostgreSQL/S3. Owner checks
now block unresolved local working copies even for terminal runs, drain all
expired trace pages, and expire successful key-export authority at the original
deadline. An integration fixture initially failed cleanup because trace expiry
writes activity rows; cleanup now deletes those before their runs. The corrected
run passed. Initial CI failures were a workspace-runtime health probe and an
extra select in a run-dispatch idle assertion; latest-head CI/review is pending.

An independent two-process question-answer probe exposed a real retry delay:
B releases its claim after A inspects it, leaving the owner waiting 30.157s.
The production pending-answer worker now uses a one-second retry in ephemeral
mode; the same probe delivered one command in 1.197s. Ordinary server cadence
is retained. A committed regression is in preparation: real PostgreSQL and two
processes, with only the provider command sink simulated. It checks no repeated
sweeps/inspections after settlement and reactivation by the next committed answer.
The regression and assembled startup suite passed 122 tests. This does not
prove live provider response or active remote execution survival.

The refreshed E2E OpenAI credential remains outstanding. No subsequent paid
attempt has been made. Remaining acceptance still includes live Stop/answer/
follow-up/continuation, packaged overlap with migrated data and large cold
restoration, ten staging deployments including rollback, repair/sleep/wake and
idle suspension, and one internal production canary forward/rollback.


### 2026-11-01 09:50 UTC qualification update

Merged: Core runtime #18518 (`006d5691a6`), overlap workflow #18526
(`16787e4167`), prompt native-answer delivery #18530 (`73cd8eb9a5`);
Cloud shape #1096 and enrollment #1098 (`316163b28d`). The staging controller
reports `316163b28d` from `/healthz`. Core maintenance #18529 is at
`a4db955403`; all review findings are resolved and its final CI is running.

The released Linux/amd64 image at Core `16787e4167`, digest
`sha256:e383df8503e8bf160646d7ec42c3eb2d94979fb10b7ef4e6bf01a5057571166f`,
passed authenticated private-mode overlap: 130 reads, 26 acknowledged saves,
zero failures, two full predecessor-container/home deletions, the same browser
session cookie, shared-file reads and unready replacement rejection. Every
normal container exited cleanly. Test PostgreSQL and S3 resources were removed.
Receipt: `/private/tmp/paperclip-zdt-container-eVSi2A/evidence.json`.
This is HTTP session and storage proof; it does not qualify browser rendering,
distinct versions or active model execution. Earlier failed fixtures retain
receipts: local-trusted non-loopback bind refusal, loopback auth-origin rewrite,
and incomplete public-origin configuration. They reached no overlap assertions.

A 1,024-file, 64 MiB cold directory exposed sequential restoration timing out
at 30.065s with 25ms added latency per GET. Receipt:
`/private/tmp/paperclip-zdt-cold-cAEX5q/evidence.json`. The file authority owner
now restores with eight bounded streams, cancelling and awaiting every sibling
on failure. The same real PG/S3 experiment passed in 4.180s (1,025 GETs including
instructions), with the entire predecessor home deleted and local adoption
disabled. Receipt: `/private/tmp/paperclip-zdt-cold-C0DRZV/evidence.json`;
tested source patch: `/private/tmp/paperclip-zdt-cold-restore-tested.patch`.
Eight durable-file regressions passed, including corruption, cancellation,
retained previous projection and successful retry. This qualifies the recorded
size and latency; the unchanged upper storage limits are not a performance claim.

The existing staging volume E2E target was selected after browser access and
idle-agent checks. Its active fleet campaign was allowed to finish; the target
was then pinned through the audited user-managed API. Exact private target,
prior version, audit and resulting version are recorded in
`/private/tmp/paperclip-zdt-staging-pin.json`. No volume has been detached or
hosted overlap sequence started by this chat. Deploy and qualify the merged
maintenance image before calling enrollment; the enrollment/campaign owners
must continue to hold their normal operation leases.

The local paid-run gate is still the saved E2E OpenAI credential returning 401.
The credential file has not changed since August; a refresh request is pending.
No paid model ran and no attempt-specific Daytona credential was minted through
the new launcher. Existing live failure/cleanup receipts remain unchanged.
Still required: active execution and continuation, cross-process follow-up,
migrated packaged overlap, ten staging replacements including rollback, browser
and sleep/wake/idle verification there, and one internal production canary.

### 2026-11-01 10:12 UTC hosted qualification preparation

Core maintenance #18529 merged as `d941ed3879`; bounded cold restore #18531
merged as `1d348bbef0`. Both passed all current-head CI and Greptile 5/5 with
no unresolved review threads. This checkout now starts from the latter merge.
Published image and Cloud composition qualification are still pending.

The earlier staging target was superseded: its historical local execution
workspaces require their own migration review. It was unpinned at 09:59 UTC
without a volume or deployment mutation by this chat. The superseded browser
fixture auto-assigned an agent despite the composer showing no assignee;
that attempted run failed. The task was then unassigned, paused and hidden.
Do not count this as successful agent execution or assume it incurred no cost.
Private setup and restoration receipts remain under `/private/tmp/paperclip-zdt-`.

A dedicated staging fixture was provisioned through the normal signup API.
Its concrete host and stack identity remain in the private qualification receipt.
It is pinned through the audited user-managed API, and the existing operator
was added through the audited membership API. Normal organization-launcher
entry reached its dashboard. A separate synthetic fixture owner authenticated
through the normal Cloud entry-code/session flow. The tenant serves Core
`16787e4167` in Cloud distribution `cloud-41292158258-1`.

The fixture contains a paused, wake-disabled agent with 34 synthetic files
(524,936 bytes), all read back through the API, and unassigned backlog task
with one saved comment. The data will exercise volume enrollment and
subsequent replacement. Receipt: `/private/tmp/paperclip-zdt-hosted-fixture.json`.
No hosted enrollment or overlap has yet run; the original volume is attached.
This controlled fixture does not qualify arbitrary historic local workspaces.
The saved E2E model credential remains an external blocker for paid-agent proof.

The published Linux/amd64 maintenance image for `d941ed3879`, digest
`sha256:5370ef6c938a639d5994bb20fb85e0a07b9210b264389b2076cc5890f66ea686`,
passed the real-volume migration rehearsal. A legacy container wrote two files
and generated its decision-signing key on its volume. After confirmed shutdown,
the packaged maintenance entry migrated the files, verified shared objects and
exported that exact original key; unauthenticated status was denied and ordinary
app routes were absent. Both predecessor containers and the entire volume were
then deleted. A new empty-home container retained the original session and read
the migrated files. Two further replacements served 111 reads and 23 saves with
zero failures; unready replacement refusal and clean exits passed. Owned test
resources were removed. Receipt: `/private/tmp/paperclip-zdt-container-7r1Nwv/evidence.json`.
This small-file Core image rehearsal complements the multi-page migration tests;
it does not qualify Cloud routing, large cold folders or active agents.

### 2026-11-01 10:29 UTC packaged Cloud proof

The exact Cloud composition `cloud-41296664811-1`, Core `d941ed3879`,
digest `sha256:bce104e05623bd365740013c8fbb87680da7e152f9c94bd099884a9a5f6367cc`,
passed the same real-volume maintenance, key preservation, full volume removal
and empty-home replacement rehearsal: 121 reads, 25 saves, zero failures.
Receipt: `/private/tmp/paperclip-zdt-container-JBK8C7/evidence.json`.
This verifies the private Cloud packaging contains the working maintenance entry;
it does not substitute for Railway routing or active-agent acceptance.

The dedicated hosted fixture passed a ten-second authenticated baseline with
19 reads, three saves, one WebSocket connection and all 34 file hashes intact.
Normal browser entry and an issue-title edit persisted. Receipt:
`/private/tmp/paperclip-zdt-hosted-smoke-s1Q33a/evidence.json`.
The first named-stack deployment was refused before creating a campaign because
an existing fleet campaign still reserved the fixture. That campaign completed
at 10:24:40 UTC and skipped the now-pinned fixture. Its operation lease was not
held; the campaign reservation was the actual conflict. The refused workflow
was explicitly retried, and the named-stack request
is deploying the qualified maintenance composition. No hosted enrollment has
started and no controller allowlist has changed yet.

The named-stack request completed at 10:31 UTC with serving commit verification
for `d941ed3879`. A new continuous deployment campaign then started. The controller
restart guard correctly refuses the allowlist change until that campaign finishes.
The original volume remains attached and the fixture is pinned.

Core `1d348bbef0` published its image, but its post-merge Cloud-source check
timed out after 15 seconds in the new cold-folder regression. All other shards
passed. The unchanged test passed locally against the owned PostgreSQL fixture;
the eight-test file took 10.03 seconds. Native `Buffer.equals` retains complete
byte equality while avoiding generic assertion traversal over 40 large buffers.
After that assertion-only change, all eight tests passed in 5.90 seconds, with
the cold-folder case taking 561 ms. The 15-second test timeout and 30-second
production deadline remain unchanged. The original CI failure is retained at
`/private/tmp/paperclip-zdt-final-source-verification-failed.log`; local before
and after logs are `/private/tmp/paperclip-zdt-buffer-test-{before,after}-pg.log`.
A first local attempt failed before tests because embedded PostgreSQL could not
start; the existing external test database enabled the comparison. The failed
post-merge shard was retried once while the assertion fix proceeds through review.

### 2026-11-01 11:07 UTC package compatibility prerequisite

The post-merge source retry passed. The final Cloud composition for Core
`1d348bbef0` is `cloud-41298718800-1`, digest
`sha256:800cb8578368c63e33bdd048786ec66b3e7a9902f0f221d7fe41ea3c35134020`.
It passed the real-volume migration and empty-home rehearsal with 121 reads,
25 saves and zero failures; receipt:
`/private/tmp/paperclip-zdt-container-drdrQS/evidence.json`.

The forward/rollback manifest comparison exposed a real packaging blocker.
The Agent Computer bundle differed only in its embedded Runner source revision
and source map, despite unchanged Runner inputs, SDKs and dependency lock.
The exact-package gate correctly requires maintenance for those two images.
Do not use them as proof of an app-only overlap pair.

The Cloud source-selection owner now selects the last first-parent Runner input
change when the older reviewed ROM pin differs, then proves complete input
equality. The plugin and ROM builder share that selection and keep temporary
history alive through archive verification. Actual clean checkouts of both
released Core commits select `66e8fab9447aa21350f87ddec79fcd027f3e23ad`.
A real shallow-checkout probe selected the same source in 25.6 seconds without
modifying the caller. The focused suite passed 32 cases; full Cloud tests passed
4,830 cases with 129 gated skips and no failures. Rebuilt package equality and
hosted overlap remain unverified. Private receipts are
`/private/tmp/paperclip-zdt-canonical-source-{proof,shallow-proof}.json`.

Core's assertion fix is in #18533, reviewed at 5/5. One CI shard received a
runner shutdown signal, so that cancelled shard and its downstream aggregate
gate were retried. The original cancellation log remains at
`/private/tmp/paperclip-zdt-buffer-pr-cancelled-job.log`.
No hosted enrollment has occurred. After the controller became quiet, the
qualified maintenance image was added to the staging allowlist without an
automatic deployment. An explicit controller configuration restart was then
submitted with a mutation-confirmed deployment identity. The prior busy-campaign
and pending-default checks produced no mutations. Private receipt:
`/private/tmp/paperclip-zdt-controller-allowlist-RzRa7k/receipt.json`.
The paid-agent credential blocker and all remaining acceptance criteria remain.


### 2026-11-01 11:15 UTC hosted enrollment response correction

Core #18533 merged as `247552fe0719dcc92f7b42c50b658be6f624986d`; Cloud
#1099 merged as `1c5c5133c2d3740fdb716b26c31f038add273b55`. Both latest
heads passed all checks and review at 5/5 with no unresolved findings. Real
ROM-input generation also verified the complete source archive and Linux
dependency lock in 53.1 seconds from a clean checkout.

The staging controller configuration restart succeeded with unchanged source
`316163b28`. The first real enrollment request at 11:08 UTC failed before
provider mutation with `Enrollment requires the owned Railway service domain`.
The registry correctly retains maintenance routing. The original web deployment
and attached volume were not stopped or changed. Railway's scoped domain query
returns the matching service/environment but a null `projectId`. Reproducing
that response in the existing lifecycle test fails identically. The correction
accepts the nullable project field from the project-scoped query while rejecting
explicit project, service or environment mismatches before provider mutation.
The original attempt identity is retained for retry after reviewed deployment.
Private failure receipt: `/private/tmp/paperclip-zdt-enrollment-controller-logs.json`.
No hosted overlap deployment or production canary has passed yet.


### 2026-11-01 11:25 UTC exact release pair qualified

Cloud #1100 merged as `abcb017123013f2baa215fd665b4092495de00a1` after
4,831 local tests, 129 explicit skips, typecheck, golden-path smoke and all
latest-head CI checks passed, with 5/5 review and no unresolved findings. Its
automatic staging controller deployment is starting; enrollment retry waits for
that serving revision. The original held deployment and attached volume were
independently confirmed unchanged after the first failure.

The rebuilt pair now has byte-identical Cloud bundles, SDKs and dependency lock:
`cloud-41300941768-1` (Core `1d348bbef0`) and `cloud-41301234904-1` (Core
`d941ed3879`). Both select the same canonical Runner source. The production
`ephemeralPackageOverlap` function accepts this pair. There is no database diff
between the two Core commits. Exact manifest receipt:
`/private/tmp/paperclip-zdt-canonical-pair-proof.json`.

Each exact image passed its own packaged migration, complete predecessor-volume
deletion and two empty-home replacements against real PostgreSQL and S3: 118
reads/24 saves and 116 reads/24 saves respectively, no failures, all owned
resources cleaned. Receipts: `/private/tmp/paperclip-zdt-container-woB7ci/evidence.json`
and `/private/tmp/paperclip-zdt-container-tMUSnD/evidence.json`. Both images were
added to the staging allowlist with deployment skipped, under the normal quiet
guards, before the reviewed controller rollout. The repeated hosted experiment
will invoke the existing fleet workflow driver with exact release references and
a single pinned fixture; it retains campaign/release/serving verification while
avoiding repeated GitHub scheduler waits. No hosted success is inferred from
these local receipts. Active-agent credentials remain blocked as previously noted.


### 2026-11-01 11:34 UTC maintenance entrypoint qualification

The corrected controller is serving `abcb017123013f2baa215fd665b4092495de00a1`.
The first prepare reached the durable `preparing` phase and stopped the old
deployment, but Railway's remove call timed out. A read-only provider check
confirmed removal and retention of the attached volume, then the same attempt
resumed successfully to `migrating`. Its healthy maintenance process reported
`blocked` during configuration; no detach was attempted.

Railway's start-command override replaces ENTRYPOINT, whereas the original local
Docker rehearsal replaced only CMD. The maintenance process therefore ran as root
and refused the original UID-1000-owned signing key. An explicit local entrypoint
override reproduced the same blocked status and captured root process identity
and key ownership, without reading key contents into evidence. Failed receipt:
`/private/tmp/paperclip-zdt-container-5nGSUs/evidence.json`.

Cloud #1101 preserves Core's init and entrypoint wrapper in the maintenance
command. With actual entrypoint replacement, the corrected packaged rehearsal
passed original-key preservation, volume deletion and later empty-home recovery:
116 reads, 24 saves, no failures, cleanup confirmed in
`/private/tmp/paperclip-zdt-container-POFr0C/evidence.json`. Twelve lifecycle tests,
root typecheck, the full 4,831-pass suite and ordinary golden-path smoke passed.
The PR is awaiting CI/review; hosted preparation will resume with the same
attempt after deployment. The original live volume remains attached and retained.
No hosted overlap or active-agent acceptance has passed.

### 2026-11-01 11:48 UTC reviewed entrypoint fix

Cloud #1101 merged as `76f2dedf076ed139af3a7136e988c6748589d50b` with
all latest-head checks passing and no unresolved review findings. The exact image
currently held in staging also passed the corrected Railway-entrypoint rehearsal:
118 reads, 24 saves, zero failures, original signing authority retained, predecessor
volume deleted and all owned test resources cleaned. Private receipt:
`/private/tmp/paperclip-zdt-container-vyIrsD/evidence.json`.

Automatic staging controller workflow `41302710585` passed preflight and is
waiting for the ordinary controller coordination gate. The concurrent app campaign
has completed 16 of 17 targets with one still running; the pinned qualification
fixture is excluded. No cancellation or coordination bypass is permitted. The
serving controller remains `abcb017123013f2baa215fd665b4092495de00a1`.
Enrollment must resume with its original attempt identity after the new controller
is serving. The active-model credential remains unavailable; no paid-agent result
or hosted overlap acceptance is inferred from the local container proofs.


### 2026-11-01 12:34 UTC live enrollment and runtime admission findings

Cloud #1101 reached staging at 12:05 UTC. The owning enrollment attempt completed
migration and authenticated eligibility: 34 agent objects, 12 skill versions,
zero blockers. The original signing key was stored before the volume detached.
The original volume remains retained. Final app boot failed because Railway left
the maintenance start command unchanged when the provider sent null.

The same attempt exposed delayed detach reads, automatic maintenance deployment
after detach, and successful deployment stops whose API responses timed out.
Cloud #1102 handles those provider transitions with bounded ownership-checked
reconciliation, an empty-string start-command reset, and app reconfiguration on
same-attempt boot retry. Root typecheck, 4,835 tests (129 gated skips), ordinary
routing/sleep smoke and 352 focused provider tests passed. Review/deployment is
pending. Tenant routing remains in maintenance; no ten-roll acceptance is claimed.

The user supplied a working credential location; the OpenAI authentication gate
is resolved without exposing the key. Two live attempts exposed premature runtime
admission: fresh run rows still say legacy while workspace preparation runs,
before the native runtime selector commits its decision. Workspace preparation
must validate storage authority; runtime selection must validate the resolved
native warm lifecycle. Two focused regressions failed before this source fix;
all 156 workspace/runtime/ephemeral-contract tests passed after it. Full typecheck
and build passed; the full test suite and rebuilt live cell are running.

A third live attempt mistakenly used the old compiled server and reproduced the
old guard. That retained failure is not evidence against the source fix. The
launcher now records the compiled server hash and rejects that stale guard.
All three completed attempts revoked their owned Daytona credentials and deleted
their disposable object buckets. No paid-agent acceptance has passed yet.


### 2026-11-01 12:43 UTC recovery fix merged and live cleanup boundary

Cloud #1102 merged as `461c4aea28a1ffc31b1175db42158338dd9de1ae` after
4,853 passing tests (129 gated skips), typecheck, routing/sleep smoke, latest-head
required CI and 5/5 review with no unresolved threads. The optional security
scanner was inconclusive because its sandbox could not start; a rerun request
returned 404. Automatic staging deployment is workflow `41307729362`.

The rebuilt live cell completed two native Codex/Daytona runs. Its first web
replacement then failed while deleting an immutable skill-cache directory in the
stopped predecessor home. The attempt remains failed, with partial estimated LLM
cost $0.1072965 and incomplete usage coverage. The shared harness cleanup now
makes stopped owned directories removable without following symlinks; seven
focused regressions and the E2E typecheck pass. No receipt is accepted without
whole-home deletion. Its leaked remote fixture is being reconciled through exact
company/environment labels and recorded lease IDs; the first delete was refused
while the sandbox was stopping. Original attempt evidence is retained.

Required broad checks exposed separate failures: `pnpm test:run` stopped at a
15-second chat integration timeout (338 passed); that exact test passed in
isolation without changing its limit. Product E2E unit checks reported 5,898
passes and 13 failures in untouched onboarding expectations, operating receipts,
Pi catalog assertions, workflow security assertions and embedded PostgreSQL
startup. These are not counted as passes; baseline attribution is pending.
Workspace typecheck/build and all 156 affected Core tests remain passing.
