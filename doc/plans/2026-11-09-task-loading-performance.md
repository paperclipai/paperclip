# Task loading performance: latest chat in ~0 ms

Date: 2026-11-09 · Branch: `claude/task-loading-perf-154fea` (base `33a23e0246`)

## Goal

Opening a task from the "Mine" issues list should show the composer and the latest
messages almost immediately. If an agent is live, the user should catch up on its
progress. If the run is done, the user should see the last messages. Older history
loads only when the user asks for it. The page must not move content around:
skeletons must have the same size as the content that replaces them, and the latest
message must not move once it is visible.

### Finish conditions

The user-facing endpoint is reviewable PRs with these results remeasured on staging.

| # | Condition | Baseline (below) | Target |
|---|---|---|---|
| F1 | Revisit a task whose data is cached → composer and latest message visible | 144–170 ms (14.6 s when the run log gates) | ≤ 100 ms, for every task |
| F2 | Hover, then click a row → composer and latest message visible | not prefetched today | ≤ 150 ms |
| F3 | Click a row with no prefetch (data not cached) → composer and latest message visible | 1.1–2.0 s (13.9 s when the run log gates) | ≤ 600 ms p50 (one round trip) |
| F4 | Hard load of a task URL → content painted | 5.2 s | ≤ 1.5 s |
| F5 | Layout stability | CLS 0.035 on every click | 0 inside the chat; the latest message never moves after it first appears |
| F6 | API requests started before the page is ready | ~30 on a click, ~70 on a hard load | ≤ 3 on the critical path |
| F7 | Live run | — | Shows the current run status within F1–F3 and streams new output |

The evidence for each condition is a timing sample from the staging harness (Phase 0):
5 tasks × 3 starting states, run serially, reporting the median and range. The same
journey is repeated after each PR is deployed.

## Baseline on staging, measured 2026-11-09

- **Environment:** the shared staging instance, one company with production-like data, desktop Chrome, HTTP/2, no throttling.
- **JS cache:** the JS bundle was already in the browser cache.
- **Harness:** an in-page harness that checks every animation frame for the thread mount, a visible composer, the latest `[data-conversation-message]` being visible in the viewport, layout shifts, and resource timing.

### Click from the list (data not cached in React Query)

| Task | Composer + latest message | Thread mounted | API requests (total / before ready) | What it waited on |
|---|---|---|---|---|
| Task A | 1,107 ms | 38 ms | 35 / 33 | `GET /issues/:id` 1,016 ms; activity, runs, recent-comments ~710 ms each |
| Task B | 1,190 ms | 56 ms | 49 / 31 | `GET /issues/:id` 1,289 ms; ~10 parallel queries of 800–900 ms |
| Task C | 1,977 ms | 935 ms | 41 / 28 | a serial chain: work-products, activity and runs started at ~900 ms |
| Task D | 2,014 ms | 540 ms | — | — |
| **Task E** | **13,862 ms** | 40 ms | 78 / 76 | **`GET /heartbeat-runs/:id/log` 11,150 ms** |

### Revisit (React Query cache warm)

| Task | Composer + latest message | Note |
|---|---|---|
| Task D | 144 ms | |
| Task B | 170 ms | |
| **Task E** | **14,651 ms** | The run log is fetched again and gates the page again (13.2 s) |

### Hard load (direct URL, JS from cache)

| Task | Document TTFB | First contentful paint | Header paint | **Content paint** | API requests before content |
|---|---|---|---|---|---|
| Task F | 478 ms | 676 ms | 2,416 ms | **5,211 ms** | 70 |
| Task G | 4,558 ms (outlier; a later fetch of the same HTML took 207–389 ms) | 4,980 ms | 6,587 ms | 7,841 ms | 72 |

The page parses about 7.7 MB of JS, even with all of it served from the cache.

### Server latency floor

Each endpoint was requested 3 times in a row, without competing requests.

