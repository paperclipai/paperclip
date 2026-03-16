import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const telegramThreadMappings = pgTable(
  "telegram_thread_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    chatId: text("chat_id").notNull(),
    messageThreadId: text("message_thread_id").notNull(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUniqueIdx: uniqueIndex("telegram_thread_mappings_issue_idx").on(table.issueId),
    chatThreadUniqueIdx: uniqueIndex("telegram_thread_mappings_chat_thread_idx").on(
      table.chatId,
      table.messageThreadId,
    ),
  }),
);
