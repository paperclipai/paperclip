# Weekly Review Wave 1-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Weekly Executive Operating Review foundation: schema, shared contracts, Northstar fixture skeleton, lifecycle events, retention helpers, and local adapter/model readiness probes for `claude_local`, `codex_local`, and `agy_local`.

**Architecture:** Add company-scoped review tables and readiness probe tables in `packages/db`, shared constants/types/validators in `packages/shared`, and focused server services/routes for retention, events, Northstar fixture seeding, adapter readiness, and model assurance. Do not build the finding engine, review UI, narration, or governance action APIs in this plan; Waves 1-2 only establish contracts and runtime readiness foundations used by Wave 3+.

**Tech Stack:** TypeScript, Drizzle ORM, Express, Zod, Vitest, pnpm workspace scripts.

---

## Scope Boundary

This plan implements only Wave 1 and Wave 2 from [the PRD/SPEC](./2026-05-21-weekly-executive-operating-review-mvp.md).

In scope:

- Weekly review schema tables.
- Weekly review lifecycle event table and retention helper.
- Company-scoped adapter readiness probe table.
- Shared constants, types, and validators for weekly review, adapter readiness, and model assurance.
- Northstar Labs fixture skeleton with agents/projects/issues/runs/probe metadata sufficient for Wave 3 finding-engine tests.
- Adapter/model readiness services and routes for `claude_local`, `codex_local`, and `agy_local`.
- Basic execution gate helper that heartbeat start paths can call before starting local adapter runs.
- `agy_local` replaces `gemini_local` for new Google local adapter assurance. Existing `gemini_local` rows are legacy migration context only; new Weekly Review MVP contracts, fixture records, routes, and readiness/model assurance evidence use `agy_local`.
- `agy_local` model assurance accepts only `gemini-3.5-flash` for MVP certification.

Out of scope:

- Deterministic finding engine.
- Weekly Review UI.
- CEO governance action implementation.
- LLM narration.
- External data sources.
- Automatic adapter/model fallback.
- Any changes under `server/work/`.

Current worktree note:

- Preserve unrelated local changes in `cli/src/__tests__/network-bind.test.ts`, `cli/src/__tests__/onboard.test.ts`, `ui/src/pages/AgentDetail.tsx`, `ui/src/pages/AgentDetail.test.tsx`, and `server/work/`.
- Do not revert or clean those files as part of this feature.

## File Map

Create:

- `packages/db/src/schema/weekly_reviews.ts`
- `packages/shared/src/types/weekly-review.ts`
- `packages/shared/src/types/adapter-readiness.ts`
- `packages/shared/src/types/model-assurance.ts`
- `packages/shared/src/validators/weekly-review.ts`
- `packages/shared/src/validators/adapter-readiness.ts`
- `packages/shared/src/validators/model-assurance.ts`
- `server/src/services/weekly-review/events.ts`
- `server/src/services/weekly-review/retention.ts`
- `server/src/services/weekly-review/northstar-fixture.ts`
- `server/src/services/adapter-readiness/index.ts`
- `server/src/services/model-assurance/index.ts`
- `server/src/routes/adapter-readiness.ts`
- `server/src/routes/model-assurance.ts`
- `server/src/__tests__/weekly-review-schema-contract.test.ts`
- `server/src/__tests__/weekly-review-retention.test.ts`
- `server/src/__tests__/northstar-fixture.test.ts`
- `server/src/__tests__/adapter-readiness-service.test.ts`
- `server/src/__tests__/model-assurance-service.test.ts`
- `server/src/__tests__/adapter-readiness-routes.test.ts`

Modify:

- `packages/db/src/schema/index.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/index.ts`
- `server/src/routes/index.ts`
- `server/src/services/heartbeat.ts` only for a narrow readiness-gate hook if Wave 2 implementation reaches execution blocking.

Generate:

- Drizzle migration via `pnpm db:generate`.

---

## Task 1: Shared Constants And Types

**Files:**

- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types/weekly-review.ts`
- Create: `packages/shared/src/types/adapter-readiness.ts`
- Create: `packages/shared/src/types/model-assurance.ts`
- Create: `packages/shared/src/validators/weekly-review.ts`
- Create: `packages/shared/src/validators/adapter-readiness.ts`
- Create: `packages/shared/src/validators/model-assurance.ts`

- [ ] **Step 1: Add the shared constants**

In `packages/shared/src/constants.ts`, add these exports near related domain constants:

```ts
export const WEEKLY_REVIEW_STATUSES = ["draft", "ready", "archived"] as const;
export const WEEKLY_REVIEW_VERSION_STATUSES = [
  "generating",
  "draft",
  "validation_failed",
  "ready",
  "stale",
  "archived",
] as const;
export const WEEKLY_REVIEW_FINDING_CATEGORIES = [
  "decision_blocker",
  "action_required",
  "evidence_gap",
  "stale_item",
  "budget_signal",
  "quality_signal",
  "win_context",
] as const;
export const WEEKLY_REVIEW_FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const WEEKLY_REVIEW_FINDING_STATUSES = ["open", "actioned", "acknowledged", "dismissed", "stale"] as const;
export const WEEKLY_REVIEW_RECOMMENDATION_STATES = ["open", "accepted", "dismissed", "completed"] as const;
export const WEEKLY_REVIEW_ACTION_STATUSES = ["requested", "completed", "failed"] as const;
export const WEEKLY_REVIEW_EVENT_TYPES = [
  "generation_started",
  "source_snapshot_captured",
  "findings_computed",
  "citations_validated",
  "adapter_readiness_attached",
  "model_assurance_attached",
  "narration_generated",
  "narration_validation_failed",
  "version_ready",
  "version_validation_failed",
  "generation_failed",
  "version_marked_stale",
  "version_archived",
] as const;
export const WEEKLY_REVIEW_EVENT_STATUSES = ["started", "completed", "failed", "skipped"] as const;

export const LOCAL_ADAPTER_ASSURANCE_TYPES = ["claude_local", "codex_local", "agy_local"] as const;
export const ADAPTER_READINESS_STATUSES = ["ready", "warning", "blocked", "unknown", "not_applicable"] as const;
export const ADAPTER_READINESS_REASON_CODES = [
  "binary_missing",
  "auth_failed",
  "model_missing",
  "workspace_invalid",
  "hello_failed",
  "quota_limited",
  "quota_unknown",
  "resume_unsupported",
  "cancel_unsupported",
  "fixture_binding_missing",
  "fixture_run_missing",
] as const;

export const MODEL_ASSURANCE_POLICY_STATUSES = [
  "approved_default",
  "approved_primary",
  "approved_cheap",
  "approved_fallback",
  "manual_allowed",
  "warning",
  "blocked",
  "unknown",
] as const;
export const MODEL_ASSURANCE_ROLE_FITS = ["strong", "acceptable", "weak", "blocked", "unknown"] as const;
export const MODEL_ASSURANCE_MODEL_SOURCES = [
  "adapter_config",
  "detected",
  "cli_default",
  "provider_default",
  "unknown",
] as const;
export const MODEL_ASSURANCE_REASON_CODES = [
  "model_unresolved",
  "model_not_listed",
  "model_detect_failed",
  "model_hello_failed",
  "model_quota_limited",
  "model_profile_missing",
  "cheap_profile_missing",
  "role_fit_weak",
  "cost_policy_warning",
  "cost_policy_blocked",
  "manual_model_unverified",
  "fallback_requires_approval",
] as const;
```

- [ ] **Step 2: Add adapter readiness types**

Create `packages/shared/src/types/adapter-readiness.ts`:

```ts
import type {
  ADAPTER_READINESS_REASON_CODES,
  ADAPTER_READINESS_STATUSES,
  LOCAL_ADAPTER_ASSURANCE_TYPES,
} from "../constants.js";

