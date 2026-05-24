import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const crewbriefCrewMembers = pgTable("crewbrief_crew_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: text("employee_id").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  email: text("email"),
  phone: text("phone"),
  baseAirport: text("base_airport"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
