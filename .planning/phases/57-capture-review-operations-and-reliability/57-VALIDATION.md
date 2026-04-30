---
phase: 57
slug: capture-review-operations-and-reliability
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
---

# Phase 57 — Validation Strategy

> Per-phase validation contract for capture review operations and reliability reporting.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm exec vitest run packages/shared/src/rt2-task.test.ts ui/src/components/Rt2DailyBoard.test.tsx` |
| **Full suite command** | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx && pnpm typecheck` |
| **Estimated runtime** | ~60 seconds for focused suite, ~3 minutes for typecheck on this host |

---

## Sampling Rate

- **After shared contract edits:** run `packages/shared/src/rt2-task.test.ts`.
- **After backend route/service edits:** run `server/src/__tests__/rt2-task-routes.test.ts` with `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`.
- **After board UI edits:** run `ui/src/components/Rt2DailyBoard.test.tsx`.
- **Before completion:** run the focused combined suite and `pnpm typecheck`.
- **Max feedback latency:** 120 seconds before typecheck; embedded Postgres route test is host-dependent but must be attempted with opt-in.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 57-01-01 | 01 | 1 | REVIEW-01, REVIEW-03 | T-57-03 | Filter/report contracts use shared source/status/evidence vocabulary | unit | `pnpm exec vitest run packages/shared/src/rt2-task.test.ts` | ✅ W0 | ✅ green |
| 57-01-02 | 01 | 1 | REVIEW-01, REVIEW-02, REVIEW-03 | T-57-01 / T-57-02 / T-57-03 / T-57-05 | Company-scoped queue/report routes expose only durable redacted evidence | integration | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run server/src/__tests__/rt2-task-routes.test.ts` | ✅ W0 | ✅ green |
| 57-01-03 | 01 | 1 | REVIEW-01, REVIEW-03 | T-57-04 | Board review UI filters actionable drafts and shows source reliability without hiding defaults | component | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` | ✅ W0 | ✅ green |
| 57-01-04 | 01 | 1 | REVIEW-02 | T-57-02 | Promoted draft rows show durable source draft/revision evidence labels | component | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` | ✅ W0 | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Operator visual scan of dense report layout | REVIEW-01, REVIEW-03 | Exact source noise interpretation depends on live capture volume | Run `pnpm dev`, open daily work board, create mixed capture drafts, toggle source/status/evidence filters, and inspect the `입력 신뢰도 리포트` rows. |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency target defined
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** passed
