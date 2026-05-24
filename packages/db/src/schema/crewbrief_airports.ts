import { pgTable, text, timestamp, uuid, numeric } from "drizzle-orm/pg-core";

export const crewbriefAirports = pgTable("crewbrief_airports", {
  id: uuid("id").primaryKey().defaultRandom(),
  icao: text("icao").notNull().unique(),
  iata: text("iata"),
  name: text("name").notNull(),
  city: text("city"),
  country: text("country"),
  latitude: numeric("latitude"),
  longitude: numeric("longitude"),
  timezone: text("timezone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
