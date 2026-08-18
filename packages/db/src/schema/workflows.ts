import { desc } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    workflowKey: text("workflow_key"),
    capabilities: jsonb("capabilities").notNull().default([]),
    runnerType: text("runner_type").notNull().default("google_adk"),
    runnerConfig: jsonb("runner_config").notNull().default({}),
    pipelineDefinition: jsonb("pipeline_definition").notNull().default({}),
    pipelineSourceHash: text("pipeline_source_hash"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("workflows_company_status_idx").on(table.companyId, table.status),
    companyUpdatedIdx: index("workflows_company_updated_idx").on(table.companyId, table.updatedAt),
    companyWorkflowKeyUq: unique("workflows_company_workflow_key_uq").on(table.companyId, table.workflowKey),
    capabilitiesIdx: index("workflows_capabilities_idx").using("gin", table.capabilities),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    reviewStage: text("review_stage"),
    revision: integer("revision").notNull().default(0),
    inputMarkdown: text("input_markdown").notNull(),
    error: text("error"),
    summary: text("summary"),
    provider: text("provider"),
    model: text("model"),
    usage: jsonb("usage"),
    contextSnapshot: jsonb("context_snapshot"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkflowCreatedIdx: index("workflow_runs_company_workflow_created_idx").on(
      table.companyId,
      table.workflowId,
      table.createdAt,
    ),
    workflowStatusIdx: index("workflow_runs_workflow_status_idx").on(table.workflowId, table.status),
  }),
);

export const workflowRunEvents = pgTable(
  "workflow_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    actor: text("actor").notNull(),
    phase: text("phase").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    details: jsonb("details").notNull().default({}),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runCreatedIdx: index("workflow_run_events_run_created_idx").on(table.workflowRunId, table.createdAt, table.id),
    runIdempotencyUq: unique("workflow_run_events_run_idempotency_unique").on(table.workflowRunId, table.idempotencyKey),
  }),
);

export const workflowExtensionRequests = pgTable(
  "workflow_extension_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    extensionKey: text("extension_key").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    generationId: text("generation_id").notNull(),
    revision: integer("revision").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runCreatedIdx: index("workflow_extension_requests_run_created_idx").on(table.workflowRunId, table.createdAt),
    runIdempotencyUq: unique("workflow_extension_requests_run_extension_idempotency_unique").on(
      table.workflowRunId,
      table.extensionKey,
      table.idempotencyKey,
    ),
  }),
);

export const workflowRunPhases = pgTable(
  "workflow_run_phases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    phaseKey: text("phase_key").notNull(),
    label: text("label").notNull(),
    kind: text("kind").notNull().default("phase"),
    ordinal: integer("ordinal").notNull().default(0),
    status: text("status").notNull().default("idle"),
    metadata: jsonb("metadata"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runOrdinalIdx: index("workflow_run_phases_run_ordinal_idx").on(table.workflowRunId, table.ordinal),
    runPhaseKeyIdx: index("workflow_run_phases_run_phase_key_idx").on(table.workflowRunId, table.phaseKey),
    runPhaseKeyUnique: unique("workflow_run_phases_run_id_phase_key_unique").on(table.workflowRunId, table.phaseKey),
  }),
);

export const workflowRunTelemetryEvents = pgTable(
  "workflow_run_telemetry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    schemaVersion: text("schema_version").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    sequence: integer("sequence").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    actorKind: text("actor_kind").notNull(),
    actorName: text("actor_name"),
    operationKind: text("operation_kind").notNull(),
    operationName: text("operation_name").notNull(),
    status: text("status"),
    input: jsonb("input"),
    output: jsonb("output"),
    attributes: jsonb("attributes").notNull().default({}),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSequenceIdx: index("workflow_run_telemetry_events_run_sequence_idx").on(table.workflowRunId, table.sequence),
    runSpanIdx: index("workflow_run_telemetry_events_run_span_idx").on(table.workflowRunId, table.spanId),
    companyCreatedIdx: index("workflow_run_telemetry_events_company_created_idx").on(table.companyId, table.createdAt),
    runEventIdUnique: unique("workflow_run_telemetry_events_run_event_id_unique").on(table.workflowRunId, table.eventId),
  }),
);

export const workflowHandoffs = pgTable(
  "workflow_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    phaseKey: text("phase_key").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    reviewStage: text("review_stage"),
    revision: integer("revision").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    promptMarkdown: text("prompt_markdown").notNull(),
    responseMarkdown: text("response_markdown"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runStatusIdx: index("workflow_handoffs_run_status_idx").on(table.workflowRunId, table.status),
    runPhaseIdx: index("workflow_handoffs_run_phase_idx").on(table.workflowRunId, table.phaseKey),
    runIdempotencyUq: unique("workflow_handoffs_run_idempotency_unique").on(table.workflowRunId, table.idempotencyKey),
  }),
);

export const workflowDeliverables = pgTable(
  "workflow_deliverables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary"),
    audience: text("audience").notNull().default("human"),
    contentType: text("content_type").notNull(),
    contentPath: text("content_path"),
    contentBody: text("content_body"),
    byteSize: integer("byte_size").notNull().default(0),
    originalFilename: text("original_filename"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("workflow_deliverables_company_created_idx").on(table.companyId, table.createdAt),
    workflowCreatedIdx: index("workflow_deliverables_workflow_created_idx").on(table.workflowId, desc(table.createdAt)),
    runCreatedIdx: index("workflow_deliverables_run_created_idx").on(table.workflowRunId, table.createdAt),
  }),
);

export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    templateMarkdown: text("template_markdown").notNull(),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("workflow_schedules_company_status_idx").on(table.companyId, table.status),
    workflowNextRunIdx: index("workflow_schedules_workflow_next_run_idx").on(table.workflowId, table.nextRunAt),
    companyNextRunIdx: index("workflow_schedules_company_next_run_idx").on(table.companyId, table.nextRunAt),
  }),
);
