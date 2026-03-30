import { pgTable, uuid, text, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentTelegramConfigs = pgTable(
  "agent_telegram_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    botToken: text("bot_token").notNull(),
    botUsername: text("bot_username"),
    enabled: boolean("enabled").notNull().default(false),
    ownerChatId: text("owner_chat_id"),
    allowedUserIds: jsonb("allowed_user_ids").$type<string[]>().notNull().default([]),
    requireMention: boolean("require_mention").notNull().default(true),
    mentionPatterns: jsonb("mention_patterns").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUnique: uniqueIndex("agent_telegram_configs_agent_idx").on(table.agentId),
    companyIdx: uniqueIndex("agent_telegram_configs_company_idx").on(table.companyId, table.agentId),
  }),
);
