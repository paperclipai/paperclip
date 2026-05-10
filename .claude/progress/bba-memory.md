# BBA Memory — Progress State

Last updated: 2026-05-10

## Open PRs (stack order)

| PR | Branch | Status | Description |
|----|--------|--------|-------------|
| #5583 | feat/bba-memory-phase-a | Open | Phase A: schema, seeds, repository, smoke test |
| #5595 | feat/bba-memory-phase-b-to-e | Open | Phase B-E: service, routes, keepalive, instrumentation |
| #5601 | feat/bba-memory-ui-component-1 | Open | Component 1: BbaMemoryRecentRunsPanel (no tests) |
| #5602 | feat/bba-memory-ui-component-2 | Open | Component 2: BbaMemoryExecuteBetPanel + executeBbaBet |
| #5604 | feat/bba-memory-ui-operator-playground | Open | BbaOperatorPlayground — C1+C2+presets |
| #5606 | feat/bba-memory-ui-tests-infra | Open | Testing infra + 43 tests + useBbaMemoryRuns hook |
| #5636 | feat/bba-memory-phase-f-hardening | Open | Phase F: server idempotency, safeParseMetaJson, UI hardening |
| #5641 | feat/bba-memory-phase-f-ui-plus | Draft | Phase F+ UI: auto-retry + replay banner + PR review + runbook |
| TBD | feat/bba-memory-phase-f-backend-plus | Draft (Codex) | Phase F+ backend: rate limiter + metrics + DELETE + 18 tests |

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

## Phase F+ UI (2026-05-10) — commits 720b9461 + bc1adcd3, Draft PR #5641

### Completed

- **Auto-retry on 5xx**: `executeBbaBet` refactored to options-bag signature; retries up to 3 attempts with 1s/2s exponential backoff using same `Idempotency-Key`; reads `X-Idempotent-Replay` header from response
- **Replay banner**: `wasReplay` state in `BbaMemoryExecuteBetPanel`; shows "↻ Cached replay (60s window)" (`data-testid="replay-banner"`) inside result panel when server confirmed idempotent replay
- **PR #5636 review**: [`.claude/reviews/pr-5636-phase-f.md`](.claude/reviews/pr-5636-phase-f.md) — 10 findings, REQUEST CHANGES verdict
- **Demo runbook**: [`docs/bba-memory-demo-runbook.md`](../../docs/bba-memory-demo-runbook.md) — pre-demo checklist, 8-min happy path script, 2 failure mode demos, 5 Q&A pairs, post-demo issues

## Phase F+ Backend (2026-05-10) — Codex branch `feat/bba-memory-phase-f-backend-plus`

- Draft PR: https://github.com/theproject1-glitch/paperclip/pull/1
- Commits:
  - `97fa3223` chore: gitignore Claude Code session artifacts and run logs
  - `3571cf14` feat(server): per-company rate limiter for /execute
  - `f835a935` feat(server): idempotency replay counter + admin DELETE + metrics
  - `ec2aefd9` test(server): contract tests for bba-memory + execute (18 tests)
- Tests: 18 passed (`pnpm --filter server exec vitest run src/routes/__tests__/bba-memory.contract.test.ts src/routes/__tests__/betting-browser-automation.contract.test.ts`)

## Phase F+ Closure (2026-05-10) — branch `docs/bba-memory-phase-f-closure`

### PR #5641 stacking resolution

- **Decision**: Path A.2 (documented, not rebased). GitHub rejects cross-fork base edits.
- **Action taken**: Comment posted on PR #5641: https://github.com/paperclipai/paperclip/pull/5641#issuecomment-4415530631
- **Resolution on merge**: After #5636 merges to master, PR #5641's diff auto-shrinks to 2 commits.

### Scope-creep blocker status (#5636)

- **Status**: Split plan written. Awaiting maintainer execution.
- **Split plan**: [`docs/bba-memory-pr-5636-split-plan.md`](../../docs/bba-memory-pr-5636-split-plan.md)
- **Key finding**: All out-of-scope changes in single commit `b8eaf441` — not cherry-pick-able. Uses `git checkout b8eaf441 -- <files>` + `git checkout 43016fb1 -- <files>`.

### New docs delivered

| Doc | Path | Purpose |
|-----|------|---------|
| Split plan | [`docs/bba-memory-pr-5636-split-plan.md`](../../docs/bba-memory-pr-5636-split-plan.md) | Executable git commands for maintainer to split #5636 |
| Merge runbook | [`docs/bba-memory-merge-runbook.md`](../../docs/bba-memory-merge-runbook.md) | Merge order, dependency graph, conflict-risk matrix, rollback plan |
| Demo readiness | [`docs/bba-memory-demo-readiness-checklist.md`](../../docs/bba-memory-demo-readiness-checklist.md) | T-7d / T-1d / T-30min checklists + failure recovery scripts |

## Deferred (separate PRs)

- **#5606 (test-infra)**: `@testing-library/react` + `happy-dom` in `ui/package.json` — prerequisite for Component 1-b + 2-b tests
- **Component 1-b**: 5+1 tests for `BbaMemoryRecentRunsPanel`
- **Component 2-b**: 9 tests for `BbaMemoryExecuteBetPanel` (includes replay-banner test)
- **D-3**: 3 skipped tests in `betting-browser-automation.test.ts`
- **Phase F backend split**: CDP launch mode + migration idempotency should be in their own PR (flagged in #5636 review)

## Codex Phase F+ Backend Review (2026-05-10)

- **Review file**: [`.claude/reviews/pr-codex-phase-f-backend.md`](.claude/reviews/pr-codex-phase-f-backend.md)
- **Verdict**: **APPROVE** — no ship blockers
- **Commits reviewed**: 9 (`97fa3223` → `f5ed34e5`), 14 files, +934/−98
- **Tests added**: 31 (9 bba-memory contract, 9 execute contract, 8 repository unit, 5 rate-limit unit)
- **Ship blockers**: 0
- **P1 follow-ups**: 3
  - P1-1: Replay counter over-counts cross-company key collisions (move increment past company-ID guard)
  - P1-2: `DELETE /idempotency-keys` uses company-member auth; any member can clear idempotency protection
  - P1-3: Process-local metrics counters undocumented — resets on restart, per-instance in multi-pod
- **Nits**: 5 (Map GC, export annotation, X-Request-ID format validation, `?all=true` test gap, metrics window inconsistency)
- **Standout**: `inFlightIdempotency` Map correctly coalesces concurrent same-key requests without distributed lock
- **Merge blocker**: Must retarget to `paperclipai/paperclip:master` after PR #5636 merges (Step 8 in merge runbook)
- **ARM eligible**: No — manual review recommended (see merge runbook)

## Human actions needed

- Execute split plan for #5636 (see `docs/bba-memory-pr-5636-split-plan.md`)
- Approve + merge PRs in stack order: #5583 → #5595 → #5606 → #5601 → #5602 → #5604 → #5636 → #5641 → Phase F+ backend
- Retarget Codex PR (#1 on fork) to `paperclipai/paperclip:master` after #5636 merges
- Ping cryppadotta/devinfoley to review + ARM auto-merge
- Create Paperclip issue from `docs/bba-memory-ui-integration-paperclip-issue.md` as P0 CTO issue
- Create Paperclip issues from runbook "Post-Demo Follow-ups" section (6 items)