- `/api/cli-auth/me` 272–365 ms. This trivial authenticated request sets the floor for each round trip from this machine.
- `/api/issues/:id/recent-comments` 300 ms.
- `/api/issues/:id?view=core` 464–595 ms, with one sample at 3.2 s.
- `/api/issues/:id` full 863–996 ms.
- `/api/issues/:id/activity?view=recent` 520–1,061 ms.
- `/api/issues/:id/runs?view=recent` 374–1,125 ms.

During a click, ~30 requests run at the same time, and each slows to 700–1,500 ms.

**Server-Timing** samples:
- `issue_lookup` took 893–908 ms in one cold sample and ~100–160 ms in others.
- `paperclip_issue` (full view) took 736–1,813 ms.

### Run log read

Task E has a failed run with no saved reply. Its log comes from the object-store journal (`s3_segments`).

| Read | Time |
|---|---|
| Tail, 32 KB at offset 414,581, with `alignStartToRecord=true` (what the UI sends) | 11.9 s, 11.2 s |
| Same tail without alignment | 6.1 s |
| Same 32 KB at offset 0 | 2.0 s |

### Repeated and polling requests

These requests were made during one 17 s visit (Task E):

| Request | Count |
|---|---|
| `issues/summaries?ids` | 22 |
| `/issues/:id/live-runs` (two id forms) | 11 |
| `/issues/:id/browsers` | 6 |
| `companies/:id/agents` (60 KB each) | 6 |
| `companies/:id/live-runs` | 3 |
| descendant, created-from and parent lists | 2–3 each |

## Where the time goes

1. **The run transcript blocks the whole chat.**
   - The composer and messages stay hidden until history is ready: `historyPending = initialHistoryPending || planLoading || transcriptHistoryPending || chatMetadataPending` (`ui/src/components/TaskChatThread.tsx:3216`).
   - The composer dock is hidden until then too (`concealed={!historyRevealed}`, `TaskChatThread.tsx:3524`).
   - `transcriptHistoryPending` waits for every failed run, live run, or run without a reply to finish hydrating.
   - The only cap is the 15 s reveal timeout. One slow log read therefore hides even saved messages the page has already fetched.
2. **Tail reads from the object-store log are serial.**
   - `readRange` in `server/src/services/object-byte-journal.ts:525` visits index nodes and payload segments one by one, with one S3 GET for each.
   - A tail read crosses many small segments.
   - `alignStartToRecord` repeats the whole traversal for the 32 KB before it (`object-run-log-store.ts:388`), which doubles the cost.
   - Nothing caches these objects, although segments cannot change after they are written.
3. **The page waits on many queries.**
   - `initialHistoryPending` waits on about ten queries: recent comments, interactions, attachments, work products, activity, runs, comment runs, comment input facts, live runs and active run.
   - The thread also waits on the plan, transcripts and conversation metadata.
   - Even when every query is fast, the reveal waits for the slowest of ~30 concurrent requests that compete on the server.
4. **Prefetch covers only part of what the page waits on.**
   - `prefetchIssueDetailForNavigation` (`ui/src/lib/issueDetailCache.ts:227`) warms only the core view and recent comments.
   - Everything else that gates the reveal still starts on click.
   - Nothing is kept across reloads (no React Query persister). A hard load is therefore always cold.
5. **The full issue request waits for the core request.**
   - The full `GET /issues/:id` starts only after `view=core` resolves (`IssueDetail.tsx:3361`).
6. **Non-critical work competes with the reveal.**
   - chat-binding, email tasks, browsers, external-objects, feedback votes, tree holds, projects, related-issue lists and polling all start on the click and share server capacity with the requests that matter.
7. **The hard-load path is heavy.**
   - It parses about 7.7 MB of JS.
   - It sends 70 API requests before content appears.
   - The header paints 1.5 s after navigation starts, and the content 4.3 s after.

## Feedback loop

