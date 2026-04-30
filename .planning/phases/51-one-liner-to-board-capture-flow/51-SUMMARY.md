---
phase: 51-one-liner-to-board-capture-flow
status: complete
requirements:
  - CAPTURE-01
  - CAPTURE-02
  - CAPTURE-03
key-files:
  - packages/shared/src/types/rt2-task.ts
  - packages/shared/src/validators/rt2-task.ts
  - packages/shared/src/rt2-task.test.ts
  - ui/src/api/rt2-tasks.ts
  - ui/src/pages/rt2/OneLinerPage.tsx
  - ui/src/components/FloatingOneLinerCapture.tsx
  - ui/src/components/Rt2DailyBoard.tsx
  - ui/src/components/Rt2DailyBoard.test.tsx
  - ui/src/pages/rt2/DailyWorkPage.tsx
  - server/src/services/rt2-work-board.ts
---

# Phase 51 Summary

Phase 51 connected One-Liner input to the daily work board review flow.

## Delivered

- Web, floating, and voice One-Liner inputs now create reviewable RT2 capture drafts instead of bypassing board review through direct task creation.
- The daily work board now shows a Korean `One-Liner 보드 검수함` with review counts, duplicate warnings, source evidence, permission/signing state, parsed work type, deliverable, base price, and action buttons.
- Review-required drafts can be promoted to task from the board using existing capture queue APIs; drafts can also be held through the existing fail path.
- Mobile/native/inbound drafts remain on the same capture queue and are shown through the same board review surface.

## Verification

- `pnpm exec vitest run packages/shared/src/rt2-task.test.ts` - passed.
- `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` - passed.
- `pnpm typecheck` - passed.
- `pnpm exec vitest run server/src/__tests__/rt2-task-routes.test.ts` - skipped because embedded Postgres tests are disabled by default on Windows.
- `pnpm test` - attempted; timed out after 304 seconds on this host, consistent with existing accepted full-suite timeout debt.

## Deferred

- Persistent draft revision route remains a future improvement if operators need to save edited draft fields and return later before promotion.
- Jarvis/wiki/graph/economy detailed evidence panels remain Phase 52.
