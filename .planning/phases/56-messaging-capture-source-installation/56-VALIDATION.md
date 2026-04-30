---
phase: 56
slug: messaging-capture-source-installation
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
---

# Phase 56 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts` |
| **Full suite command** | `pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx && pnpm typecheck` |
| **Estimated runtime** | ~120 seconds for focused suite, host-dependent for typecheck |

---

## Sampling Rate

- **After every task commit:** Run the nearest focused changed-file subset.
- **After the plan wave:** Run the full suite command above.
- **Before completion:** Focused suite and typecheck must be green, or host-specific blockers must be recorded.
- **Max feedback latency:** 120 seconds for shared/server/UI focused feedback before typecheck.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 56-01-01 | 01 | 1 | MSG-01, MSG-02 | T-56-01 / T-56-02 | Source evidence and inbound payload contracts preserve metadata without exposing secrets | unit | `pnpm exec vitest run packages/shared/src/rt2-task.test.ts` | ✅ W0 | ⬜ pending |
| 56-01-02 | 01 | 1 | MSG-01, MSG-02, MSG-03 | T-56-01 / T-56-03 / T-56-04 | Public inbound route verifies source/signature and persists success/failure evidence | integration | `pnpm exec vitest run server/src/__tests__/rt2-task-routes.test.ts` | ✅ W0 | ⬜ pending |
| 56-01-03 | 01 | 1 | MSG-01 | T-56-02 | Operator setup shows callback/status and never displays saved secret material | component | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` plus any added setup test | ✅ W0 | ⬜ pending |
| 56-01-04 | 01 | 1 | MSG-03 | T-56-05 | Board inbox distinguishes duplicate, unauthorized/signature, and malformed messaging failures | component | `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx` | ✅ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers the phase requirements:

- Vitest is configured.
- Shared capture contracts and server route tests already exist.
- Capture source signing evidence tests already exist and can be extended.
- Board capture inbox tests already exist.
- Public route raw body support exists through `express.json` rawBody stashing in `server/src/app.ts`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real provider callback setup | MSG-01, MSG-02 | Real Slack/Teams app configuration is environment/account-dependent | Run dev server, copy callback URL from setup UI, inspect signed request examples, and verify a simulated provider payload creates a board review draft. |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency target defined
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending execution
