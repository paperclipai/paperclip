---
phase: 39
slug: enterprise-connector-apply-loop
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-29
---

# Phase 39: Enterprise Connector Apply Loop - Validation Strategy

> Per-phase validation contract for execution. This phase touches identity connector evidence, SCIM apply semantics, company boundary, and auditability, so validation must cover both persistence behavior and fallback route contracts without external network dependency.

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | Vitest with `supertest` for Express route tests |
| Config file | `package.json` / workspace Vitest configuration |
| Quick run command | `pnpm test -- server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts server/src/__tests__/rt2-v23-route-fallback.test.ts` |
| UI run command | `pnpm test -- ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx` |
| Full suite command | `pnpm typecheck && pnpm test` |
| Estimated runtime | Host-dependent; embedded Postgres tests may skip on unsupported Windows hosts |

## Sampling Rate

- **After backend schema/service/route work:** Run `pnpm test -- server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts server/src/__tests__/rt2-v23-route-fallback.test.ts`
- **After UI integration:** Run `pnpm test -- ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx server/src/__tests__/rt2-v23-route-fallback.test.ts`
- **Before phase verification:** Run `pnpm typecheck && pnpm test`
- **Max feedback latency:** No three consecutive implementation tasks without an automated test command.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 39-01-01 | 01 | 1 | EXT-01, EXT-02 | T-39-04 | Connector evidence is company-scoped and typed through shared/server contracts. | typecheck | `pnpm typecheck` | W0 | pending |
| 39-01-02 | 01 | 1 | EXT-01, EXT-02 | T-39-02, T-39-06 | SSO evidence persists; SCIM preview/apply rejects stale previews and unacknowledged deactivate actions. | route/service | `pnpm test -- server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts` | W0 | pending |
| 39-01-03 | 01 | 1 | EXT-01, EXT-02 | T-39-01, T-39-03 | Routes enforce company access and audit evidence IDs/counts/failure reasons. | route/fallback | `pnpm test -- server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts server/src/__tests__/rt2-v23-route-fallback.test.ts` | existing/W0 | pending |
| 39-02-01 | 02 | 2 | EXT-01, EXT-02 | T-39-08 | UI API uses shared contracts and posts SCIM apply through the company-scoped route. | typecheck | `pnpm typecheck` | existing | pending |
| 39-02-02 | 02 | 2 | EXT-01, EXT-02 | T-39-09, T-39-12 | Operator UI shows persisted evidence, disables unsafe deactivate apply, and renders rollback candidates. | UI test | `pnpm test -- ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx` | W0 | pending |
| 39-02-03 | 02 | 2 | EXT-01, EXT-02 | T-39-07, T-39-10 | Final route/UI contract remains aligned and default suite passes. | full suite | `pnpm typecheck && pnpm test` | existing/W0 | pending |

## Wave 0 Requirements

- [ ] `server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts` - embedded persistence/service/route tests for EXT-01 and EXT-02.
- [ ] `ui/src/pages/rt2/EnterpriseRolloutPage.test.tsx` - UI contract tests for persisted evidence, SCIM apply controls, deactivate acknowledgement, and rollback candidate rendering.
- [ ] `server/src/__tests__/rt2-v23-route-fallback.test.ts` - fallback route-contract coverage updated for new Phase 39 response shapes.

## Manual-Only Verifications

All Phase 39 required behaviors should have automated verification. Manual browser inspection is optional for layout polish only and must not replace route/service/UI tests.

## Validation Sign-Off

- [x] All plans have `<automated>` verification commands.
- [x] Sampling continuity avoids long unverified implementation stretches.
- [x] Wave 0 identifies all missing test artifacts before execution.
- [x] No watch-mode flags are required.
- [x] Default verification remains `pnpm typecheck && pnpm test`.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending execution evidence
