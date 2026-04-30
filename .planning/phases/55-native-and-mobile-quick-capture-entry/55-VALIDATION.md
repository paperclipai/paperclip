---
phase: 55
slug: native-and-mobile-quick-capture-entry
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
---

# Phase 55 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm exec vitest run ui/src/lib/rt2-quick-capture-queue.test.ts ui/src/pages/rt2/QuickCapturePage.test.tsx` |
| **Full suite command** | `pnpm exec vitest run ui/src/lib/rt2-quick-capture-queue.test.ts ui/src/pages/rt2/QuickCapturePage.test.tsx ui/src/components/Rt2DailyBoard.test.tsx packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts && pnpm run test:identity-gate && pnpm run rt2:identity-gate && pnpm typecheck` |
| **Estimated runtime** | ~120 seconds for focused suite, host-dependent for typecheck |

---

## Sampling Rate

- **After every task commit:** Run the quick command or the nearest focused changed-file subset.
- **After every plan wave:** Run the full suite command above.
- **Before `$gsd-verify-work`:** Focused suite, identity gate, and typecheck must be green.
- **Max feedback latency:** 120 seconds for UI/unit feedback before typecheck.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 55-01-01 | 01 | 1 | NATIVE-02 | T-55-01 | Local queue is bounded, validated, and stores no auth/session secrets | unit | `pnpm exec vitest run ui/src/lib/rt2-quick-capture-queue.test.ts` | ✅ W0 | ✅ green |
| 55-01-02 | 01 | 1 | NATIVE-01, NATIVE-03 | T-55-02 / T-55-03 | Quick capture UI shows connection/auth/sync state and blocks unsafe sends | component | `pnpm exec vitest run ui/src/pages/rt2/QuickCapturePage.test.tsx` | ✅ W0 | ✅ green |
| 55-01-03 | 01 | 1 | NATIVE-01 | T-55-04 | PWA install metadata is RealTycoon2-branded and exposes quick capture entry | script | `pnpm run test:identity-gate && pnpm run rt2:identity-gate` | ✅ W0 | ✅ green |
| 55-01-04 | 01 | 1 | NATIVE-01, NATIVE-02, NATIVE-03 | T-55-05 | Existing capture draft handoff remains review-first and type-safe | integration | `pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx` | ✅ W0 | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers the phase requirements:

- Vitest is configured.
- `localStorage` is available in `ui/vitest.setup.ts`.
- Capture draft server/shared/UI tests already exist.
- Identity gate scripts already exist and can be extended to cover manifest metadata.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| PWA standalone install feel | NATIVE-01 | Browser install UI is platform/browser-dependent | Run dev UI, open quick-capture route on mobile viewport, inspect manifest shortcut and standalone metadata in browser devtools. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s for focused tests
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** passed on 2026-04-30
