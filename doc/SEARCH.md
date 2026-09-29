# Task search relevance

## Product rubric

Search should help someone reopen work they remember, using whatever fragment
stuck in memory: an ID, a few title words, a technical name, or something in the
conversation. The first screen should contain plausible answers, with enough
context to explain each match.

| Intent | Good result | Failure |
|---|---|---|
| Known task ID | Exact ID first, case-insensitive; accept `PAP-42`, `pap42`, `PAP 42` | A mention or neighboring ID beats the task |
| Remembered title | Exact title, phrase, then all title words in any order | A recent comment mentioning those words beats the title |
| Several concepts | Every meaningful query term contributes, including short terms such as API/UI | A task matches only one common word |
| Exact phrase | Quoted text stays together and literal | Quotes silently behave like OR or fuzzy search |
| Thread memory | Find words across task text, comments and current documents | Relevant content exists but the task cannot be found |
| Technical text | Preserve underscores, percent signs, paths and numbers | SQL wildcard expansion or fuzzy IDs return unrelated work |
| Typo | Conservative title-word correction; all other terms still required | Ignoring a short term changes the query's meaning |
| Result explanation | Show the best evidence and link to its source | A title hit jumps into an unrelated comment |
| Old work | Strong completed-task matches remain ahead of weak recent hits | Recency/activity replaces relevance |
| Boundaries | Company, visibility, deletion and explicit filters always apply | Content leaks through counts, snippets or typo matches |
| Operations | PostgreSQL only, synchronous current-row reads, bounded query/page sizes | A worker, remote index or eventual-consistency repair is required |

Judge results on a 0–3 scale: **3** directly answers the remembered task intent,
**2** is useful related work, **1** is only an incidental mention, **0** is
irrelevant. Ambiguous short queries may have several grade-3 answers; do not
invent a unique intended task for them.

Acceptance gates:

- Every unambiguous known-task case returns its intended task first.
- Every grade-3 result in the small judged corpus appears in the first five.
- All explicit negative, visibility, filter, freshness and literal-query cases pass.
- Report mean reciprocal rank (first grade-3 result) and nDCG@5 (graded ordering
  and recall). Target MRR ≥ 0.95 and nDCG@5 ≥ 0.90 on the authored corpus.
- Measure both the full search page and the command-palette/task-list API.
- Measure database-backed latency separately from relevance. Report dataset
  size, warm/cold assumptions and hardware; a small fixture is not scale proof.
  Initial target: warm p95 ≤ 250 ms at 10,000 tasks and 30,000 short comments.
  A regression greater than 20% from baseline requires investigation and an
  explicit explanation of the cost; do not describe a quality improvement as
  latency-neutral when it is not.

The initial corpus is synthetic and deliberately adversarial. It includes
plausible distractors and gives older completed tasks strong relevance labels.
It is not evidence that every real user's search is solved. Add real failed
queries and human judgments as they become available. Do not adjust judgments
just to improve a score.

## Previous behavior

The command palette calls the issue-list endpoint. It searched one literal
substring across title, identifier, description and comments, prioritized titles
before identifiers, and did not search documents or recover typos. Reordered
words commonly returned no result.

Company search used a different algorithm: any token admitted a result, bonuses
from titles, comments and documents accumulated, and title-only token coverage
was indistinguishable from words scattered across a long thread. It ran edit
distance for title words, discarded short terms from fuzzy matching, and also
fuzzed identifiers. Quotes were tokenized but did not constrain other matches.

## Matching contract

Both task search paths use `server/src/services/task-search.ts`. Search is lexical:
trim/collapse whitespace, normalize case, keep quoted phrases, remove a small
set of unquoted grammatical filler words, deduplicate terms, and retain up to
8 terms within the existing 200-character query bound. All-filler queries keep
their terms. No synonym service, embedding model or language-specific stemming
is involved.

All retained terms must match. Full search and task lists allow terms to occur
across task text and current, undeleted conversation/document content. The
Tasks scope requires coverage in task text. Comments and Documents require a
participating match in that source, while retaining the task context. Exact/prefix
identifiers and conservative title-word typo matches are additional task matches.
Typo matching runs only when no literal match satisfies the requested filters.
It never guesses task numbers, loosens a quoted phrase or drops a short query
term. Alphabetic terms of one to three characters must begin a word, so `UI`
does not match `build`, while incomplete longer words still support typeahead.

Ranking uses disjoint bands: exact ID, ID prefix, exact title, title phrase,
all title terms, all task-text terms, all thread terms, then title typo recovery.
Whole-word title matches and title prefixes break close ties; status has only a
small effect within a band. Full search uses recency and stable IDs for remaining
ties; task lists retain their existing priority/activity tie-breaking. Explicit
created/updated/priority sort modes retain their documented behavior. Other
entity types retain their existing scoring rules, rescaled to keep exact names
ahead of speculative task typo matches. The UI displays the server's order
without regrouping results by source.

The existing `pg_trgm` indexes support literal substring retrieval. Tagged
comment/document match sets are computed once per search with separate indexed
patterns. Ranking stages carry compact flags; descriptions and matching snippets
are fetched for the result window. The database reads current rows, so creates, edits, deletions and
hidden-task changes take effect without indexing jobs. Bounded edit-distance
checks operate on titles only, run only as a zero-result fallback, and guard
fuzzystrmatch's 255-character argument limit. There is no schema migration or
new extension in this change.

