import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentContracts } from "./agent_contracts.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentContractRevisions = pgTable(
  "agent_contract_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").notNull().references(() => agentContracts.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    laneKey: text("lane_key"),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    name: text("name").notNull(),
    allowedIssueTypes: jsonb("allowed_issue_types").$type<string[]>().notNull().default([]),
    requiredEvidenceTypes: jsonb("required_evidence_types").$type<string[]>().notNull().default([]),
    allowedEvidenceTypes: jsonb("allowed_evidence_types").$type<string[]>().notNull().default([]),
    requiresApprovalFor: jsonb("requires_approval_for").$type<string[]>().notNull().default([]),
    maxRunDurationSeconds: integer("max_run_duration_seconds"),
    contract: jsonb("contract").$type<Record<string, unknown>>().notNull().default({}),
    changeSummary: text("change_summary"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    activatedByUserId: text("activated_by_user_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyContractIdx: index("agent_contract_revisions_company_contract_idx").on(table.companyId, table.contractId),
    companyContractVersionIdx: uniqueIndex("agent_contract_revisions_contract_version_uq").on(
      table.contractId,
      table.version,
    ),
    companyAgentStatusIdx: index("agent_contract_revisions_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyStatusIdx: index("agent_contract_revisions_company_status_idx").on(table.companyId, table.status),
    companyLaneStatusIdx: index("agent_contract_revisions_company_lane_status_idx").on(
      table.companyId,
      table.laneKey,
      table.status,
    ),
  }),
);
