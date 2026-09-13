import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const agencyWebhookConfigs = pgTable(
  "agency_webhook_configs",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agencyName: text("agency_name").notNull(),
    agencyCode: text("agency_code").notNull(),
    webhookSecret: text("webhook_secret").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: uniqueIndex("agency_webhook_configs_code_idx").on(t.companyId, t.agencyCode),
  }),
);
