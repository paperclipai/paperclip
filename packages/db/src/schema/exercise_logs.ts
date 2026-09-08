import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const exerciseLogs = pgTable(
  "exercise_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    exerciseDate: text("exercise_date").notNull(), // YYYY-MM-DD
    activityType: text("activity_type").notNull(), // "running" | "walking" | "cycling" | "swimming" | "strength" | "yoga" | "hiit" | "stretching" | "other"
    durationMinutes: integer("duration_minutes").notNull(),
    intensityLevel: text("intensity_level"), // "light" | "moderate" | "vigorous"
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyDateIdx: index("exercise_logs_user_company_date_idx").on(
      table.userId,
      table.companyId,
      table.exerciseDate,
    ),
  }),
);
