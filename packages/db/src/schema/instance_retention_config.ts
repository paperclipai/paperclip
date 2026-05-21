import { pgTable, uuid, integer, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const instanceRetentionConfig = pgTable("instance_retention_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  succeededRunRetentionHours: integer("succeeded_run_retention_hours").notNull().default(72),
  failedRunRetentionHours: integer("failed_run_retention_hours").notNull().default(168),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
