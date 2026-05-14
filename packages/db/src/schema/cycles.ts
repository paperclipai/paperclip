import { pgTable, uuid, text, timestamp, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    number: integer("number"),
    startsAt: date("starts_at"),
    endsAt: date("ends_at"),
    originId: text("origin_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("cycles_company_idx").on(table.companyId),
    originIdx: uniqueIndex("cycles_origin_idx").on(table.companyId, table.originId),
  }),
);
