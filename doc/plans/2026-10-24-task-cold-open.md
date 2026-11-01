# Task cold-open performance

Branch: `codex/task-cold-open`. Owner: task detail UI and existing issue/run read services.
Endpoint: tested, reviewable PR; deployment and staging acceptance are separate.

Cold opens show the instruction and recent exchange without hydrating historical
run diagnostics. Full issue enrichment stays on its existing authorized route.
The core view skips enrichment. Recent comments retain the latest human input
and four recent replies, plus the first human instruction when no description
exists. Recent activity preserves queue/steering metadata. Recent run summaries
select the latest run; conversation event reads exclude tools and traces.
Original comment/steering facts are read separately for visible comments, with
at most two facts per comment and 100 comment IDs per request. A reconnect that
leaves a watched unfinished run outside the recent window reconciles run summaries.
Core snapshots share task-detail mutation updates, rollback and invalidation.

The browser retains messages and runs observed while open. New native runs use
the normal event path. Expansion fetches full history, preserves existing rows,
and remains expanded on return in the session. Deep links and classic/Agent Chat
retain their full-history behavior. No database migration or permissions change.

| Case | Evidence |
| --- | --- |
| Cold task | Page tests hold enrichment/history pending while recent messages render; desktop/mobile thread tests keep content and composer visible. |
| Long history | Disposable app with 80 comments and six large run histories; cold network uses recent comments, recent runs, and one conversation-events request. Expansion reveals older comments. |
| Active page | Burst catch-up tests retain 60 messages across cursor pages; new-run tests retain previously visible runs. |
| Native history | Real PostgreSQL test filters tool payloads, preserves request lifecycles and message deltas, and pages by sequence. Expansion test resets cursor without duplicates. |
| Access | Core and preview route tests reject a foreign authenticated tenant. |
| Compatibility | Existing task UI, full event reads, and full activity/run reads remain covered. |

Measurements on the disposable local fixture: core read 50 ms; recent comments
24 ms; recent run summaries 17 ms. Latest native conversation events: 839 JSON
characters / 8 ms versus full latest-run events: 1,099,005 / 86 ms. These are local
HTTP samples, not staging latency promises. Browser navigation showed the initial
content paint at 1.34 seconds, with development assets already cached.

Verification: affected UI/API tests, real PostgreSQL tests, workspace typecheck,
production build, token gates, and map checks. The full suite was attempted but
this host exhausts macOS PostgreSQL semaphores. Targeted database tests were run
against a separate disposable database on an existing local server; the temporary
test setup override was restored before typecheck/build.

Related open PRs: #14667 changes the reveal gate and scroll anchors; #16229 adds
general history pagination. This change adds a core read and a folded cold-open
projection, while preserving the default full API contracts. Coordinate those
shared files if either PR lands first.
