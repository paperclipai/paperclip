import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const nutritionLogs = pgTable(
  "nutrition_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    logDate: text("log_date").notNull(), // YYYY-MM-DD
    waterMl: integer("water_ml").notNull(), // millilitres
    calories: integer("calories"),
    proteinG: integer("protein_g"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("nutrition_logs_user_company_idx").on(table.userId, table.companyId),
    userDateUq: uniqueIndex("nutrition_logs_user_date_uq").on(
      table.companyId,
      table.userId,
      table.logDate,
    ),
  }),
);