| Question | Loop and environment | Cost per iteration |
|---|---|---|
| Is the user-visible timing better? | Staging harness (Phase 0) run through Chrome against real data, after each deploy | ~5 min per sample set, plus the deploy |
| Does a UI gate or prefetch change help? | Local `tests/perf/issue-detail` Playwright harness with production assets (`PAPERCLIP_UI_DEV_MIDDLEWARE=false`), plus a CDP network RTT of ~150 ms so local results match staging round trips | ~2–3 min |
| Is the object-store log read faster? | Server unit or bench test against a fake object provider with ~60 ms latency per GET and a fixture log with many small segments. Confirm on staging with Honeycomb traces (GET count per request) | seconds |
| Did we break layout? | Existing `layout-stability`, `loading-layout`, `compact-startup` and `saved-reply-startup` specs, plus the frame recorder in the harness | ~3 min |

Two things local runs cannot show: real multi-tenant contention and real S3 latency. Every
result therefore gets a staging check before we call it done.

## Plan: PR slices in priority order

### P0. Measurement, before any changes (small PR)

- Commit the staging click harness as `tests/perf/issue-detail/staging-click-harness.js`. It runs in the page and records, per sample:
  - T_composer and T_latest
  - T_thread
  - layout shifts and moves of the latest message
  - requests before ready, and the request that released the reveal
- Use the same harness against local runs, so every comparison uses the same measurement.
- Add `Server-Timing` to the endpoints the reveal waits on:
  - `recent-comments`
  - `activity`
  - `runs`
  - `live-runs`
  - `heartbeat-runs/:id/log`, including its object GET count and total GET time
  - `heartbeat-runs/:id/events`
- Add a local fixture with a failed run that has no reply and a multi-segment object log. Give the fake provider realistic per-GET latency so it reproduces Task E.

### P1. Show the composer and saved messages without waiting for transcripts (UI, biggest win)

- Remove `transcriptHistoryPending` from the reveal gate.
  - Runs that are still hydrating render in a **reserved, fixed-height run slot**: a collapsed "agent activity" row with the same geometry as the loaded collapsed state. That row expands only when the user acts, so its content never pushes the latest message.
  - Live runs show their status line right away and stream output as it arrives.
- Never hide the composer dock behind history.
  - It is pinned to the bottom of the viewport and its height comes from the composer itself, so it can render on the first frame with the thread skeleton above it.
  - Keep the draft and focus behaviour.
- Narrow `initialHistoryPending` to what defines the structure of the latest view: recent comments and interactions.
  - Activity, runs, attachments and work products go into reserved slots or load after the reveal.
- Expected result on staging:
  - Task E drops from 13.9 s to the time of the other tasks (~1.1–2 s).
  - The tail of every other cold click gets shorter, because the slowest of ~10 queries no longer decides the reveal.
- Regression journeys:
  - deep link to an older comment
  - Back restore
  - a draft during refetch
  - failed or stalled requests
  - a run that finishes while the page is open

### P2. Fix object-store log tail reads (server)

- In `readRange`, fetch the payload segments for a range in parallel, with limited concurrency (~8).
- Align to a record in **one pass**: read `[offset − 32 KB, end)` once and cut at the last newline. Do not re-traverse.
- Cache immutable segments and index nodes per process, in a bounded LRU keyed by content key and company.
- Optionally:
  - Store a tail pointer or the last index node in the head, so a tail read skips the walk from the root.
  - Compact small segments when the log closes.
- Target: a 32 KB tail read under 500 ms on staging, with no stalls of several seconds. The staging check is Honeycomb GET counts plus the harness.
- Also benefits: every live run viewer and the polling fallback.

### P3. Load the data before the click (target ~0 ms)

- **Prefetch everything the reveal waits on.**
  - Add the P1-narrowed set to `prefetchIssueDetailForNavigation` (`issueDetailCache.ts:227`).
  - Trigger it on `pointerover`, `pointerdown`, `focusin` and keyboard selection, which already exist for code and core data.
  - Also trigger it on idle for the first few visible rows of "Mine".
  - Respect `staleTime` and company scope.
