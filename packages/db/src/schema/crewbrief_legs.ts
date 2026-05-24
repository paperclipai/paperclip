import { pgTable, text, timestamp, uuid, numeric, integer } from "drizzle-orm/pg-core";

export const crewbriefLegs = pgTable("crewbrief_legs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: text("trip_id").notNull(),
  dutyDayId: text("duty_day_id"),
  legNumber: integer("leg_number").notNull(),
  flightNumber: text("flight_number").notNull(),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  alternate: text("alternate"),
  scheduledDeparture: text("scheduled_departure"),
  scheduledArrival: text("scheduled_arrival"),
  aircraftId: uuid("aircraft_id"),
  filedAltitude: text("filed_altitude"),
  estimatedTimeEnroute: text("estimated_time_enroute"),
  distance: text("distance"),
  fuelPlan: numeric("fuel_plan"),
  fuelUnit: text("fuel_unit").default("lbs"),
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
