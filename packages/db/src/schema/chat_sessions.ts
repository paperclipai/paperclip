import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    startedByUserId: text("started_by_user_id").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"), // "idle_timeout" | "user_closed" | "agent_closed" | null
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentStartedIdx: index("chat_sessions_agent_started_idx").on(table.agentId, table.startedAt),
    companyAgentIdx: index("chat_sessions_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
