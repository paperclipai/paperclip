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
