# Phase 25: Daily Wiki Projector - Plan

**Phase**: 25
**Name**: Daily Wiki Projector
**Status**: draft
**Created**: 2026-04-27
**Context**: `.planning/phases/25-daily-wiki-projector/25-CONTEXT.md`

## Goal

Implement a daily wiki projector that auto-generates date-indexed wiki pages from RT2 board events. Users can view daily pages, navigate to index/log, and filter by user. The projector is replay-safe and idempotent, and hooks into the existing `appendAndProject()` knowledge_core chain.

## Implementation Tasks

### 25-1: Add daily wiki page schema extensions

**Why**: `rt2_v33_daily_wiki_pages` already exists but needs metadata fields for sourceEventIds tracking and idempotent upsert logic.

**Files**:
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` — add `sourceEventIds jsonb` column for idempotency tracking, ensure unique constraint covers `(companyId, reportDate, userId)`

**Tasks**:
- [x] Add `sourceEventIds jsonb` column to track which events contributed to each page
- [x] Verify unique constraint: `(companyId, projectId, userId, reportDate)` — already exists as `companyProjectUserReportDateUq`

**Verification**: `pnpm typecheck` passes, migration generates cleanly.

---

### 25-2: Extend rt2-knowledge-projector with daily page projection

**Why**: Existing `projectEvent()` handles cumulative index/log/topic pages. Phase 25 needs date-indexed daily page generation as part of the same projector flow.

**Files**:
- `server/src/services/rt2-knowledge-projector.ts` — extend with daily wiki projection methods

**Tasks**:
- [x] Add `upsertDailyWikiPage(input)` — upsert to `rt2_v33_daily_wiki_pages` with sourceEventIds tracking
- [x] Add `renderDailyPage(events, date, userId?)` — generate markdown from event lines, filter by userId if provided
- [x] Add `projectDailyForCompany(companyId, date)` — rebuild a specific day's daily page from all events on that date
- [x] Add `projectDailyEvent(event)` — project a single event into all relevant daily pages (by date and by user)
- [x] Extend `projectEvent()` to also call `projectDailyEvent()` — the daily projector runs alongside the existing cumulative projector
- [x] Ensure idempotency: skip events already in `sourceEventIds` when appending event lines

**Verification**: `pnpm typecheck` passes.

---

### 25-3: Add daily wiki routes

**Why**: Users need a way to read daily wiki pages and the date-catalog index.

**Files**:
- `server/src/routes/rt2-knowledge.ts` — add daily wiki endpoints

**Tasks**:
- [x] `GET /companies/:companyId/rt2/knowledge/daily?date=YYYY-MM-DD` — fetch full daily wiki page for a date (all users combined)
- [x] `GET /companies/:companyId/rt2/knowledge/daily?date=YYYY-MM-DD&userId=xxx` — fetch per-user daily page
- [x] `GET /companies/:companyId/rt2/knowledge/daily/index` — list all daily pages for the company, ordered by date (date-catalog)

**Verification**: Route files compile, new endpoints follow existing company-scoped auth pattern.

---

### 25-4: Add full-rebuild admin endpoint

**Why**: ROADMAP.md success criterion 4 requires "re-running the daily wiki projector from event start produces bit-identical output". Need a way to trigger full replay for recovery.

**Files**:
- `server/src/services/rt2-knowledge-projector.ts` — add `projectAllDaily(companyId)` method
- `server/src/routes/rt2-knowledge.ts` — add admin endpoint

**Tasks**:
- [x] Add `projectAllDaily(companyId)` — iterate all events for company, project each into daily pages, respect already-processed event skip
- [x] `POST /companies/:companyId/rt2/knowledge/daily/rebuild` — trigger full replay for a company (admin only)

**Verification**: Rebuild endpoint exists, rebuilds produce identical output.

---

### 25-5: Add UI page for daily wiki (optional - depends on existing UI)

**Why**: Success criteria require user-facing viewing of daily wiki pages. Check if existing KnowledgePage has daily wiki tab or if new tab needed.

**Files**:
- `ui/src/pages/rt2/KnowledgePage.tsx` — check if daily tab exists

**Tasks**:
- [x] Check existing KnowledgePage for daily wiki tab/panel
- [x] If no daily tab: add `DailyWiki` or `BoardLog` panel to the Knowledge page
- [x] Date picker for selecting which day to view
- [x] User filter dropdown for per-user view

**Verification**: UI builds, page renders without console errors.

---

## Phase Order

Phase 25 is the first phase in v2.4 milestone. No prior phase dependencies.

## Success Criteria Verification

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | User can view daily wiki page listing all board events for a selected date | `GET /rt2/knowledge/daily?date=YYYY-MM-DD` returns page with event lines |
| 2 | User can navigate to index.md showing a date-catalog and log.md showing chronological activity | `GET /rt2/wiki-pages?pageType=index` returns index, `GET /rt2/wiki-pages?pageType=log` returns log (from Phase 5 projector) |
| 3 | User can view per-user daily pages | `GET /rt2/knowledge/daily?date=YYYY-MM-DD&userId=xxx` returns user-filtered page |
| 4 | Re-running from event start produces bit-identical output (replay-safe) | `POST /rt2/knowledge/daily/rebuild` produces same output as incremental updates |
| 5 | Running twice does not duplicate content (idempotent) | `sourceEventIds` tracking prevents double-append |
| 6 | Projector appends via `appendAndProject()` | Existing `appendAndProject()` in rt2-domain-events.ts already calls `projectEvent()` — daily projection runs in same chain |

## Related Context Files

- `.planning/phases/25-daily-wiki-projector/25-CONTEXT.md` — phase boundary, decisions, canonical refs
- `.planning/phases/05-wikillm-and-graphify-knowledge-core/05-CONTEXT.md` — cumulative wiki projector contract, replay-safe rules
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-CONTEXT.md` — source-of-truth semantics
- `.planning/PROJECT.md` — RT2-first identity

## Out of Scope

- Graph visualization (Phase 26)
- Linting/batch consistency checks (Phase 29)
- Vector embedding or semantic search (v2+)

---

*Plan: 25-daily-wiki-projector*
*Created: 2026-04-27*