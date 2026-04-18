import {
  pgTable,
  uuid,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentHireEvents = pgTable(
  "agent_hire_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callerAgentId: uuid("caller_agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    createdAgentId: uuid("created_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    callerCreatedIdx: index("agent_hire_events_caller_created_idx").on(
      table.callerAgentId,
      table.createdAt,
    ),
  }),
);
