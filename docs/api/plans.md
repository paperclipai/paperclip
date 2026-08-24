---
title: Plan Documents
summary: Structured plan documents with revision history, milestones, sections, and approval gates
version: v0.4.0-alpha
last_updated: 2026-08-16
---

# Plan Documents

Plan documents are structured, revisioned issue artifacts that represent an implementation plan. They support sections, milestones, revision diffing, and approval review gates.

## Key Concepts

| Concept | Description |
|---|---|
| **Plan Document** | A revisioned document on an issue with key `plan`. Contains structured metadata (sections, milestones) in addition to a free-form markdown body. |
| **Section** | A named block within the plan metadata with a title, body, and display order. |
| **Milestone** | A named checkpoint with acceptance criteria, status tracking (`pending`, `in_progress`, `completed`, `cancelled`), and order. |
| **Revision** | Each update creates or supersedes a revision. Plan revisions can be compared with diff endpoints. |
| **Review Gate** | An approval checkpoint on a plan revision. Gates are created per-revision and must be approved before the plan can be considered fully accepted. |
| **Plan Status** | Overall plan status: `draft` → `in_review` → `approved` → `superseded`. A plan auto-transitions to `approved` when all its gates for the current revision are approved. |
| **Accepted Plan Decomposition** | When a plan is approved, agents can request board acceptance via a `request_confirmation` interaction. Once a board user accepts, the agent can create child issues from the approved plan via the accepted plan decomposition workflow. Agents cannot accept — human board interaction is required. |

## Create/Update Plan Document

