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
