# Zero-downtime web deployments

Date: 2026-10-31. Status: implementation in progress; local HTTP/storage overlap,
failure recovery and graceful drain passed. Cloud shape implementation underway.

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
| Prior prerequisites | #18403 now merged; current source fetched | Characterize remaining local authority paths |
| Core implementation | `/private/tmp/paperclip-zero-downtime-20261031`, durable files, readiness/drain and migration/cleanup implemented in draft PR #18518 | Cross-process commands, browser/assets, active Runner qualification |
| Cloud implementation | `/private/tmp/paperclip-cloud-zero-downtime-20261031`, persisted ephemeral shape and image/variable gates implemented in draft PR #1096 | Complete lifecycle guards, test and deploy qualification |
| Staging / production | Not selected or deployed | Record exact target, owner, artifact and campaign before action |

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
The existing shared `canary-staging` stack is `stack-pool-8fabb27531db77af`.
Do not assume it is exclusively owned: select a dedicated zero-downtime test
stack or acquire the existing stack operation lock before any hosted mutation.
No hosted mutation or paid model call has occurred for this task yet.

Remaining: live overlap proof; released artifacts; migration/enrollment and
compatible rollback; ten staging deployments; internal production canary.
