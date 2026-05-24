import { pgTable, text, timestamp, uuid, date } from "drizzle-orm/pg-core";

export const crewbriefDutyDays = pgTable("crewbrief_duty_days", {
  id: uuid("id").primaryKey().defaultRandom(),
  dutyDayId: text("duty_day_id").notNull().unique(),
  tripId: text("trip_id").notNull(),
  crewMemberId: uuid("crew_member_id"),
  dutyDate: date("duty_date").notNull(),
  reportTime: text("report_time"),
  releaseTime: text("release_time"),
  position: text("position"),
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
