import { type AnyPgColumn, pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { rooms } from "./rooms.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const roomMessages = pgTable(
  "room_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    senderAgentId: uuid("sender_agent_id").references(() => agents.id),
    senderUserId: text("sender_user_id"),
    type: text("type").notNull(),
    body: text("body").notNull(),
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>(),
    actionStatus: text("action_status"),
    actionTargetAgentId: uuid("action_target_agent_id").references(() => agents.id),
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => roomMessages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomCreatedIdx: index("room_messages_room_created_idx").on(table.roomId, table.createdAt),
    companyIdx: index("room_messages_company_idx").on(table.companyId),
    actionStatusIdx: index("room_messages_action_status_idx").on(table.companyId, table.actionStatus),
  }),
);
