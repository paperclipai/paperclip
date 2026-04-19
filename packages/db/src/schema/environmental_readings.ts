import {
  pgTable,
  uuid,
  text,
  timestamp,
  real,
  index,
} from "drizzle-orm/pg-core";
import { userLocations } from "./user_locations.js";

export const environmentalReadings = pgTable(
  "environmental_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id").notNull().references(() => userLocations.id),
    readingAt: timestamp("reading_at", { withTimezone: true }).notNull(),
    aqi: real("aqi"),
    pm25: real("pm25"),
    pm10: real("pm10"),
    no2: real("no2"),
    uvIndex: real("uv_index"),
    landSurfaceTemp: real("land_surface_temp"),
    ndvi: real("ndvi"),
    dataSource: text("data_source").notNull().default("planet_labs"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    locationReadingAtIdx: index("environmental_readings_location_reading_at_idx").on(
      table.locationId,
      table.readingAt,
    ),
  }),
);
