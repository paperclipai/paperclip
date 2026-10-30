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
