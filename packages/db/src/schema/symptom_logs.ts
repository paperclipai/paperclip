import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const symptomLogs = pgTable(
  "symptom_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    symptomDate: text("symptom_date").notNull(), // YYYY-MM-DD
    symptom: text("symptom").notNull(),
    severity: integer("severity"), // 1–5, optional
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyDateIdx: index("symptom_logs_user_company_date_idx").on(
      table.userId,
      table.companyId,
      table.symptomDate,
    ),
  }),
);
