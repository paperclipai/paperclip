import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const completionContractEvaluations = pgTable(
  "completion_contract_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    contract: text("contract").notNull(),
    result: text("result", { enum: ["pass", "fail"] }).notNull(),
    missing: text("missing"),
    evaluator: text("evaluator", { enum: ["gate", "preflight", "audit"] }).notNull(),
    agentId: uuid("agent_id"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("cce_issue_idx").on(table.issueId),
    companyIdx: index("cce_company_idx").on(table.companyId),
    evaluatedAtIdx: index("cce_evaluated_at_idx").on(table.evaluatedAt),
  }),
);

export const completionContractOverrides = pgTable(
  "completion_contract_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    contract: text("contract").notNull(),
    reason: text("reason").notNull(),
    approver: text("approver", { enum: ["board", "cto"] }).notNull(),
    authorizedByUserId: uuid("authorized_by_user_id"),
    authorizedByAgentId: uuid("authorized_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("cco_issue_idx").on(table.issueId),
    companyIdx: index("cco_company_idx").on(table.companyId),
  }),
);
