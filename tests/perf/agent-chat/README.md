# Long-running agent chats

`agent-chat-startup.spec.ts` drives the real standing-chat route with a retained
600-message, 300-run synthetic conversation. Completed runs have valid native
assistant events; there are no model calls. It verifies recent-only startup,
one backward page per upward gesture, delayed/error recovery, an unobscured latest reply, retained rows and
drafts, Back, older links, one saved live message, and sending before the first upward scroll. The send check uses separate retained fixture files per browser project so queued board input cannot alter the main history dataset. The live-message check posts one reply with a temporary key for the fixture agent, then revokes it. It starts no agent execution. Delayed inline images verify both following the latest reply and retaining an unpinned reading anchor. Additional checks keep message paging available during a receipts outage and verify that successive pages request each newly revealed metadata id once and avoid rereading previously hydrated terminal streams. Native stream recovery still refreshes on retry, resume, mode change, or reconnect. The disposable board user dismisses the current optional announcement before the journeys.

Use a disposable loopback instance with Agent Chat enabled. The first seed needs
its matching PostgreSQL URL, with a database name ending in `_test`:

```sh
PAPERCLIP_ISSUE_PERF_BASE_URL=http://127.0.0.1:3221 \
PAPERCLIP_CHAT_PERF_DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:55503/fast_chat_preview_test \
  pnpm exec playwright test --config tests/perf/agent-chat/playwright.config.ts
```

The recipe enables Streamlined UI and the disposable board user's Coordinator
preference. It creates isolated fixture records through the API and database;
never point it at a shared instance. The fixture is retained at
`test-results/agent-chat/fixture-600.json`. Override
`PAPERCLIP_CHAT_PERF_SEED_FILE` to reuse an existing matching fixture; retained
fixtures need no database connection for browser journeys.
`PAPERCLIP_CHAT_PERF_MESSAGES=6000` creates a larger fixture for the same assertions.
The rig blocks service workers so fixture responses are intercepted deterministically and build-update reloads cannot change the selected UI artifact. The ordinary local prototype keeps the normal service worker enabled.
The rig runs the same journeys on desktop and mobile. Use `--project=desktop`
for the smaller iteration loop, then run both projects before handoff.

`PAPERCLIP_TASK_COLD_OPEN_DATABASE_URL` lets the focused server suite reuse a
separate disposable loopback database ending in `_test`; it applies migrations
and retains randomly scoped fixture records until that database is discarded.
The normal CI path still uses the embedded PostgreSQL helper.

Measure startup latency separately from these assertions: use matched production
builds, the same retained fixture and server, alternate baseline/candidate order,
and stop this task's builds and suites during timing samples. Readiness is the
visible recent conversation at its intended position with an editable composer,
not the loading shell. Retain per-frame geometry and server timings alongside
sample medians/ranges; do not treat fewer transcript requests as latency proof.

Terminal native transcripts read during a visit are retained in the application's
query cache by company, run, status and projection. A cached return can reveal
those rows immediately while the normal cursor-based catch-up read runs in the
background. Live runs and uncached projections still wait for hydration. Cache
reuse does not remove reconnect or retry reads. Return navigation also exercises
cached question editors: a scroll event queued before their layout grows must
retain bottom-follow, while an upward gesture and Back reading anchors still win.
Mounted rows survive query-cache eviction. Expanding a cached preview restores
the full projection before catch-up, including older rows and late events.

### Local comparison, 2026-11-06

Compared baseline `523818ea9bf81f96abf4e6b73e81c2ce87518c07` with the
terminal-history cache and scroll-event fix using production assets, Chromium
151.0.7922.34, a 1440×900 viewport and the same retained 600-message/300-run
fixture (with the rig's saved live replies). Five alternating pairs per profile;
no CPU throttling, profiling, builds or this task's test suites during samples.
Other worktrees remained active on the shared host. Browser contexts had fresh
HTTP/application caches for direct opens; in-app entry started from a freshly
loaded task collection; return reused that visit's application cache.

Times are median milliseconds, with min–max in parentheses. Readiness means a
revealed conversation at the bottom with an editable composer.

| Network | Journey | Baseline | Candidate | Median paired saving |
| --- | --- | --- | --- | --- |
| Loopback | Direct open | 439 (420–489) | 425 (409–474) | 10 |
| Loopback | In-app entry | 277 (268–284) | 279 (271–285) | −3 |
| Loopback | Cached return | 115 (106–120) | 118 (113–120) | −4 |
| 150 ms latency | Direct open | 3586 (3573–3597) | 3575 (3418–3595) | 10 |
| 150 ms latency | In-app entry | 1956 (1930–1959) | 1958 (1955–1961) | −4 |
| 150 ms latency | Cached return | 547 (538–553) | 131 (120–137) | 416 |

Only the slower-network cached return establishes a reliable speed improvement:
all five paired deltas are positive. Direct opens and uncached navigation remain
unchanged. The unchanged server's issue-read timing medians were 18.2 vs 16.9 ms
on the latency profile (20 reads per variant). Baseline and candidate entry assets
were `index-8fGouAl3.js` and `index-BVkn60XK.js`. This is local synthetic proof,
not a claim about deployed staging latency. The cached-question reproduction went
from a persistent 198-pixel bottom gap to zero.

The chat's pending task questions use the attention service's scoped question
projection. It keeps current access, audience, dismissal, queue, snooze and archive
rules without constructing the company feed. Ranks are relative to the returned
questions. Seeded queue membership checks use bounded batches on both scoped
questions and the company feed. New memberships keep their existing audit path.
The first reveal still waits for these cards so their arrival does not move an
already visible conversation.

Compare the full service against a pinned commit before this optimization:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-chat-questions.ts \
  --baseline-ref=909e29dd07 --unrelated=1000
```

The benchmark creates a disposable PostgreSQL database with two relevant tasks
and the requested number of unrelated blocked tasks and questions. It alternates
five baseline/candidate pairs for chat questions and the company badge summary,
compares all returned fields except contextual rank and the generated timestamp,
counts SQL calls and captures the actual interaction query plans.
`PAPERCLIP_CHAT_QUESTIONS_TEST_DATABASE_URL` can reuse a dedicated database ending
in `_test`. `PAPERCLIP_COORDINATOR_HANDOFF_TEST_DATABASE_URL` provides the same
option for the canonical handoff service tests. These paths retain synthetic
fixtures when an external test database is used.
