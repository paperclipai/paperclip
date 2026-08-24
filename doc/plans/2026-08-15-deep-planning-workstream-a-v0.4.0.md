# Workstream A: Deep Planning — Technical Execution Plan

**Date**: 2026-08-15
**Author**: CTO (Voyonder)
**Status**: Technical Plan (pending implementation)
**Part of**: Project Polaris (VOY-1184)
**Target Release**: v0.4.0

---

## 1. Current-State Assessment

### 1.1 What Already Exists

The Paperclip codebase already has a generic document system that serves as the foundation:

| Component | Location | Description |
|---|---|---|
| `documents` table | `packages/db/src/schema/documents.ts` | Generic document storage with title, latestBody, format, revision tracking, locking, sourceTrust |
| `document_revisions` table | `packages/db/src/schema/document_revisions.ts` | Full revision history — body, revisionNumber, changeSummary, author attribution |
| `issue_documents` table | `packages/db/src/schema/issue_documents.ts` | Links documents to issues with a unique `key` (e.g. "plan") |
| `issue_plan_decompositions` table | `packages/db/src/schema/issue_plan_decompositions.ts` | Links accepted plan revisions to child issues with status tracking |
| `documentService` | `server/src/services/documents.ts` | Full CRUD: upsert, restore revision, lock/unlock, delete, list revisions |
| `isSystemIssueDocumentKey` | `packages/shared/src/constants.ts` | System doc keys: `continuation-summary`, `pipeline-case-body`. "plan" is NOT a system key |
| Plan review context builder | `server/src/services/plan-review-context.ts` | Builds structured context for codex prompts including threads, comments, annotation anchors |
| Accepted plan confirmation | `server/src/services/issue-thread-interactions.ts` | `request_confirmation` interaction can target an issue document revision; `findAcceptedPlanDocumentInteraction` validates acceptance |
| Legacy plan extraction | `server/src/services/documents.ts` `extractLegacyPlanBody` | Extracts `<plan>` tags from issue description for backward compat |
| `planDocument` in issue response | `packages/shared/src/types/issue.ts` | `IssuePayload.planDocument` already wired into issue retrieval |

### 1.2 Key Gaps

| Capability | Status | Gap |
|---|---|---|
| Plan body text with revision history | ✅ Done | Documents + revisions work generically |
| Plan→Issue decomposition | ⚠️ Partial | Issue exists on DB schema level; creation flow not well-connected to milestones |
| Structured plan sections/milestones | ❌ Missing | Plan is freeform markdown; no schema for sections, milestones, status |
| Plan revision diffs | ❌ Missing | Revisions saved but no diff endpoint or inline diff rendering |
| Plan-level review gates with acceptance criteria | ⚠️ Partial | `request_confirmation` exists but no structured acceptance criteria |
| Board UI for plan browsing | ❌ Missing | No plan browsing surface on the board |
| Plan document key as system key | ❌ Not needed | "plan" is intentionally user-facing, not system-managed |

---

## 2. Architecture & Data Model

### 2.1 Core Principle: Extend, Don't Replace

The existing document system is already designed to support typed documents via the `key` column on `issue_documents`. We extend it with structured metadata rather than introducing a parallel "plan" table hierarchy. This preserves:

- Single document revision chain (revision history for free)
- Document locking semantics (lock before editing)
- Source trust tracking
- Revision restore operations

### 2.2 Plan Metadata Schema

Add a `plan_metadata` JSONB column to the `documents` table:

```typescript
// On documents table, nullable JSONB
plan_metadata: {
  sections: PlanSection[];
  milestones: PlanMilestone[];
  status: 'draft' | 'in_review' | 'approved' | 'superseded';
  version: 1; // schema version for migration
}

type PlanSection = {
  id: string;               // stable UUID for cross-referencing
  title: string;
  body: string;             // markdown section body
  order: number;
};

type PlanMilestone = {
  id: string;               // stable UUID
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  order: number;
  acceptanceCriteria?: string[]; // structured ACs for review gates
};
```

**Why JSONB and not a separate table:**
- `documents` already has JSONB columns (`source_trust`)
- Plan metadata is fundamentally coupled to the document lifecycle (revisions, locking)
- No separate migration for plan-specific CRUD
- The `latestBody` remains the freeform markdown body; `plan_metadata.sections` is the structured representation
- When `plan_metadata` changes, a new revision is created (body+metadata snapshot)

