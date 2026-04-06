# Deliverables System Design

**Date:** 2026-04-03
**Status:** Approved
**Approach:** New Deliverables System + Link to Existing Entities (Approach C)

## Overview

A dedicated deliverables management system where the CEO (user) can review, comment on, and approve final outputs produced by agents. Deliverables can be tied to issues, grouped by project, or standalone. They support multi-stage review pipelines with auto-wake agent notifications and CEO override capabilities.

## Goals

1. Provide a central place to view all agent-produced outputs awaiting review
2. Support multi-stage review pipelines (customizable per deliverable, per project, or via reusable templates)
3. Auto-notify agents when changes are requested; allow CEO to reassign
4. Support rich content: files, URLs, markdown, code references, embedded previews
5. Integrate with existing inbox, dashboard, and activity systems

## Data Model

### `deliverables` table

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| companyId | uuid FK → companies | Required, onDelete: cascade |
| projectId | uuid FK → projects | Optional, onDelete: set null |
| issueId | uuid FK → issues | Optional, onDelete: set null |
| title | text | Required |
| description | text | Markdown, optional |
| type | text | `code`, `document`, `deployment`, `mixed` |
| status | text | `draft`, `in_review`, `changes_requested`, `approved`, `rejected` |
| priority | text | `critical`, `high`, `medium`, `low` |
| currentStageIndex | integer | Which review stage is active (0-based) |
| reviewPipelineTemplateId | uuid FK → review_pipeline_templates | Optional, onDelete: set null |
| submittedByAgentId | uuid FK → agents | Nullable, onDelete: set null |
| submittedByUserId | text | Nullable (text, matches codebase user ID convention) |
| dueAt | timestamptz | Optional deadline |
| submittedAt | timestamptz | When submitted for review |
| approvedAt | timestamptz | When final stage approved |
| rejectedAt | timestamptz | When rejected |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** companyId + status, companyId + projectId, companyId + issueId, submittedByAgentId

**Status transitions:**
- `draft` → `in_review` (agent/user submits via `/submit` — atomically enters first stage)
- `in_review` → `approved` (final stage passes; or auto-approved if zero stages)
- `in_review` → `changes_requested` (reviewer requests changes)
- `in_review` → `rejected` (reviewer rejects)
- `changes_requested` → `in_review` (agent resubmits)
- `rejected` → `in_review` (reopened)

**Zero-stage deliverables:** When a deliverable has no review stages and `/submit` is called, it auto-approves immediately (status goes directly to `approved`).

### `deliverable_contents` table

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| deliverableId | uuid FK → deliverables | Required |
| kind | text | `file`, `url`, `markdown`, `code_ref`, `preview` |
| title | text | Display name |
| body | text | For markdown content |
| url | text | For url, preview, code_ref kinds |
| filePath | text | For file kind (server storage path) |
| originalFilename | text | For file kind |
| mimeType | text | For file kind |
| sizeBytes | bigint | For file kind (bigint with mode: "number", matches artifacts pattern) |
| metadata | jsonb | Flexible: branch, commit SHA, diff URL, deploy env, etc. |
| sortOrder | integer | Display ordering |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** deliverableId (onDelete: cascade from deliverables)

### `deliverable_review_stages` table

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| deliverableId | uuid FK → deliverables | Required, onDelete: cascade |
| stageIndex | integer | 0-based ordering |
| label | text | e.g., "QA Review", "CEO Approval" |
| reviewerAgentId | uuid FK → agents | Nullable, onDelete: set null |
| reviewerUserId | text | Nullable (text, matches codebase convention) |
| status | text | `pending`, `approved`, `changes_requested`, `rejected`, `skipped` |
| decisionNote | text | Reviewer's feedback |
| decidedAt | timestamptz | When decision was made |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** deliverableId + stageIndex (unique)

**Reviewer deleted:** If an agent reviewer is deleted, `reviewerAgentId` is set to null. A stage with no reviewer becomes unassigned — the CEO (user) must reassign it or skip the stage to unblock the pipeline.

### `deliverable_comments` table

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| deliverableId | uuid FK → deliverables | Required, onDelete: cascade |
| stageId | uuid FK → deliverable_review_stages | Optional, onDelete: set null |
| authorAgentId | uuid FK → agents | Nullable, onDelete: set null |
| authorUserId | text | Nullable (text, matches codebase convention) |
| body | text | Markdown |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** deliverableId

### `review_pipeline_templates` table

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| companyId | uuid FK → companies | Required, onDelete: cascade |
| name | text | e.g., "Quick Review", "Full QA Pipeline" |
| description | text | Optional |
| stages | jsonb | Array of `{ label, reviewerAgentId?, reviewerUserId?, role? }`. When instantiated, agent/user IDs are validated; missing reviewers fall back to `role` field for assignment at review time. |
| isDefault | boolean | One per company can be default |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** companyId

