import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { costEvents } from "./cost_events.js";
import type {
  BackgroundJobBackendKind,
  BackgroundJobEventLevel,
  BackgroundJobEventType,
  BackgroundJobRunStatus,
  BackgroundJobRunTrigger,
  BackgroundJobStatus,
} from "@paperclipai/shared";

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    jobType: text("job_type").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    backendKind: text("backend_kind").$type<BackgroundJobBackendKind>().notNull().default("server_worker"),
    status: text("status").$type<BackgroundJobStatus>().notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceProjectId: uuid("source_project_id").references(() => projects.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeStatusIdx: index("background_jobs_company_type_status_idx").on(
      table.companyId,
      table.jobType,
      table.status,
    ),
    companyKeyUq: uniqueIndex("background_jobs_company_key_uq").on(table.companyId, table.key),
  }),
);

export const backgroundJobRuns = pgTable(
  "background_job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => backgroundJobs.id, { onDelete: "set null" }),
    jobKey: text("job_key").notNull(),
    jobType: text("job_type").notNull(),
    trigger: text("trigger").$type<BackgroundJobRunTrigger>().notNull().default("manual"),
    status: text("status").$type<BackgroundJobRunStatus>().notNull().default("queued"),
    requestedByActorType: text("requested_by_actor_type").notNull().default("system"),
    requestedByActorId: text("requested_by_actor_id").notNull().default("system"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceProjectId: uuid("source_project_id").references(() => projects.id, { onDelete: "set null" }),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    totalItems: integer("total_items"),
    processedItems: integer("processed_items").notNull().default(0),
    succeededItems: integer("succeeded_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    skippedItems: integer("skipped_items").notNull().default(0),
    progressPercent: integer("progress_percent"),
    currentItem: text("current_item"),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("background_job_runs_company_created_idx").on(table.companyId, table.createdAt),
    companyTypeStatusIdx: index("background_job_runs_company_type_status_idx").on(
      table.companyId,
      table.jobType,
      table.status,
    ),
    companyIssueCreatedIdx: index("background_job_runs_company_issue_created_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.createdAt,
    ),
    jobCreatedIdx: index("background_job_runs_job_created_idx").on(table.jobId, table.createdAt),
  }),
);

export const backgroundJobEvents = pgTable(
  "background_job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => backgroundJobRuns.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<BackgroundJobEventType>().notNull(),
    level: text("level").$type<BackgroundJobEventLevel>().notNull().default("info"),
    message: text("message"),
    progressPercent: integer("progress_percent"),
    totalItems: integer("total_items"),
    processedItems: integer("processed_items"),
    succeededItems: integer("succeeded_items"),
    failedItems: integer("failed_items"),
    skippedItems: integer("skipped_items"),
    currentItem: text("current_item"),
    details: jsonb("details").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runCreatedIdx: index("background_job_events_run_created_idx").on(table.runId, table.createdAt),
    companyCreatedIdx: index("background_job_events_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

export const backgroundJobCostEvents = pgTable(
  "background_job_cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => backgroundJobRuns.id, { onDelete: "cascade" }),
    costEventId: uuid("cost_event_id").notNull().references(() => costEvents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("background_job_cost_events_run_idx").on(table.runId),
    costEventUq: uniqueIndex("background_job_cost_events_cost_event_uq").on(table.costEventId),
  }),
);
