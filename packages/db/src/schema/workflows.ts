import { pgTable, uuid, text, timestamp, jsonb, index, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEnabledIdx: index("workflows_company_enabled_idx").on(table.companyId, table.enabled),
  }),
);
