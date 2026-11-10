# Tasks and Inbox cold-open checks

Run against a disposable local instance with production UI assets. The suite
creates 220 unassigned backlog tasks and 110 board approvals. It does not invoke
a model. The origin must be a loopback address.

```sh
pnpm --filter @paperclipai/ui build
PAPERCLIP_COLLECTION_PERF_BASE_URL=http://127.0.0.1:3219 \
  pnpm exec playwright test --config tests/perf/collections/playwright.config.ts
```

Start the isolated instance with `PAPERCLIP_UI_DEV_MIDDLEWARE=false` to serve the
production build. The instance and its database must be disposable. These tests
retain and reuse their fixture in `test-results/collections/fixture.json`; they
only replace it when the previous company's API returns 404. Other errors fail.

The journeys check desktop and phone row budgets, incremental scrolling,
retained row identity and height, shared count-only navigation, the Coordinator
Inbox with Streamlined UI disabled, and the page-owned Needs You feed and Needs
attention task index. Screenshots and failure traces stay in `test-results`.
Request counts and row budgets are acceptance checks. They do not establish an
end-to-end latency improvement. Measure cold, warm, and Back timings separately
with the same fixture, assets, cache, viewport, and CPU/network settings.

`parent-context.spec.ts` holds the complete Mine response, including parent
metadata, then checks row geometry through deferred visible diagnostics. Mine
uses one assembled source read; it does not fetch parent or failed-task context
from the browser before reveal. Recent retains its separate index/context path.
`startup-regressions.spec.ts` covers session bootstrap and legacy fallback,
partial source errors, resolved failure context, scoped 429 recovery, and
archive/Undo persistence. Its authenticated session and failed-run responses are
simulated transport fixtures over a real local board. They do not prove hosted
login or model execution.
The embedded bootstrap case holds separate company/access responses until Mine
rows appear. Initial WebSocket reconciliation may request those endpoints in the
background; their responses must not block the first rows. Missing or mismatched
bootstrap data still requires the ordinary fallback reads.
The two 429 cases keep the existing automatic backoff and `Retry-After` policy.
They allow 45 seconds for its bounded retry window before exercising manual
Retry. Other cases keep the normal short assertion timeout. Timing samples do
not accelerate the browser clock.

`mine-workspaces.spec.ts` guards Mine against waiting on a company-wide
execution-workspace list. Its fixture (`workspace-fixture.ts`) adds a company
with 6,000 execution workspaces, 4,000 of them created for finished tasks, and
12 Mine tasks that each run in their own isolated workspace. The API cannot
create execution workspaces, so this fixture writes those rows to the instance
database. Set `PAPERCLIP_CONFIG` to the disposable instance's `config.json`
(embedded PostgreSQL), or `PAPERCLIP_COLLECTION_PERF_DATABASE_URL` to its
loopback database. The fixture is retained in
`test-results/collections/workspace-fixture.json` with the same 404 rule as the
main fixture. The spec routes isolated workspaces on for its own pages. It
checks that Mine requests only `ids`-filtered workspace summaries for the
workspaces its rows reference, that rows appear while those reads are held when
neither the Workspace column nor workspace grouping is active, and that the
Workspace column still shows each row's workspace name. Its timing case turns on
the real isolated-workspaces setting, restores it, and records cold time from
navigation start to the first Mine row (two frames after mount) over
`PAPERCLIP_COLLECTION_PERF_TIMING_RUNS` runs (default and minimum 5). It records
a native scenario without request interception and a separate diagnostic scenario that delays
workspace reads by 3 seconds. The timings are attached evidence, not budgets.

Run these focused browser checks before the full collection suite:

```sh
PAPERCLIP_COLLECTION_PERF_BASE_URL=http://127.0.0.1:<candidate-ui-port> \
  pnpm exec playwright test --config tests/perf/collections/playwright.config.ts \
  parent-context.spec.ts startup-regressions.spec.ts
```

