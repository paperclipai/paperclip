# Deliverables System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deliverables management system where users review, comment on, and approve agent-produced outputs through configurable multi-stage review pipelines.

**Architecture:** New DB tables (6 tables via Drizzle ORM) + Express REST API service/routes + React UI pages. Integrates with existing heartbeat wake system for agent notifications, existing inbox for review alerts, and existing activity log for audit trail. Follows the exact patterns established by the artifacts and approvals features.

**Tech Stack:** PostgreSQL (Drizzle ORM), Express 5, React + TanStack Query, TypeScript throughout.

**Spec:** `docs/superpowers/specs/2026-04-03-deliverables-design.md`

---

## Chunk 1: Database Schema & Shared Types

### Task 1: Add shared constants and types

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/types/deliverable.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Add deliverable constants to shared/constants.ts**

Add at the end of `packages/shared/src/constants.ts`:

```typescript
export const DELIVERABLE_TYPES = ["code", "document", "deployment", "mixed"] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const DELIVERABLE_STATUSES = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const DELIVERABLE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type DeliverablePriority = (typeof DELIVERABLE_PRIORITIES)[number];

export const DELIVERABLE_CONTENT_KINDS = ["file", "url", "markdown", "code_ref", "preview"] as const;
export type DeliverableContentKind = (typeof DELIVERABLE_CONTENT_KINDS)[number];

export const DELIVERABLE_STAGE_STATUSES = [
  "pending",
  "approved",
  "changes_requested",
  "rejected",
  "skipped",
] as const;
export type DeliverableStageStatus = (typeof DELIVERABLE_STAGE_STATUSES)[number];
```

- [ ] **Step 2: Create deliverable types file**

Create `packages/shared/src/types/deliverable.ts`:

```typescript
import type {
  DeliverableType,
  DeliverableStatus,
  DeliverablePriority,
  DeliverableContentKind,
  DeliverableStageStatus,
} from "../constants.js";

export interface Deliverable {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  title: string;
  description: string | null;
  type: DeliverableType;
  status: DeliverableStatus;
  priority: DeliverablePriority;
  currentStageIndex: number;
  reviewPipelineTemplateId: string | null;
  submittedByAgentId: string | null;
  submittedByUserId: string | null;
  dueAt: Date | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Populated in detail queries
  contents?: DeliverableContent[];
  stages?: DeliverableReviewStage[];
  comments?: DeliverableComment[];
}

export interface DeliverableContent {
  id: string;
  deliverableId: string;
  kind: DeliverableContentKind;
  title: string;
  body: string | null;
  url: string | null;
  filePath: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  metadata: Record<string, unknown> | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliverableReviewStage {
  id: string;
  deliverableId: string;
  stageIndex: number;
  label: string;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  status: DeliverableStageStatus;
  decisionNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliverableComment {
  id: string;
  deliverableId: string;
  stageId: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewPipelineTemplate {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  stages: ReviewPipelineTemplateStage[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewPipelineTemplateStage {
  label: string;
  reviewerAgentId?: string;
  reviewerUserId?: string;
  role?: string;
}

export interface ProjectReviewDefault {
  projectId: string;
  companyId: string;
  reviewPipelineTemplateId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 3: Export new types from types/index.ts**

Add to `packages/shared/src/types/index.ts`:

```typescript
export type {
  Deliverable,
  DeliverableContent,
  DeliverableReviewStage,
  DeliverableComment,
  ReviewPipelineTemplate,
  ReviewPipelineTemplateStage,
  ProjectReviewDefault,
} from "./deliverable.js";
```

- [ ] **Step 4: Verify shared package compiles**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/types/deliverable.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add deliverable types and constants"
```

---

### Task 2: Create DB schema files

**Files:**
- Create: `packages/db/src/schema/deliverables.ts`
- Create: `packages/db/src/schema/deliverable_contents.ts`
- Create: `packages/db/src/schema/deliverable_review_stages.ts`
- Create: `packages/db/src/schema/deliverable_comments.ts`
- Create: `packages/db/src/schema/review_pipeline_templates.ts`
- Create: `packages/db/src/schema/project_review_defaults.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create deliverables schema**

Create `packages/db/src/schema/deliverables.ts`:

```typescript
import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { reviewPipelineTemplates } from "./review_pipeline_templates.js";

