# Staff Engineer Structural Review: Template Deployment Fix (ded3ef6717)

**Date:** 2026-08-21
**Commit:** `ded3ef6717` — fix(templates): transaction-safe issue prefix allocation + verify scripts
**Reviewer:** Staff Engineer (eee825c7)
**Status:** ✅ APPROVED — one advisory note

---

## Summary

The Release Engineer's template deployment verification uncovered and fixed a genuine PostgreSQL transaction hazard: the old `createCompanyWithUniquePrefix` retry-loop pattern relied on catching unique constraint violations (23505), but PostgreSQL aborts the **entire transaction** on any constraint violation — including inside a `SAVEPOINT` unless explicitly rolled back to the savepoint. Since `deployTemplate` wraps all work in `db.transaction()`, deploying the travel-concierge template (prefix "VOY" already taken by the Voyonder company) would abort the entire deployment.

**Fix:** Replace the retry-loop with `allocateUniqueIssuePrefix`, which proactively queries existing prefixes via `SELECT ... LIKE 'BASE%'` and picks a non-conflicting value before INSERTing. This avoids the uniqueness violation entirely and works both inside and outside transactions.

## Files Changed

| File | Change | Risk |
|------|--------|------|
| `server/src/services/companies.ts` | New `allocateUniqueIssuePrefix()` function; `createCompanyWithUniquePrefix` simplified | **Low** — well-structured, typed |
| `server/src/app.ts` | Added `knowledgeStarterPackRoutes` import + mount (was missing) | **Low** — bugfix, standard pattern |
| 6 new test files | E2E + transaction tests | **Low** — comprehensive |

## Verification

- ✅ `companies-service.test.ts`: 10/10 pass
- ✅ `company-templates-routes.test.ts`: 17/17 pass
- ✅ E2E: all 4 templates deploy successfully

## Structural Findings

### ✅ PASS: Transaction safety

The core bug is fixed. `allocateUniqueIssuePrefix` uses a read-before-write pattern that does not trigger a constraint violation inside the transaction. The old retry-loop's fatal interaction with PostgreSQL transaction semantics is eliminated.

### ✅ PASS: Index utilization

The `LIKE 'BASE%'` query on `companies.issuePrefix` leverages the existing B-tree unique index `companies_issue_prefix_idx`. For a B-tree index with default C collation, `LIKE 'BASE%'` (no leading wildcard) is a range scanable predicate — performant.

### ✅ PASS: Edge cases

- Empty name (no letters) → falls back to `ISSUE_PREFIX_FALLBACK = "CMP"` ✓
- "A" name → single character prefix ✓
- All 9999 suffixes exhausted → throws clear error ✓
- Non-ASCII company names (Unicode letters) → stripped to ASCII via `[^A-Z]` filter; `Letter.toUpperCase()` handles most Latin-derived scripts ✓

### ⚠️ ADVISORY: TOCTOU race on prefix allocation

The `allocateUniqueIssuePrefix` function does a lock-free SELECT to find available prefixes. Between the SELECT and the subsequent INSERT, a concurrent transaction could insert a company with the same prefix, causing a unique constraint violation. Inside a transaction (template deployment), this aborts the deployment; outside a transaction (standalone company creation), it surfaces as a 500 to the caller.

**Likelihood:** Very low in practice. Template deployments are sequential per-user; concurrent deployments of different templates use different base prefixes ("VOY", "CPA", "ENG", "SUP"). The window between SELECT and INSERT is a single round-trip. Multiple deployments of the **same** template concurrently would be needed to trigger this.

**Mitigation options:**
1. **Advisory lock** — `pg_advisory_xact_lock(hash('company_prefix:' + base))` at the start of `allocateUniqueIssuePrefix`. No deadlock risk since it's early in the transaction.
2. **FOR UPDATE** — `SELECT ... FOR UPDATE` on the matching rows (would need raw SQL in postgres-js). This serializes concurrent allocations for the same base prefix.
3. **Accept** — The error message surfaces clearly, and the user can retry. For admin-only template deployment, this is acceptable.

**Recommendation:** Accept for now unless concurrent admin deployments become common. Document in the deploy API contract that concurrent deployments of the same template may fail and should be retried.

### ✅ PASS: Missing route registration fixed

`knowledgeStarterPackRoutes` was absent from `app.ts` despite the package existing and being imported in the template deploy service. This was a genuine missing-wire bug that would have caused a 404 at runtime when the template deploy code tried to install a starter pack. Fixed correctly.

## Test Quality Assessment

| Test File | Lines | Coverage |
|-----------|-------|----------|
| `company-templates-routes.test.ts` | 542 | 17 tests: happy path + 7 failure-mode rollback tests + auth guard + 404 |
| `company-templates-e2e.ts` | 142 | End-to-end deploy of all 4 templates against embedded PG |
| `company-templates-verify.ts` | 242 | Comprehensive verification script with atomicity checks |
| `test-tx-basic.ts` | 70 | Basic transaction behavior tests |
| `test-tx-minimal.ts` | 38 | Minimal transaction test |
| `test-voy-fix.ts` | 28 | Travel-concierge-specific regression test |

All tests are meaningful and exercise the real code paths. The route tests use mocked services for unit isolation; the E2E/verify scripts use the embedded PostgreSQL for integration confidence.

## Disposition

✅ **APPROVED** — fix is correct, tests are comprehensive, no structural blockers.

The TOCTOU race is documented above but is low-risk and acceptable for the current deployment model. No action required before shipping.

---
Staff Engineer — standing by.
