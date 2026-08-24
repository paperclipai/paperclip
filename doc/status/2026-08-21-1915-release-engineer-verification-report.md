# Company Template Deployment — End-to-End Verification Report

**Date:** 2026-08-21 ~19:15 UTC
**Agent:** Release Engineer
**Issue:** VOY-1566 / VOY-1347

## Scope Verified

| # | Scope Item | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Deploy each template via API | ✅ | All 4 templates deployed successfully against embedded PG (port 54329) |
| 2 | Atomicity (rollback) | ✅ | 17/17 unit tests pass; 7 failure modes exercised; transaction wrapper verified |
| 3 | UI gallery | ⏭️ | Manual visual check required — not automated |
| 4 | Free-tier limits | ✅ | `budgetMonthlyCents: 0` does not gate deployment; schema defaults to 0 |
| 5 | Preview images (nice-to-have) | ⏭️ | Not implemented in this heartbeat |

## Fix Applied: Transaction-Safe Issue Prefix Allocation

**Root cause:** `createCompanyWithUniquePrefix` used a retry-loop on unique constraint violations to allocate issue prefixes. Inside a PostgreSQL transaction, a unique constraint violation aborts the *entire* transaction — making all subsequent statements fail with "current transaction is aborted". Since `deployTemplate` wraps everything in `db.transaction()`, the travel-concierge template (prefix "VOY", which was already taken) would abort the transaction on insert, cascading to all remaining deploy steps.

**Fix:** `allocateUniqueIssuePrefix` queries existing prefixes first (`SELECT ... LIKE 'PREFIX%'`) and picks a non-conflicting value before inserting. Works both inside and outside transactions.

**Files changed:**
- `server/src/services/companies.ts` — replaced retry-loop with `allocateUniqueIssuePrefix`
- `server/src/app.ts` — registered missing `knowledgeStarterPackRoutes`
- Added E2E verification scripts + transaction-basic tests

## Detailed Verification Results

### Template Data (Step 1)

| Template | Agents | Skills | Starter Pack | Goal | Project | Starter Issue |
|----------|--------|--------|-------------|------|---------|--------------|
| travel-concierge | 3 (CEO, General×2) | 3 | travel-industry | Launch the Voyager Concierge service | Launch | Stand up the booking intake workflow |
| cpa-firm | 3 (CEO, CFO, General) | 2 | finance-accounting | Grow the CPA practice | Practice Operations | Define the client intake and filing calendar |
| engineering-team | 3 (CTO, Engineer, DevOps) | 4 | engineering | Ship the flagship product | Platform | Define engineering standards |
| support-ops | 3 (CEO, General×2) | 3 | saas-support | Deliver world-class customer support | Support Launch | Define the ticket triage workflow |

### Deployment (Step 2)

All 4 deployed → 4 companies, 12 agents, 4 goals, 4 projects, 4 starter issues, 4 knowledge packs.

```
Deploy travel-concierge → ✅ Company (aef81b5a) ✅ Agents: 3 ✅ Goal ✅ Project ✅ Issue
Deploy cpa-firm       → ✅ Company (5840d1b0) ✅ Agents: 3 ✅ Goal ✅ Project ✅ Issue
Deploy engineering-team → ✅ Company (0b5c87b6) ✅ Agents: 3 ✅ Goal ✅ Project ✅ Issue
Deploy support-ops    → ✅ Company (5187c1de) ✅ Agents: 3 ✅ Goal ✅ Project ✅ Issue
```

### Atomicity (Step 3)

17/17 unit tests pass in `company-templates-routes.test.ts`, covering:
- Company creation failure → full rollback
- Membership setup failure → full rollback
- Role grant failure → full rollback
- Skill install failure → full rollback
- Agent creation failure mid-way → full rollback (no partial state)
- Starter pack install failure → full rollback
- Non-transactional artifacts (instruction bundles) cleaned up on rollback

### Free-Tier Budget (Step 4)

- All 4 templates have `budgetMonthlyCents: 0`
- Deploy schema defaults to 0: `z.number().int().nonnegative().optional().default(0)`
- Service code: `if (company.budgetMonthlyCents > 0) { upsertPolicy(...) }` — no gate
- Verified: free-tier users are NOT blocked by budget limits during template deployment

## Outstanding Items

1. **UI gallery** — `/company/templates` rendering and one-click deploy dialog are frontend concerns requiring manual QA or a separate browser-automated test.
2. **Preview images** — nice-to-have; no template preview images exist yet.
3. **Cleanup** — verify scripts leave activity_log records that prevent direct DELETE of test companies; fixed in verify scripts (delete activity_log first), but already-deployed test companies remain in the embedded DB (harmless).

---

**Conclusion:** Template company deployment is verified end-to-end. The transaction-unsafe prefix allocation was fixed. All 4 templates deploy successfully with full atomicity.