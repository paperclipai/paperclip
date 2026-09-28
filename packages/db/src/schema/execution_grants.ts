import { index, pgTable, text, timestamp, uniqueIndex, uuid, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/** Immutable approved intent; only consumedAt/consumedByRunId change after issuance. */
export const executionGrants = pgTable("execution_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  decisionKind: text("decision_kind").$type<"agent" | "board">().notNull(),
  decisionId: uuid("decision_id").notNull(),
  proposerAgentId: uuid("proposer_agent_id").notNull(),
  approverAgentId: uuid("approver_agent_id"),
  approverUserId: text("approver_user_id"),
  executorAgentId: uuid("executor_agent_id").notNull(),
  targetAgentId: uuid("target_agent_id").notNull(),
  operation: text("operation").notNull(),
  targetRevisionId: uuid("target_revision_id"),
  requestHash: text("request_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  policyVersion: integer("policy_version").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedByRunId: uuid("consumed_by_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  decisionUq: uniqueIndex("execution_grants_company_decision_uq")
    .on(table.companyId, table.decisionKind, table.decisionId),
  targetIdx: index("execution_grants_company_target_idx").on(table.companyId, table.targetAgentId),
}));
