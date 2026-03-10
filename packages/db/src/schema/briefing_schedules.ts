import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { records } from "./records.js";

// Briefing schedules treat briefing records as templates and create generated child briefings on each run.
export const briefingSchedules = pgTable(
  "briefing_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    recordId: uuid("record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    cadence: text("cadence").notNull(),
    timezone: text("timezone").notNull(),
    localHour: integer("local_hour").notNull(),
    localMinute: integer("local_minute").notNull(),
    dayOfWeek: integer("day_of_week"),
    windowPreset: text("window_preset").notNull(),
    autoPublish: boolean("auto_publish").notNull().default(false),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status").notNull().default("idle"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordUq: uniqueIndex("briefing_schedules_record_uq").on(table.recordId),
    companyNextRunIdx: index("briefing_schedules_company_next_run_idx").on(table.companyId, table.enabled, table.nextRunAt),
  }),
);
