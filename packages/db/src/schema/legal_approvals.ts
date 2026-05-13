import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { legalMatters } from "./legal_matters.js";

export const legalApprovals = pgTable(
  "legal_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    matterId: uuid("matter_id").references(() => legalMatters.id),
    riskGateKey: text("risk_gate_key").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id"),
    requestedByUserId: text("requested_by_user_id"),
    approverRole: text("approver_role").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    rationale: text("rationale"),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusGateIdx: index(
      "legal_approvals_company_status_gate_idx",
    ).on(table.companyId, table.status, table.riskGateKey),
    companyMatterIdx: index("legal_approvals_company_matter_idx").on(
      table.companyId,
      table.matterId,
    ),
  }),
);
