import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const meditationLogs = pgTable(
  "meditation_logs",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id").notNull(),
    sessionDate: text("session_date").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    technique: text("technique"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCompanyIdx: index("meditation_logs_user_company_idx").on(t.userId, t.companyId),
    dateIdx: index("meditation_logs_date_idx").on(t.companyId, t.userId, t.sessionDate),
  }),
);
