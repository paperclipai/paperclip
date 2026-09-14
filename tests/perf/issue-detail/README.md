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

## Task layout stability

`layout-stability.spec.ts` exercises the real task route, including Inbox
navigation, with 160 Markdown comments and a resolved interaction. It delays
initial comments, tests failures and retry, tracks a reading anchor across
media growth, composer resizing, properties toggles, older-page loading and
Back navigation, and covers mobile reduced motion and explicit comment links.
The eight scenarios also exercise same-task hash navigation without remounting
on desktop and mobile, and stalled native/log reads that expose Retry after
the 15-second request deadline.
Videos and per-frame `layout.json` measurements are written under each test's
output directory. The two-pixel assertion measures a logical row's viewport
offset; total scroll offset legitimately changes when history is prepended.

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
