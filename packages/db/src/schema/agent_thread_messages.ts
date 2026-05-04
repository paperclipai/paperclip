import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agentThreads } from "./agent_threads.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";

export const agentThreadMessages = pgTable(
  "agent_thread_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => agentThreads.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    role: text("role").notNull(),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    producingHeartbeatRunId: uuid("producing_heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadCreatedAtIdx: index("agent_thread_messages_company_thread_created_at_idx").on(
      table.companyId,
      table.threadId,
      table.createdAt,
    ),
    companyRunIdx: index("agent_thread_messages_company_run_idx").on(table.companyId, table.producingHeartbeatRunId),
    threadRunUq: uniqueIndex("agent_thread_messages_thread_run_uq")
      .on(table.threadId, table.producingHeartbeatRunId)
      .where(sql`${table.producingHeartbeatRunId} IS NOT NULL`),
  }),
);
