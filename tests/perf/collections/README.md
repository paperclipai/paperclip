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
