import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentPromptVersions = pgTable(
  "agent_prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    versionNumber: integer("version_number").notNull(),
    systemPrompt: text("system_prompt"),
    agentInstructions: text("agent_instructions"),
    changedByUserId: text("changed_by_user_id"),
    changeSummary: text("change_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentVersionIdx: index("agent_prompt_versions_agent_idx").on(table.agentId, table.versionNumber),
  }),
);
