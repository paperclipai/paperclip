import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const medicationLogs = pgTable(
  "medication_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    medicationDate: text("medication_date").notNull(), // YYYY-MM-DD
    medicationName: text("medication_name").notNull(),
    dosage: text("dosage"),
    taken: boolean("taken").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyDateIdx: index("medication_logs_user_company_date_idx").on(
      table.userId,
      table.companyId,
      table.medicationDate,
    ),
  }),
);
