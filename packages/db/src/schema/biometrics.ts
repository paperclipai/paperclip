import { pgTable, uuid, text, timestamp, integer, doublePrecision, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const biometricReadings = pgTable(
  "biometric_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    measurementDate: text("measurement_date").notNull(), // YYYY-MM-DD
    weightKg: doublePrecision("weight_kg"),
    systolicBp: integer("systolic_bp"),
    diastolicBp: integer("diastolic_bp"),
    restingHeartRate: integer("resting_heart_rate"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("biometric_readings_user_company_idx").on(table.userId, table.companyId),
    userDateUq: uniqueIndex("biometric_readings_user_date_uq").on(
      table.companyId,
      table.userId,
      table.measurementDate,
    ),
  }),
);
