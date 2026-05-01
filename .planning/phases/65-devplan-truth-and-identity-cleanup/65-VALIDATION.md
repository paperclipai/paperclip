---
phase: 65
slug: devplan-truth-and-identity-cleanup
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-01
---

# Phase 65 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node assert + TypeScript typecheck |
| **Config file** | `package.json` scripts |
| **Quick run command** | `node scripts/rt2-devplan-alignment-gate.test.mjs && node scripts/rt2-identity-gate.test.mjs` |
| **Full suite command** | `pnpm run test:devplan-alignment-gate && pnpm run test:identity-gate && pnpm run rt2:identity-gate && pnpm run rt2:devplan-alignment-gate && pnpm typecheck` |
| **Estimated runtime** | ~90 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node scripts/rt2-devplan-alignment-gate.test.mjs && node scripts/rt2-identity-gate.test.mjs`
- **After every plan wave:** Run `pnpm run test:devplan-alignment-gate && pnpm run test:identity-gate && pnpm run rt2:identity-gate && pnpm run rt2:devplan-alignment-gate && pnpm typecheck`
- **Before `$gsd-verify-work`:** Full suite must be green or any host limitation must be recorded in `65-VERIFICATION.md`
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 65-01-01 | 01 | 1 | ALIGN-01, ALIGN-02, ALIGN-03 | T-65-01 | Unsupported complete claims are blocked | script | `pnpm run test:devplan-alignment-gate` | yes | pending |
| 65-01-02 | 01 | 1 | IDENTITY-01, IDENTITY-02, IDENTITY-03 | T-65-02 / T-65-03 | Product-facing legacy identity is blocked while compatibility refs remain allowed | script | `pnpm run test:identity-gate && pnpm run rt2:identity-gate` | yes | pending |
| 65-01-03 | 01 | 1 | ALIGN-01, IDENTITY-01 | T-65-04 | Operator-facing alignment and docs describe current v3.1 truth | typecheck/script | `pnpm typecheck && pnpm run rt2:devplan-alignment-gate` | yes | pending |
| 65-01-04 | 01 | 1 | ALIGN-01..03, IDENTITY-01..03 | T-65-04 | Closure artifacts match verified evidence | docs/script | `pnpm run rt2:devplan-alignment-gate && pnpm run rt2:identity-gate` | yes | pending |

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Operator wording is not misleading | ALIGN-01, IDENTITY-01 | Copy nuance cannot be fully asserted | Review `PlanAlignmentPage.tsx`, `doc/PRODUCT.md`, and compatibility docs for RealTycoon2-first framing |

---

## Validation Sign-Off

- [x] All tasks have automated verify commands
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all missing references
- [x] No watch-mode flags
- [x] Feedback latency target under 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