**Revision diff handling:** The `body` field in `document_revisions` captures the full markdown at that point. For structured diffs, we add a `plan_metadata` JSONB column to `document_revisions` as well, snapshotting the metadata at revision time.

### 2.3 Plan Review Gates

Add a `plan_review_gates` table to represent structured review gates with acceptance criteria:

```typescript
// New table: plan_review_gates
{
  id: uuid PK;
  companyId: uuid FK -> companies;
  documentId: uuid FK -> documents;        // which plan document
  revisionId: uuid FK -> document_revisions; // which revision this gate targets
  milestoneId: string | null;              // optional: links to milestone.id in plan_metadata
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  acceptanceCriteria: string[];            // the ACs to satisfy
  assignedAgentId?: uuid FK -> agents;     // optional reviewer
  createdByAgentId?: uuid FK -> agents;
  createdByUserId?: text;
  resolvedByAgentId?: uuid FK -> agents;
  resolvedByUserId?: text;
  resolvedAt?: timestamp;
  resolutionComment?: text;
  supersededByGateId?: uuid FK -> plan_review_gates; // linked to newer version
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

Each plan revision creates or supersedes review gates. When a plan is updated (new revision), pending gates from the previous revision are auto-superseded. Approval requires resolving ALL gates assigned to that revision.

### 2.4 Plan→Issue Decomposition with Milestone Links

Extend `issue_plan_decompositions` with a nullable `milestoneId` column:

```typescript
// Add to issue_plan_decompositions:
milestoneId?: text;  // references PlanMilestone.id in the accepted plan_metadata
```

This allows the board UI to render "which milestone does this child issue belong to" and provide milestone-level progress tracking.

### 2.5 Diffs for Plan Revisions

A new service function `computeDocumentDiff(prevRevisionId, currRevisionId)` that:

1. Fetches both `document_revisions.body` and `document_revisions.plan_metadata`
2. Computes line-level text diff using a diff library
3. Returns a structured diff result

The diff computation uses `diff` npm package (check if already a dependency — used in other services). If not, add as peer dependency.

### 2.6 Entity Relationship Diagram (Text)

```
documents (extends with plan_metadata JSONB)
  │
  ├──< document_revisions (extends with plan_metadata JSONB snapshot)
  │
  ├──< issue_documents [key='plan']
  │
  ├──< plan_review_gates (NEW)
  │     └── references revisionId, milestoneId
  │
  └──< issue_plan_decompositions (extends with milestoneId)
        └── references acceptedPlanRevisionId, milestoneId
```

---

## 3. API Surface Changes

### 3.1 New Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/issues/:id/documents/plan/upsert` | Upsert plan with structured metadata (sections, milestones) |
| `GET` | `/api/issues/:id/documents/plan` | Get plan document with parsed metadata |
| `GET` | `/api/issues/:id/documents/plan/revisions` | List plan document revisions |
| `GET` | `/api/issues/:id/documents/plan/revisions/:revId/diff` | Diff two plan revisions |
| `POST` | `/api/issues/:id/plan/gates` | Create review gate on a plan revision |
| `GET` | `/api/issues/:id/plan/gates` | List review gates for current plan revision |
| `PATCH` | `/api/issues/:id/plan/gates/:gateId` | Resolve/reject a review gate |
| `GET` | `/api/issues/:id/plan/decomposition` | Get plan→issue decomposition with milestone grouping |

### 3.2 Modified Endpoints

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/issues/:id` | Include `planDocument.metadata` in response |
| `GET` | `/api/issues/:id/plan/decompositions/children` | Add `milestoneId` filter |

### 3.3 WebSocket / Event Changes

When a plan revision's review gates are resolved:
- Emit `plan:gate-resolved` event to subscribers on the issue

When a plan document is upserted with new metadata:
- Emit `plan:updated` event

---

## 4. Data Flow Diagrams

### 4.1 Plan Creation & Revision Flow

```
Agent writes plan
    │
    ▼
POST /issues/:id/documents/plan/upsert
  │  ├─→ Validate plan_metadata schema
  │  ├─→ If existing plan document:
  │  │     ├─ Lock check (fail if locked)
  │  │     ├─ baseRevisionId conflict check
  │  │     ├─ Insert new document_revision (body + plan_metadata snapshot)
  │  │     └─ Update documents.latestBody, documents.plan_metadata
  │  └─ If no existing plan:
  │        ├─ Insert documents row (body + plan_metadata)
  │        ├─ Insert document_revision (rev 1)
  │        └─ Insert issue_documents (key='plan')
  │
  ▼