### `project_review_defaults` table

| Column | Type | Notes |
|--------|------|-------|
| projectId | uuid PK FK → projects | onDelete: cascade |
| companyId | uuid FK → companies | Required, onDelete: cascade, for query efficiency (matches codebase pattern) |
| reviewPipelineTemplateId | uuid FK → review_pipeline_templates | onDelete: cascade |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

**Indexes:** companyId

## Review Pipeline Flow

```
Agent completes work
       |
       v
Creates Deliverable (status: draft)
  - Attaches content (files, URLs, code refs, markdown, previews)
  - Pipeline assigned from: custom stages > project default > company default template
       |
       v
Agent submits (status: draft -> in_review, atomic)
  - If zero stages: auto-approve immediately (draft -> approved)
  - Otherwise: Stage 0 reviewer gets notified (inbox + dashboard widget)
       |
       v
Stage N reviewer acts:
  |-- Approve -> moves to Stage N+1 (next reviewer notified)
  |-- Request Changes -> status: changes_requested
  |     |-- Auto-wake original agent with feedback (default)
  |     |-- CEO/user can reassign to different agent
  |           |
  |     Agent revises, resubmits -> back to current stage
  |-- Reject -> status: rejected (terminal, can be reopened)
       |
       v
Final stage approved -> status: approved
  - If linked to issue: issue can auto-transition to "done" (configurable)
  - Activity logged, inbox notification sent
```

### Agent Auto-Wake on "Request Changes"

Uses the existing heartbeat wake system. Wake context payload:

```json
{
  "wakeReason": "deliverable_changes_requested",
  "deliverableId": "uuid",
  "deliverableTitle": "Login Page Redesign",
  "stageLabel": "QA Review",
  "reviewerNote": "The login form is missing error states...",
  "issueId": "uuid or null"
}
```

### CEO Override

At any stage, the CEO (user) or CEO agent can:
- Reassign the deliverable to a different agent
- Skip a stage (mark as skipped, advance to next)
- Add or remove stages mid-review
- Force-approve or force-reject

## API Endpoints

### Deliverables CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/companies/:companyId/deliverables` | List deliverables. Filters: status, projectId, issueId, submittedByAgentId, reviewerMe |
| POST | `/companies/:companyId/deliverables` | Create deliverable |
| GET | `/deliverables/:id` | Get deliverable detail (includes contents, stages, comments) |
| PATCH | `/deliverables/:id` | Update title, description, priority, dueAt |
| DELETE | `/deliverables/:id` | Soft-delete |

### Content Management

| Method | Path | Description |
|--------|------|-------------|
| POST | `/deliverables/:id/contents` | Add content item |
| PATCH | `/deliverables/:id/contents/:contentId` | Update content |
| DELETE | `/deliverables/:id/contents/:contentId` | Remove content |

### Lifecycle Actions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/deliverables/:id/submit` | Submit for review (draft -> in_review; auto-approves if zero stages) |
| POST | `/deliverables/:id/stages/:stageId/approve` | Approve current stage |
| POST | `/deliverables/:id/stages/:stageId/request-changes` | Request changes + auto-wake agent |
| POST | `/deliverables/:id/stages/:stageId/reject` | Reject |
| POST | `/deliverables/:id/stages/:stageId/skip` | Skip a stage (CEO override) |
| POST | `/deliverables/:id/reassign` | Reassign to different agent |
| POST | `/deliverables/:id/reopen` | Reopen rejected deliverable |

### Comments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/deliverables/:id/comments` | List comments |
| POST | `/deliverables/:id/comments` | Add comment |

### Review Stages (per-deliverable customization)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/deliverables/:id/stages` | Add stage |
| PATCH | `/deliverables/:id/stages/:stageId` | Edit stage |
| DELETE | `/deliverables/:id/stages/:stageId` | Remove stage |

### Pipeline Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/companies/:companyId/review-templates` | List templates |
| POST | `/companies/:companyId/review-templates` | Create template |
| PATCH | `/review-templates/:id` | Update template |
| DELETE | `/review-templates/:id` | Delete template |

### Project Defaults

| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects/:projectId/review-defaults` | Get project default pipeline |
| PUT | `/projects/:projectId/review-defaults` | Set project default pipeline |

## UI Design

### 1. Dedicated Sidebar Page — `/deliverables`

New top-level sidebar item with a `PackageCheck` icon, placed in the "Work" section between "Artifacts" and "Deployments".

**Three tab views:**

- **Review Queue** (default): Deliverables waiting for the current user's action, sorted by priority then due date. Each card shows title, submitter agent name + icon, project name, current stage label, content type icons, and time waiting.

- **All Deliverables**: Full list with filters (status, project, agent, type, date range). Supports table and card toggle views.

- **Templates**: Manage review pipeline templates. Each template shows its stages visually as a horizontal pipeline with reviewer names.

### 2. Deliverable Detail View

Accessed by clicking a deliverable from any list.

- **Header**: Title, status badge, priority badge, linked issue/project breadcrumbs, due date
- **Content panel**: Tabbed view of attached content items. Files show download links, markdown renders inline, URLs show link-out buttons, code refs show commit/branch info, preview kind shows an iframe.
- **Review pipeline visualization**: Horizontal stage tracker. Completed stages show green checkmark, current stage is highlighted with arrow, upcoming stages show grey circles. Each stage shows reviewer name.
- **Action bar** (visible to current stage reviewer): Approve / Request Changes / Reject buttons. Reassign dropdown for CEO override.
- **Comment thread**: Threaded discussion below the action bar. Comments can be filtered by stage. Agent and user messages use the same enhanced visual distinction as CEO Chat (violet for agents, blue for user).

### 3. Dashboard Widget — "Pending Reviews"

A compact card on the main Dashboard page showing:
- Count of deliverables needing the user's review
- Top 3-5 items with title, submitter agent, and wait time
- "View All" link navigating to the deliverables review queue

### 4. Inbox Integration

New inbox item types:
- `deliverable_needs_review` — when a deliverable reaches a stage where you are the reviewer
- `deliverable_approved` — when your submitted deliverable is fully approved
- `deliverable_changes_requested` — when changes are requested on your deliverable

Clicking an inbox item navigates to the deliverable detail view.

### 5. Issue Detail Integration

New "Deliverables" tab on the existing issue detail page:
- Lists all deliverables linked to that issue
- Quick-create button to make a new deliverable from the issue context
- Shows deliverable status inline

## Integration with Existing Systems

### Heartbeat Wake System
- "Request Changes" action calls the existing `heartbeat.wakeup()` with deliverable-specific context
- Agent receives feedback and can revise + resubmit

### Activity Log
- All deliverable actions logged via existing `logActivity()` pattern
- Entity type: `deliverable`
- Actions: `deliverable.created`, `deliverable.submitted`, `deliverable.stage_approved`, `deliverable.changes_requested`, `deliverable.rejected`, `deliverable.approved`, `deliverable.reassigned`, `deliverable.comment_added`

### Inbox
- Leverages existing inbox notification system
- New notification types added for deliverable review actions

### Issue Status
- When a deliverable linked to an issue gets fully approved, the issue can optionally auto-transition to `done` (configurable per deliverable or project)
- When an agent submits a deliverable for an issue, the issue can auto-transition to `in_review`

## File Structure (New Files)

```
packages/db/src/schema/deliverables.ts
packages/db/src/schema/deliverable_contents.ts
packages/db/src/schema/deliverable_review_stages.ts
packages/db/src/schema/deliverable_comments.ts
packages/db/src/schema/review_pipeline_templates.ts
packages/db/src/schema/project_review_defaults.ts
packages/db/src/migrations/NNNN_deliverables.sql     (number is placeholder, use next available)
packages/shared/src/types/deliverable.ts
server/src/services/deliverables.ts
server/src/routes/deliverables.ts                   (export: deliverableRoutes)
server/src/routes/review-templates.ts               (export: reviewTemplateRoutes)
ui/src/api/deliverables.ts
ui/src/api/reviewTemplates.ts
ui/src/pages/Deliverables.tsx                       (main page with tabs)
ui/src/pages/DeliverableDetail.tsx                  (detail view)
ui/src/components/DeliverableCard.tsx
ui/src/components/DeliverableStatusBadge.tsx
ui/src/components/ReviewPipelineVisualizer.tsx       (horizontal stage tracker)
ui/src/components/DeliverableContentPanel.tsx        (tabbed content viewer)
ui/src/components/ReviewActionBar.tsx                (approve/reject/request changes)
ui/src/components/PendingReviewsWidget.tsx           (dashboard widget)
```

## Modified Files

```
packages/db/src/schema/index.ts                     (export new schemas)
packages/shared/src/types/index.ts                  (export new types)
packages/shared/src/constants.ts                    (add deliverable constants)
server/src/routes/index.ts                          (register new routes)
server/src/app.ts                                   (mount new routes)
server/src/services/index.ts                        (export new service)
ui/src/App.tsx                                      (add routes + redirect)
ui/src/components/Sidebar.tsx                       (add nav item)
ui/src/lib/queryKeys.ts                             (add deliverable keys)
ui/src/pages/Dashboard.tsx                          (add widget)
ui/src/pages/IssueDetail.tsx                        (add Deliverables tab)
```

## Non-Goals (Explicitly Out of Scope)

- File upload storage system (reuse existing asset/attachment infrastructure)
- Real-time collaborative editing of deliverable content
- Version history / diffing of deliverable revisions (can be added later)
- External webhook notifications (email, Slack) for review actions
- Automated testing / CI integration for code-type deliverables
