# Next bottleneck batch

## Scope and observation

Find the next bounded batch after the three merged slow-query fixes. This is a
diagnosis pass: rank fresh costs, identify actual callers and existing work,
and define the smallest performance and correctness experiments. No application
code, schema, hosted configuration or deployment changes are part of this pass.

The reported workspace's Cloud, Neon database/runtime role, and Railway
deployment were revalidated from the live registry. The staging app served
`8548173fc9efdc0fa07644fb92dcc0b6851a95e5` throughout the query window. Upstream
`master` was refreshed to `50b932a142216331b8d476042b454bc123739c40`. Private
resource mapping, normalized SQL and raw logs remain outside Git.

After that stable measurement window, the final serving check at 18:49:08 UTC
observed revision `6e781e0ab20cdaeb6570cebdb5f14dbb8557ba04`.
The grants route/policy/authorization paths, wake-notice owner and skills
route/service are byte-identical between that source and the measured source.
The counts below describe the earlier window, not a post-rollout measurement.
Re-baseline the assembled application before accepting a later performance fix.

The fresh query window is 2026-10-27 **18:32:51.270–18:38:07.464 UTC**, or
316.194 seconds. Both snapshots read every statement for the exact application
database OID and runtime-role OID through the existing monitoring view, using
bounded read-only transactions. There is no top-100 or query-family filter.

- Statistics reset stayed at 14:21:16.446 UTC; eviction count stayed zero.
- There were 4,573 starting and 4,590 ending entries, with no missing entries or
  invalid matched counters. Entry-level epochs were checked.
- The 1,147 matched entries with positive call deltas account for 121,299 calls
  and 596.418 seconds of summed SQL execution time. They are all top-level
  entries, so this total does not add nested statement timings.
- Seventeen new entries contribute 25 calls and 75.941 ms as separate lower
  bounds. They are excluded from the matched ranking.
- I/O timing is disabled. Zero timing fields do not establish zero I/O latency.
  Point-in-time wait samples cannot establish sustained pressure or its absence.
- The probe comparator passed eight controlled cases, including global/entry
  resets, decreasing counters, missing/new entries, evictions and scope changes.
  An initial diagnostic assertion about a pooler's default read-only setting
  was rejected before capture; the successful probe checks the actual transaction.

