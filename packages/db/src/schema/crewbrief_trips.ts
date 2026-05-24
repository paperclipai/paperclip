import { pgTable, text, timestamp, uuid, date } from "drizzle-orm/pg-core";

export const crewbriefTrips = pgTable("crewbrief_trips", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: text("trip_id").notNull().unique(),
  airline: text("airline"),
  status: text("status").notNull().default("scheduled"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
