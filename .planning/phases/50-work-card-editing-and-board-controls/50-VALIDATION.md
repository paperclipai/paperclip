---
phase: 50
slug: work-card-editing-and-board-controls
status: passed
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
updated: 2026-04-30
---

# Phase 50 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | Existing repo/package configuration; component tests use file-level `@vitest-environment jsdom` where needed |
| **Quick run command** | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx packages/shared/src/rt2-daily-report.test.ts` |
| **Full suite command** | `pnpm typecheck && pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx server/src/__tests__/rt2-daily-report-routes.test.ts server/src/__tests__/rt2-task-routes.test.ts packages/shared/src/rt2-daily-report.test.ts` |
| **Estimated runtime** | ~90 seconds for focused suite on a supported host; embedded Postgres route tests may skip on unsupported Windows hosts |

---

## Sampling Rate

- **After every task commit:** Run `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx packages/shared/src/rt2-daily-report.test.ts`
- **After every plan wave:** Run `pnpm typecheck && pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx server/src/__tests__/rt2-daily-report-routes.test.ts server/src/__tests__/rt2-task-routes.test.ts packages/shared/src/rt2-daily-report.test.ts`
- **Before `$gsd-verify-work`:** Focused suite and `pnpm typecheck` must be green; run `pnpm test` if feasible under current host constraints
- **Max feedback latency:** 120 seconds for focused checks, excluding embedded Postgres startup/skip detection

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 50-01-01 | 01 | 1 | BOARD-04 | T-50-01 | Cross-company and wrong-assignee edits remain rejected | shared/server unit-route | `pnpm exec vitest run packages/shared/src/rt2-daily-report.test.ts server/src/__tests__/rt2-daily-report-routes.test.ts` | ✅ / W0 extensions | ✅ green |
| 50-01-02 | 01 | 1 | BOARD-04 | T-50-02 | Invalid quick-edit payloads are rejected by shared Zod validators | shared unit | `pnpm exec vitest run packages/shared/src/rt2-daily-report.test.ts` | ✅ / W0 extensions | ✅ green |
| 50-02-01 | 02 | 2 | BOARD-04 | T-50-03 | Title, deliverable, base price, quality, and OKR edits route to canonical owners | server route | `pnpm exec vitest run server/src/__tests__/rt2-daily-report-routes.test.ts server/src/__tests__/rt2-task-routes.test.ts` | ✅ / W0 extensions | ✅ green |
| 50-02-02 | 02 | 2 | BOARD-04 | T-50-04 | Daily lane/status edits still materialize activity log and wiki evidence | server route | `pnpm exec vitest run server/src/__tests__/rt2-daily-report-routes.test.ts` | ✅ / W0 extensions | ✅ green |
| 50-03-01 | 03 | 3 | BOARD-04 | — | Quick edit controls stay board-context, Korean-labeled, and preserve failed drafts | component | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` | ✅ / W0 extensions | ✅ green |
| 50-03-02 | 03 | 3 | BOARD-05 | — | Five required filters, search, and view-only sort preserve lane grouping and persisted state | component | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` | ✅ / W0 extensions | ✅ green |
| 50-04-01 | 04 | 4 | BOARD-04, BOARD-05 | T-50-01..04 | Focused integration evidence plus typecheck pass before phase verification | integration | `pnpm typecheck && pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx server/src/__tests__/rt2-daily-report-routes.test.ts server/src/__tests__/rt2-task-routes.test.ts packages/shared/src/rt2-daily-report.test.ts` | ✅ / W0 extensions | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `packages/shared/src/rt2-daily-report.test.ts` — enriched daily card fields and new quick-edit validators covered.
- [x] `server/src/__tests__/rt2-daily-report-routes.test.ts` — cohesive daily payload fields, lane/wiki preservation, and authorization/ownership paths covered; Windows embedded Postgres guard may skip local execution unless explicitly enabled.
- [x] `server/src/__tests__/rt2-task-routes.test.ts` — reused quality metadata and deliverable/base-price conventions covered where the route family owns them; Windows embedded Postgres guard may skip local execution unless explicitly enabled.
- [x] `ui/src/components/Rt2DailyBoard.test.tsx` — quick edit affordance, Korean per-field feedback, five filters, search targets, and non-persisted sort order covered.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dense board usability at desktop and narrow widths | BOARD-04, BOARD-05 | Component tests can assert labels and state, but visual density/layout stability needs a browser pass if implementation changes layout substantially | Run the dev UI, open `daily-work`, toggle all filters/search/sort, expand quick edit on multiple cards, confirm toolbar/lane widths do not overlap or jump incoherently |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s for focused checks
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-04-30
