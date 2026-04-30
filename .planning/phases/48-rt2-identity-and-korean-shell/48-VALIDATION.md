---
phase: 48
slug: rt2-identity-and-korean-shell
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
---

# Phase 48 — Validation Strategy

> Per-phase validation contract for RealTycoon2 Korean shell identity.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | existing workspace Vitest config |
| **Quick run command** | `pnpm --filter @paperclipai/ui test -- --run src/components/Sidebar.test.tsx src/components/SidebarAccountMenu.test.tsx src/components/SidebarCompanyMenu.test.tsx src/components/CompanySettingsSidebar.test.tsx src/context/BreadcrumbContext.test.tsx` |
| **Full suite command** | `pnpm typecheck && pnpm test` |
| **Estimated runtime** | focused: ~30-90 seconds; full: host-dependent |

## Sampling Rate

- **After every task commit:** Run the focused UI test or a narrower changed-file Vitest command.
- **After every plan wave:** Run `pnpm typecheck`.
- **Before verification:** Run focused UI tests plus targeted metadata/string checks.
- **Max feedback latency:** 2 minutes for focused tests.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 48-01-01 | 01 | 1 | IDENT-01, IDENT-04 | — | N/A | source/test | `rg -n "Paperclip|lang=\"en\"" ui/index.html` should not find visible defaults | ✅ | ⬜ pending |
| 48-01-02 | 01 | 1 | IDENT-01, IDENT-03 | — | N/A | unit/source | focused App/Layout metadata/copy assertions | ✅ | ⬜ pending |
| 48-02-01 | 02 | 1 | IDENT-01, IDENT-02, IDENT-03 | — | N/A | unit | focused sidebar/menu tests | ✅ | ⬜ pending |
| 48-03-01 | 03 | 2 | IDENT-02, IDENT-03, IDENT-04 | — | N/A | unit/source | focused settings/fallback tests and identity scan | ✅ | ⬜ pending |

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| First viewport feels like RealTycoon2 Korean work system | IDENT-01, IDENT-03 | Visual/product perception is not fully source-verifiable | Run `pnpm dev:ui`, open the app, confirm first visible shell/navigation/startup copy is Korean/RT2-first. |

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all missing references
- [x] No watch-mode flags
- [x] Feedback latency < 2 minutes for focused tests
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
