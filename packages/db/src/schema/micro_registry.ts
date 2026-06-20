import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const microPods = pgTable(
  "micro_pods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    paperclipIssueId: uuid("paperclip_issue_id").references(() => issues.id, { onDelete: "set null" }),
    identifier: text("identifier").notNull(),
    title: text("title").notNull(),
    source: text("source").notNull(),
    thesis: text("thesis").notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    lifecycleState: text("lifecycle_state").notNull().default("draft"),
    improvementAttemptCount: integer("improvement_attempt_count").notNull().default(0),
    dependencies: jsonb("dependencies").$type<unknown[]>().notNull().default([]),
    computeAssignmentId: uuid("compute_assignment_id"),
    dataAssignmentId: uuid("data_assignment_id"),
    brokerAssignmentId: uuid("broker_assignment_id"),
    evidencePackId: uuid("evidence_pack_id"),
    promotionRequestId: uuid("promotion_request_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    companyStateIdx: index("micro_pods_company_state_idx").on(table.companyId, table.lifecycleState),
    companyOwnerStateIdx: index("micro_pods_company_owner_state_idx").on(
      table.companyId,
      table.ownerAgentId,
      table.lifecycleState,
    ),
    companyIdentifierUq: uniqueIndex("micro_pods_company_identifier_uq").on(table.companyId, table.identifier),
  }),
);

export const microExperiments = pgTable(
  "micro_experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    podId: uuid("pod_id").notNull().references(() => microPods.id, { onDelete: "cascade" }),
    paperclipIssueId: uuid("paperclip_issue_id").references(() => issues.id, { onDelete: "set null" }),
    identifier: text("identifier").notNull(),
    title: text("title").notNull(),
    hypothesis: text("hypothesis").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceUrl: text("source_url"),
    lifecycleState: text("lifecycle_state").notNull().default("draft"),
    maxImprovementAttempts: integer("max_improvement_attempts").notNull().default(5),
    improvementAttemptCount: integer("improvement_attempt_count").notNull().default(0),
    overnightAllowed: boolean("overnight_allowed").notNull().default(false),
    holdingPeriodMinMinutes: integer("holding_period_min_minutes").notNull().default(1),
    holdingPeriodMaxMinutes: integer("holding_period_max_minutes"),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    verdict: text("verdict"),
    verdictReason: text("verdict_reason"),
    evidencePackId: uuid("evidence_pack_id"),
    promotionRequestId: uuid("promotion_request_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    companyStateIdx: index("micro_experiments_company_state_idx").on(table.companyId, table.lifecycleState),
    companyPodStateIdx: index("micro_experiments_company_pod_state_idx").on(
      table.companyId,
      table.podId,
      table.lifecycleState,
    ),
    companyIdentifierUq: uniqueIndex("micro_experiments_company_identifier_uq").on(table.companyId, table.identifier),
  }),
);

export const microDependencyRequests = pgTable(
  "micro_dependency_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    podId: uuid("pod_id").references(() => microPods.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id").references(() => microExperiments.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    routedToAgentId: uuid("routed_to_agent_id").references(() => agents.id, { onDelete: "set null" }),
    paperclipIssueId: uuid("paperclip_issue_id").references(() => issues.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("micro_dependency_requests_company_status_idx").on(table.companyId, table.status),
    companyPodIdx: index("micro_dependency_requests_company_pod_idx").on(table.companyId, table.podId),
  }),
);

export const microEvidencePacks = pgTable(
  "micro_evidence_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    podId: uuid("pod_id").references(() => microPods.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id").references(() => microExperiments.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    artifactUri: text("artifact_uri").notNull(),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("micro_evidence_packs_company_status_idx").on(table.companyId, table.status),
    companyExperimentIdx: index("micro_evidence_packs_company_experiment_idx").on(table.companyId, table.experimentId),
  }),
);

export const microPromotionRequests = pgTable(
  "micro_promotion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    podId: uuid("pod_id").references(() => microPods.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id").references(() => microExperiments.id, { onDelete: "cascade" }),
    evidencePackId: uuid("evidence_pack_id").references(() => microEvidencePacks.id, { onDelete: "set null" }),
    target: text("target").notNull(),
    status: text("status").notNull().default("requested"),
    rationale: text("rationale").notNull(),
    riskNotes: text("risk_notes"),
    paperclipIssueId: uuid("paperclip_issue_id").references(() => issues.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("micro_promotion_requests_company_status_idx").on(table.companyId, table.status),
    companyExperimentIdx: index("micro_promotion_requests_company_experiment_idx").on(table.companyId, table.experimentId),
  }),
);
