import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { autonomyIncidents } from "./autonomy_incidents.js";

export const lanePolicies = pgTable(
  "lane_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    laneKey: text("lane_key").notNull(),
    laneName: text("lane_name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status").notNull().default("healthy"),
    statusReason: text("status_reason"),
    maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(1),
    maxManagerRuns: integer("max_manager_runs").notNull().default(0),
    allowParallelWithDependencyProof: boolean("allow_parallel_with_dependency_proof").notNull().default(false),
    allowRetry: boolean("allow_retry").notNull().default(false),
    maxRetryAttempts: integer("max_retry_attempts").notNull().default(0),
    allowedAgentIds: jsonb("allowed_agent_ids").$type<string[]>().notNull().default([]),
    allowedIssueTypes: jsonb("allowed_issue_types").$type<string[]>().notNull().default([]),
    allowedEvidenceTypes: jsonb("allowed_evidence_types").$type<string[]>().notNull().default([]),
    budgetPolicyRef: text("budget_policy_ref"),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
    activeRunId: uuid("active_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    activeIssueId: uuid("active_issue_id").references(() => issues.id, { onDelete: "set null" }),
    activeAgentId: uuid("active_agent_id").references(() => agents.id, { onDelete: "set null" }),
    stoppedByIncidentId: uuid("stopped_by_incident_id").references(() => autonomyIncidents.id, { onDelete: "set null" }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLaneKeyIdx: uniqueIndex("lane_policies_company_lane_key_uq").on(table.companyId, table.laneKey),
    companyDefaultIdx: uniqueIndex("lane_policies_company_default_uq")
      .on(table.companyId)
      .where(sql`${table.isDefault} = true`),
    companyStatusIdx: index("lane_policies_company_status_idx").on(table.companyId, table.status),
    companyActiveRunIdx: index("lane_policies_company_active_run_idx").on(table.companyId, table.activeRunId),
    companyActiveIssueIdx: index("lane_policies_company_active_issue_idx").on(table.companyId, table.activeIssueId),
    companyActiveAgentIdx: index("lane_policies_company_active_agent_idx").on(table.companyId, table.activeAgentId),
  }),
);