To collect timings, build the pinned baseline production assets once and retain
that output. Build candidate UI assets only when their inputs change. Serve both
outputs from stable loopback origins. If server behavior changes, each origin
must proxy its matching pinned API revision against the same disposable database.
Using the candidate API for both arms proves only a UI comparison. Keep agents
and external providers inactive. Neither arm may migrate or reseed the shared
fixture during a comparison.

The harness checks the configured API against each UI proxy, records HTML and
entry-asset SHA-256 receipts, and records both serving API revisions. Supply full
source SHAs to label the client artifacts, then run:

```sh
INBOX_BASELINE_URL=http://127.0.0.1:<baseline-port> \
INBOX_CANDIDATE_URL=http://127.0.0.1:<candidate-port> \
INBOX_BASELINE_API_URL=http://127.0.0.1:<baseline-api-port> \
INBOX_CANDIDATE_API_URL=http://127.0.0.1:<candidate-api-port> \
INBOX_BASELINE_SOURCE_REVISION=<full-baseline-sha> \
INBOX_CANDIDATE_SOURCE_REVISION=<full-candidate-sha> \
  node --import ./server/node_modules/tsx/dist/loader.mjs \
  tests/perf/collections/measure-mine-context.ts
```

The script retains a four-parent, 30-child fixture, archives three completed
parents, and enables the personal Coordinator preference. Both APIs must expose
that same company. It runs five alternating pairs by default. `INBOX_PAIRS`,
`INBOX_FIXTURE_FILE`, and `INBOX_OUTPUT` override the count and evidence paths.
No request interception is used in timings.
`INBOX_NETWORK_LATENCY_MS` accepts an integer from 0 to 2000 and defaults to 0
(native loopback). A nonzero value uses Chromium CDP network emulation on every
page, with unlimited throughput and unchanged CPU. Record native and 100 ms
latency runs in separate `INBOX_OUTPUT` files; each sample labels its scenario.
CDP specifies minimum request-to-response-header latency. This controlled extra
round-trip scenario tests serial request dependencies; it does not prove hosted
latency or reproduce the full staging network.

By default, `INBOX_HTTP_CACHE=warm` warms each browser context once, then reloads
the document for each initial sample. This retains HTTP cache while clearing app
query state. `INBOX_HTTP_CACHE=cold` uses fresh browser contexts;
`INBOX_HTTP_CACHE=both` records these scenarios separately. Warm Recent-to-Mine
navigation and task-to-Mine Back retain query state. Use `INBOX_HEADFUL=1` and
`PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome` when installed Chrome is the intended browser.

Initial readiness requires visible Mine rows plus two animation frames. The
report retains every sample and failure, exact row membership/order, row geometry,
asset identities, full API resource timings, request statuses and primary-request
start. Health, session, board access, companies and preferences remain timing
controls. A faster initial total alone does not attribute a gain to its final
context response. The fixed post-reveal window defaults to two seconds;
`INBOX_TAIL_MS` changes it, up to 30 seconds. Counts retain 429s and unfinished
requests rather than treating them as successful work. Use the same immutable
asset cache policy on both origins and stop builds and suites during timing runs.

Startup cases also check that shared collection controls do not require the
task-detail bundle before reveal, even when a different organization is remembered.
Code warms after the collection paints, or on task-link intent. A successful
immutable response allows module preloading to compile the cached chunk without
executing it. A failed fetch leaves the collection usable and permits navigation
without a document reload. Direct task URLs preload their static dependencies
while identity is pending. These cases must run with
production assets: development modules do not exercise the bundle boundaries.

The functional cases route feature settings and delayed responses. Routing
disables browser HTTP caching. For warm-cache timings, set the real local feature
settings and use fresh browser contexts without request interception. Keep normal
cache writes enabled so code warmed after paint can be used on the next task open.
Retain intercepted runs as separate diagnostic evidence.
Match the server's hashed asset cache policy (`public, max-age=31536000, immutable`);
Vite preview's default `no-cache` policy adds revalidation that the shipped server
does not require. Keep HTML uncached and return 404 for missing assets.
