import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const pilotApplications = pgTable("pilot_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  practiceType: text("practice_type").notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
