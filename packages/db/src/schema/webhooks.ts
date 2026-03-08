import { pgTable, uuid, text, timestamp, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret"),
    events: jsonb("events").$type<string[]>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("webhooks_company_id_idx").on(table.companyId),
    companyEnabledIdx: index("webhooks_company_enabled_idx").on(table.companyId, table.enabled),
  }),
);
