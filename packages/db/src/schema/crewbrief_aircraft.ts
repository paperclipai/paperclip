import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const crewbriefAircraft = pgTable("crewbrief_aircraft", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  registration: text("registration").notNull().unique(),
  configuration: text("configuration"),
  manufacturer: text("manufacturer"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