The matched HTTP read contains 997 completed log records from the same deployment
and exact time window, below its 2,000-record cap. One WebSocket connection is
excluded from ordinary request latency. The remaining 996 include 603 HTTP 304
responses and one HTTP 500 from issue summaries; this is an observed traffic
sample, not a clean acceptance run. Duration units follow
[Railway's log contract](https://docs.railway.com/observability/logs).

SQL execution time can overlap across requests and background workers. Its sum
is neither elapsed time nor endpoint latency. Honeycomb queries using the
verified host, forwarded host and stack fields found no matching request spans
in the checked dataset/window; the SQL share of these HTTP requests is unproved.

## Fresh rankings

| SQL caller | Calls | Mean SQL time | Total SQL time | Returned/affected rows | Disposition |
| --- | ---: | ---: | ---: | ---: | --- |
| Chat lifecycle milestone candidates | 167 | 1,497.65 ms | 250.108 s | 0 | Exact caller overlaps open draft #17606 |
| Terminal workspace last activity | 245 | 591.64 ms | 144.951 s | 245 | No qualified open fix for these reads found |
| Inbound wake-notice candidates | 647 | 48.99 ms | 31.694 s | 0 | Exact duty overlaps open draft #17647 |
| GitHub stale-review repair UPDATE | 12 | 1,658.12 ms | 19.897 s | 0 | Exact duty overlaps open draft #17664 |
| GitHub review source-run fallback | 82 | 230.25 ms | 18.880 s | 1 | Distinct query in GitHub maintenance owner |
| GitHub stopped-response recovery | 12 | 1,340.53 ms | 16.086 s | 120 | Exact duty overlaps open draft #17661 |

The first two families still account for **66.24%** of matched SQL time after
the earlier query improvements. Their existing optimized SQL shapes are active.
The historical pre-fix fingerprints had no new calls in this window.

Guarded membership upserts used **41.660 ms across 84 calls**. The advisory-lock
statement with a large historical maximum used **0.950 ms across 174 calls**.
Neither historical cumulative total belongs on the new bottleneck shortlist.

| Ordinary HTTP route | Requests | Mean | Sample p95 | Maximum | Relevant result |
| --- | ---: | ---: | ---: | ---: | --- |
| GET connection grants | 2 | 61.447 s | 66.388 s | 66.388 s | Both 200; minimum 56.506 s; very small sample |
| GET company skills | 20 | 2.733 s | 6.015 s | 13.945 s | All 304 |
| GET company issues | 135 | 1.079 s | 2.957 s | 9.671 s | 112 returned 304 |
| GET sidebar badges | 197 | 482 ms | 1.440 s | 5.851 s | All 304 |
| GET run events | 203 | 346 ms | 1.063 s | 4.273 s | 137 returned 304 |

Percentiles use nearest rank within the observed sample. Upstream request
duration is almost identical to total duration for these routes. That locates
the observed delay behind the edge, but does not distinguish application CPU,
database round trips, pool wait or other dependencies.

## Recommended next work

### 1. Connection-grants capability fan-out

This is the largest newly observed individual request delay. The route is
`server/src/routes/tool-access.ts:1754`. Listing grants itself uses batched
database reads. The route also describes connection capabilities by inspecting
every company agent. Each inspection asks the connection-management policy for
a capability; its default mutation-authority calculation expands existing
company-wide installations to their agents and checks each target serially.
This creates quadratic authorization fan-out in the reproduced service path. No provider HTTP call
was found in this listing path. The relevant route and policy paths are
unchanged between the measured source, later serving source and refreshed
upstream master. The per-agent helper is `tool-access.ts:665–692`; the repeated
install expansion and target checks are `connection-management.ts:143–158` and
`:225–249`. It deliberately checks retained installed targets as well as the
candidate target.

The fresh SQL window contains thousands of individually fast membership,
project, issue and run-authority reads. Their counts alone do not attribute them
to these two requests. A scratch local reproduction called the real exported
`connectionManagementService.capability` → `authorize` → authorization service
with a synthetic database transport and an implicit local board actor. Four
agents caused 16 real target probes / 28 transport queries; eight agents caused
64 probes / 88 queries. The outer iteration follows the private route helper's
source; the helper itself was not exported or executed by the harness. This
proves the policy amplification through real code (blast-radius evidence level
4), not its share of the observed hosted request latency or a faster treatment.
The Cloud connection-creator case also reproduced 16 → 64 target probes, with
60 → 216 transport queries and 32 → 128 membership reads. A missing installed
target negative case denied all capabilities. These are synthetic transport
counts through real policy code, not real PostgreSQL or HTTP measurements.
Next measure the assembled route with representative installed scopes and
controlled database round-trip latency. The fix should make capability description share equivalent
request-local facts while retaining each target's authorization decision.

**Safety fact to prove:** any reused authority fact belongs to the same actor,
company, connection and request; a denied or absent target cannot inherit an
allowed sibling's capability. Cover board, user and agent callers, personal and
company installations, project/resource restrictions, removed grants, missing
agents and mixed allowed/denied targets. Preserve current membership/revocation
reads between requests. Do not make a one-minute route appear fast by skipping
its checks. Do not bypass installed-target checks by passing `mutation:false` or
`readOnly:true`; a missing installed target currently denies every candidate.

### 2. Qualify existing inbound wake-notice work

The measured query is owned by
`server/src/services/chat-channels/inbound/wakeup-notices.ts`, in
`createInboundWakeNotices.enqueueInboundWakeupPublications`. This selects
historical notice eligibility; it is not the execution-admission gate. It ran
647 times at approximately 2.05 calls per second and returned no rows. Its
31.694 seconds of SQL time included 12,973,945 shared-buffer hits and no
shared-block reads or temporary blocks in this window. The deployed and current
upstream query paths are identical.

Direct overlap is confirmed in
[#17647](https://github.com/paperclipai/paperclip/pull/17647), draft head
`ca8f2d17c64fc7cecff4526817d1ac6e1d479ff4`. It changes this exact selector and
removes its normal publication-maintenance call. Its coordinator reconstructs
durable scopes at startup, retains cursors, and consumes committed-change
notifications. Explicit/manual publication drains still call the selector, so
eliminating all 647 observed calls is not established. The PR is stacked on
`codex/sleep-cancel-contention` rather than master. Advance and qualify this
existing work, its dependencies and remaining callers before creating a
competing implementation. This pass did not run its tests or qualify its CI.

For remaining query work, capture the actual SQL and parameters from this service and
reproduce long retained action/publication/comment history with no pending
notice, followed by a single real eligible notice. Compare plans and all output
columns before deciding whether to narrow the query or wake it from concrete
committed obligations. A quiet path must still reconstruct unresolved work at
startup and recover missed notifications.

**Safety fact to prove:** a narrower candidate path still finds every notice
authorized by the original action/publication relationship, with unchanged
company scope and deduplication. Cover legacy/native lineage, malformed or
missing context, delayed commits, resolved/expired actions, failed publication,
duplicate delivery and drain/resume. Removing the recurring call requires proof
for every producer and restart/recovery path, not only an empty-queue test.

### 3. Skills-list reconciliation and repeated resolution

`server/src/routes/company-skills.ts:467` calls the service list at
`server/src/services/company-skills.ts:3269`. Every request first awaits
`ensureSkillInventoryCurrent` at line 3235: bundled imports, bundled-release
verification, folder reconciliation and local-source inspection. The shared
promise coalesces concurrent work but is removed when it finishes, so a later
request repeats the refresh. A GET can therefore perform filesystem and
database reconciliation before listing any skills.

The list then resolves every agent's desired skills again for each displayed
skill (`company-skills.ts:3351`). Reference resolution performs searches over
the skill list at line 2152. This is a concrete repeated-work lead, but its share
of the measured 2.733-second HTTP mean remains unproved. These service/route
files are identical in the deployed source, local integration and current
upstream master.

First profile the real service with representative skill and agent counts,
separating inventory refresh, database reads, desired-skill resolution and
serialization. Compute each agent's desired-key set once per request as the
first small candidate, comparing complete results. Treat any longer-lived
inventory cache as a separate change requiring freshness proof.

**Safety fact to prove:** each agent contributes at most once to each selected
skill, with identical exact-ID/key/slug resolution and ambiguous/missing alias
handling. Preserve visibility, folder/subtree/search filtering, sort order,
last-editor results and changed local-source discovery. A cached authorized
inventory cannot be reused for another principal's visibility.

## Existing work and deferred candidates

- [#17606](https://github.com/paperclipai/paperclip/pull/17606) owns the exact chat
  lifecycle milestone path. Its draft branch moves lifecycle work to committed
  changes and reconstructs pending work. Audit its producer/recovery proof and
  drive its checks before starting a competing polling rewrite. Its draft
  status and source design are not proof that it is safe or merge-ready.
- [#17664](https://github.com/paperclipai/paperclip/pull/17664) and
  [#17661](https://github.com/paperclipai/paperclip/pull/17661) overlap the two
  measured GitHub maintenance duties. The source-run fallback is a distinct
  delivery/link/run lookup in `chat-github-checks.ts:181–202`, used when the
  review lacks a resolvable run. It still merits a local plan/equality experiment,
  coordinated with those owner changes. A previous scalar delivery lookup fix
  in #17669 is already deployed and must not be proposed again.
- Workspace activity is called at
  `server/src/services/execution-workspaces.ts:3576` through the shared terminal
  workspace worker, already migrated by #16282. Its query is at
  `server/src/services/git-workspace-expiration.ts:153–160`.
  [#17505](https://github.com/paperclipai/paperclip/pull/17505) adjusts cursor and
  retry deadlines but leaves this query/call intact. A second pass could batch
  repeated activity reads; fresh destructive eligibility, live leases and
  concurrent reopen checks must remain authoritative. No qualified open fix
  reducing these activity reads was found in the scoped check.
- [#17896](https://github.com/paperclipai/paperclip/pull/17896),
  [#17894](https://github.com/paperclipai/paperclip/pull/17894), and
  [#17893](https://github.com/paperclipai/paperclip/pull/17893) are already merged
  after the measured deployment. They narrow explicit-continuation run reads,
  avoid duplicate GitHub webhook body transfer and narrow review-wait JSON.
  The final 18:49:08 serving source contains all three. Evaluate their impact in
  a new post-rollout window before duplicating those changes.
- [#17907](https://github.com/paperclipai/paperclip/pull/17907) keeps the skill
  cache lock alive during slow preparation. Its documented scope does not
  explain why preparation is slow or remove the skills-list work above.

The prior Slack continuation's 353.059-second delay is confirmed by an exact
deployed-version `heartbeat.queue` span without children. Executor startup begins
after that wait. A periodic recovery chain stayed in flight for at least
240.086 seconds and suppressed eight ticks, but an earlier recovery pass reached
its post-resume stage while the continuation was still queued. Source cleanup
had completed before the answer arrived. This narrows the failure to queue /
admission or recovery scheduling; it does not establish the blocking gate, a
lost wake, or SQL as the cause. Instrument gate decisions and recovery stages
before choosing a repair. No task was replayed or re-woken for diagnosis.

## Finish conditions for the next implementation batch

Take at most the three priorities above, advancing existing work where it
overlaps. Pin the deployed baseline, prove
the suspected cost with the real caller, define the performance criterion, then
compare complete behavior and adversarial authority/recovery cases. Keep
independent changes in independent PRs with green final-head checks. No migration
or boot script is justified by this discovery pass. Repeat hosted acceptance and
a fresh comparable counter/request window after an authorized rollout.

The private evidence set retains all raw inputs, comparator validation, exact
source inventories, request summaries and query snapshots. This document is the
sanitized discovery handoff. Correctness of proposed optimizations is unproved
until their real-code comparisons and regressions run.
