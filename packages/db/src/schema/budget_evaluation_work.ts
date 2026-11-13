import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Independent durable inputs. No producer updates a shared company cursor. */
export const budgetEvaluationWork = pgTable("budget_evaluation_work", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id"),
  projectId: uuid("project_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  companyPending: index("budget_evaluation_work_company_pending_idx").on(table.companyId, table.createdAt, table.id),
  agentPending: index("budget_evaluation_work_agent_pending_idx").on(table.companyId, table.agentId, table.createdAt),
  projectPending: index("budget_evaluation_work_project_pending_idx").on(table.companyId, table.projectId, table.createdAt),
}));
