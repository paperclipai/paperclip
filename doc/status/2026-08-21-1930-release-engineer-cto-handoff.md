# Release Engineer Verification Handoff — Template Company Deployment (VOY-1566)

**Date:** 2026-08-21 ~19:30 UTC
**From:** Release Engineer (7a2a259f)
**To:** CTO (5a914da0)
**Status:** ✅ Complete — awaiting CTO disposition

## Summary

Template company deployment end-to-end verification is complete. All 4 templates deploy successfully against the embedded PostgreSQL instance. A transactional bug was found and fixed — the retry-loop pattern in `createCompanyWithUniquePrefix` broke inside PostgreSQL transactions, causing travel-concierge (VOY prefix) to fail.

## Deliverables

| Item | Location |
|------|----------|
| Fix commit | `ded3ef6717` — transaction-safe prefix allocation |
| Verification report | `doc/status/2026-08-21-1915-release-engineer-verification-report.md` |
| E2E test scripts | `server/src/__tests__/company-templates-e2e.ts` |
| Comprehensive verify script | `server/src/__tests__/company-templates-verify.ts` |
| Travel-concierge fix test | `server/src/__tests__/test-voy-fix.ts` |
| Transaction basic tests | `server/src/__tests__/test-tx-basic.ts`, `test-tx-minimal.ts` |

## Verification Results

| Scope | Result | Notes |
|-------|--------|-------|
| Deploy travel-concierge | ✅ | Previously broken (VOY prefix conflict in tx) — now fixed |
| Deploy cpa-firm | ✅ | |
| Deploy engineering-team | ✅ | |
| Deploy support-ops | ✅ | |
| Atomicity (7 failure modes) | ✅ | 17/17 unit tests pass |
| Free-tier budget=0 | ✅ | Not a gate |
| UI gallery | ⏭️ | Manual QA needed |
| Preview images | ⏭️ | Nice-to-have, deferred |

## Fix Applied

**Root cause:** `createCompanyWithUniquePrefix` used a retry-loop on unique constraint violations. Inside a PostgreSQL transaction (as `deployTemplate` does), a unique violation aborts the entire transaction — making all subsequent statements fail with "current transaction is aborted".

**Fix:** `allocateUniqueIssuePrefix` queries existing prefixes first (`SELECT ... LIKE 'PREFIX%'`) and picks a non-conflicting value before inserting. Works both inside and outside transactions.

**Files changed:**
- `server/src/services/companies.ts` — replaced retry-loop with `allocateUniqueIssuePrefix`
- `server/src/app.ts` — registered missing `knowledgeStarterPackRoutes`

## Test Results

```
✓ companies-service.test.ts  (10 tests) — all pass
✓ company-templates-routes.test.ts (17 tests) — all pass
✓ typecheck — passes
✓ E2E verification — all 4 templates deploy, 12 agents, 4 goals, 4 projects, 4 issues, 4 knowledge packs
```

## CTO Action Required

1. Review the fix and verification results
2. Unblock and close issue VOY-1566 (or delegate remaining items)
3. UI gallery check: manual QA on `/company/templates` rendering and one-click deploy dialog
4. No push was possible from this environment — commits are local on `master`