---
phase: 32
slug: lint-traceability-and-milestone-acceptance-closure
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-28
---

# Phase 32 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts`, `server/vitest.config.ts` |
| **Quick run command** | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | Focused lint test under 60s; full suite varies by host |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` when source or lint evidence changed; otherwise perform artifact presence and traceability checks.
- **After every plan wave:** Run `pnpm --filter @paperclipai/server typecheck`; retry `pnpm typecheck` if practical.
- **Before verification:** Focused lint test must be green, server typecheck must be green or explicitly blocked, and final artifact matrix must align across requirements, summary frontmatter, verification, validation, and re-audit evidence.
- **Max feedback latency:** 120 seconds for focused lint/server checks. Full workspace checks may exceed this and should be recorded exactly.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 32-01-01 | 01 | 1 | LINT-01..LINT-04 | T-32-01 | Requirement acceptance is based on code/test evidence, not planning text alone. | artifact + unit | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` | yes | pending |
| 32-01-02 | 01 | 1 | LINT-01..LINT-04 | T-32-02 | Lint validation proves evidence-only behavior and no wiki mutation. | artifact + unit | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` | yes | pending |
| 32-01-03 | 01 | 1 | LINT-01..LINT-04 | T-32-03 | Final re-audit preserves original gap context while recording post-closure acceptance. | artifact | artifact matrix inspection | yes | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Phase 29 summary frontmatter traceability | LINT-01..LINT-04 | Milestone acceptance depends on planning artifact metadata, not runtime behavior. | Inspect `.planning/phases/29-consistency-linting-batch/29-01-SUMMARY.md` and confirm `requirements-completed` lists LINT-01 through LINT-04. |
| Final v2.4 re-audit result | LINT-01..LINT-04 | Re-audit artifact synthesizes multiple phase artifacts and command outcomes. | Inspect the final audit artifact and confirm WIKI, GRAPH, LEDGER, SETTLE, and LINT groups are accepted or explicitly deferred with evidence. |

---

## Validation Sign-Off

- [x] All tasks have automated verify or artifact inspection.
- [x] Sampling continuity: no 3 consecutive tasks without verification.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Focused feedback latency target is under 120 seconds.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-04-28