Old plan_review_gates for previous revision → superseded
Plan approval gate → pending
    │
    ▼
Emit `plan:updated`

```

### 4.2 Review Gate Resolution Flow

```
Board user or agent resolves a gate
    │
    ▼
PATCH /issues/:id/plan/gates/:gateId
  │  ├─→ Validate gate belongs to current plan revision
  │  ├─→ Set status, resolvedBy, resolutionComment
  │  └─→ Check if ALL gates for this revision are resolved
  │
  ├─→ All gates approved:
  │     ├─ Create `request_confirmation` interaction targeting the plan revision
  │     │  (triggers agent wake for confirmation handling)
  │     └─ Emit `plan:gate-resolved`
  │
  └─→ Gate rejected:
        ├─ Create `request_confirmation` interaction with outcome="rejected"
        └─ Emit `plan:gate-resolved`
```

### 4.3 Plan Decomposition with Milestone Linkage

```
Plan revision is accepted
    │
    ▼
Agent calls POST /issues/:id/plan/decompositions
  │  ├─→ Validates acceptedPlanRevisionId has been confirmed
  │  ├─→ Links milestoneId (from plan_metadata.milestones[].id)
  │  ├─→ Creates issue_plan_decompositions row
  │  └─→ Creates child issues with milestone reference
  │
  ▼
Board UI groups child issues by milestoneId
```

---

## 5. State Transitions

### 5.1 Plan Document States

```
[draft] ──upsert──▶ [in_review] ──all gates pass──▶ [approved]
    ▲                                                    │
    └─────────────── new revision ───────────────────────┘
                                                         │
                                                    [superseded]
                                                    (next revision
                                                     supersedes it)
