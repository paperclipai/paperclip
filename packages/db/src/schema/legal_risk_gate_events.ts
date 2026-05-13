import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { legalMatters } from "./legal_matters.js";
import { legalApprovals } from "./legal_approvals.js";

export const legalRiskGateEvents = pgTable(
  "legal_risk_gate_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    matterId: uuid("matter_id").references(() => legalMatters.id),
    approvalId: uuid("approval_id").references(() => legalApprovals.id),
    riskGateKey: text("risk_gate_key").notNull(),
    triggeredByAgentId: uuid("triggered_by_agent_id"),
    triggerAction: text("trigger_action").notNull(),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>().notNull().default({}),
    outcome: text("outcome").notNull().default("pending"),
    gateDefinitionVersion: text("gate_definition_version"),
    profileKey: text("profile_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyGateOutcomeIdx: index(
      "legal_risk_gate_events_company_gate_outcome_idx",
    ).on(table.companyId, table.riskGateKey, table.outcome),
    companyMatterIdx: index("legal_risk_gate_events_company_matter_idx").on(
      table.companyId,
      table.matterId,
    ),
    companyApprovalIdx: index("legal_risk_gate_events_company_approval_idx").on(
      table.companyId,
      table.approvalId,
    ),
  }),
);
