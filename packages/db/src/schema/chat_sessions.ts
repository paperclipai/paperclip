import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    taskKey: text("task_key").notNull(),
    title: text("title"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("chat_sessions_company_idx").on(table.companyId),
    agentUpdatedIdx: index("chat_sessions_agent_updated_idx").on(table.agentId, table.updatedAt),
    agentArchivedUpdatedIdx: index("chat_sessions_agent_archived_updated_idx").on(
      table.agentId,
      table.archivedAt,
      table.updatedAt,
    ),
    lastRunIdx: index("chat_sessions_last_run_idx").on(table.lastRunId),
    companyAgentTaskKeyUnique: uniqueIndex("chat_sessions_company_agent_task_key_idx").on(
      table.companyId,
      table.agentId,
      table.taskKey,
    ),
  }),
);
