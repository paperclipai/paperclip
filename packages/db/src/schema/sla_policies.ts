import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const slaPolicies = pgTable(
  "sla_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDefaultUq: uniqueIndex("sla_policies_company_default_uq")
      .on(table.companyId)
      .where(sql`${table.isDefault} = true and ${table.status} = 'active'`),
    companyStatusIdx: index("sla_policies_company_status_idx").on(table.companyId, table.status),
  }),
);
