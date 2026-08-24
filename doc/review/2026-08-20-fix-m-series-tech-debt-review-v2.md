# Staff Engineer Re-Review: `fix/m-series-tech-debt` (M1 Foundation)

**Reviewer:** Staff Engineer
**Branch:** `fix/m-series-tech-debt`
**Date:** 2026-08-20 (second review pass)
**Base:** `master`
**Status:** ⏳ CONDITIONAL APPROVAL for M1 scope — see conditions below

---

## Scope of this review

The M1 implementation (VOY-1492, issue `db2d91bf`) is marked **done** by the Founding Engineer. This pass re-verifies the current working tree, superseding the earlier review at `doc/review/2026-08-20-fix-m-series-tech-debt-review.md` which was written against an earlier version.

The broader M-series tech-debt changes (committed to the branch) are NOT re-reviewed here — they were reviewed in the previous pass. This review covers only the M1 background-jobs working tree and re-evaluates the previous findings against the current state.

---

## Re-evaluation of previous findings

| # | Finding (previous) | Severity | Current state | Verdict |
|---|---|---|---|---|
| 1 | No worker → jobs never progress | BLOCKER | FE explicitly deferred to M2 (VOY-1493). ActivitySearchPanel is NOT wired into any page — the UI is dormant. | **DOWNGRADED to MEDIUM** — see below |
| 2 | SSE `/events` route shadowed by `/:id` | BLOCKER | **FIXED** in working tree. Events route at line 61, `:id` route at line 91. | **CLOSED** |
| 3 | `prepare: false` without justification | HIGH | Still present, no comment. | **UNCHANGED** — needs fix or documented tradeoff |
| 4 | Company templates all-or-nothing | HIGH | Now explicitly documented (VOY-1403, lines 449-456). Has savepoint references and rollback cleanup. | **DOWNGRADED to MEDIUM** — documented tradeoff, but flaky catalog skills risk remains |
| 5 | `sanitizeErrorForTelemetry` mutates in place | MEDIUM | Still present. Error-handler snapshots responseMessage before call. Comment added: "mutating in place preserves identity." | **DOWNGRADED to LOW** — callers are safe, landmine pattern documented |
| 6 | No tests for background-jobs/research | MEDIUM | Still true — zero test files. | **UNCHANGED** |
| 7 | Notifications TDZ fix | OK | Good fix, no further action. | **CLOSED** |
| 8 | Missing DB constraints on background_jobs | LOW | Unchanged. | **UNCHANGED** — minor |

---

## Re-evaluation: BLOCKER 1 → MEDIUM — No Worker

The FE explicitly called out "worker loop deferred to follow-up issue (VOY-1493)" in the M1 completion summary. This is a scope decision, not an oversight. Reasons it's safe:

1. **ActivitySearchPanel is unreferenced** — grep confirms zero imports outside its own file. No page loads it, no route calls it.
2. **`researchApi.searchActivities` is unreferenced** — only exported from the API index, not consumed.
3. **`backgroundJobsApi` is unreferenced** — only exported, not consumed.
4. **`useJobStatus` is unreferenced** — only imported by ActivitySearchPanel.

The infrastructure (table, migration, service, routes, UI components) is additive — no existing code is broken. The API endpoints exist but nothing calls them. The dormant pipeline is safe to land as long as no UI wires it in before the worker exists.

**Why MEDIUM and not ACCEPT:** Two risks remain:
- **API DoS vector:** `POST /api/companies/:companyId/research/activities` is open to any authenticated agent/user with company_scope:read. An agent could enqueue thousands of `research.activity_search` jobs, bloating the table. The general `POST /background-jobs` is board-only, but the research route is not. When the worker arrives, it would process all queued jobs — potential backlog.
- **Uncommitted code:** The M1 feature files exist only in the working tree (untracked). If the branch is switched or reset, ALL M1 code is permanently lost. The FE should commit the code before marking M1 done.

---

## New findings from this review pass

### MEDIUM: POST /research/activities authz inconsistency

**File:** `server/src/routes/research.ts`

The research route uses `assertCompanyScopeReadAllowed` to gate a **write** operation (creating a background job). This is a semantic mismatch — creating a job is a mutation, not a read. The route also does NOT require board-level auth (unlike the general `POST /background-jobs` which is board-only). Any agent or user with `company_scope:read` can enqueue research jobs.

While the current risk is low (no worker), the inconsistency should be resolved before M2 lands. Either:
- Require the same board-level auth as the general create route, or
- Create a specific permission like `background_job:create` and use it

### MEDIUM: SSE endpoint skips company_scope:read check

**File:** `server/src/routes/background-jobs.ts` (lines 61-85)

The SSE `/events` route calls `assertAuthenticated` + `assertCompanyAccess` but does NOT call `assertCompanyScopeReadAllowed`. The list and get-by-id routes DO check this permission. Inconsistency: an authenticated user with basic company access can subscribe to SSE and receive job status events, even if they lack `company_scope:read`. Fix: add the same scope check.

### LOW: Uncommitted feature code

The working tree contains the entire M1 implementation as **untracked files** — `git status` shows them as `??` (new, uncommitted). The modified glue files (index.ts exports, app.ts, constants.ts) are also uncommitted (`M` prefixed with space, not staged). The feature has zero durability — a `git checkout` or `git stash` destroys it.

Before marking M1 as done, the FE should commit the code. This is a basic engineering practice — "done" means committed and pushed, not sitting in the working tree.

---

## Summary: Conditions for approval

**M1 infrastructure is conditionally approved** for the `fix/m-series-tech-debt` branch, subject to the following conditions that must be resolved before this branch ships:

| # | Condition | Severity | Owner |
|---|---|---|---|
| C1 | M1 code must be committed (not working-tree-only) | REQUIRED | FE |
| C2 | `prepare: false` in client.ts must have a documented rationale | REQUIRED | FE |
| C3 | M2 (VOY-1493) must be tracked and in progress before any UI wires into the background-jobs API | REQUIRED | FE/CTO |
| C4 | Authz inconsistency on research route (read permission used for write) | RECOMMENDED | FE |
| C5 | SSE endpoint missing company_scope:read check | RECOMMENDED | FE |
| C6 | Add tests for background-jobs/research modules | RECOMMENDED | FE |
| C7 | Add CHECK constraints on background_jobs.status and background_jobs.progress | OPTIONAL | FE |

**Conditions C1-C3 are REQUIRED before shipping.** C4-C7 are recommended but can be deferred to M2.

**Routing:** Send to CTO for final sign-off with this review attached.