# BBA Memory — Progress State

Last updated: 2026-05-10

## Open PRs (stack order)

| PR | Branch | Status | Description |
|----|--------|--------|-------------|
| #5583 | feat/bba-memory-phase-a | Open | Phase A: schema, seeds, repository, smoke test |
| #5595 | feat/bba-memory-phase-b-to-e | Open | Phase B-E: service, routes, keepalive, instrumentation |
| #5601 | feat/bba-memory-ui-component-1 | Open | Component 1: BbaMemoryRecentRunsPanel (no tests) |
| #5602 | feat/bba-memory-ui-component-2 | Open | Component 2: BbaMemoryExecuteBetPanel + executeBbaBet |
| #5636 | feat/bba-memory-phase-f-hardening | Open | Phase F: server idempotency, safeParseMetaJson, UI hardening |
| (draft) | feat/bba-memory-phase-f-ui-plus | Draft | Phase F+ UI: auto-retry + replay banner + PR review + runbook |

## Phase F (2026-05-10) — commit b8eaf441, PR #5636

### Completed

- **F.1 Backend idempotency**: `idempotency_keys` SQLite table, `getIdempotencyKey`/`putIdempotencyKey`, wired into `POST /execute` route with `Idempotency-Key` header + `X-Idempotent-Replay: true` on hit
- **F.1 safeParseMetaJson**: defensive JSON.parse with warning log, used in `GET /recent-runs`
- **F-5 Tailwind refactor**: all inline `style={}` removed from `BbaMemoryExecuteBetPanel`
- **F-4 companyId-scoped idempotency (UI)**: `Map<string,number>` ref + `crypto.randomUUID()` per click
- **F-1 partial polling**: 5s interval on `recent-runs` query while `result.status === "partial"`, stops after 60s
- **F-2 Escape key**: closes modal
- **F-3 Focus trap**: Tab/Shift+Tab cycling among 3 modal elements

### Review verdict on #5636

**REQUEST CHANGES** — see [`.claude/reviews/pr-5636-phase-f.md`](.claude/reviews/pr-5636-phase-f.md)

- 1 ship blocker: scope creep (CDP launch mode + migration idempotency not in Phase F spec)
- 3 P1 follow-ups: no test for safeParseMetaJson corrupt path, no idempotency cache hit test, 3-arg → options-bag footgun
- 5 nits: INSERT OR REPLACE TTL extension bug, no SQL CHECK constraint on key length, GC on every read, missing header docs, focus trap click-outside gap

## Phase F+ UI (2026-05-10) — commit 720b9461, Draft PR

### Completed

- **Auto-retry on 5xx**: `executeBbaBet` refactored to options-bag signature; retries up to 3 attempts with 1s/2s exponential backoff using same `Idempotency-Key`; reads `X-Idempotent-Replay` header from response
- **Replay banner**: `wasReplay` state in `BbaMemoryExecuteBetPanel`; shows "↻ Cached replay (60s window)" (`data-testid="replay-banner"`) inside result panel when server confirmed idempotent replay
- **PR #5636 review**: [`.claude/reviews/pr-5636-phase-f.md`](.claude/reviews/pr-5636-phase-f.md) — 10 findings, REQUEST CHANGES verdict
- **Demo runbook**: [`docs/bba-memory-demo-runbook.md`](../../docs/bba-memory-demo-runbook.md) — pre-demo checklist, 8-min happy path script, 2 failure mode demos, 5 Q&A pairs, post-demo issues

## Deferred (separate PRs)

- **#5606 (test-infra)**: `@testing-library/react` + `happy-dom` in `ui/package.json` — prerequisite for Component 1-b + 2-b tests
- **Component 1-b**: 5+1 tests for `BbaMemoryRecentRunsPanel`
- **Component 2-b**: 9 tests for `BbaMemoryExecuteBetPanel` (includes replay-banner test)
- **D-3**: 3 skipped tests in `betting-browser-automation.test.ts`
- **Phase F backend split**: CDP launch mode + migration idempotency should be in their own PR (flagged in #5636 review)

## Human actions needed

- Approve + merge PRs in stack order: #5583 → #5595 → #5601 → #5602 → #5636 → draft F+ UI
- Ping cryppadotta/devinfoley to review + ARM auto-merge
- Create Paperclip issue from `docs/bba-memory-ui-integration-paperclip-issue.md` as P0 CTO issue
- Create Paperclip issues from runbook "Post-Demo Follow-ups" section (6 items)
