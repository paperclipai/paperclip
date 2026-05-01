---
phase: 68
slug: wikillm-living-memory-workflow
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-01
---

# Phase 68 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest + Node script tests |
| **Config file** | `vitest.config.ts`, package-level workspace configs |
| **Quick run command** | `pnpm exec vitest run packages/shared/src/rt2-knowledge.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~120 seconds focused, broad suite host-dependent |

---

## Sampling Rate

- **After every task commit:** Run the focused command for the touched package.
- **After every plan wave:** Run shared/server/ui focused tests touched by the wave.
- **Before verification:** `pnpm typecheck && pnpm test` should be attempted.
- **Max feedback latency:** 180 seconds for focused checks.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 68-01-01 | 01 | 1 | WIKI-01 | T-68-01 | Additive wiki page/export contract preserves existing wiki consumers. | unit | `pnpm exec vitest run packages/shared/src/rt2-knowledge.test.ts` | yes | passed |
| 68-01-02 | 01 | 1 | WIKI-01,WIKI-02 | T-68-02,T-68-03 | Projector materializes wikiLLM files with provenance/update evidence. | integration | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run server/src/__tests__/rt2-knowledge-projector.test.ts server/src/__tests__/rt2-knowledge-routes.test.ts` | yes | passed |
| 68-01-03 | 01 | 1 | WIKI-03 | T-68-04,T-68-05 | Jarvis wiki citations and updates stay approval-first and auditable. | integration | `$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run server/src/__tests__/rt2-knowledge-routes.test.ts` | yes | passed |
| 68-01-04 | 01 | 1 | WIKI-01,WIKI-02,WIKI-03 | T-68-06,T-68-07 | UI/gate expose living-memory evidence without engine overclaim. | ui/script | `node scripts/rt2-devplan-alignment-gate.test.mjs && pnpm run rt2:devplan-alignment-gate` | yes | passed |

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements:

- Shared Vitest tests exist in `packages/shared/src/rt2-knowledge.test.ts`.
- Server knowledge projector/route tests exist in `server/src/__tests__/`.
- DevPlan alignment gate tests exist in `scripts/rt2-devplan-alignment-gate.test.mjs`.

---

## Manual-Only Verifications

All Phase 68 behaviors have automated verification targets. Browser e2e is not default.

---

## Validation Sign-Off

- [x] All tasks have automated verify commands.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all required test infrastructure.
- [x] No watch-mode flags.
- [x] Feedback latency target defined.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** auto-approved 2026-05-01

**Execution result:** passed 2026-05-01. See `68-VERIFICATION.md`.
