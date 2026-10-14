import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { chatEndpoints } from "./chat_channels.js";
/** Personal, company-scoped callback opt-in. Never exposed through endpoint projections. */
export const chatVoiceCallbacks = pgTable("chat_voice_callbacks", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  userId: text("user_id").notNull(),
  phoneNumber: text("phone_number").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("chat_voice_callbacks_owner_uq").on(t.companyId, t.endpointId, t.userId),
  foreignKey({ columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_voice_callbacks_endpoint_fk" }).onDelete("cascade"),
  check("chat_voice_callbacks_phone_check", sql`${t.phoneNumber} ~ '^\\+[1-9][0-9]{6,14}$'`),
]);
