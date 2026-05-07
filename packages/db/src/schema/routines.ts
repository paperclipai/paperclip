import {
  type AnyPgColumn,
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
import { companySecrets } from "./company_secrets.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import type { RoutineRevisionSnapshotV1, RoutineVariable } from "@paperclipai/shared";

export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    parentIssueId: uuid("parent_issue_id").references(() => issues.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("active"),
    concurrencyPolicy: text("concurrency_policy").notNull().default("coalesce_if_active"),
    catchUpPolicy: text("catch_up_policy").notNull().default("skip_missed"),
    variables: jsonb("variables").$type<RoutineVariable[]>().notNull().default([]),
    latestRevisionId: uuid("latest_revision_id"),
    latestRevisionNumber: integer("latest_revision_number").notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("routines_company_status_idx").on(table.companyId, table.status),
    companyAssigneeIdx: index("routines_company_assignee_idx").on(table.companyId, table.assigneeAgentId),
    companyProjectIdx: index("routines_company_project_idx").on(table.companyId, table.projectId),
  }),
);

export const routineRevisions = pgTable(
  "routine_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    snapshot: jsonb("snapshot").$type<RoutineRevisionSnapshotV1>().notNull(),
    changeSummary: text("change_summary"),
    restoredFromRevisionId: uuid("restored_from_revision_id").references(
      (): AnyPgColumn => routineRevisions.id,
      { onDelete: "set null" },
    ),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routineRevisionUq: uniqueIndex("routine_revisions_routine_revision_uq").on(
      table.routineId,
      table.revisionNumber,
    ),
    companyRoutineCreatedIdx: index("routine_revisions_company_routine_created_idx").on(
      table.companyId,
      table.routineId,
      table.createdAt,
    ),
  }),
);

export const routineTriggers = pgTable(
  "routine_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    cronExpression: text("cron_expression"),
    timezone: text("timezone"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    publicId: text("public_id"),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    signingMode: text("signing_mode"),
    replayWindowSec: integer("replay_window_sec"),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    lastResult: text("last_result"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRoutineIdx: index("routine_triggers_company_routine_idx").on(table.companyId, table.routineId),
    companyKindIdx: index("routine_triggers_company_kind_idx").on(table.companyId, table.kind),
    nextRunIdx: index("routine_triggers_next_run_idx").on(table.nextRunAt),
    publicIdIdx: index("routine_triggers_public_id_idx").on(table.publicId),
    publicIdUq: uniqueIndex("routine_triggers_public_id_uq").on(table.publicId),
  }),
);

export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
    triggerId: uuid("trigger_id").references(() => routineTriggers.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    status: text("status").notNull().default("received"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key"),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>(),
    dispatchFingerprint: text("dispatch_fingerprint"),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    coalescedIntoRunId: uuid("coalesced_into_run_id"),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRoutineIdx: index("routine_runs_company_routine_idx").on(table.companyId, table.routineId, table.createdAt),
    triggerIdx: index("routine_runs_trigger_idx").on(table.triggerId, table.createdAt),
    dispatchFingerprintIdx: index("routine_runs_dispatch_fingerprint_idx").on(table.routineId, table.dispatchFingerprint),
    linkedIssueIdx: index("routine_runs_linked_issue_idx").on(table.linkedIssueId),
    idempotencyIdx: index("routine_runs_trigger_idempotency_idx").on(table.triggerId, table.idempotencyKey),
  }),
);
