# Sidebar and Apps startup performance

Outcome: one tested, reviewable PR and an isolated local preview. Preserve
sidebar accuracy, account isolation, loading layout and recovery. No merge or
staging deployment. PR: https://github.com/paperclipai/paperclip/pull/16851

## Implementation

- The five-ID summary route applies existing company/task authorization, omits
  unavailable IDs and uses a dedicated projection with no detail/workspace
  enrichment. The bound applies before deduplication. Responses are private/no-store.
- Recent history uses one account-scoped query. Successful omissions apply only
  to the requested IDs. Revisiting a cached omission requires a fresh response;
  fetch completion remains observable when React Query shares the data object.
  Full-detail cache updates require positive access confirmation and never
  activate detail queries. Failures preserve snapshots and query errors.
- Access checks overlap shell settings; the protected subtree waits for both.
  Only the first healthy socket opening exempts exact session/health keys.
  Domain catch-up and recovery remain active. Queued/status lifecycle events and
  pause/restart refresh summaries; progress/run-log events do not. Inbox archive
  preserves recent history.

Initial checkout: clean at `0ed760ce9a`. Branch:
`codex/sidebar-apps-startup-performance`. Route-splitting PR
[#16849](https://github.com/paperclipai/paperclip/pull/16849) landed during this
work. The branch was rebased onto `9179d8dcc3`; the primary comparison includes
that same route splitting on both sides. Tested application source:
`085f7a6f1e2cac82be323ab099820767597936eb`. This includes strict rejection of mixed
scalar/array or nested query syntax under Express's simple parser. Later edits
only update the evidence; earlier trials remain in the sample record.

## Evidence

The [sample record](2026-10-19-sidebar-apps-startup-evidence.json) contains every
primary sample, endpoint counts, prior trials, source revisions, environment and
browser-journey assertions. Earlier noisy trials remain visible.

Primary comparison: production UI at `9179d8dcc3` versus `085f7a6f1e`, sharing
the same final API and persistent synthetic fixture. The full-detail handler is
unchanged. Five cold and five in-app samples per revision alternate in the same
Chromium build. Profile: 1440x1000, 50ms latency, 9Mbps down, 1.5Mbps up, 4x CPU;
service workers blocked. Cold contexts disable browser cache. In-app timing
starts after dashboard recent-task refresh and two seconds of settling.
Usability requires the existing connector list and search controls; no
`networkidle` wait is used. Own builds/tests finished before this comparison.

| Median | Baseline | Candidate |
| --- | ---: | ---: |
| Cold Apps usable | 3748ms | 3668ms |
| In-app Apps usable | 1019ms | 783ms |
| Sidebar refresh complete after navigation | 3157ms | 3170ms |
| Recent-task request span | 246ms | 244ms |
| Recent-task requests, cold | 5 full details | 1 summary; 0 details |
| Recent-task decoded body bytes | 45,442 | 1,160 |
| Recent-task encoded body bytes | 5,715 | 372 |
| All API requests, cold | 35 | 31 |
| Cold long-task time | 1942ms | 1923ms |
| Cold scripting time | 2.120s | 2.025s |
| In-app long-task time | 546ms | 479ms |
| In-app scripting time | 0.677s | 0.620s |

Encoded bytes fell 93.5%; decoded bytes fell 97.4%. The request span is essentially
unchanged (246ms to 244ms), so no meaningful local API latency gain is claimed.
Cold readiness fell 79ms (2.1%); in-app readiness fell 236ms (23.2%) in this run.
Earlier aligned trials had both positive and negative readiness changes; all
samples remain visible. The reliable result is smaller task refreshes, not an
established overall Apps speedup. Final response timestamps are captured before
body/size evidence extraction. Earlier trials included that collection overhead
in response timings and are preliminary.
Warm navigation reuses fresh sidebar
data without a refresh. Each candidate cold load made one session and one
health request. Focused socket tests also prove the initial exemption/recovery.

The final unthrottled smoke completed its first summary before the socket opened,
then made the required domain catch-up batch. It recorded two summary requests,
zero passive details, and one session/health request each. The timing trace is
in `finalSmoke` in the sample record. Each refresh uses one batch; removing this
second refresh would break the required fetch-to-subscription reconciliation.

The real browser journey passed: five recent tasks; connector search and
permissions; task navigation and return; rename; inbox archive; pause/restart of
an unassigned disposable task; reload persistence; delayed summary responses.
Sidebar-row and connector-list rectangles were identical before/after releasing
held responses. No agent run was started.

## Verification and limits

- Passed after rebase: 85 focused UI/access/layout tests, 14 embedded PostgreSQL
  summary-route tests, 23 OpenAPI tests, full typecheck/build, token gates, maps
  and diff checks.
- Earlier `pnpm test:run` reported five failures in the existing 1347-case chat
  integration file; four reached 15-second timeouts. All ten matched cases passed
  on an unchanged isolated rerun. The already-failed broad run was then stopped.
  A complete green local `pnpm test:run` is **not** claimed. Latest-head CI status
  belongs in the PR handoff; focused passes do not replace it.
- Review regressions cover cached revisits, repeated omissions, in-app scripting
  scope and preparing both paired-build asset sets. Review/check status is on the PR.
- The asset preparer canonicalizes paths and skips copying onto itself. A real
  filesystem probe reproduced `ERR_FS_CP_EINVAL` without the guard, then executed
  the actual preparation block with `ui/dist` as candidate/server. It preserved
  candidate files and prepared the complete baseline asset union.
- Setup failures are retained in local logs: an initial build had concurrent
  writers; a compiled workspace server needs the TS loader for source exports;
  an archived UI needs tracked announcement assets. Successful builds use one
  writer per output directory. A browser observation URL typo was corrected
  before the complete passing journey.
- Both builds show the existing local implicit-board Assistant Connection status
  error. Connector search/navigation and the synthetic connector remain usable.
- This is local verification, not a staging deployment or proof of historical
  staging latency. Disk cleanup, workspace caching, route-splitting ownership,
  dependencies, migrations and telemetry remain outside this PR. Merging was
  excluded from the original handoff; the user later authorized a merge after
  the PR checks pass. Staging deployment remains excluded.

## PR check repair

At `453d488398`, every CI lane passed except serialized server shard 7/9.
The [failed job](https://github.com/paperclipai/paperclip/actions/runs/39285071851/job/118169386829)
reported one failure among 176 tests: the compact issue-list cache capacity test
expected 256 entries and found 238. Its 261 HTTP requests took 5,631 ms, crossing
the cache's 5,000 ms expiry. The production cache correctly prunes expired rows.
The capacity assertion therefore depended on runner speed.

The test now holds `Date.now()` fixed while it fills and checks the cache, then
restores the clock in `finally`. Real HTTP, database operations and timers still
run. This isolates capacity eviction from expiry without changing production
behavior. The earlier CI failure remains recorded here; a successful rerun does
not erase it.

The focused local rerun passed all 29 tests across the issue-list assignee/filter
and summary-route suites with real embedded PostgreSQL. `git diff --check` passed.
The next remote CI run qualifies this test-only repair; the application build
and browser measurements above remain unchanged.

## Preview and reproduction

Running preview: http://127.0.0.1:3214/APP/apps

The final production UI and compiled server use the PR head, with the TS loader
for workspace dependency exports. The performance comparison used `085f7a6f1e`.
The final preview also includes the strict query guard. Configuration/evidence:
`/tmp/paperclip-apps-perf-20261019/`; disposable database port 55489. Fixture:
one synthetic company, five tasks, a disabled draft connector and a paused agent
with heartbeat disabled. Only this task's own preview/test processes were stopped.
Native PostgreSQL package symlinks were restored with its install hook.

Archive `ui/` and `announcements/` at the baseline revision, link the same installed
dependencies, and build from that UI directory with `PAPERCLIP_BUILD_COMMIT` set
to its full SHA. Save the two production builds in separate directories, then run:

```sh
PAPERCLIP_APPS_BENCH_BASELINE_DIST=/path/to/baseline-dist \
PAPERCLIP_APPS_BENCH_CANDIDATE_DIST=/path/to/candidate-dist \
PAPERCLIP_APPS_BENCH_SERVER_DIST=/path/to/server-checkout/ui/dist \
node scripts/benchmark-apps-startup.mjs comparison http://127.0.0.1:3214/ /tmp/apps-comparison
```

The harness rejects non-loopback targets, creates/reuses synthetic fixtures,
prepares both hashed asset sets in the static server directory, swaps only the
production HTML document and measures real asset/API traffic. It writes JSON
and screenshots. Do not run a build that clears server assets during it.
