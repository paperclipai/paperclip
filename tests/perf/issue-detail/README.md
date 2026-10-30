# Issue-detail performance baseline

Run the repeatable baseline from the repository root:

```sh
pnpm exec playwright test --config tests/perf/issue-detail/playwright.config.ts
```

The rig starts an isolated seeded Paperclip instance, runs five samples for each scenario/profile, and writes median-ready raw data plus a Markdown table to `test-results/issue-detail-perf/`.

Scenarios:

- S1 warm in-app navigation: loads the Issues list, clears the waterfall, and clicks the seeded issue.
- S2 cold open: creates a fresh browser context and deep-links to the seeded issue.

Profiles:

- Unthrottled.
- Fast 4G network with 4x CPU slowdown.

Override the sample count (minimum five) or port when needed:

```sh
PAPERCLIP_ISSUE_PERF_RUNS=7 PAPERCLIP_ISSUE_PERF_PORT=3210 pnpm exec playwright test --config tests/perf/issue-detail/playwright.config.ts
```

Outputs include `baseline.md`, `baseline.json`, and a Chrome trace for the first run of each scenario/profile. Open `*.trace.json` in Chrome DevTools Performance to inspect the `issue-detail:*` user-timing marks.

Set `PAPERCLIP_ISSUE_PERF_PROFILE=1` to capture actual Chrome CPU samples and
conversation-readiness transitions in one diagnostic sample per scenario/profile.
Import the resulting `*.cpuprofile` in DevTools and inspect `*.readiness.json` for
the task, comments, metadata, activity, runs, runtime, plan and transcript gates.
Each gate records changes with `detail.ready`; use its last transition before
content paint when a gate becomes pending after mount. These diagnostic runs
include profiler overhead. Run without the flag for before/after latency claims.
Readiness marks stay in the local browser and contain only fixed gate names and
booleans; the harness enables them before navigation.

For bundle comparisons, build the UI and serve the production assets from an
isolated local instance with `PAPERCLIP_UI_DEV_MIDDLEWARE=false`. The default
managed server above uses development middleware, which does not reproduce
production chunk loading. Keep the server, database, browser profile and sample
count the same for both builds, and avoid concurrent builds or test suites while
measuring latency.

Copy the first run's output outside `test-results/issue-detail-perf`, then reuse
its persisted task with `PAPERCLIP_ISSUE_PERF_SEED_FILE=/path/to/before/baseline.json`
and `PAPERCLIP_ISSUE_PERF_BASE_URL` pointing to that disposable instance. The
harness validates the task identity before measuring. Network spans in the trace
use recorded request start/end timestamps relative to task navigation; they
include completed requests observed during the sample, even after content paint.

## Task layout stability

`compact-startup.spec.ts` keeps a synthetic local reproduction with 24 messages,
a plan, three documents and three saved PR cards. It holds the enriched task
response, records each visible frame's card count and geometry, and rejects
cards inserted after the conversation becomes readable. It also checks document,
older-comment and unknown anchors without full comments/activity/run reads.
Run it with the same loopback-only URL override below. The fixture URL is saved
in `test-results/compact-startup-fixture.json` for manual inspection and reuse.

`layout-stability.spec.ts` exercises the real task route, including Inbox
navigation, with 160 Markdown comments and a resolved interaction. It delays
initial comments, tests failures and retry, tracks a reading anchor across
media growth, composer resizing, properties toggles, older-page loading and
Back navigation, and covers mobile reduced motion and explicit comment links.
The eight scenarios also exercise same-task hash navigation without remounting
on desktop and mobile, and stalled native/log reads that expose Retry after
the 15-second request deadline.
`plan-startup.spec.ts` also opens tasks with and without a saved plan while
blocking the separate plan endpoint. Both must reveal the saved conversation
from the task response without issuing that redundant read.
It also checks task-list navigation, where a list-only snapshot needs one normal
plan fetch and must still show a saved plan when present.
Videos and per-frame `layout.json` measurements are written under each test's
output directory. The two-pixel assertion measures a logical row's viewport
offset; total scroll offset legitimately changes when history is prepended.

Ordinary task opens defer the concealed history and composer until their initial
data is ready. The skeleton and scroll/composer containers retain their geometry.
Comment-link navigation prepares content eagerly so the target can be positioned
before reveal. Revealed content stays mounted during refresh. The draft scenario
holds a background task read, checks the same editor remains mounted, reloads the
saved draft, sends one reply, and independently checks its persisted comment.

To run against an existing **disposable local test-drive instance**:

```sh
PAPERCLIP_ISSUE_PERF_BASE_URL=http://127.0.0.1:3102 \
  pnpm exec playwright test --config tests/perf/issue-detail/playwright.config.ts layout-stability.spec.ts
```

The suite creates its own company and fixtures. The URL override accepts only
loopback origins and rejects remote hosts. Use a disposable local instance,
not a shared or production instance. Without the override, the harness starts its own
isolated instance as before. Live provider walkthroughs additionally require a
configured native Paperclip runner and Codex authentication; deterministic
browser fixtures do not substitute for watching an actual provider run.

For the live walkthrough, first assign a disposable task to a native Paperclip
runner configured with the Codex provider. Its scratch project should contain
a small `sum.mjs` fixture. The script sends a paced job, scrolls up, disconnects
and reconnects, steers a follow-up, and records through completion:

```sh
PAPERCLIP_LAYOUT_LIVE_URL=http://127.0.0.1:3102/LAY/issues/LAY-8 \
  node tests/perf/issue-detail/live-feed.walkthrough.mjs
```

Inspect `test-results/task-layout/live-acceptance/` for the video, screenshots,
per-frame positions, layout shifts, browser timing counters, and reading-anchor
measurement. The live script rejects non-local URLs and uses real provider
capacity. Review the video as well as the assertions: layout-shift scores alone
do not capture programmatic scrolling or replacement flashes.
