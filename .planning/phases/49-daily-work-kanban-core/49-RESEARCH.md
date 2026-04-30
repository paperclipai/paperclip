# Phase 49: Daily Work Kanban Core - Research

**Researched:** 2026-04-30
**Status:** Complete

## Summary

Phase 49 should not build a new board stack. The repo already has the two halves needed:

- `Rt2DailyBoard` + `rt2DailyReportApi` + `rt2DailyReportService` provide daily-work persistence, activity logging, wiki materialization, deliverable counts, price totals, quality state, and OKR gap flags.
- `KanbanBoard` provides the product-facing 3-lane Korean work-board pattern and compact card metadata density.

The implementation should adapt the daily board into the primary route, normalize lane vocabulary to `todo / doing / done`, and preserve existing daily report save/wiki behavior.

## Key Findings

### Existing Daily Board Path

- `ui/src/components/Rt2DailyBoard.tsx` renders the daily board and calls `onSaveCard` with `projectId`, `reportDate`, `lane`, `bucketLabel`, `progressPercent`, and `note`.
- `ui/src/pages/rt2/KnowledgePage.tsx` currently mounts this board only under the Knowledge page's daily tab.
- `ui/src/api/rt2-daily-report.ts` exposes `getBoard`, `saveCard`, `getWiki`, and `queryWiki`.
- `server/src/routes/rt2-daily-report.ts` emits `rt2.daily-report.updated` and `rt2.daily-wiki.updated` after save.
- `server/src/services/rt2-daily-report.ts` derives card fields required by BOARD-03: deliverable count, base price total, quality state, OKR context, and gap flags.

### Lane Vocabulary Gap

Current lane values are `today`, `support_1`, and `support_2`. Phase 49 requires To-Do, Doing, Done. The safest change is:

- Type/schema values: `todo`, `doing`, `done`
- UI labels: `할 일`, `진행 중`, `완료`
- Compatibility mapping for existing persisted values:
  - `today -> todo`
  - `support_1 -> doing`
  - `support_2 -> done`

Database migration should update existing rows and relax/recreate the check constraint.

### Primary Route Gap

`ui/src/App.tsx` currently redirects company root to `one-liner`. Phase 49 should add a daily-work route and make it the company root/default. `one-liner` remains available for Phase 51 capture work.

`ui/src/lib/company-routes.ts` and company page memory fallback should include the new route so company switching lands on the daily board rather than `one-liner`.

### Verification Focus

The highest-signal checks are:

- `packages/shared/src/rt2-daily-report.test.ts`
- `ui/src/components/Rt2DailyBoard.test.tsx`
- focused UI route/sidebar tests touched by route changes
- `server/src/__tests__/rt2-daily-report-routes.test.ts` when embedded Postgres is supported on the host
- `pnpm typecheck`

## Validation Architecture

Phase 49 validation should prove:

- The daily board route is the company default operational surface.
- The board renders `할 일`, `진행 중`, and `완료`.
- Lane movement persists via `rt2DailyReportApi.saveCard`.
- Cards show BOARD-03 metadata without expansion.
- Old lane values do not break persisted data because service/schema migration maps them.

## RESEARCH COMPLETE