export const deliverables = pgTable(
  "deliverables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").notNull().default("mixed"),
    status: text("status").notNull().default("draft"),
    priority: text("priority").notNull().default("medium"),
    currentStageIndex: integer("current_stage_index").notNull().default(0),
    reviewPipelineTemplateId: uuid("review_pipeline_template_id").references(() => reviewPipelineTemplates.id, { onDelete: "set null" }),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    submittedByUserId: text("submitted_by_user_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("idx_deliverables_company_status").on(table.companyId, table.status),
    companyProjectIdx: index("idx_deliverables_company_project").on(table.companyId, table.projectId),
    companyIssueIdx: index("idx_deliverables_company_issue").on(table.companyId, table.issueId),
    submittedByAgentIdx: index("idx_deliverables_submitted_by_agent").on(table.submittedByAgentId),
  }),
);
```

- [ ] **Step 2: Create deliverable_contents schema**

Create `packages/db/src/schema/deliverable_contents.ts`:

```typescript
import { pgTable, uuid, text, bigint, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { deliverables } from "./deliverables.js";

export const deliverableContents = pgTable(
  "deliverable_contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    filePath: text("file_path"),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    metadata: jsonb("metadata"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableIdx: index("idx_deliverable_contents_deliverable").on(table.deliverableId),
  }),
);
```

- [ ] **Step 3: Create deliverable_review_stages schema**

Create `packages/db/src/schema/deliverable_review_stages.ts`:

```typescript
import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { deliverables } from "./deliverables.js";
import { agents } from "./agents.js";

export const deliverableReviewStages = pgTable(
  "deliverable_review_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    stageIndex: integer("stage_index").notNull(),
    label: text("label").notNull(),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reviewerUserId: text("reviewer_user_id"),
    status: text("status").notNull().default("pending"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableStageUniqueIdx: uniqueIndex("idx_deliverable_review_stages_unique").on(table.deliverableId, table.stageIndex),
    deliverableIdx: index("idx_deliverable_review_stages_deliverable").on(table.deliverableId),
  }),
);
```

- [ ] **Step 4: Create deliverable_comments schema**

Create `packages/db/src/schema/deliverable_comments.ts`:

```typescript
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { deliverables } from "./deliverables.js";
import { deliverableReviewStages } from "./deliverable_review_stages.js";
import { agents } from "./agents.js";