```text
POST /issues/{issueId}/documents/plan
{
  "title": "Implement caching layer",
  "body": "# Caching Implementation\n\n## Overview\n...",
  "changeSummary": "Added Redis integration details",
  "baseRevisionId": null,
  "planMetadata": {
    "version": 1,
    "status": "draft",
    "sections": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "title": "Overview",
        "body": "High-level approach...",
        "order": 0
      },
      {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "title": "Implementation Steps",
        "body": "1. Add Redis client\n2. Create cache service...",
        "order": 1
      }
    ],
    "milestones": [
      {
        "id": "660e8400-e29b-41d4-a716-446655440000",
        "title": "Redis integration complete",
        "description": "Redis client configured and connected",
        "status": "pending",
        "order": 0,
        "acceptanceCriteria": [
          "Redis client connects successfully",
          "Cache service handles connection failures gracefully"
        ]
      }
    ]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `title` | string? | Optional document title (max 200 chars) |
| `body` | string (required) | Free-form plan body in markdown (max 524288 chars) |
| `changeSummary` | string? | Summary of what changed in this revision (max 500 chars) |
| `baseRevisionId` | UUID? | Required for updates — the current latest revision ID. Omit for new documents. Stale IDs return 409 Conflict. |
| `planMetadata` | object? | Structured plan metadata (see below) |

### PlanMetadata

| Field | Type | Description |
|---|---|---|
| `version` | number (literal `1`) | Schema version |
| `status` | enum | Plan status: `draft`, `in_review`, `approved`, `superseded` (default: `draft`) |
| `sections` | PlanSection[] | Ordered sections (max 100) |
| `milestones` | PlanMilestone[] | Ordered milestones with acceptance criteria (max 50) |

### PlanSection

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Unique section identifier |
| `title` | string | Section title (1-200 chars) |
| `body` | string | Section body (max 524288 chars) |
| `order` | integer | Display order (0-indexed) |

### PlanMilestone

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Unique milestone identifier |
| `title` | string | Milestone title (1-200 chars) |
| `description` | string? | Optional description (max 5000 chars) |
| `status` | enum | `pending`, `in_progress`, `completed`, `cancelled` (default: `pending`) |
| `order` | integer | Display order (0-indexed) |
| `acceptanceCriteria` | string[] | Criteria that define milestone completion (max 50 items) |

**Response**: Returns the document with `201 Created` on first creation or `200 OK` on update.

## Get Plan Document

```text
GET /issues/{issueId}/documents/plan
```

Returns the current plan document for the issue, including full `body`, `title`, `planMetadata`, and `latestRevisionId`.

Returns `404` if no plan document exists for the issue.

## List Plan Revisions

```text
GET /issues/{issueId}/documents/plan/revisions
```

Lists all revisions of the plan document for the issue, ordered by creation date descending.

## Diff Plan Revisions

```text
GET /issues/{issueId}/documents/plan/revisions/{revisionId}/diff?againstRevisionId={againstRevisionId}
```

| Query Param | Type | Description |
|---|---|---|
| `againstRevisionId` | UUID | (Optional) The revision to diff against. If omitted, diffs against the previous revision. |

Returns a structured diff between two plan revisions.

**Response**: Returns a `PlanRevisionDiff` object:

```json
{
  "revision": {
    "id": "uuid-of-target-revision",
    "revisionNumber": 3
  },
  "previousRevision": {
    "id": "uuid-of-compared-revision",
    "revisionNumber": 2
  },
  "bodyDiff": [
    {
      "type": "unchanged",
      "value": "Step 1: Set up Redis client",
      "oldLineNumber": 1,
      "newLineNumber": 1
    },
    {
      "type": "added",
      "value": "Step 2: Create cache service",
      "newLineNumber": 2
    },
    {
      "type": "removed",
      "value": "Step 2: Evaluate Redis options",
      "oldLineNumber": 2
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `revision` | `{ id, revisionNumber }` | The target revision the diff was computed for |
| `previousRevision` | `{ id, revisionNumber } | null` | The revision compared against. `null` when this is the first revision. |
| `bodyDiff` | `PlanBodyDiffLine[]` | Line-level diff of the plan body. Each line has `type` (`added`, `removed`, or `unchanged`), `value` (the line text), and optional `oldLineNumber`/`newLineNumber` for position tracking. |

## Create Plan Review Gate

```text
POST /issues/{issueId}/plan/gates
{
  "milestoneId": "660e8400-e29b-41d4-a716-446655440000",
  "acceptanceCriteria": [
    "Redis client connects successfully",
    "Cache service handles connection failures gracefully"
  ],
  "assignedAgentId": "agent-uuid"
}
```

| Field | Type | Description |
|---|---|---|
| `milestoneId` | UUID? | Optional — associates the gate with a specific milestone |
| `acceptanceCriteria` | string[] | Criteria that must be met for gate approval (max 50 items) |
| `assignedAgentId` | UUID? | Optional — assigns gate resolution to a specific agent |

**Response**: `201 Created` — returns the created gate.

**Note**: Created gates are automatically linked to the current (latest) plan revision. When a new plan revision is created, existing pending gates for previous revisions are auto-superseded.

## List Plan Review Gates

```text
GET /issues/{issueId}/plan/gates?revisionId={revisionId}
```

| Query Param | Type | Description |
|---|---|---|
| `revisionId` | UUID | (Optional) Filter gates by revision. If omitted, returns gates for all revisions. |

Returns gates for the issue. Gate statuses: `pending`, `approved`, `rejected`, `superseded`.

## Resolve Plan Review Gate

```text
PATCH /issues/{issueId}/plan/gates/{gateId}
{
  "status": "approved",
  "resolutionComment": "All criteria verified — Redis integration is solid."
}
```

| Field | Type | Description |
|---|---|---|
| `status` | enum (required) | `approved` or `rejected` |
| `resolutionComment` | string? | Optional context for the resolution (max 4000 chars) |

**Response**: Returns the resolved gate and the overall approval status for the revision.

```json
{
  "gate": {
    "id": "uuid",
    "companyId": "uuid",
    "documentId": "uuid",
    "revisionId": "uuid",
    "milestoneId": "uuid",
    "status": "approved",
    "acceptanceCriteria": ["...", "..."],
    "assignedAgentId": "uuid",
    "createdByAgentId": "uuid",
    "resolvedByAgentId": "uuid",
    "resolvedByUserId": null,
    "resolvedAt": "2026-08-16T00:00:00.000Z",
    "resolutionComment": "All criteria verified — Redis integration is solid.",
    "supersededByGateId": null,
    "createdAt": "2026-08-15T00:00:00.000Z",
    "updatedAt": "2026-08-16T00:00:00.000Z"
  },
  "allApproved": true
}
```

| Field | Type | Description |
|---|---|---|
| `gate` | PlanReviewGate | The resolved gate, now with updated status and resolution fields |
| `allApproved` | boolean | `true` when all gates for the current revision are approved (zero pending, zero rejected) and the plan is ready for decomposition |

**Behavior**:
- When `allApproved` is `true`, the plan status auto-transitions to `approved`. A rejected gate (even if all other gates are approved) prevents auto-approval — the plan stays `in_review` until the rejection is resolved by creating a new revision.
- Agents are woken (`issue_plan_gate_resolved`) on gate resolution so they can react to the outcome.
- A live `plan.gate_resolved` event is emitted for real-time UI updates.

## List Accepted Plan Decompositions

```text
GET /issues/{issueId}/accepted-plan-decompositions
```

Returns all child issues created from approved plan decompositions for this issue.

## Create Accepted Plan Decomposition

```text
POST /issues/{issueId}/accepted-plan-decompositions
{
  "acceptedPlanRevisionId": "revision-uuid",
  "milestoneId": "milestone-uuid",
  "children": [
    {
      "title": "Set up Redis client",
      "assigneeAgentId": "agent-uuid",
      "projectId": "project-uuid",
      "status": "todo"
    },
    {
      "title": "Create cache service",
      "assigneeAgentId": "agent-uuid",
      "projectId": "project-uuid",
      "status": "todo"
    }
  ]
}
```

Creates child issues from an accepted (approved) plan. The `acceptedPlanRevisionId` must reference a plan revision whose gates are all approved.

| Field | Type | Description |
|---|---|---|
| `acceptedPlanRevisionId` | UUID (required) | The plan revision that was approved |
| `milestoneId` | UUID? | Optional milestone to associate with the decomposition |
| `children` | ChildIssue[] | Child issues to create (see Issue Create API for fields) |

**Response**: `201 Created` — returns the created child issues.

**Requirement — accepted plan confirmation**: Decomposition is only possible after a human (board user) has **accepted a plan confirmation interaction** for that exact plan revision. The flow is:

1. An agent creates a `request_confirmation` interaction on the issue with a target of `{ "type": "issue_document", "key": "plan", "issueId": "...", "revisionId": "..." }` — the `revisionId` must be the latest plan revision. The interaction is the explicit waiting path; the issue is moved to `in_review`.
2. A **board user** accepts the confirmation via the board UI (`POST /issues/{id}/interactions/{interactionId}/accept`). **Agents cannot accept plan confirmations** — `assertBoard` requires a human user. (Task watchdogs may only accept when the plan is eligible under their contract; otherwise the board decides.)
3. Once accepted, agents can call this decomposition endpoint with the accepted `acceptedPlanRevisionId`.

If the plan revision is superseded by a newer revision before acceptance, the pending interaction expires with `outcome: "stale_target"` — create a fresh confirmation against the new revision. If a board/user comment lands while the confirmation is pending, it is superseded (`superseded_by_comment`) and must be re-created.

**Errors**:
- `422 Unprocessable Entity` — `"acceptedPlanRevisionId must have an accepted plan confirmation"` — no accepted `request_confirmation` interaction targets this revision. Have a board user accept the plan confirmation first.
- `422 Unprocessable Entity` — `"acceptedPlanRevisionId must belong to the source issue's plan document"` — the revision is not from this issue's plan document.
- `409 Conflict` — `"Accepted-plan decomposition already exists for this revision with a different child set"` — decomposition is idempotent per revision; a retry with a different child set is rejected.

## Plan Lifecycle

```text
draft ──> in_review ──> approved ──> superseded
                │                          │
                └── (gates are created)     └── (newer revision supersedes)
                     │
                all gates approved
                     │
                plan status → approved
                     │
                board accepts plan confirmation
                     │
                decomposition allowed
```

- Plans start as `draft`
- Review gates keep the plan in `in_review` until all are approved
- Once all gates for the current revision approve, plan auto-transitions to `approved`
- `approved` alone is not enough to decompose — a board user must accept the plan confirmation (`request_confirmation` targeting the approved revision) first. Agents cannot accept; this requires human board interaction.
- Once accepted, approved plans can be decomposed into child issues
- Newer revisions supersede older ones (gates on previous revisions are auto-superseded)

## Agent Events

| Event | Triggered When |
|---|---|
| `issue_plan_updated` | Plan document created or updated — wakes the issue assignee |
| `issue_plan_gate_resolved` | A review gate is approved or rejected — wakes the issue assignee |
| `plan.updated` | Live event (WebSocket) — real-time UI update |
| `plan.gate_created` | Live event (WebSocket) — emitted when a review gate is created |
| `plan.gate_resolved` | Live event (WebSocket) — real-time UI gate status update |