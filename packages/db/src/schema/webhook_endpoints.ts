import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    provider: text("provider").notNull().default("generic"),
    secret: text("secret").notNull(),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    eventCount: integer("event_count").notNull().default(0),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("webhook_endpoints_company_status_idx").on(table.companyId, table.status, table.createdAt),
    companyProviderIdx: index("webhook_endpoints_company_provider_idx").on(table.companyId, table.provider),
    companySlugUnique: uniqueIndex("webhook_endpoints_company_slug_uidx").on(table.companyId, table.slug),
  }),
);