export const deliverableComments = pgTable(
  "deliverable_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").references(() => deliverableReviewStages.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableIdx: index("idx_deliverable_comments_deliverable").on(table.deliverableId),
  }),
);
```

- [ ] **Step 5: Create review_pipeline_templates schema**

Create `packages/db/src/schema/review_pipeline_templates.ts`:

```typescript
import { pgTable, uuid, text, boolean, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const reviewPipelineTemplates = pgTable(
  "review_pipeline_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    stages: jsonb("stages").notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("idx_review_pipeline_templates_company").on(table.companyId),
  }),
);
```

- [ ] **Step 6: Create project_review_defaults schema**

Create `packages/db/src/schema/project_review_defaults.ts`:

```typescript
import { pgTable, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";
import { reviewPipelineTemplates } from "./review_pipeline_templates.js";

export const projectReviewDefaults = pgTable(
  "project_review_defaults",
  {
    projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reviewPipelineTemplateId: uuid("review_pipeline_template_id").notNull().references(() => reviewPipelineTemplates.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("idx_project_review_defaults_company").on(table.companyId),
  }),
);
```

- [ ] **Step 7: Export all schemas from index.ts**

Add to the end of `packages/db/src/schema/index.ts`:

```typescript
export { reviewPipelineTemplates } from "./review_pipeline_templates.js";
export { projectReviewDefaults } from "./project_review_defaults.js";
export { deliverables } from "./deliverables.js";
export { deliverableContents } from "./deliverable_contents.js";
export { deliverableReviewStages } from "./deliverable_review_stages.js";
export { deliverableComments } from "./deliverable_comments.js";
```

- [ ] **Step 8: Verify DB package compiles**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/packages/db && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema/
git commit -m "feat(db): add deliverables schema tables"
```

---

### Task 3: Create database migration

**Files:**
- Create: `packages/db/src/migrations/0055_deliverables.sql`

- [ ] **Step 1: Generate the migration SQL**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/packages/db && npx drizzle-kit generate`

If drizzle-kit doesn't produce a clean migration, create `packages/db/src/migrations/0055_deliverables.sql` manually:

```sql
CREATE TABLE IF NOT EXISTS "review_pipeline_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "stages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "project_review_defaults" (
  "project_id" uuid PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "review_pipeline_template_id" uuid NOT NULL REFERENCES "review_pipeline_templates"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text,
  "type" text NOT NULL DEFAULT 'mixed',
  "status" text NOT NULL DEFAULT 'draft',
  "priority" text NOT NULL DEFAULT 'medium',
  "current_stage_index" integer NOT NULL DEFAULT 0,
  "review_pipeline_template_id" uuid REFERENCES "review_pipeline_templates"("id") ON DELETE SET NULL,
  "submitted_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "submitted_by_user_id" text,
  "due_at" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverable_contents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deliverable_id" uuid NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "url" text,
  "file_path" text,
  "original_filename" text,
  "mime_type" text,
  "size_bytes" bigint,
  "metadata" jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverable_review_stages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deliverable_id" uuid NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "stage_index" integer NOT NULL,
  "label" text NOT NULL,
  "reviewer_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "reviewer_user_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "decision_note" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverable_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deliverable_id" uuid NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "stage_id" uuid REFERENCES "deliverable_review_stages"("id") ON DELETE SET NULL,
  "author_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "author_user_id" text,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_review_pipeline_templates_company" ON "review_pipeline_templates" ("company_id");
CREATE INDEX IF NOT EXISTS "idx_project_review_defaults_company" ON "project_review_defaults" ("company_id");
CREATE INDEX IF NOT EXISTS "idx_deliverables_company_status" ON "deliverables" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "idx_deliverables_company_project" ON "deliverables" ("company_id", "project_id");
CREATE INDEX IF NOT EXISTS "idx_deliverables_company_issue" ON "deliverables" ("company_id", "issue_id");
CREATE INDEX IF NOT EXISTS "idx_deliverables_submitted_by_agent" ON "deliverables" ("submitted_by_agent_id");
CREATE INDEX IF NOT EXISTS "idx_deliverable_contents_deliverable" ON "deliverable_contents" ("deliverable_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_deliverable_review_stages_unique" ON "deliverable_review_stages" ("deliverable_id", "stage_index");
CREATE INDEX IF NOT EXISTS "idx_deliverable_review_stages_deliverable" ON "deliverable_review_stages" ("deliverable_id");
CREATE INDEX IF NOT EXISTS "idx_deliverable_comments_deliverable" ON "deliverable_comments" ("deliverable_id");
```

- [ ] **Step 2: Verify migration applies**

Start the server with auto-migration: `pushd /c/Users/DRRAM/Projects/PaperClipNew && pnpm --filter @paperclipai/server run dev`
Expected: Server logs show "Applying 1 pending migrations" and starts successfully.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/migrations/
git commit -m "feat(db): add deliverables migration 0055"
```

---

## Chunk 2: Server Service & Routes

### Task 4: Create deliverables server service

**Files:**
- Create: `server/src/services/deliverables.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create the deliverables service**

Create `server/src/services/deliverables.ts`. The service should follow the pattern in `server/src/services/artifacts.ts` (function that takes `db: Db` and returns an object of methods). It must include:

**CRUD methods:**
- `list(companyId, filters?)` — query deliverables with optional filters: status, projectId, issueId, submittedByAgentId. Join stages for current stage info. Order by priority desc, createdAt desc.
- `getById(id)` — get deliverable with contents, stages, and comments populated
- `create(companyId, data)` — create deliverable. If no custom stages provided, check project default pipeline, then company default template. Instantiate stages from template (validate agent IDs exist, fall back to role if missing).
- `update(id, data)` — update title, description, priority, dueAt. Set updatedAt.
- `remove(id)` — soft-delete (set status to a deleted state, or hard delete — follow artifacts pattern which hard-deletes)

**Lifecycle methods:**
- `submit(id)` — validate status is `draft`. If zero stages, set status to `approved` + approvedAt. Otherwise set status to `in_review` + submittedAt, notify stage 0 reviewer.
- `approveStage(id, stageId, decisionNote, actor)` — validate stage is current and status is pending. Set stage status to `approved` + decidedAt. If final stage, set deliverable status to `approved` + approvedAt. Otherwise increment currentStageIndex and notify next reviewer.
- `requestChanges(id, stageId, decisionNote, actor)` — set stage status to `changes_requested`, set deliverable status to `changes_requested`. Prepare wake context for agent.
- `rejectStage(id, stageId, decisionNote, actor)` — set deliverable status to `rejected` + rejectedAt.
- `skipStage(id, stageId, actor)` — set stage status to `skipped`. Advance to next stage or approve if final.
- `resubmit(id)` — validate status is `changes_requested`. Reset current stage to `pending`, set deliverable back to `in_review`.
- `reopen(id)` — validate status is `rejected`. Set status to `in_review`, reset current stage to pending.
- `reassign(id, newAgentId)` — update submittedByAgentId on the deliverable.

**Content methods:**
- `addContent(deliverableId, data)` — insert into deliverable_contents
- `updateContent(contentId, data)` — update content item
- `removeContent(contentId)` — delete content item

**Comment methods:**
- `listComments(deliverableId)` — list comments ordered by createdAt
- `addComment(deliverableId, body, actor)` — insert comment with author info

**Stage management methods:**
- `addStage(deliverableId, data)` — insert new stage, reindex stageIndex values
- `updateStage(stageId, data)` — update label, reviewer
- `removeStage(stageId)` — delete stage, reindex remaining

**Review template methods (can be in same service or separate):**
- `listTemplates(companyId)` — list pipeline templates
- `getTemplate(id)` — get single template
- `createTemplate(companyId, data)` — create template. If isDefault, unset other defaults.
- `updateTemplate(id, data)` — update template
- `deleteTemplate(id)` — delete template
- `getProjectDefault(projectId)` — get project's default pipeline
- `setProjectDefault(projectId, companyId, templateId)` — upsert project default

- [ ] **Step 2: Export service from index.ts**

Add to `server/src/services/index.ts`:

```typescript
export { deliverableService } from "./deliverables.js";
```

- [ ] **Step 3: Verify server compiles**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add server/src/services/deliverables.ts server/src/services/index.ts
git commit -m "feat(server): add deliverables service with full CRUD and lifecycle"
```

---

### Task 5: Create deliverables server routes

**Files:**
- Create: `server/src/routes/deliverables.ts`
- Create: `server/src/routes/review-templates.ts`
- Modify: `server/src/routes/index.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Create deliverables routes**

Create `server/src/routes/deliverables.ts` following the pattern from `server/src/routes/artifacts.ts`. Export function `deliverableRoutes(db: Db)`.

Routes to implement:

```
GET    /companies/:companyId/deliverables
POST   /companies/:companyId/deliverables
GET    /deliverables/:id
PATCH  /deliverables/:id
DELETE /deliverables/:id
POST   /deliverables/:id/submit
POST   /deliverables/:id/stages/:stageId/approve
POST   /deliverables/:id/stages/:stageId/request-changes
POST   /deliverables/:id/stages/:stageId/reject
POST   /deliverables/:id/stages/:stageId/skip
POST   /deliverables/:id/reassign
POST   /deliverables/:id/reopen
POST   /deliverables/:id/contents
PATCH  /deliverables/:id/contents/:contentId
DELETE /deliverables/:id/contents/:contentId
POST   /deliverables/:id/stages
PATCH  /deliverables/:id/stages/:stageId
DELETE /deliverables/:id/stages/:stageId
GET    /deliverables/:id/comments
POST   /deliverables/:id/comments
```

Each route must:
- Cast `req.params.*` with `as string` (Express v5 types)
- Call `assertCompanyAccess(req, companyId)` for company-scoped routes
- Call `getActorInfo(req)` for actor tracking
- Call `logActivity()` for create/update/delete/lifecycle actions
- Return proper HTTP status codes

For `request-changes` route, add heartbeat wake integration:

```typescript
// After setting stage to changes_requested:
try {
  const { heartbeat } = await import("../services/heartbeat.js");
  const hb = heartbeat(db);
  if (deliverable.submittedByAgentId) {
    await hb.wakeup(deliverable.submittedByAgentId, {
      wakeReason: "deliverable_changes_requested",
      deliverableId: deliverable.id,
      deliverableTitle: deliverable.title,
      stageLabel: stage.label,
      reviewerNote: req.body.decisionNote ?? "",
      issueId: deliverable.issueId,
    });
  }
} catch (err) {
  // Log but don't fail the request
  logger.warn({ err }, "failed to wake agent for deliverable changes");
}
```

- [ ] **Step 2: Create review-templates routes**

Create `server/src/routes/review-templates.ts`. Export function `reviewTemplateRoutes(db: Db)`.

Routes:

```
GET    /companies/:companyId/review-templates
POST   /companies/:companyId/review-templates
PATCH  /review-templates/:id
DELETE /review-templates/:id
GET    /projects/:projectId/review-defaults
PUT    /projects/:projectId/review-defaults
```

- [ ] **Step 3: Export routes from index.ts**

Add to `server/src/routes/index.ts`:

```typescript
export { deliverableRoutes } from "./deliverables.js";
export { reviewTemplateRoutes } from "./review-templates.js";
```

- [ ] **Step 4: Mount routes in app.ts**

Add imports at top of `server/src/app.ts`:

```typescript
import { deliverableRoutes } from "./routes/deliverables.js";
import { reviewTemplateRoutes } from "./routes/review-templates.js";
```

Add in the route mounting section (after `api.use(sandboxRoutes(db))`):

```typescript
api.use(deliverableRoutes(db));
api.use(reviewTemplateRoutes(db));
```

- [ ] **Step 5: Verify server compiles**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Start server and test basic endpoints**

Start server: `pushd /c/Users/DRRAM/Projects/PaperClipNew && pnpm --filter @paperclipai/server run dev`

Test with curl (use a valid companyId from your DB):
```bash
curl -s http://localhost:4100/api/companies/<COMPANY_ID>/deliverables | head -c 200
curl -s http://localhost:4100/api/companies/<COMPANY_ID>/review-templates | head -c 200
```
Expected: `[]` (empty arrays)

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/deliverables.ts server/src/routes/review-templates.ts server/src/routes/index.ts server/src/app.ts
git commit -m "feat(server): add deliverables and review-templates routes"
```

---

## Chunk 3: Frontend API Client & Query Keys

### Task 6: Create frontend API clients

**Files:**
- Create: `ui/src/api/deliverables.ts`
- Create: `ui/src/api/reviewTemplates.ts`
- Modify: `ui/src/lib/queryKeys.ts`

- [ ] **Step 1: Create deliverables API client**

Create `ui/src/api/deliverables.ts`:

```typescript
import { api } from "./client";

export interface Deliverable {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  title: string;
  description: string | null;
  type: string;
  status: string;
  priority: string;
  currentStageIndex: number;
  reviewPipelineTemplateId: string | null;
  submittedByAgentId: string | null;
  submittedByUserId: string | null;
  dueAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contents?: DeliverableContent[];
  stages?: DeliverableReviewStage[];
  comments?: DeliverableComment[];
}

export interface DeliverableContent {
  id: string;
  deliverableId: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  filePath: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  metadata: Record<string, unknown> | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableReviewStage {
  id: string;
  deliverableId: string;
  stageIndex: number;
  label: string;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  status: string;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableComment {
  id: string;
  deliverableId: string;
  stageId: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeliverableInput {
  title: string;
  description?: string;
  type?: string;
  priority?: string;
  projectId?: string;
  issueId?: string;
  dueAt?: string;
  templateId?: string;
  stages?: Array<{ label: string; reviewerAgentId?: string; reviewerUserId?: string }>;
}

export interface UpdateDeliverableInput {
  title?: string;
  description?: string;
  priority?: string;
  dueAt?: string | null;
}

export const deliverablesApi = {
  list: (companyId: string, filters?: { status?: string; projectId?: string; issueId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return api.get<Deliverable[]>(`/companies/${companyId}/deliverables${qs}`);
  },
  get: (id: string) => api.get<Deliverable>(`/deliverables/${id}`),
  create: (companyId: string, data: CreateDeliverableInput) =>
    api.post<Deliverable>(`/companies/${companyId}/deliverables`, data),
  update: (id: string, data: UpdateDeliverableInput) =>
    api.patch<Deliverable>(`/deliverables/${id}`, data),
  remove: (id: string) => api.delete<Deliverable>(`/deliverables/${id}`),

  // Lifecycle
  submit: (id: string) => api.post<Deliverable>(`/deliverables/${id}/submit`),
  approveStage: (id: string, stageId: string, decisionNote?: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/approve`, { decisionNote }),
  requestChanges: (id: string, stageId: string, decisionNote?: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/request-changes`, { decisionNote }),
  rejectStage: (id: string, stageId: string, decisionNote?: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/reject`, { decisionNote }),
  skipStage: (id: string, stageId: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/skip`),
  reassign: (id: string, agentId: string) =>
    api.post<Deliverable>(`/deliverables/${id}/reassign`, { agentId }),
  reopen: (id: string) => api.post<Deliverable>(`/deliverables/${id}/reopen`),

  // Contents
  addContent: (id: string, data: Record<string, unknown>) =>
    api.post<DeliverableContent>(`/deliverables/${id}/contents`, data),
  updateContent: (id: string, contentId: string, data: Record<string, unknown>) =>
    api.patch<DeliverableContent>(`/deliverables/${id}/contents/${contentId}`, data),
  removeContent: (id: string, contentId: string) =>
    api.delete<void>(`/deliverables/${id}/contents/${contentId}`),

  // Stages
  addStage: (id: string, data: { label: string; reviewerAgentId?: string; reviewerUserId?: string }) =>
    api.post<DeliverableReviewStage>(`/deliverables/${id}/stages`, data),
  updateStage: (id: string, stageId: string, data: Record<string, unknown>) =>
    api.patch<DeliverableReviewStage>(`/deliverables/${id}/stages/${stageId}`, data),
  removeStage: (id: string, stageId: string) =>
    api.delete<void>(`/deliverables/${id}/stages/${stageId}`),

  // Comments
  listComments: (id: string) =>
    api.get<DeliverableComment[]>(`/deliverables/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<DeliverableComment>(`/deliverables/${id}/comments`, { body }),
};
```

- [ ] **Step 2: Create review templates API client**

Create `ui/src/api/reviewTemplates.ts`:

```typescript
import { api } from "./client";

export interface ReviewPipelineTemplate {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  stages: Array<{ label: string; reviewerAgentId?: string; reviewerUserId?: string; role?: string }>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectReviewDefault {
  projectId: string;
  companyId: string;
  reviewPipelineTemplateId: string;
  createdAt: string;
  updatedAt: string;
}

export const reviewTemplatesApi = {
  list: (companyId: string) =>
    api.get<ReviewPipelineTemplate[]>(`/companies/${companyId}/review-templates`),
  create: (companyId: string, data: { name: string; description?: string; stages: unknown[]; isDefault?: boolean }) =>
    api.post<ReviewPipelineTemplate>(`/companies/${companyId}/review-templates`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<ReviewPipelineTemplate>(`/review-templates/${id}`, data),
  remove: (id: string) =>
    api.delete<void>(`/review-templates/${id}`),
  getProjectDefault: (projectId: string) =>
    api.get<ProjectReviewDefault>(`/projects/${projectId}/review-defaults`),
  setProjectDefault: (projectId: string, data: { companyId: string; reviewPipelineTemplateId: string }) =>
    api.put<ProjectReviewDefault>(`/projects/${projectId}/review-defaults`, data),
};
```

- [ ] **Step 3: Add query keys**

Add to `ui/src/lib/queryKeys.ts` inside the `queryKeys` object:

```typescript
deliverables: {
  list: (companyId: string, filters?: { status?: string; projectId?: string; issueId?: string }) =>
    ["deliverables", companyId, filters ?? {}] as const,
  detail: (id: string) => ["deliverables", "detail", id] as const,
  comments: (id: string) => ["deliverables", "comments", id] as const,
},
reviewTemplates: {
  list: (companyId: string) => ["review-templates", companyId] as const,
  projectDefault: (projectId: string) => ["review-templates", "project-default", projectId] as const,
},
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/deliverables.ts ui/src/api/reviewTemplates.ts ui/src/lib/queryKeys.ts
git commit -m "feat(ui): add deliverables and review-templates API clients"
```

---

## Chunk 4: Frontend UI — Main Page & Detail View

### Task 7: Create Deliverables main page

**Files:**
- Create: `ui/src/pages/Deliverables.tsx`
- Create: `ui/src/components/DeliverableCard.tsx`
- Create: `ui/src/components/DeliverableStatusBadge.tsx`
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Create DeliverableStatusBadge component**

Create `ui/src/components/DeliverableStatusBadge.tsx` — a simple badge component following the pattern from `DeploymentStatusBadge.tsx`. Map each status to colors:
- `draft` → grey/muted
- `in_review` → cyan/blue
- `changes_requested` → amber/yellow
- `approved` → green
- `rejected` → red

- [ ] **Step 2: Create DeliverableCard component**

Create `ui/src/components/DeliverableCard.tsx` — a card showing:
- Title, status badge, priority badge
- Submitter agent name/icon (use agent lookup from parent)
- Project name (if linked)
- Current stage label
- Content type icons (small icons for file/url/markdown/code/preview)
- Time waiting (use `relativeTime` from utils)
- Click handler to navigate to detail

- [ ] **Step 3: Create Deliverables main page**

Create `ui/src/pages/Deliverables.tsx` with three tabs:
- **Review Queue** — uses `deliverablesApi.list(companyId, { status: "in_review" })`, filtered to deliverables where user is current stage reviewer. Shows DeliverableCard grid.
- **All Deliverables** — full list with status/project/type filter dropdowns. Supports card and table toggle views.
- **Templates** — lists review pipeline templates with create/edit/delete. Each template shows stages as horizontal pills.

Use `useBreadcrumbs` for page title. Use `useCompany` for companyId. Follow the tab pattern from `Approvals.tsx`.

- [ ] **Step 4: Add sidebar nav item**

In `ui/src/components/Sidebar.tsx`, add import for `PackageCheck` from lucide-react and add nav item in the Work section (between Goals and Artifacts):

```tsx
<SidebarNavItem to="/deliverables" label="Deliverables" icon={PackageCheck} />
```

- [ ] **Step 5: Add routes in App.tsx**

Add import:
```typescript
import { Deliverables } from "./pages/Deliverables";
```

Add in `boardRoutes()` function (after goals route):
```tsx
<Route path="deliverables" element={<Deliverables />} />
```

Add unprefixed redirect (with the other UnprefixedBoardRedirect routes):
```tsx
<Route path="deliverables" element={<UnprefixedBoardRedirect />} />
```

- [ ] **Step 6: Build and verify**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/ui && npx vite build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/Deliverables.tsx ui/src/components/DeliverableCard.tsx ui/src/components/DeliverableStatusBadge.tsx ui/src/components/Sidebar.tsx ui/src/App.tsx
git commit -m "feat(ui): add Deliverables main page with review queue, list, and templates tabs"
```

---

### Task 8: Create Deliverable Detail page

**Files:**
- Create: `ui/src/pages/DeliverableDetail.tsx`
- Create: `ui/src/components/ReviewPipelineVisualizer.tsx`
- Create: `ui/src/components/DeliverableContentPanel.tsx`
- Create: `ui/src/components/ReviewActionBar.tsx`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Create ReviewPipelineVisualizer**

Create `ui/src/components/ReviewPipelineVisualizer.tsx` — horizontal pipeline showing stages:
- Each stage is a pill/node connected by lines
- Completed stages: green with checkmark icon
- Current stage: highlighted with blue border, pulsing indicator
- Skipped stages: grey with strikethrough
- Upcoming stages: grey/muted circle
- Each node shows: label, reviewer name (agent name or "You")

- [ ] **Step 2: Create DeliverableContentPanel**

Create `ui/src/components/DeliverableContentPanel.tsx` — tabbed panel for viewing content items:
- Tab per content item, with icon based on `kind`
- `markdown` → render with MarkdownBody component
- `url` → show link with ExternalLink icon
- `file` → show filename, size, download link
- `code_ref` → show commit/branch info from metadata, link to URL
- `preview` → render iframe with the URL

- [ ] **Step 3: Create ReviewActionBar**

Create `ui/src/components/ReviewActionBar.tsx` — action bar for current reviewer:
- Shows only when user is the current stage reviewer
- Approve button (green), Request Changes button (amber), Reject button (red)
- Skip Stage button (muted, for CEO override)
- Reassign dropdown (lists agents, for CEO override)
- Each action opens a small modal/popover for optional decisionNote text
- All actions use mutations that invalidate the deliverable detail query

- [ ] **Step 4: Create DeliverableDetail page**

Create `ui/src/pages/DeliverableDetail.tsx`:
- Fetches deliverable via `deliverablesApi.get(id)` — includes contents, stages, comments
- Fetches agents via `agentsApi.list(companyId)` for name lookups
- **Header**: title (editable inline), status badge, priority dropdown, project/issue breadcrumbs, due date
- **Pipeline visualizer**: `<ReviewPipelineVisualizer stages={deliverable.stages} currentIndex={deliverable.currentStageIndex} />`
- **Content panel**: `<DeliverableContentPanel contents={deliverable.contents} />` with "Add Content" button
- **Action bar**: `<ReviewActionBar deliverable={deliverable} />` (only if user is current reviewer)
- **Comment thread**: reuse the same visual pattern as ChatInterface — violet for agents, blue for users. Text input at bottom for adding comments.

- [ ] **Step 5: Add route in App.tsx**

Add import and route in `boardRoutes()`:
```tsx
import { DeliverableDetail } from "./pages/DeliverableDetail";
// In boardRoutes:
<Route path="deliverables/:deliverableId" element={<DeliverableDetail />} />
```

Add unprefixed redirect:
```tsx
<Route path="deliverables/:deliverableId" element={<UnprefixedBoardRedirect />} />
```

- [ ] **Step 6: Build and verify**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/ui && npx vite build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/DeliverableDetail.tsx ui/src/components/ReviewPipelineVisualizer.tsx ui/src/components/DeliverableContentPanel.tsx ui/src/components/ReviewActionBar.tsx ui/src/App.tsx
git commit -m "feat(ui): add DeliverableDetail page with pipeline visualizer, content panel, and review actions"
```

---

## Chunk 5: Dashboard Widget & Issue Integration

### Task 9: Add Pending Reviews dashboard widget

**Files:**
- Create: `ui/src/components/PendingReviewsWidget.tsx`
- Modify: `ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Create PendingReviewsWidget**

Create `ui/src/components/PendingReviewsWidget.tsx`:
- Uses `deliverablesApi.list(companyId, { status: "in_review" })` with `refetchInterval: 30_000`
- Filters to deliverables where the current user is the reviewer at `currentStageIndex`
- Shows a compact card: "Pending Reviews" header with count badge
- Lists top 5 items: title, submitter agent name, time waiting
- Each item is a link to `/deliverables/:id`
- "View All" footer link to `/deliverables`
- If no pending reviews, show a subtle "All caught up" message

- [ ] **Step 2: Add widget to Dashboard**

Read `ui/src/pages/Dashboard.tsx` to find where other dashboard widgets are rendered. Add `<PendingReviewsWidget />` in the appropriate grid/section. Import the component.

- [ ] **Step 3: Build and verify**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/ui && npx vite build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/PendingReviewsWidget.tsx ui/src/pages/Dashboard.tsx
git commit -m "feat(ui): add Pending Reviews dashboard widget"
```

---

### Task 10: Add Deliverables tab to Issue Detail

**Files:**
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Read IssueDetail.tsx to understand tab structure**

Read `ui/src/pages/IssueDetail.tsx` to find where tabs are defined and how other tabs (Comments, Activity, Attachments, Approvals) are structured.

- [ ] **Step 2: Add Deliverables tab**

Add a new "Deliverables" tab to the IssueDetail page:
- Query `deliverablesApi.list(companyId, { issueId })` for deliverables linked to this issue
- Show list of DeliverableCard components
- "New Deliverable" button that creates a deliverable pre-linked to this issue
- If no deliverables, show empty state with "Create Deliverable" CTA

- [ ] **Step 3: Build and verify**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew/ui && npx vite build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/IssueDetail.tsx
git commit -m "feat(ui): add Deliverables tab to IssueDetail page"
```

---

### Task 11: Final integration & rebuild

**Files:**
- All previously modified files

- [ ] **Step 1: Full TypeScript check**

Run: `pushd /c/Users/DRRAM/Projects/PaperClipNew && pnpm run build` or check each package:
```bash
pushd /c/Users/DRRAM/Projects/PaperClipNew/packages/shared && npx tsc --noEmit
pushd /c/Users/DRRAM/Projects/PaperClipNew/packages/db && npx tsc --noEmit
pushd /c/Users/DRRAM/Projects/PaperClipNew/server && npx tsc --noEmit
pushd /c/Users/DRRAM/Projects/PaperClipNew/ui && npx vite build
```
Expected: All pass

- [ ] **Step 2: Start server and test end-to-end**

Start server: `pushd /c/Users/DRRAM/Projects/PaperClipNew && pnpm --filter @paperclipai/server run dev`
- Migration should auto-apply
- Navigate to `/deliverables` page — should load
- Create a review template
- Create a deliverable, add content, submit it
- Walk through the review pipeline (approve stages)
- Check dashboard widget shows pending reviews
- Check issue detail has Deliverables tab

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete deliverables system — full review pipeline with multi-stage approvals"
```
