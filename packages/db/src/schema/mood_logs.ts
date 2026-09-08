import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const moodLogs = pgTable(
  "mood_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    logDate: text("log_date").notNull(), // YYYY-MM-DD
    moodScore: integer("mood_score").notNull(), // 1–10
    energyLevel: integer("energy_level"), // 1–10, optional
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("mood_logs_user_company_idx").on(table.userId, table.companyId),
    userDateUq: uniqueIndex("mood_logs_user_date_uq").on(
      table.companyId,
      table.userId,
      table.logDate,
    ),
  }),
);
