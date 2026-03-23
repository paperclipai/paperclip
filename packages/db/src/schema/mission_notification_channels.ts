import { pgTable, uuid, text, boolean, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { missions } from "./missions.js";

export const missionNotificationChannels = pgTable("mission_notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  channelType: text("channel_type").notNull(),
  config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
  triggers: text("triggers").array().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