- **Add a chat bootstrap endpoint**, `GET /issues/:id/chat-bootstrap`. It returns one company-scoped response with:
  - the core issue
  - the latest N timeline items, already merged: comments, interactions, run summaries and the latest status of a live run
  - the composer facts: assignee, model and permissions
  - a `cursor` used to catch up after the response
  - This replaces ~10 gating round trips with one, so the floor becomes ~300 ms on a cold click.
  - The existing granular queries are seeded from the bootstrap response, so invalidation keeps working unchanged.
  - Contracts change in shared, server and UI.
- **Keep the last-seen chat window per task in IndexedDB.**
  - Bounded size, scoped by company and user, cleared on logout or company change.
  - On revisit or hard load, render from it on the first frame, then revalidate with `?since=cursor`.
  - New items append under the bottom anchor, so the reading position does not move.
  - A small "syncing" indicator sits in a reserved slot.
  - Freshness is guaranteed by the catch-up read plus the websocket subscription, not by a time window.
- **Run full detail in parallel with core.** Start full detail at the same time as `view=core` instead of after it (`IssueDetail.tsx:3361`). Drop that ordering if the bootstrap endpoint makes the core view unnecessary.

### P4. Remove fan-out and polling noise

- Defer the requests the reveal does not need (chat-binding, email tasks, browsers, external-objects, feedback votes, tree holds, projects, descendant, created-from and parent lists). Start them in `requestIdleCallback` after the reveal, or when their UI is opened.
- Find out why `issues/summaries?ids` runs about every 0.5–1 s, and why `agents` (60 KB), `live-runs` and `browsers` refetch repeatedly while a task is open.
  - Batch those requests.
  - Remove duplicates.
  - Rely on websocket invalidation instead.
- Goal: ≤ 3 requests on the critical path, and a quiet page after load.
- These changes also lower load on the staging server.

### P5. Hard-load path

After P3, a hard load can render from the persisted chat window. The remaining work:

- Profile the 1.5 s between navigation and header paint: JS parse and evaluate of 7.7 MB, and module initialisation.
- Measure the 70 requests made before content and remove the ones not needed.
- Consider inlining the chat bootstrap for the requested URL into the HTML response, so the first paint needs no extra round trip.

### P6. Layout contract

- Find the `DIV` that shifts (CLS 0.035) ~25–40 ms after every click. It is most likely the swap from the list to the detail skeleton.
- Make the skeleton's geometry match the header, thread and composer exactly.
- Add the harness checks "latest message never moves after first visible" and "composer never moves" to the existing frame-recording specs.

## Acceptance matrix (applies to every slice)

| Case | Check |
|---|---|
| Done task with a saved reply, short and long thread | Latest message and composer within target; no movement |
| Failed run with no reply (Task E shape) | Not gated by the transcript; run slot is reserved |
| Live run | Status visible right away; new output streams; no duplicate after catch-up |
| Deep link to an older comment, Back restore | Anchor kept |
| Draft typed during background refresh, navigating away and back | Draft kept; no duplicate send |
| Company switch, logout | Persisted cache isolated and cleared |
| Websocket down | Polling fallback still catches up |

## Deferred / follow-ups

- Server-side `issue_lookup` by identifier sometimes takes ~900 ms. Hand it to `fix-slow-queries` with Neon evidence if it persists after P4 reduces contention.
- The 4.5 s document TTFB outlier on one hard load. Watch for it in the harness; it may be an instance wake-up.

## State

- [x] Staging baseline captured (this doc)
- [ ] P0 harness + Server-Timing
- [ ] P1 ungate transcripts / composer
- [ ] P2 object log reads
- [ ] P3 prefetch + bootstrap + persisted window
- [ ] P4 fan-out/polling
- [ ] P5 hard load
- [ ] P6 layout contract
