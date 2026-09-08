import { pgTable, uuid, text, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const sleepRecords = pgTable(
  "sleep_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    sleepDate: text("sleep_date").notNull(), // YYYY-MM-DD of the morning woken up
    durationMinutes: integer("duration_minutes").notNull(),
    quality: text("quality"), // "poor" | "fair" | "good" | "excellent"
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("sleep_records_user_company_idx").on(table.userId, table.companyId),
    userDateUq: uniqueIndex("sleep_records_user_date_uq").on(
      table.companyId,
      table.userId,
      table.sleepDate,
    ),
  }),
);