```

### 5.2 Review Gate States

```
[pending] ──approve──▶ [approved]
[pending] ──reject───▶ [rejected]
[pending|approved|rejected] ──plan updated──▶ [superseded]
```

### 5.3 Milestone States

```
[pending] ──decompose──▶ [in_progress] ──all children closed──▶ [completed]
[pending] ──reject───▶ [cancelled]
```

---

## 6. Edge Cases & Failure Modes

| Scenario | Handling |
|---|---|
| Agent upserts plan while another agent has it locked | Conflict error; caller must retry with baseRevisionId |
| Plan revision updated before gates are resolved | Auto-supersede all pending gates on old revision; new revision starts fresh |
| MilestoneId in decomposition references deleted milestone | Validate milestoneId exists in current plan_metadata; if milestone was removed, return unprocessable |
| Diff between non-adjacent revisions | Supported; diff library handles arbitrary revision pairs |
| Plan metadata JSONB schema evolves | Version field in plan_metadata enables schema migration |
| Empty plan document | Allow empty body but require at least one section if metadata is present |
| Gate assigned to non-existent agent | Validate agentId; return unprocessable if not found |
| Decomposition child count exceeds requested | `issue_plan_decompositions` already enforces `requestedChildCount` |
| Legacy `<plan>` tag plan on migration to structured | `getIssueDocumentPayload` continues to include `legacyPlanDocument` fallback |

---

## 7. Test Coverage Matrix

### 7.1 Unit / Integration Tests

| Test Area | What to Test | Priority |
|---|---|---|
| plan_metadata validation | Schema parse, required fields, max section count | P0 |
| Upsert with structured metadata | Creation, update with baseRevisionId conflict, lock conflict | P0 |
| Review gate lifecycle | Create, approve, reject, supersede, all-gates-approved check | P0 |
| Plan revision diff | Adjacent revisions, non-adjacent, empty old revision | P0 |
| Milestone linkage in decomposition | Create with milestoneId, validate against plan_metadata | P0 |
| Gate supersession on plan update | Old gates auto-superseded, new revision starts fresh | P0 |
| Legacy plan fallback | Existing `<plan>`-tagged issue still returns legacyPlanDocument | P1 |
| Diff endpoint with null plan_metadata | Old revision before structured metadata existed | P1 |
| Concurrent gate resolution | Two simultaneous PATCH on same gate → conflict | P1 |

### 7.2 E2E / Smoke Tests

| Test Area | What to Test | Priority |
|---|---|---|
| Full plan lifecycle | Create plan → add milestones → submit for review → approve gates → accept → decompose | P0 |
| Board browsing | Plan appears in board UI with milestones visible | P0 |
| Gate resolution via board | Board user resolves gate → plan transitions to approved | P1 |

---

## 8. Implementation Phases

### Phase 1: Schema & Data Model (Foundation)
**Assignee**: Founding Engineer
**Review**: Staff Engineer

- Add `plan_metadata` JSONB column to `documents` table (migration)
- Add `plan_metadata` JSONB column to `document_revisions` table (migration)
- Create `plan_review_gates` table (migration)
- Add `milestoneId` to `issue_plan_decompositions` (migration)
- Define shared Zod schemas: `planMetadataSchema`, `planSectionSchema`, `planMilestoneSchema`, `planReviewGateSchema`
- Add `PLAN_REVIEW_GATE_STATUSES` constant

### Phase 2: Backend Service (Plan Management)
**Assignee**: Founding Engineer
**Review**: Staff Engineer

- Extend `documentService` with `upsertPlanDocument` (handles metadata + body in one call)
- Add `listPlanRevisions` method
- Add `computePlanDiff` service function
- Add `planReviewGateService` with: create, list, approve, reject, auto-supersede
- Extend `issuePlanDecompositionService` with milestone support
- Wire auto-supersession when plan is updated (pending gates → superseded)

### Phase 3: API Routes
**Assignee**: Founding Engineer
**Review**: Staff Engineer

- POST /issues/:id/documents/plan/upsert
- GET /issues/:id/documents/plan
- GET /issues/:id/documents/plan/revisions
- GET /issues/:id/documents/plan/revisions/:revId/diff (query: againstRevId)
- POST /issues/:id/plan/gates
- GET /issues/:id/plan/gates
- PATCH /issues/:id/plan/gates/:gateId
- Update issue GET to include plan_metadata

### Phase 4: Codex Agent Skill Integration
**Assignee**: Founding Engineer
**Review**: Staff Engineer

- Extend agent heartbeat plan-review-context to include gate status
- Update codex planning skills to produce structured plan_metadata
- Update createIssueDecomposition to accept milestoneId

### Phase 5: Board UI
**Assignee**: Founding Engineer
**Review**: Staff Engineer

- Plan browsing component on board (list plans with title + status + milestone progress)
- Plan detail view with sections and milestones displayed
- Gate resolution UI (inline approve/reject per gate)
- Milestone progress bar on plan card
- Plan→Issue decomposition view showing issues grouped by milestone

### Phase 6: Release & QA
**Assignee**: Release Engineer / QA Engineer

- Verify migrations on staging DB
- Run full test matrix
- Smoke test: create plan → approve → decompose → land → verify
- Release notes for v0.4.0-alpha

---

## 9. Implementation Order & Blocking Dependencies

```
Phase 1 (Schema) ──blocker──▶ Phase 2 (Services) ──blocker──▶ Phase 3 (Routes)
                                                                    │
                                                                    ├──blocker──▶ Phase 4 (Codex)
                                                                    │
                                                                    └──blocker──▶ Phase 5 (Board UI)

Phase 3 + 4 + 5 ──blocker──▶ Phase 6 (Release & QA)
```

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| JSONB schema drift between code and DB | Low | Medium | Zod validation at write boundary; version field in metadata |
| Board UI scope creep | Medium | Medium | Keep UI minimal: plan list, milestone view, gate buttons. No drag-drop reordering |
| Legacy plan migration complexity | Low | Low | Legacy plan fallback retained; no migration of existing issues required |
| Codex skill must produce structured output | Medium | High | Add plan_metadata builder in codex skill; validate with Zod before write |

---

## 11. Future-Proofing Notes

These design decisions leave room for the other Workstreams and future iterations:

- **Memory Workstream (B)**: Plan metadata JSONB can be extended with memory references or embeddings without schema migration
- **CEO Chat**: Plan document can be rendered in chat as structured summary
- **MAXIMIZER MODE** (out of scope for v0.4.0): Plan sections can be decomposed into work items that MAXIMIZER executes sequentially
- **Self-Organization** (out of scope for v0.4.0): Milestone status tracking provides the progress signal for self-organizing agents to reprioritize