---
phase: 54
slug: persistent-capture-draft-revision
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
updated: 2026-04-30
---

# Phase 54 - Validation Strategy

> Per-phase validation contract for persistent capture draft revision.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm exec vitest run packages/shared/src/rt2-task.test.ts ui/src/components/Rt2DailyBoard.test.tsx` |
| **Full suite command** | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx && pnpm typecheck` |
| **Estimated runtime** | ~120 seconds for focused suite, host-dependent for typecheck |

---

## Sampling Rate

- **After shared contract edits:** run `packages/shared/src/rt2-task.test.ts`.
- **After backend route/service edits:** run `server/src/__tests__/rt2-task-routes.test.ts` with `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`.
- **After board UI edits:** run `ui/src/components/Rt2DailyBoard.test.tsx`.
- **Before completion:** run the focused combined suite and `pnpm typecheck`.
- **Max feedback latency:** 120 seconds for focused tests before typecheck.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 54-01-01 | 01 | 1 | DRAFT-01, DRAFT-03 | T-54-01 | Capture drafts persist immutable original evidence plus append-only revision rows | shared/server | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts` | ✅ W0 | ✅ green |
| 54-01-02 | 01 | 1 | DRAFT-02 | T-54-02 | Operators can save revised title, task, deliverable, price, quality, OKR/KPI, and notes before promotion | shared/server/UI | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx` | ✅ W0 | ✅ green |
| 54-01-03 | 01 | 1 | DRAFT-04 | T-54-03 | Hold, reject, request-revision, reopen-to-review, and promote states keep inbox lifecycle explicit | server/UI | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx` | ✅ W0 | ✅ green |
| 54-01-04 | 01 | 1 | DRAFT-01, DRAFT-02, DRAFT-03, DRAFT-04 | T-54-04 | Promotion uses latest reviewed revision while preserving source/duplicate/permission evidence | shared/server/UI | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx` | ✅ W0 | ✅ green |

*Status: pending, green, red, flaky.*

---

## Wave 0 Requirements

Existing infrastructure covered the phase requirements:

- Vitest is configured.
- Capture draft shared contracts, server routes, and board UI tests already existed from the Phase 51 capture review flow.
- Embedded Postgres route tests can be enabled with `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`.
- `Rt2DailyBoard` already owns the capture review inbox insertion point.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Operator scan of dense revision drawer | DRAFT-02, DRAFT-03 | Exact review comfort depends on real operator workflow and sample volume | Run `pnpm dev`, open the daily board capture inbox, reopen a draft, save a revision, inspect history/source evidence, and promote from the latest revision. |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency target defined
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** passed on 2026-04-30

## Evidence Source

- `.planning/phases/54-persistent-capture-draft-revision/54-01-SUMMARY.md`
- `.planning/phases/54-persistent-capture-draft-revision/54-VERIFICATION.md`