export type LocalAdapterAssuranceType = (typeof LOCAL_ADAPTER_ASSURANCE_TYPES)[number];
export type AdapterReadinessStatus = (typeof ADAPTER_READINESS_STATUSES)[number];
export type AdapterReadinessReasonCode = (typeof ADAPTER_READINESS_REASON_CODES)[number];

export interface AdapterReadinessBooleans {
  basicReady: boolean;
  operationalReady: boolean;
  fixtureReady: boolean;
}

export interface AdapterFallbackRecommendation {
  adapterType: LocalAdapterAssuranceType;
  label: string;
  reason: string;
  requiresApproval: true;
}

export interface AdapterReadinessProbe {
  id: string;
  companyId: string;
  agentId: string;
  adapterType: LocalAdapterAssuranceType;
  status: AdapterReadinessStatus;
  basicReady: boolean;
  operationalReady: boolean;
  fixtureReady: boolean;
  reasonCodes: AdapterReadinessReasonCode[];
  cliVersion: string | null;
  authMode: string | null;
  model: string | null;
  modelProfile: string | null;
  workspaceStatus: string | null;
  quotaWindows: Record<string, unknown> | null;
  helloRunStatus: string | null;
  helloRunMetadata: Record<string, unknown> | null;
  heartbeatRunId: string | null;
  fallbackRecommendation: AdapterFallbackRecommendation | null;
  strictMode: boolean;
  checkedByUserId: string | null;
  checkedAt: string;
  createdAt: string;
}
```

- [ ] **Step 3: Add model assurance types**

Create `packages/shared/src/types/model-assurance.ts`:

```ts
import type {
  MODEL_ASSURANCE_MODEL_SOURCES,
  MODEL_ASSURANCE_POLICY_STATUSES,
  MODEL_ASSURANCE_REASON_CODES,
  MODEL_ASSURANCE_ROLE_FITS,
} from "../constants.js";

export type ModelAssuranceModelSource = (typeof MODEL_ASSURANCE_MODEL_SOURCES)[number];
export type ModelAssurancePolicyStatus = (typeof MODEL_ASSURANCE_POLICY_STATUSES)[number];
export type ModelAssuranceRoleFit = (typeof MODEL_ASSURANCE_ROLE_FITS)[number];
export type ModelAssuranceReasonCode = (typeof MODEL_ASSURANCE_REASON_CODES)[number];

export interface ModelAssuranceSummary {
  selectedModel: string | null;
  resolvedModel: string | null;
  modelSource: ModelAssuranceModelSource;
  modelProfile: string | null;
  modelAvailable: boolean;
  modelRunnable: boolean;
  policyStatus: ModelAssurancePolicyStatus;
  roleFit: ModelAssuranceRoleFit;
  roleFitReason: string | null;
  reasonCodes: ModelAssuranceReasonCode[];
  capabilities: Record<string, unknown> | null;
}
```

- [ ] **Step 4: Add weekly review types**

Create `packages/shared/src/types/weekly-review.ts`:

```ts
import type {
  WEEKLY_REVIEW_ACTION_STATUSES,
  WEEKLY_REVIEW_EVENT_STATUSES,
  WEEKLY_REVIEW_EVENT_TYPES,
  WEEKLY_REVIEW_FINDING_CATEGORIES,
  WEEKLY_REVIEW_FINDING_SEVERITIES,
  WEEKLY_REVIEW_FINDING_STATUSES,
  WEEKLY_REVIEW_RECOMMENDATION_STATES,
  WEEKLY_REVIEW_STATUSES,
  WEEKLY_REVIEW_VERSION_STATUSES,
} from "../constants.js";
import type { AdapterReadinessProbe } from "./adapter-readiness.js";
import type { ModelAssuranceSummary } from "./model-assurance.js";

export type WeeklyReviewStatus = (typeof WEEKLY_REVIEW_STATUSES)[number];
export type WeeklyReviewVersionStatus = (typeof WEEKLY_REVIEW_VERSION_STATUSES)[number];
export type WeeklyReviewFindingCategory = (typeof WEEKLY_REVIEW_FINDING_CATEGORIES)[number];
export type WeeklyReviewFindingSeverity = (typeof WEEKLY_REVIEW_FINDING_SEVERITIES)[number];
export type WeeklyReviewFindingStatus = (typeof WEEKLY_REVIEW_FINDING_STATUSES)[number];
export type WeeklyReviewRecommendationState = (typeof WEEKLY_REVIEW_RECOMMENDATION_STATES)[number];
export type WeeklyReviewActionStatus = (typeof WEEKLY_REVIEW_ACTION_STATUSES)[number];
export type WeeklyReviewEventType = (typeof WEEKLY_REVIEW_EVENT_TYPES)[number];
export type WeeklyReviewEventStatus = (typeof WEEKLY_REVIEW_EVENT_STATUSES)[number];

export interface WeeklyReviewSummary {
  findingCounts: Record<string, number>;
  recommendationCounts: Record<string, number>;
  adapterReadiness: AdapterReadinessProbe[];
  modelAssurance: Record<string, ModelAssuranceSummary>;
}

export interface WeeklyReviewEvent {
  id: string;
  reviewId: string | null;
  versionId: string | null;
  companyId: string;
  eventType: WeeklyReviewEventType;
  status: WeeklyReviewEventStatus;
  actorUserId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  inputCounts: Record<string, number> | null;
  debugMetadata: Record<string, unknown> | null;
  expiresAt: string | null;
  createdAt: string;
}
```

- [ ] **Step 5: Add Zod validators**

Create `packages/shared/src/validators/adapter-readiness.ts`:

```ts
import { z } from "zod";
import {
  ADAPTER_READINESS_REASON_CODES,
  ADAPTER_READINESS_STATUSES,
  LOCAL_ADAPTER_ASSURANCE_TYPES,
} from "../constants.js";

export const adapterReadinessStatusSchema = z.enum(ADAPTER_READINESS_STATUSES);
export const adapterReadinessReasonCodeSchema = z.enum(ADAPTER_READINESS_REASON_CODES);
export const localAdapterAssuranceTypeSchema = z.enum(LOCAL_ADAPTER_ASSURANCE_TYPES);

export const adapterReadinessProbeRequestSchema = z.object({
  adapterType: localAdapterAssuranceTypeSchema,
  strictMode: z.boolean().optional(),
});

export const adapterFallbackRecommendationSchema = z.object({
  adapterType: localAdapterAssuranceTypeSchema,
  label: z.string().min(1),
  reason: z.string().min(1),
  requiresApproval: z.literal(true),
});

export const adapterReadinessProbeSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  adapterType: localAdapterAssuranceTypeSchema,
  status: adapterReadinessStatusSchema,
  basicReady: z.boolean(),
  operationalReady: z.boolean(),
  fixtureReady: z.boolean(),
  reasonCodes: z.array(adapterReadinessReasonCodeSchema),
  cliVersion: z.string().nullable(),
  authMode: z.string().nullable(),
  model: z.string().nullable(),
  modelProfile: z.string().nullable(),
  workspaceStatus: z.string().nullable(),
  quotaWindows: z.record(z.string(), z.unknown()).nullable(),
  helloRunStatus: z.string().nullable(),
  helloRunMetadata: z.record(z.string(), z.unknown()).nullable(),
  heartbeatRunId: z.string().uuid().nullable(),
  fallbackRecommendation: adapterFallbackRecommendationSchema.nullable(),
  strictMode: z.boolean(),
  checkedByUserId: z.string().uuid().nullable(),
  checkedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