PostgreSQL documents the existing index support in
[pg_trgm](https://www.postgresql.org/docs/17/pgtrgm.html).

## Reproduce the evaluation

```sh
pnpm exec vitest run server/src/__tests__/task-search-quality.test.ts
# Also write per-query rankings and metrics for inspection:
SEARCH_EVAL_REPORT=/tmp/search-quality.json pnpm exec vitest run server/src/__tests__/task-search-quality.test.ts
# Include the larger latency dataset and query plans:
SEARCH_EVAL_SCALE=1 SEARCH_EVAL_REPORT=/tmp/search-scale.json pnpm exec vitest run server/src/__tests__/task-search-quality.test.ts
```

The fixture is `server/src/__tests__/fixtures/task-search-corpus.ts`. Tests run
the real services against a temporary embedded PostgreSQL database with the
normal migrations. `SEARCH_EVAL_BASELINE=1` records judgments without asserting
improved behavior. To compare another revision, copy this test, its fixture and
`task-search.ts` into a separate worktree for that revision, leave its actual
`company-search.ts` and `issues.ts` services unchanged, and run with
`SEARCH_EVAL_BASELINE=1`. The copied helper is not used by the baseline services;
its query-plan branch is disabled in baseline mode.

## Initial evaluation — 2026-09-12

Compared against `2083bf6f9` using the same 31-task corpus and 24 queries (23
queries with intended answers, plus one no-result query).

| Surface | Intended answer first, before → after | MRR, before → after | nDCG@5, before → after |
|---|---|---|---|
| Full search | 17/23 → 23/23 | 0.828 → 1.000 | 0.904 → 0.999 |
| Quick search / task list | 5/23 → 23/23 | 0.268 → 1.000 | 0.339 → 0.999 |

The relevance gates pass. These results measure the authored corpus, not general
search accuracy. The no-result query also returns no tasks in both surfaces.

The scale run adds 10,000 tasks with ~300-character descriptions and 30,000
~345-character comments. Measurements call the real service methods (including
facets/snippets or task-list hydration), excluding HTTP and UI debounce. Each
query has one separately recorded first request and 20 warm repetitions; p95
is the 19th sorted warm sample. This is not a cold-disk test. Both revisions used
PostgreSQL 18.1, default planner/memory settings, and `ANALYZE` after seeding.
The host was an Apple M5 Max with 128 GiB RAM, running an x86_64 PostgreSQL
binary and other development tests concurrently. Treat timing deltas as local
measurements, not production capacity or a controlled concurrency benchmark.

| Query | Full p95 before → after (ms) | Quick p95 before → after (ms) |
|---|---|---|
| `GitHub OAuth` | 139 → 95 | 39 → 128 |
| `OAuth callback GitHub` | 209 → 81 | 26 → 134 |
| `mibile api` | 153 → 131 | 19 → 111 |
| `search` | 172 → 41 | 22 → 67 |
| `quasarxylophone` | 154 → 105 | 18 → 218 |
| `routine` (matches all 10,000 added tasks) | 239 → 253 | 152 → 371 |

Selective full searches improved. Quick search is more expensive: it now
evaluates term coverage, searches documents, and can scan company titles for
typo recovery. The old quick search returned no answers for the reordered and
typo queries, so its lower cost did not deliver equivalent results. The relative
regression threshold is triggered, and broad-query p95 does **not** meet the
initial 250 ms target. This is an explicit performance limitation of this pass.
The implementation adds no operational service, but it is not latency-neutral.

`EXPLAIN (ANALYZE, BUFFERS)` confirmed existing trigram indexes on selective
comment/document retrieval and zero fuzzy-branch executions for successful
literal searches. Removing descriptions from intermediate materialized rows
eliminated 1,699 temporary blocks (~13 MiB) of writes in the broad-query core
plan; its final measured execution was 139 ms with no temporary writes. The
quick-search endpoint also performs its existing activity sorting and task
hydration. Larger companies, long threads and sustained concurrent searches
still need production-shaped measurement before a stronger latency claim.

Browser acceptance used the real built app against an isolated PostgreSQL
database containing this corpus. Starting from the dashboard, the Search link
found an older completed task from reordered title words and opened that task.
Command-K ranked `PAP-42` first for `pap42`; `mibile api` recovered only the
intended mobile API task and carried the query into full search. Quoted
`"connection timeout"` excluded scattered words. `Hermes parser` showed the
document title as evidence and opened the correct plan in the task's side panel.
The desktop result layout was visually inspected. Mobile layout, continuous
transition timing and production data were not part of this walkthrough.

For a future failed search, record the query, what the person remembered, and
the intended task IDs. Grade the old top five and any missed intended tasks
before changing the ranker, add realistic distractors, then run both entry
points. Keep these judgments independent of the ranking constants.

Verification: 78 search/parser tests (including the real PostgreSQL scale run),
14 existing task-list search/filter tests, and 29 Search/CommandPalette UI tests
passed. Workspace typecheck, the final server typecheck, production build,
Storybook build and token gates passed. The full repository test run was stopped
after `chat-channels.integration.test.ts` reported one failure in “publishes a
closed-choice question, settles its Slack card, and delivers its exact
continuation response”; that test passed when rerun alone. The remaining broad
suite was not completed, so this is not a claim of a green repository-wide run.

The API response contracts and company authorization stay unchanged. Artifact,
agent and project ranking are separate from the task relevance rubric. Extraction
search and the specialized blocked-attention queue retain their existing
literal matching. Pure semantic paraphrases and
language-specific word inflections are outside this first lexical rubric.
