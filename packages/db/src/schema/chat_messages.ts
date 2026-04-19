import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { chatSessions } from "./chat_sessions.js";
import { agents } from "./agents.js";

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    sender: text("sender").notNull(), // "user" | "agent"
    content: text("content").notNull(),
    attachments: jsonb("attachments"), // ChatAttachment[] | null
    readAt: timestamp("read_at", { withTimezone: true }), // when the recipient read this message
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index("chat_messages_session_created_idx").on(table.sessionId, table.createdAt),
    agentCreatedIdx: index("chat_messages_agent_created_idx").on(table.agentId, table.createdAt),
  }),
);