```

Create `packages/shared/src/validators/model-assurance.ts`:

```ts
import { z } from "zod";
import {
  MODEL_ASSURANCE_MODEL_SOURCES,
  MODEL_ASSURANCE_POLICY_STATUSES,
  MODEL_ASSURANCE_REASON_CODES,
  MODEL_ASSURANCE_ROLE_FITS,
} from "../constants.js";

export const modelAssuranceModelSourceSchema = z.enum(MODEL_ASSURANCE_MODEL_SOURCES);
export const modelAssurancePolicyStatusSchema = z.enum(MODEL_ASSURANCE_POLICY_STATUSES);
export const modelAssuranceRoleFitSchema = z.enum(MODEL_ASSURANCE_ROLE_FITS);
export const modelAssuranceReasonCodeSchema = z.enum(MODEL_ASSURANCE_REASON_CODES);
```

Create `packages/shared/src/validators/weekly-review.ts`:

```ts
import { z } from "zod";
import {
  WEEKLY_REVIEW_EVENT_STATUSES,
  WEEKLY_REVIEW_EVENT_TYPES,
  WEEKLY_REVIEW_FINDING_CATEGORIES,
  WEEKLY_REVIEW_FINDING_SEVERITIES,
  WEEKLY_REVIEW_FINDING_STATUSES,
  WEEKLY_REVIEW_STATUSES,
  WEEKLY_REVIEW_VERSION_STATUSES,
} from "../constants.js";

export const weeklyReviewStatusSchema = z.enum(WEEKLY_REVIEW_STATUSES);
export const weeklyReviewVersionStatusSchema = z.enum(WEEKLY_REVIEW_VERSION_STATUSES);
export const weeklyReviewFindingCategorySchema = z.enum(WEEKLY_REVIEW_FINDING_CATEGORIES);
export const weeklyReviewFindingSeveritySchema = z.enum(WEEKLY_REVIEW_FINDING_SEVERITIES);
export const weeklyReviewFindingStatusSchema = z.enum(WEEKLY_REVIEW_FINDING_STATUSES);
export const weeklyReviewEventTypeSchema = z.enum(WEEKLY_REVIEW_EVENT_TYPES);
export const weeklyReviewEventStatusSchema = z.enum(WEEKLY_REVIEW_EVENT_STATUSES);

