import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agentThreads } from "./agent_threads.js";
import { agentThreadMessages } from "./agent_thread_messages.js";

export const agentThreadReads = pgTable(
  "agent_thread_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => agentThreads.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    lastReadMessageId: uuid("last_read_message_id").references(() => agentThreadMessages.id, { onDelete: "set null" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadIdx: index("agent_thread_reads_company_thread_idx").on(table.companyId, table.threadId),
    companyUserIdx: index("agent_thread_reads_company_user_idx").on(table.companyId, table.userId),
    companyThreadUserUnique: uniqueIndex("agent_thread_reads_company_thread_user_uq").on(
      table.companyId,
      table.threadId,
      table.userId,
    ),
  }),
);
