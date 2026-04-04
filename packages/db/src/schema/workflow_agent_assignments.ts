import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { workflows } from "./workflows.js";

export const workflowAgentAssignments = pgTable(
  "workflow_agent_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowAgentUq: uniqueIndex("workflow_agent_assignments_workflow_agent_uq").on(table.workflowId, table.agentId),
    companyAgentIdx: index("workflow_agent_assignments_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
