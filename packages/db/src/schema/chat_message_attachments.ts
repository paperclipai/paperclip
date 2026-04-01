import { pgTable, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { chatMessages } from "./chat_messages.js";
import { assets } from "./assets.js";

export const chatMessageAttachments = pgTable(
  "chat_message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    chatMessageId: uuid("chat_message_id").notNull().references(() => chatMessages.id),
    assetId: uuid("asset_id").notNull().references(() => assets.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("chat_message_attachments_message_idx").on(table.chatMessageId),
    assetUq: uniqueIndex("chat_message_attachments_asset_uq").on(table.assetId),
  }),
);