export const generateWeeklyReviewSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  previousVersionId: z.string().uuid().optional(),
});
```

- [ ] **Step 6: Export new modules**

Modify `packages/shared/src/index.ts`:

```ts
export * from "./types/weekly-review.js";
export * from "./types/adapter-readiness.js";
export * from "./types/model-assurance.js";
export * from "./validators/weekly-review.js";
export * from "./validators/adapter-readiness.js";
export * from "./validators/model-assurance.js";
```

- [ ] **Step 7: Typecheck shared**

Run:

```sh
pnpm --filter @paperclipai/shared typecheck
```

Expected:

```text
tsc --noEmit
```

exits `0`.

---

## Task 2: Weekly Review Database Schema

**Files:**

- Create: `packages/db/src/schema/weekly_reviews.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/src/migrations/*`

- [ ] **Step 1: Add schema file**

Create `packages/db/src/schema/weekly_reviews.ts`:

```ts
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { activityLog } from "./activity_log.js";

export const weeklyReviews = pgTable(
  "weekly_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("draft"),
    latestVersionId: uuid("latest_version_id"),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPeriodIdx: index("weekly_reviews_company_period_idx").on(table.companyId, table.periodStart, table.periodEnd),
    companyStatusIdx: index("weekly_reviews_company_status_idx").on(table.companyId, table.status),
  }),
);

export const weeklyReviewVersions = pgTable(
  "weekly_review_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").notNull().references(() => weeklyReviews.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("generating"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    generatedByUserId: text("generated_by_user_id").references(() => authUsers.id),
    sourceWindowStart: timestamp("source_window_start", { withTimezone: true }).notNull(),
    sourceWindowEnd: timestamp("source_window_end", { withTimezone: true }).notNull(),
    summaryJson: jsonb("summary_json").$type<Record<string, unknown>>(),
    validationJson: jsonb("validation_json").$type<Record<string, unknown>>(),
    narrationStatus: text("narration_status").notNull().default("not_requested"),
    narrationText: text("narration_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewVersionIdx: index("weekly_review_versions_review_version_idx").on(table.reviewId, table.versionNumber),
    companyStatusIdx: index("weekly_review_versions_company_status_idx").on(table.companyId, table.status),
  }),
);

export const weeklyReviewFindings = pgTable(
  "weekly_review_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").notNull().references(() => weeklyReviews.id),
    versionId: uuid("version_id").notNull().references(() => weeklyReviewVersions.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    stableId: text("stable_id").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    workstream: text("workstream"),
    evidenceIdsJson: jsonb("evidence_ids_json").$type<string[]>(),
    recommendedActionJson: jsonb("recommended_action_json").$type<Record<string, unknown>>(),
    recommendationText: text("recommendation_text"),
    reasonCode: text("reason_code"),
    sourceEntityType: text("source_entity_type"),
    sourceEntityId: text("source_entity_id"),
    confidence: text("confidence"),
    detectedAt: timestamp("detected_at", { withTimezone: true }),
    validationStatus: text("validation_status").notNull().default("unknown"),
    rulesTriggeredJson: jsonb("rules_triggered_json").$type<string[]>(),
    actorId: text("actor_id"),
    uiCtaJson: jsonb("ui_cta_json").$type<Record<string, unknown>>(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionIdx: index("weekly_review_findings_version_idx").on(table.versionId),
    companyCategoryIdx: index("weekly_review_findings_company_category_idx").on(table.companyId, table.category),
    stableIdx: index("weekly_review_findings_version_stable_idx").on(table.versionId, table.stableId),
  }),
);

export const weeklyReviewCitations = pgTable(
  "weekly_review_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").notNull().references(() => weeklyReviews.id),
    versionId: uuid("version_id").notNull().references(() => weeklyReviewVersions.id),
    findingId: uuid("finding_id").references(() => weeklyReviewFindings.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    citationType: text("citation_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    field: text("field"),
    label: text("label").notNull(),
    excerpt: text("excerpt"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionIdx: index("weekly_review_citations_version_idx").on(table.versionId),
    entityIdx: index("weekly_review_citations_entity_idx").on(table.companyId, table.entityType, table.entityId),
  }),
);

export const weeklyReviewRecommendations = pgTable(
  "weekly_review_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").notNull().references(() => weeklyReviews.id),
    versionId: uuid("version_id").notNull().references(() => weeklyReviewVersions.id),
    findingId: uuid("finding_id").references(() => weeklyReviewFindings.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    state: text("state").notNull().default("open"),
    title: text("title").notNull(),
    rationale: text("rationale"),
    proposedActionJson: jsonb("proposed_action_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionIdx: index("weekly_review_recommendations_version_idx").on(table.versionId),
    findingIdx: index("weekly_review_recommendations_finding_idx").on(table.findingId),
  }),
);

export const weeklyReviewActions = pgTable(
  "weekly_review_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").notNull().references(() => weeklyReviews.id),
    versionId: uuid("version_id").notNull().references(() => weeklyReviewVersions.id),
    findingId: uuid("finding_id").references(() => weeklyReviewFindings.id),
    recommendationId: uuid("recommendation_id").references(() => weeklyReviewRecommendations.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actionKind: text("action_kind").notNull(),
    status: text("status").notNull().default("requested"),
    requestedByUserId: text("requested_by_user_id").references(() => authUsers.id),
    targetEntityType: text("target_entity_type"),
    targetEntityId: text("target_entity_id"),
    requestJson: jsonb("request_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    activityLogId: uuid("activity_log_id").references(() => activityLog.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionIdx: index("weekly_review_actions_version_idx").on(table.versionId),
    companyStatusIdx: index("weekly_review_actions_company_status_idx").on(table.companyId, table.status),
  }),
);

export const weeklyReviewEvents = pgTable(
  "weekly_review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").references(() => weeklyReviews.id),
    versionId: uuid("version_id").references(() => weeklyReviewVersions.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    actorUserId: text("actor_user_id").references(() => authUsers.id),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    sourceWindowStart: timestamp("source_window_start", { withTimezone: true }),
    sourceWindowEnd: timestamp("source_window_end", { withTimezone: true }),
    inputCountsJson: jsonb("input_counts_json").$type<Record<string, number>>(),
    findingCountsJson: jsonb("finding_counts_json").$type<Record<string, number>>(),
    citationValidationJson: jsonb("citation_validation_json").$type<Record<string, unknown>>(),
    adapterReadinessSummaryJson: jsonb("adapter_readiness_summary_json").$type<Record<string, unknown>>(),
    modelAssuranceSummaryJson: jsonb("model_assurance_summary_json").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    failureReason: text("failure_reason"),
    debugMetadataJson: jsonb("debug_metadata_json").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("weekly_review_events_company_created_idx").on(table.companyId, table.createdAt),
    expiresIdx: index("weekly_review_events_expires_idx").on(table.expiresAt),
  }),
);

export const adapterReadinessProbes = pgTable(
  "adapter_readiness_probes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    adapterType: text("adapter_type").notNull(),
    status: text("status").notNull().default("unknown"),
    basicReady: boolean("basic_ready").notNull().default(false),
    operationalReady: boolean("operational_ready").notNull().default(false),
    fixtureReady: boolean("fixture_ready").notNull().default(false),
    reasonCodesJson: jsonb("reason_codes_json").$type<string[]>(),
    cliVersion: text("cli_version"),
    authMode: text("auth_mode"),
    model: text("model"),
    resolvedModel: text("resolved_model"),
    modelSource: text("model_source").notNull().default("unknown"),
    modelProfile: text("model_profile"),
    modelAvailable: boolean("model_available").notNull().default(false),
    modelRunnable: boolean("model_runnable").notNull().default(false),
    modelPolicyStatus: text("model_policy_status").notNull().default("unknown"),
    roleFit: text("role_fit").notNull().default("unknown"),
    roleFitReason: text("role_fit_reason"),
    modelReasonCodesJson: jsonb("model_reason_codes_json").$type<string[]>(),
    modelCapabilitiesJson: jsonb("model_capabilities_json").$type<Record<string, unknown>>(),
    workspaceStatus: text("workspace_status"),
    quotaWindowsJson: jsonb("quota_windows_json").$type<Record<string, unknown>>(),
    helloRunStatus: text("hello_run_status"),
    helloRunMetadataJson: jsonb("hello_run_metadata_json").$type<Record<string, unknown>>(),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    fallbackRecommendationJson: jsonb("fallback_recommendation_json").$type<Record<string, unknown>>(),
    strictMode: boolean("strict_mode").notNull().default(false),
    checkedByUserId: text("checked_by_user_id").references(() => authUsers.id),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("adapter_readiness_probes_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    adapterCreatedIdx: index("adapter_readiness_probes_adapter_created_idx").on(table.adapterType, table.createdAt),
    expiresIdx: index("adapter_readiness_probes_expires_idx").on(table.expiresAt),
  }),
);
```

- [ ] **Step 2: Export schema tables**

Modify `packages/db/src/schema/index.ts`:

```ts
export {
  weeklyReviews,
  weeklyReviewVersions,
  weeklyReviewFindings,
  weeklyReviewCitations,
  weeklyReviewRecommendations,
  weeklyReviewActions,
  weeklyReviewEvents,
  adapterReadinessProbes,
} from "./weekly_reviews.js";
```

- [ ] **Step 3: Run DB typecheck before migration**

Run:

```sh
pnpm --filter @paperclipai/db typecheck
```

Expected: exits `0`.

- [ ] **Step 4: Generate migration**

Run:

```sh
pnpm db:generate
```

Expected: a new migration file and matching Drizzle snapshot are generated under `packages/db/src/migrations`.

- [ ] **Step 5: Verify migration numbering**

Run:

```sh
pnpm --filter @paperclipai/db run check:migrations
```

Expected: exits `0`.

---

## Task 3: Weekly Review Event And Retention Services

**Files:**

- Create: `server/src/services/weekly-review/events.ts`
- Create: `server/src/services/weekly-review/retention.ts`
- Create: `server/src/__tests__/weekly-review-retention.test.ts`

- [ ] **Step 1: Add event service test**

Create `server/src/__tests__/weekly-review-retention.test.ts` with tests for retention helpers:

```ts
import { describe, expect, it } from "vitest";
import {
  computeDebugEventExpiresAt,
  computeProbeExpiresAt,
  isAuditCriticalWeeklyReviewTable,
  redactWeeklyReviewDebugMetadata,
} from "../services/weekly-review/retention.js";

describe("weekly review retention", () => {
  it("expires failed debug metadata after 30 days", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");
    expect(computeDebugEventExpiresAt(now).toISOString()).toBe("2026-06-20T12:00:00.000Z");
  });

  it("expires readiness probe records after 90 days", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");
    expect(computeProbeExpiresAt(now).toISOString()).toBe("2026-08-19T12:00:00.000Z");
  });

  it("never purges audit-critical weekly review records", () => {
    expect(isAuditCriticalWeeklyReviewTable("weekly_reviews")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_versions")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_citations")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_actions")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_events")).toBe(false);
  });

  it("redacts dangerous debug metadata fields", () => {
    expect(
      redactWeeklyReviewDebugMetadata({
        prompt: "secret prompt",
        transcript: "raw transcript",
        env: { OPENAI_API_KEY: "sk-test" },
        signedUrl: "https://example.test/signed",
        validationErrors: ["missing citation"],
        ruleNames: ["citation.required"],
      }),
    ).toEqual({
      validationErrors: ["missing citation"],
      ruleNames: ["citation.required"],
    });
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```sh
pnpm exec vitest run server/src/__tests__/weekly-review-retention.test.ts
```

Expected: fails because `server/src/services/weekly-review/retention.ts` does not exist.

- [ ] **Step 3: Add retention service**

Create `server/src/services/weekly-review/retention.ts`:

```ts
const DAY_MS = 24 * 60 * 60 * 1000;
const DEBUG_RETENTION_DAYS = 30;
const PROBE_RETENTION_DAYS = 90;

const AUDIT_CRITICAL_TABLES = new Set([
  "weekly_reviews",
  "weekly_review_versions",
  "weekly_review_findings",
  "weekly_review_citations",
  "weekly_review_recommendations",
  "weekly_review_actions",
  "activity_log",
]);

const ALLOWED_DEBUG_KEYS = new Set([
  "validationErrors",
  "ruleNames",
  "entityIds",
  "counts",
  "errorCode",
  "failureReason",
]);

export function computeDebugEventExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + DEBUG_RETENTION_DAYS * DAY_MS);
}

export function computeProbeExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + PROBE_RETENTION_DAYS * DAY_MS);
}

export function isAuditCriticalWeeklyReviewTable(tableName: string): boolean {
  return AUDIT_CRITICAL_TABLES.has(tableName);
}

export function redactWeeklyReviewDebugMetadata(input: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (ALLOWED_DEBUG_KEYS.has(key)) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}
```

- [ ] **Step 4: Add event service**

Create `server/src/services/weekly-review/events.ts`:

```ts
import type { Db } from "@paperclipai/db";
import { weeklyReviewEvents } from "@paperclipai/db";
import type { WeeklyReviewEventStatus, WeeklyReviewEventType } from "@paperclipai/shared";
import { computeDebugEventExpiresAt, redactWeeklyReviewDebugMetadata } from "./retention.js";

export interface RecordWeeklyReviewEventInput {
  companyId: string;
  reviewId?: string | null;
  versionId?: string | null;
  eventType: WeeklyReviewEventType;
  status: WeeklyReviewEventStatus;
  actorUserId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  sourceWindowStart?: Date | null;
  sourceWindowEnd?: Date | null;
  inputCounts?: Record<string, number> | null;
  findingCounts?: Record<string, number> | null;
  citationValidation?: Record<string, unknown> | null;
  adapterReadinessSummary?: Record<string, unknown> | null;
  modelAssuranceSummary?: Record<string, unknown> | null;
  errorCode?: string | null;
  failureReason?: string | null;
  debugMetadata?: Record<string, unknown> | null;
}

export function weeklyReviewEventService(db: Db) {
  return {
    record: async (input: RecordWeeklyReviewEventInput) => {
      const isFailure = input.status === "failed" || input.eventType.endsWith("_failed");
      const [row] = await db.insert(weeklyReviewEvents).values({
        companyId: input.companyId,
        reviewId: input.reviewId ?? null,
        versionId: input.versionId ?? null,
        eventType: input.eventType,
        status: input.status,
        actorUserId: input.actorUserId ?? null,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        sourceWindowStart: input.sourceWindowStart ?? null,
        sourceWindowEnd: input.sourceWindowEnd ?? null,
        inputCountsJson: input.inputCounts ?? null,
        findingCountsJson: input.findingCounts ?? null,
        citationValidationJson: input.citationValidation ?? null,
        adapterReadinessSummaryJson: input.adapterReadinessSummary ?? null,
        modelAssuranceSummaryJson: input.modelAssuranceSummary ?? null,
        errorCode: input.errorCode ?? null,
        failureReason: input.failureReason ?? null,
        debugMetadataJson: isFailure ? redactWeeklyReviewDebugMetadata(input.debugMetadata) : null,
        expiresAt: isFailure ? computeDebugEventExpiresAt() : null,
      }).returning();

      return row;
    },
  };
}
```

- [ ] **Step 5: Run retention tests**

Run:

```sh
pnpm exec vitest run server/src/__tests__/weekly-review-retention.test.ts
```

Expected: passes.

---

## Task 4: Adapter And Model Readiness Services

**Files:**

- Create: `server/src/services/adapter-readiness/index.ts`
- Create: `server/src/services/model-assurance/index.ts`
- Create: `server/src/__tests__/adapter-readiness-service.test.ts`
- Create: `server/src/__tests__/model-assurance-service.test.ts`

- [ ] **Step 1: Add model assurance service tests**

Create `server/src/__tests__/model-assurance-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateModelAssurance } from "../services/model-assurance/index.js";

describe("evaluateModelAssurance", () => {
  it("approves codex primary model for engineering implementation", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: "gpt-5.3-codex",
        knownModels: [{ id: "gpt-5.3-codex", label: "gpt-5.3-codex" }],
        detectedModel: null,
        modelProfiles: [{ key: "cheap", label: "Cheap", adapterConfig: { model: "gpt-5.3-codex-spark" }, source: "adapter_default" }],
        helloRunSucceeded: true,
      }),
    ).toMatchObject({
      policyStatus: "approved_primary",
      roleFit: "strong",
      modelAvailable: true,
      modelRunnable: true,
      reasonCodes: [],
    });
  });

  it("warns on manual undiscovered model until hello-run proves it", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "codex_local",
        agentRole: "engineering",
        selectedModel: "manual-future-model",
        knownModels: [],
        detectedModel: null,
        modelProfiles: [],
        helloRunSucceeded: false,
      }),
    ).toMatchObject({
      policyStatus: "manual_allowed",
      modelAvailable: false,
      modelRunnable: false,
      reasonCodes: ["model_not_listed", "manual_model_unverified"],
    });
  });

  it("blocks weak role fit for cheap model on governed decision work", () => {
    expect(
      evaluateModelAssurance({
        adapterType: "agy_local",
        agentRole: "governance",
        selectedModel: "gemini-3.5-flash",
        knownModels: [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
        detectedModel: null,
        modelProfiles: [{ key: "cheap", label: "Cheap", adapterConfig: { model: "gemini-3.5-flash" }, source: "adapter_default" }],
        helloRunSucceeded: true,
      }),
    ).toMatchObject({
      policyStatus: "blocked",
      roleFit: "blocked",
      reasonCodes: ["role_fit_weak"],
    });
  });
});
```

- [ ] **Step 2: Run model assurance test and verify it fails**

Run:

```sh
pnpm exec vitest run server/src/__tests__/model-assurance-service.test.ts
```

Expected: fails because service does not exist.

- [ ] **Step 3: Add model assurance service**

Create `server/src/services/model-assurance/index.ts`:

```ts
import type { AdapterModel, AdapterModelProfileDefinition } from "../../adapters/index.js";
import type { ModelAssuranceReasonCode, ModelAssuranceSummary } from "@paperclipai/shared";

type AgentWorkRole = "engineering" | "research" | "governance" | "operations" | "finance" | "utility";

interface EvaluateModelAssuranceInput {
  adapterType: string;
  agentRole: AgentWorkRole;
  selectedModel: string | null | undefined;
  knownModels: AdapterModel[];
  detectedModel: string | null;
  modelProfiles: AdapterModelProfileDefinition[];
  helloRunSucceeded: boolean;
}

function modelFromProfile(profile: AdapterModelProfileDefinition): string | null {
  const model = profile.adapterConfig?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function isCheapProfileModel(model: string, profiles: AdapterModelProfileDefinition[]): boolean {
  return profiles.some((profile) => profile.key === "cheap" && modelFromProfile(profile) === model);
}

function roleFitFor(adapterType: string, role: AgentWorkRole, model: string | null, profiles: AdapterModelProfileDefinition[]) {
  if (!model) return { roleFit: "unknown" as const, reason: "Model could not be resolved." };
  const cheap = isCheapProfileModel(model, profiles);

  if (adapterType === "agy_local" && model !== "gemini-3.5-flash") {
    return { roleFit: "blocked" as const, reason: "AGY MVP certification only allows gemini-3.5-flash." };
  }
  if (cheap && ["governance", "research"].includes(role)) {
    return { roleFit: "blocked" as const, reason: "Cheap profile cannot make governed or material evidence decisions." };
  }
  if (adapterType === "codex_local" && role === "engineering") return { roleFit: "strong" as const, reason: null };
  if (adapterType === "agy_local" && role === "research") return { roleFit: "strong" as const, reason: null };
  if (adapterType === "claude_local" && ["governance", "operations", "finance"].includes(role)) {
    return { roleFit: "strong" as const, reason: null };
  }
  if (cheap) return { roleFit: "acceptable" as const, reason: "Cheap profile is acceptable for bounded low-risk utility work." };
  return { roleFit: "acceptable" as const, reason: null };
}

export function evaluateModelAssurance(input: EvaluateModelAssuranceInput): ModelAssuranceSummary {
  const selected = input.selectedModel?.trim() || null;
  const resolved = selected ?? input.detectedModel?.trim() ?? null;
  const known = Boolean(resolved && input.knownModels.some((model) => model.id === resolved));
  const manualAllowed = input.adapterType === "codex_local" && Boolean(resolved) && !known;
  const reasonCodes: ModelAssuranceReasonCode[] = [];

  if (!resolved) reasonCodes.push("model_unresolved");
  if (resolved && !known) reasonCodes.push("model_not_listed");
  if (manualAllowed && !input.helloRunSucceeded) reasonCodes.push("manual_model_unverified");
  if (!input.modelProfiles.some((profile) => profile.key === "cheap")) reasonCodes.push("cheap_profile_missing");

  const fit = roleFitFor(input.adapterType, input.agentRole, resolved, input.modelProfiles);
  if (fit.roleFit === "blocked" || fit.roleFit === "weak") reasonCodes.push("role_fit_weak");

  const blocked = fit.roleFit === "blocked" || (!resolved && !manualAllowed);
  const policyStatus =
    blocked ? "blocked"
      : manualAllowed ? "manual_allowed"
      : isCheapProfileModel(resolved ?? "", input.modelProfiles) ? "approved_cheap"
      : selected ? "approved_primary"
      : "approved_default";

  return {
    selectedModel: selected,
    resolvedModel: resolved,
    modelSource: selected ? "adapter_config" : input.detectedModel ? "detected" : "unknown",
    modelProfile: isCheapProfileModel(resolved ?? "", input.modelProfiles) ? "cheap" : "primary",
    modelAvailable: known,
    modelRunnable: input.helloRunSucceeded,
    policyStatus,
    roleFit: fit.roleFit,
    roleFitReason: fit.reason,
    reasonCodes: Array.from(new Set(reasonCodes)),
    capabilities: null,
  };
}
```

- [ ] **Step 4: Add adapter readiness service tests**

Create `server/src/__tests__/adapter-readiness-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateAdapterReadiness, shouldBlockAgentExecutionForReadiness } from "../services/adapter-readiness/index.js";

describe("adapter readiness", () => {
  it("blocks execution when basic readiness fails", () => {
    const result = evaluateAdapterReadiness({
      adapterType: "codex_local",
      cliFound: false,
      authOk: false,
      modelOk: false,
      workspaceOk: true,
      helloRunOk: false,
      operationalWarnings: [],
      fixtureReady: false,
      strictMode: false,
    });

    expect(result.status).toBe("blocked");
    expect(result.basicReady).toBe(false);
    expect(result.reasonCodes).toContain("binary_missing");
    expect(shouldBlockAgentExecutionForReadiness(result)).toBe(true);
  });

  it("warns on operational gaps unless strict mode is enabled", () => {
    const warning = evaluateAdapterReadiness({
      adapterType: "claude_local",
      cliFound: true,
      authOk: true,
      modelOk: true,
      workspaceOk: true,
      helloRunOk: true,
      operationalWarnings: ["quota_unknown"],
      fixtureReady: false,
      strictMode: false,
    });
    expect(warning.status).toBe("warning");
    expect(shouldBlockAgentExecutionForReadiness(warning)).toBe(false);

    const strict = { ...warning, strictMode: true };
    expect(shouldBlockAgentExecutionForReadiness(strict)).toBe(true);
  });
});
```

- [ ] **Step 5: Add adapter readiness service**

Create `server/src/services/adapter-readiness/index.ts`:

```ts
import type {
  AdapterReadinessReasonCode,
  AdapterReadinessStatus,
  LocalAdapterAssuranceType,
} from "@paperclipai/shared";

interface EvaluateAdapterReadinessInput {
  adapterType: LocalAdapterAssuranceType;
  cliFound: boolean;
  authOk: boolean;
  modelOk: boolean;
  workspaceOk: boolean;
  helloRunOk: boolean;
  operationalWarnings: AdapterReadinessReasonCode[];
  fixtureReady: boolean;
  strictMode: boolean;
}

export interface AdapterReadinessEvaluation {
  adapterType: LocalAdapterAssuranceType;
  status: AdapterReadinessStatus;
  basicReady: boolean;
  operationalReady: boolean;
  fixtureReady: boolean;
  reasonCodes: AdapterReadinessReasonCode[];
  strictMode: boolean;
}

export function evaluateAdapterReadiness(input: EvaluateAdapterReadinessInput): AdapterReadinessEvaluation {
  const reasonCodes: AdapterReadinessReasonCode[] = [];
  if (!input.cliFound) reasonCodes.push("binary_missing");
  if (!input.authOk) reasonCodes.push("auth_failed");
  if (!input.modelOk) reasonCodes.push("model_missing");
  if (!input.workspaceOk) reasonCodes.push("workspace_invalid");
  if (!input.helloRunOk) reasonCodes.push("hello_failed");
  reasonCodes.push(...input.operationalWarnings);

  const basicReady = input.cliFound && input.authOk && input.modelOk && input.workspaceOk && input.helloRunOk;
  const operationalReady = basicReady && input.operationalWarnings.length === 0;
  const status: AdapterReadinessStatus =
    !basicReady ? "blocked"
      : !operationalReady || !input.fixtureReady ? "warning"
      : "ready";

  return {
    adapterType: input.adapterType,
    status,
    basicReady,
    operationalReady,
    fixtureReady: input.fixtureReady,
    reasonCodes: Array.from(new Set(reasonCodes)),
    strictMode: input.strictMode,
  };
}

export function shouldBlockAgentExecutionForReadiness(input: Pick<AdapterReadinessEvaluation, "basicReady" | "operationalReady" | "strictMode">): boolean {
  if (!input.basicReady) return true;
  if (input.strictMode && !input.operationalReady) return true;
  return false;
}
```

- [ ] **Step 6: Run focused service tests**

Run:

```sh
pnpm exec vitest run server/src/__tests__/adapter-readiness-service.test.ts server/src/__tests__/model-assurance-service.test.ts
```

Expected: passes.

---

## Task 5: Persisted Readiness Probe Service And Routes

**Files:**

- Modify: `server/src/services/adapter-readiness/index.ts`
- Modify: `server/src/services/model-assurance/index.ts`
- Create: `server/src/routes/adapter-readiness.ts`
- Create: `server/src/routes/model-assurance.ts`
- Modify: `server/src/routes/index.ts`
- Create: `server/src/__tests__/adapter-readiness-routes.test.ts`

- [ ] **Step 1: Add route contract test**

Create `server/src/__tests__/adapter-readiness-routes.test.ts` using the existing route-test style in nearby tests. Test expectations:

```ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adapterReadinessRoutes } from "../routes/adapter-readiness.js";

const mockGetLatest = vi.hoisted(() => vi.fn());
const mockProbe = vi.hoisted(() => vi.fn());

vi.mock("../services/adapter-readiness/index.js", () => ({
  adapterReadinessService: () => ({
    getLatestForAgent: mockGetLatest,
    probeAgent: mockProbe,
  }),
}));

function app() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [],
      isInstanceAdmin: true,
    } as any;
    next();
  });
  app.use("/api", adapterReadinessRoutes({} as any));
  return app;
}

describe("adapter readiness routes", () => {
  beforeEach(() => {
    mockGetLatest.mockReset();
    mockProbe.mockReset();
  });

  it("returns latest agent readiness", async () => {
    mockGetLatest.mockResolvedValue({ status: "ready" });
    const res = await request(app()).get("/api/companies/company-1/agents/agent-1/adapter-readiness");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
    expect(mockGetLatest).toHaveBeenCalledWith("company-1", "agent-1");
  });

  it("probes agent readiness", async () => {
    mockProbe.mockResolvedValue({ status: "warning" });
    const res = await request(app())
      .post("/api/companies/company-1/agents/agent-1/adapter-readiness/probe")
      .send({ adapterType: "codex_local", strictMode: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "warning" });
  });
});
```

- [ ] **Step 2: Implement route**

Create `server/src/routes/adapter-readiness.ts`:

```ts
import type { Db } from "@paperclipai/db";
import { adapterReadinessProbeRequestSchema } from "@paperclipai/shared";
import { Router } from "express";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { adapterReadinessService } from "../services/adapter-readiness/index.js";

export function adapterReadinessRoutes(db: Db) {
  const router = Router();
  const svc = adapterReadinessService(db);

  router.get("/companies/:companyId/agents/:agentId/adapter-readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getLatestForAgent(companyId, agentId));
  });

  router.post("/companies/:companyId/agents/:agentId/adapter-readiness/probe", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    const body = adapterReadinessProbeRequestSchema.parse(req.body);
    const actor = getActorInfo(req);
    res.json(await svc.probeAgent(companyId, agentId, {
      adapterType: body.adapterType,
      strictMode: body.strictMode ?? false,
      checkedByUserId: actor.actorType === "user" ? actor.actorId : null,
    }));
  });

  return router;
}
```

- [ ] **Step 3: Add initial service methods backed by DB**

Extend `server/src/services/adapter-readiness/index.ts` with:

```ts
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { adapterReadinessProbes, agents } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { computeProbeExpiresAt } from "../weekly-review/retention.js";
import { findServerAdapter } from "../../adapters/index.js";

export function adapterReadinessService(db: Db) {
  return {
    getLatestForAgent: async (companyId: string, agentId: string) => {
      const [row] = await db
        .select()
        .from(adapterReadinessProbes)
        .where(and(eq(adapterReadinessProbes.companyId, companyId), eq(adapterReadinessProbes.agentId, agentId)))
        .orderBy(desc(adapterReadinessProbes.createdAt))
        .limit(1);
      return row ?? null;
    },
    probeAgent: async (
      companyId: string,
      agentId: string,
      input: { adapterType: LocalAdapterAssuranceType; strictMode: boolean; checkedByUserId: string | null },
    ) => {
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
        .limit(1);
      if (!agent) throw notFound("Agent not found");

      const adapter = findServerAdapter(input.adapterType);
      const evaluation = evaluateAdapterReadiness({
        adapterType: input.adapterType,
        cliFound: Boolean(adapter),
        authOk: Boolean(adapter),
        modelOk: Boolean(adapter),
        workspaceOk: true,
        helloRunOk: Boolean(adapter),
        operationalWarnings: adapter?.getQuotaWindows ? [] : ["quota_unknown"],
        fixtureReady: false,
        strictMode: input.strictMode,
      });

      const [row] = await db.insert(adapterReadinessProbes).values({
        companyId,
        agentId,
        adapterType: input.adapterType,
        status: evaluation.status,
        basicReady: evaluation.basicReady,
        operationalReady: evaluation.operationalReady,
        fixtureReady: evaluation.fixtureReady,
        reasonCodesJson: evaluation.reasonCodes,
        strictMode: input.strictMode,
        checkedByUserId: input.checkedByUserId,
        expiresAt: computeProbeExpiresAt(),
      }).returning();

      return row;
    },
  };
}
```

- [ ] **Step 4: Register route**

Modify `server/src/routes/index.ts`:

```ts
export { adapterReadinessRoutes } from "./adapter-readiness.js";
export { modelAssuranceRoutes } from "./model-assurance.js";
```

Also register these route factories wherever route factories are mounted in `server/src/index.ts` by following the existing pattern for `agentRoutes` and `costRoutes`.

- [ ] **Step 5: Add model assurance route**

Create `server/src/routes/model-assurance.ts` with the same access pattern:

```ts
import type { Db } from "@paperclipai/db";
import { Router } from "express";
import { assertCompanyAccess } from "./authz.js";
import { modelAssuranceService } from "../services/model-assurance/index.js";

export function modelAssuranceRoutes(db: Db) {
  const router = Router();
  const svc = modelAssuranceService(db);

  router.get("/companies/:companyId/agents/:agentId/model-assurance", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getLatestForAgent(companyId, agentId));
  });

  router.post("/companies/:companyId/agents/:agentId/model-assurance/probe", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.probeAgent(companyId, agentId));
  });

  return router;
}
```

Extend `server/src/services/model-assurance/index.ts` with `modelAssuranceService(db)` that reads the latest `adapterReadinessProbes` row and returns model fields. Keep write/probe behavior in `adapterReadinessService.probeAgent` for Wave 2 so adapter/model evidence is persisted in one company-scoped record.

- [ ] **Step 6: Run focused route tests**

Run:

```sh
pnpm exec vitest run server/src/__tests__/adapter-readiness-routes.test.ts
```

Expected: passes.

---

## Task 6: Northstar Fixture Skeleton

**Files:**

- Create: `server/src/services/weekly-review/northstar-fixture.ts`
- Create: `server/src/__tests__/northstar-fixture.test.ts`

- [ ] **Step 1: Add fixture test**

Create `server/src/__tests__/northstar-fixture.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NORTHSTAR_EXPECTED_FINDINGS, buildNorthstarFixturePlan } from "../services/weekly-review/northstar-fixture.js";

describe("Northstar weekly review fixture", () => {
  it("defines the locked eight finding ids", () => {
    expect(NORTHSTAR_EXPECTED_FINDINGS.map((finding) => finding.stableId)).toEqual([
      "NSR-F01",
      "NSR-F02",
      "NSR-F03",
      "NSR-F04",
      "NSR-F05",
      "NSR-F06",
      "NSR-F07",
      "NSR-F08",
    ]);
  });

  it("assigns local adapters and model policies by role", () => {
    const plan = buildNorthstarFixturePlan();
    expect(plan.agents.find((agent) => agent.key === "engineering-lead")).toMatchObject({
      adapterType: "codex_local",
      workstream: "Product Delivery",
    });
    expect(plan.agents.find((agent) => agent.key === "research-insights-lead")).toMatchObject({
      adapterType: "agy_local",
      workstream: "Research & Insights",
    });
    expect(plan.agents.find((agent) => agent.key === "ceo")).toMatchObject({
      adapterType: "claude_local",
      workstream: "Governance",
    });
  });
});
```

- [ ] **Step 2: Add fixture plan module**

Create `server/src/services/weekly-review/northstar-fixture.ts`:

```ts
import type { LocalAdapterAssuranceType, WeeklyReviewFindingCategory, WeeklyReviewFindingSeverity } from "@paperclipai/shared";

export const NORTHSTAR_EXPECTED_FINDINGS: Array<{
  stableId: string;
  category: WeeklyReviewFindingCategory;
  severity: WeeklyReviewFindingSeverity;
  workstream: string;
  title: string;
}> = [
  { stableId: "NSR-F01", category: "decision_blocker", severity: "critical", workstream: "Operations", title: "Support handoff owner missing blocks broad rollout" },
  { stableId: "NSR-F02", category: "action_required", severity: "high", workstream: "Governance", title: "Approve limited pilot rollout" },
  { stableId: "NSR-F03", category: "action_required", severity: "high", workstream: "Operations", title: "Assign Support/Ops Lead owner" },
  { stableId: "NSR-F04", category: "evidence_gap", severity: "high", workstream: "Research & Insights", title: "Research brief has one unsupported customer-segment claim" },
  { stableId: "NSR-F05", category: "stale_item", severity: "medium", workstream: "Operations", title: "Operations runbook update is stale and still blocks support handoff" },
  { stableId: "NSR-F06", category: "budget_signal", severity: "medium", workstream: "Budget", title: "Budget warning from citation-validation retries and prototype implementation spend" },
  { stableId: "NSR-F07", category: "quality_signal", severity: "medium", workstream: "Research & Insights", title: "Research summarization run failed validation" },
  { stableId: "NSR-F08", category: "win_context", severity: "low", workstream: "Product Delivery", title: "Cited weekly inbox digest prototype is ready for limited pilot" },
];

export function buildNorthstarFixturePlan() {
  return {
    company: {
      name: "Northstar Labs",
      issuePrefix: "NSR",
      goal: "Operate a small AI product and research studio with reliable weekly delivery, support, and governance.",
    },
    agents: [
      agent("ceo", "CEO", "Governance", "claude_local"),
      agent("product-lead", "Product Lead", "Governance", "claude_local"),
      agent("engineering-lead", "Engineering Lead", "Product Delivery", "codex_local"),
      agent("research-insights-lead", "Research & Insights Lead", "Research & Insights", "agy_local"),
      agent("support-ops-lead", "Support/Ops Lead", "Operations", "claude_local"),
      agent("finance-ops-analyst", "Finance/Ops Analyst", "Budget", "claude_local"),
    ],
    expectedFindings: NORTHSTAR_EXPECTED_FINDINGS,
  };
}

function agent(key: string, title: string, workstream: string, adapterType: LocalAdapterAssuranceType) {
  return {
    key,
    name: title,
    title,
    workstream,
    adapterType,
    modelPolicy: {
      selectedProfile: "primary",
      cheapProfileAllowedForLowRiskWork: true,
    },
  };
}
```

- [ ] **Step 3: Run fixture test**

Run:

```sh
pnpm exec vitest run server/src/__tests__/northstar-fixture.test.ts
```

Expected: passes.

---

## Task 7: Execution Readiness Gate Hook

**Files:**

- Modify: `server/src/services/adapter-readiness/index.ts`
- Modify: `server/src/services/heartbeat.ts`
- Test: `server/src/__tests__/adapter-readiness-service.test.ts`

- [ ] **Step 1: Add unit test for gate error shape**

Extend `server/src/__tests__/adapter-readiness-service.test.ts`:

```ts
import { assertCanStartAgentWithReadiness } from "../services/adapter-readiness/index.js";

it("throws a stable error when readiness blocks execution", () => {
  expect(() =>
    assertCanStartAgentWithReadiness({
      basicReady: false,
      operationalReady: false,
      strictMode: false,
      reasonCodes: ["binary_missing"],
    }),
  ).toThrow("Adapter readiness blocks execution: binary_missing");
});
```

- [ ] **Step 2: Add gate helper**

Extend `server/src/services/adapter-readiness/index.ts`:

```ts
export function assertCanStartAgentWithReadiness(input: {
  basicReady: boolean;
  operationalReady: boolean;
  strictMode: boolean;
  reasonCodes: string[];
}): void {
  if (!input.basicReady || (input.strictMode && !input.operationalReady)) {
    throw new Error(`Adapter readiness blocks execution: ${input.reasonCodes.join(", ") || "unknown"}`);
  }
}
```

- [ ] **Step 3: Add heartbeat hook**

In `server/src/services/heartbeat.ts`, add the import:

```ts
import { adapterReadinessService, assertCanStartAgentWithReadiness } from "./adapter-readiness/index.js";
```

Then, immediately before a queued run is promoted into actual adapter execution in the existing `startNextQueuedRunForAgent`/claim path, load the latest probe for local assurance adapters and call the helper:

```ts
const readiness = await adapterReadinessService(db).getLatestForAgent(agent.companyId, agent.id);
if (readiness && ["claude_local", "codex_local", "agy_local"].includes(agent.adapterType)) {
  assertCanStartAgentWithReadiness({
    basicReady: readiness.basicReady === true,
    operationalReady: readiness.operationalReady === true,
    strictMode: readiness.strictMode === true,
    reasonCodes: Array.isArray(readiness.reasonCodesJson) ? readiness.reasonCodesJson : [],
  });
}
```

Implementation note: use the exact variable names in the local function where the agent row and DB handle are available; do not refactor `heartbeat.ts` broadly.

- [ ] **Step 4: Run focused tests**

Run:

```sh
pnpm exec vitest run server/src/__tests__/adapter-readiness-service.test.ts
```

Expected: passes.

- [ ] **Step 5: Run heartbeat stop metadata test as a cheap heartbeat-adjacent smoke**

Run:

```sh
pnpm exec vitest run server/src/services/heartbeat-stop-metadata.test.ts
```

Expected: passes.

---

## Task 8: Verification And Plan Exit

**Files:** all files changed in Tasks 1-7.

- [ ] **Step 1: Run focused Wave 1-2 tests**

Run:

```sh
pnpm exec vitest run \
  server/src/__tests__/weekly-review-retention.test.ts \
  server/src/__tests__/northstar-fixture.test.ts \
  server/src/__tests__/adapter-readiness-service.test.ts \
  server/src/__tests__/model-assurance-service.test.ts \
  server/src/__tests__/adapter-readiness-routes.test.ts \
  server/src/__tests__/adapter-models.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run package typechecks**

Run:

```sh
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/db typecheck
pnpm --filter @paperclipai/server typecheck
```

Expected: all pass.

- [ ] **Step 3: Run migration generation if not already done**

Run:

```sh
pnpm db:generate
```

Expected: no schema compile errors and a migration is generated when schema changed.

- [ ] **Step 4: Run broader PR-ready verification only after Wave 1-2 are stable**

Run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all pass. If unrelated pre-existing test failures appear, isolate with focused tests and report them explicitly.

- [ ] **Step 5: Stop point before Wave 3**

Do not start the deterministic finding engine in this wave. Prepare a short handoff with:

- changed files
- generated migration file
- focused test results
- full verification result or explicit reason it was not run
- residual risks
- recommendation whether to proceed to Wave 3
