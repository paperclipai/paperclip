# 07-XORG — Implementation Plan (sketch for the architect pass)

## Phase 1 — Relations schema + validation
1. Inspect `issueRelations` schema (companyId, relatedIssueId, type). Choose representation:
   - Option A (preferred, least churn): keep `companyId` = the *dependent* issue's company; add
     nullable `relatedCompanyId` (backfill = companyId). Lookups by `relatedIssueId` become
     global.
   - Option B: drop company scoping from the table entirely and derive from joined issues.
2. Drizzle migration + backfill.
3. `issues.ts` blocker-set path: resolve blocker ids with a global `inArray(issues.id, deduped)`
   (no company filter); collect each blocker's companyId for the relation rows.
4. `assertNoBlockingCycles`: remove the companyId narrowing from graph traversal; bound depth to
   protect against pathological graphs.

## Phase 2 — Auto-resume across companies
5. Find the on-`done` unblock/wake hook (search: where issue status transition to `done` queries
   `issueRelations` type `blocks`). Make the dependent lookup global; ensure the wake targets the
   dependent issue's own company context (assignee agent heartbeat, notifications).
6. Regression: same-company unblock behavior unchanged.

## Phase 3 — Cross-org create/comment authz
7. `middleware/auth.ts`: agent principal currently carries a single `companyId`. Introduce a
   capability on the request context: `canWriteForeignCompany(kind: 'create_issue'|'comment')`
   — true for agent principals when the target company's policy allows (default true).
8. Route guards for `POST /companies/:companyId/issues` and `POST /issues/:issueId/comments`:
   accept foreign agents through the capability; all other issue mutations keep the strict
   same-company check.
9. Attribution: persist `createdByAgentId` as-is; add origin-company to the audit/metadata so
   the UI can badge "filed by COM/CMO" on a LEA issue.
10. Policy seam: `companies` settings JSON gains `allowCrossCompanyIssueCreation` (default true);
    single read in the capability check.

## Phase 4 — Read side + tests
11. Issue GET/serializers: identifiers for foreign blockers (prefix rendering) — verify the
    identifier lookup isn't company-scoped in the serializer.
12. Full test matrix from the task ACs (9 items) + regression run.

## Risks
- Hidden company-scoped queries on issueRelations elsewhere (pipelines.ts, issue-approvals.ts,
  issue-thread-interactions.ts all reference relations — audit each).
- Cycle detection performance once global: keep the traversal bounded and indexed.
- Webhooks/notifications assuming same-company context on unblock events.
