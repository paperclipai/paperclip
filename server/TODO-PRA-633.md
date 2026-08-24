# PRA-633: Deep Planning — v0.4.0-alpha

## Current State (after this heartbeat)

### What exists
Looking at the codebase, the planning system already has significant infrastructure in place as pending changes:

### 1. Structured Plan Document (sections, milestones, status tracking) ✅
- **packages/shared/src/validators/plan.ts**: Schemas for PlanSection, PlanMilestone, PlanMetadata, PlanReviewGate, UpsertPlanDocument, etc.
- **packages/db/src/schema/document_revisions.ts**: `planMetadata` jsonb column added
- **packages/db/src/schema/documents.ts**: `planMetadata` jsonb column added
- **packages/shared/src/validators/issue.ts**: `planMetadata` added to `upsertIssueDocumentSchema` ✅ (this heartbeat)
- **server/src/services/plan-documents.ts**: `planDocumentService` with `upsertPlanDocument`, `getPlanDocument`, `listPlanRevisions`
- **server/src/routes/issues.ts**: 
  - `POST /issues/:id/documents/plan` — Plan upsert with planMetadata ✅
  - `GET /issues/:id/documents/plan` — Get plan document ✅
  - Generic `PUT /issues/:id/documents/:key` — Now passes planMetadata ✅ (this heartbeat)

### 2. Plan Revision History with Diffs ✅
- **server/src/services/plan-documents.ts**: `computePlanDiff` with line-level diff (LCS-based)
- **server/src/routes/issues.ts**: `GET /issues/:id/documents/plan/revisions/:revId/diff` — Plan diff endpoint ✅

### 3. Plan-Level Review Gates ✅
- **packages/db/src/schema/plan_review_gates.ts**: Database table exists
- **server/src/services/plan-review-gates.ts**: `planReviewGateService` with:
  - `supersedeGatesForRevision` — Supersede old gates on plan update ✅ (this heartbeat)
  - `createGate` — Create review gate on current revision ✅ (this heartbeat)
  - `listGates` — List gates for plan document ✅ (this heartbeat)
  - `resolveGate` — Approve/reject gate, auto-supersede others, update plan status ✅ (this heartbeat)
- **server/src/routes/issues.ts**: 
  - `POST /issues/:id/plan/gates` — Create gate ✅
  - `GET /issues/:id/plan/gates` — List gates ✅
  - `PATCH /issues/:id/plan/gates/:gateId` — Resolve gate ✅

### 4. Plan→Issue Decomposition ✅
- Existing `accepted-plan-decompositions` endpoints with milestoneId support
- **DB schema**: `issue_plan_decompositions.milestoneId` column already added
- **Routes**: GET/POST `/issues/:id/accepted-plan-decompositions` already exist

### 5. Board UI for plan browsing and approval ❌ (out of scope for now)
- UI components not yet built — deferred to future workstream

### Files Changed (this heartbeat)
- `packages/shared/src/validators/issue.ts` — Added `planMetadata` to upsertIssueDocumentSchema
- `server/src/services/plan-review-gates.ts` — Full service implementation for review gate CRUD
- `server/src/routes/issues.ts` — Imported plan services, added planMetadata pass-through to generic doc upsert

### Verified
- ✅ TypeScript compilation passes (`npx tsc --noEmit`)

### Next Steps / Future Work
- Build board UI for plan browsing and approval (web UI components)
- E2E testing for plan review gate flows
- Plan document template/seed in onboarding assets