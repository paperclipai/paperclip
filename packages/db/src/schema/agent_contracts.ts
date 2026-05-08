import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { lanePolicies } from "./lane_policies.js";

export const agentContracts = pgTable(
  "agent_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    lanePolicyId: uuid("lane_policy_id").references(() => lanePolicies.id, { onDelete: "set null" }),
    laneKey: text("lane_key"),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    allowedIssueTypes: jsonb("allowed_issue_types").$type<string[]>().notNull().default([]),
    requiredEvidenceTypes: jsonb("required_evidence_types").$type<string[]>().notNull().default([]),
    allowedEvidenceTypes: jsonb("allowed_evidence_types").$type<string[]>().notNull().default([]),
    requiresApprovalFor: jsonb("requires_approval_for").$type<string[]>().notNull().default([]),
    maxRunDurationSeconds: integer("max_run_duration_seconds"),
    contract: jsonb("contract").$type<Record<string, unknown>>().notNull().default({}),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_contracts_company_agent_idx").on(table.companyId, table.agentId),
    companyAgentStatusIdx: index("agent_contracts_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyStatusIdx: index("agent_contracts_company_status_idx").on(table.companyId, table.status),
    companyLaneStatusIdx: index("agent_contracts_company_lane_status_idx").on(table.companyId, table.laneKey, table.status),
    companyLanePolicyIdx: index("agent_contracts_company_lane_policy_idx").on(table.companyId, table.lanePolicyId),
    companyAgentLaneNameIdx: uniqueIndex("agent_contracts_company_agent_lane_name_uq").on(
      table.companyId,
      table.agentId,
      table.laneKey,
      table.name,
    ),
  }),
);
