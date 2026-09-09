import { pgTable, uuid, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const labResults = pgTable(
  "lab_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    markerName: text("marker_name").notNull(),
    loincCode: text("loinc_code"),
    value: numeric("value").notNull(),
    unit: text("unit").notNull(),
    optimalMin: numeric("optimal_min"),
    optimalMax: numeric("optimal_max"),
    measuredDate: text("measured_date").notNull(), // YYYY-MM-DD
    source: text("source"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyDateIdx: index("lab_results_user_company_date_idx").on(
      table.userId,
      table.companyId,
      table.measuredDate,
    ),
    userCompanyMarkerIdx: index("lab_results_user_company_marker_idx").on(
      table.userId,
      table.companyId,
      table.markerName,
    ),
  }),
);
