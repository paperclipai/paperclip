import { pgTable, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentManagers = pgTable(
  "agent_managers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentManagerUniq: uniqueIndex("agent_managers_agent_manager_uniq").on(
      table.agentId,
      table.managerId,
    ),
    agentIdx: index("agent_managers_agent_idx").on(table.agentId),
    managerIdx: index("agent_managers_manager_idx").on(table.managerId),
  }),
);
