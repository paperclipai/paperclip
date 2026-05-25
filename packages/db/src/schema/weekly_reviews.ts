import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { activityLog } from "./activity_log.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

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
