import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Messaging bridge configurations per company.
 * Each row represents a configured messaging platform (telegram, email, slack, discord).
 * Only one bridge per platform per company.
 */
export const messagingBridges = pgTable(
  "messaging_bridges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Platform identifier: "telegram" | "email" | "slack" | "discord" */
    platform: text("platform").notNull(),
    /** Connection status: "connected" | "disconnected" | "error" */
    status: text("status").notNull().default("disconnected"),
    /** Last error message if status is "error" */
    lastError: text("last_error"),
    /** Platform-specific configuration (non-secret, e.g. allowed chat IDs) */
    config: jsonb("config").$type<Record<string, unknown>>().default({}),
    /** Reference to the company secret holding the bot token (for telegram) */
    secretId: uuid("secret_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("messaging_bridges_company_idx").on(table.companyId),
    companyPlatformUq: uniqueIndex("messaging_bridges_company_platform_uq").on(
      table.companyId,
      table.platform,
    ),
  }),
);
