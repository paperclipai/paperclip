import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const autonomyEvidenceEntries = pgTable(
  "autonomy_evidence_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    verdict: text("verdict").notNull().default("pending"),
    laneKey: text("lane_key"),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    title: text("title").notNull(),
    summary: text("summary"),
    uri: text("uri"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    validatorName: text("validator_name"),
    validatorVersion: text("validator_version"),
    validatorMessage: text("validator_message"),
    validatorPayload: jsonb("validator_payload").$type<Record<string, unknown>>(),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("autonomy_evidence_entries_company_status_idx").on(table.companyId, table.status),
    companyVerdictIdx: index("autonomy_evidence_entries_company_verdict_idx").on(table.companyId, table.verdict),
    companyTypeIdx: index("autonomy_evidence_entries_company_type_idx").on(table.companyId, table.type),
    companyRunIdx: index("autonomy_evidence_entries_company_run_idx").on(table.companyId, table.runId),
    companyIssueIdx: index("autonomy_evidence_entries_company_issue_idx").on(table.companyId, table.issueId),
    companyAgentIdx: index("autonomy_evidence_entries_company_agent_idx").on(table.companyId, table.agentId),
    companyApprovalIdx: index("autonomy_evidence_entries_company_approval_idx").on(table.companyId, table.approvalId),
    companySourceIdx: index("autonomy_evidence_entries_company_source_idx").on(
      table.companyId,
      table.sourceType,
      table.sourceId,
    ),
  }),
);
