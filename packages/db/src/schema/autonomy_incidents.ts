import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const autonomyIncidents = pgTable(
  "autonomy_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    severity: text("severity").notNull().default("error"),
    status: text("status").notNull().default("open"),
    laneKey: text("lane_key"),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    remediation: text("remediation"),
    stopsLane: boolean("stops_lane").notNull().default(false),
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    acknowledgedByUserId: text("acknowledged_by_user_id"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("autonomy_incidents_company_status_idx").on(table.companyId, table.status),
    companySeverityIdx: index("autonomy_incidents_company_severity_idx").on(table.companyId, table.severity),
    companyTypeIdx: index("autonomy_incidents_company_type_idx").on(table.companyId, table.type),
    companyRunIdx: index("autonomy_incidents_company_run_idx").on(table.companyId, table.runId),
    companyIssueIdx: index("autonomy_incidents_company_issue_idx").on(table.companyId, table.issueId),
    companyAgentIdx: index("autonomy_incidents_company_agent_idx").on(table.companyId, table.agentId),
    companyLaneStatusIdx: index("autonomy_incidents_company_lane_status_idx").on(
      table.companyId,
      table.laneKey,
      table.status,
    ),
    companySourceIdx: index("autonomy_incidents_company_source_idx").on(table.companyId, table.sourceType, table.sourceId),
    companyIdempotencyIdx: index("autonomy_incidents_company_idempotency_idx").on(
      table.companyId,
      table.idempotencyKey,
    ),
  }),
);
