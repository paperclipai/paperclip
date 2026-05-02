import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardUserId: text("board_user_id").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    title: text("title").notNull().default("New chat"),
    model: text("model").notNull().default("claude-opus-4-7"),
    mode: text("mode").notNull().default("chat"),
    permissionMode: text("permission_mode").notNull().default("ask"),
    effort: text("effort").notNull().default("auto"),
    adapterSessionParams: jsonb("adapter_session_params").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUpdatedIdx: index("chat_sessions_user_updated_idx").on(table.boardUserId, table.updatedAt),
  }),
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index("chat_messages_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  }),
);
