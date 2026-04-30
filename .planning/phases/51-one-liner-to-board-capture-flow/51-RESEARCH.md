# Phase 51: One-Liner to Board Capture Flow - Research

**Date:** 2026-04-30
**Status:** Complete

## Findings

### Existing Capture Contracts
- `server/src/routes/rt2-tasks.ts` already exposes inbound draft creation, capture source listing/configuration, capture queue listing, draft promotion, and draft failure routes.
- `server/src/services/rt2-work-board.ts` already parses One-Liner text, detects duplicate drafts, preserves source evidence, stores semantic context, and audits promotion/failure.
- `packages/shared/src/types/rt2-task.ts` and `packages/shared/src/validators/rt2-task.ts` already define capture queue/status/evidence contracts.

### Daily Board Integration
- `ui/src/pages/rt2/DailyWorkPage.tsx` owns the primary `daily-work` route and wraps `Rt2DailyBoard`.
- `Rt2DailyBoard` is the correct insertion point for a compact board-attached capture inbox because Phase 49-50 locked it as the primary board surface.
- Promotion should invalidate capture queue, issues, task list, and daily board queries so the promoted task appears through canonical reads.

### Key Constraint
- Existing `promoteCaptureDraft` reparses `rawText`; therefore web/floating review edits should reconstruct explicit One-Liner text before draft creation unless a later plan adds persistent draft revision.

## Validation Architecture

- Shared tests: capture source enum accepts `web`, `floating`, and `voice`.
- Server route tests: existing inbound draft/promotion/failure coverage remains valid for new sources.
- UI tests: `Rt2DailyBoard` should cover capture inbox labels, duplicate warning/source evidence, and promotion/fail callbacks.
- Typecheck: required because source enum expansion touches shared/server/UI boundaries.

## RESEARCH COMPLETE
