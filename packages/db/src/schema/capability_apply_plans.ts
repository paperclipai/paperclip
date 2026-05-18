import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

export const capabilityApplyPlans = pgTable(
  "capability_apply_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    baseDesiredConfigRevisionId: text("base_desired_config_revision_id"),
    dryRunHash: text("dry_run_hash").notNull(),
    state: text("state").notNull().default("pending"),
    stepsJson: jsonb("steps_json").$type<unknown[]>().notNull().default([]),
    redactionSummaryJson: jsonb("redaction_summary_json").$type<Record<string, unknown>>(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    optimisticVersion: integer("optimistic_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentHashUidx: uniqueIndex("cap_apply_plans_company_agent_hash_uidx").on(table.companyId, table.agentId, table.dryRunHash),
    idempotencyKeyUidx: uniqueIndex("cap_apply_plans_idempotency_key_uidx").on(table.idempotencyKey),
    // LET-395: single-use approval — at most one plan may bind a given approval row.
    approvalIdUidx: uniqueIndex("cap_apply_plans_approval_id_uidx")
      .on(table.approvalId)
      .where(sql`${table.approvalId} IS NOT NULL`),
    companyAgentIdx: index("cap_apply_plans_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

export const capabilityApplySteps = pgTable(
  "capability_apply_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => capabilityApplyPlans.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    targetRefJson: jsonb("target_ref_json").$type<Record<string, unknown>>().notNull().default({}),
    riskClass: text("risk_class").notNull(),
    annotationsJson: jsonb("annotations_json").$type<Record<string, unknown>>().notNull().default({}),
    expectedNamedSecretsJson: jsonb("expected_named_secrets_json").$type<string[]>().notNull().default([]),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    beforeSnapshotJson: jsonb("before_snapshot_json").$type<Record<string, unknown>>(),
    afterSnapshotJson: jsonb("after_snapshot_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    planOrdinalUidx: uniqueIndex("cap_apply_steps_plan_ordinal_uidx").on(table.planId, table.ordinal),
  }),
);

export const capabilityApplyEvents = pgTable(
  "capability_apply_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => capabilityApplyPlans.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => capabilityApplySteps.id, { onDelete: "set null" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id"),
    kind: text("kind").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    planCreatedAtIdx: index("cap_apply_events_plan_idx").on(table.planId, table.createdAt),
    companyCreatedAtIdx: index("cap_apply_events_company_idx").on(table.companyId, table.createdAt),
  }),
);
