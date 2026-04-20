import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const projectAgents = pgTable(
  "project_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectAgentUniqueIdx: uniqueIndex("project_agents_project_agent_unique_idx").on(
      table.projectId,
      table.agentId,
    ),
    companyIdx: index("project_agents_company_idx").on(table.companyId),
  }),
);
