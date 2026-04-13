import { pgTable, text, integer, timestamp, boolean, uuid } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const specMetadata = pgTable("spec_metadata", {
  specPath: text("spec_path").primaryKey(),
  totalRuns: integer("total_runs").notNull().default(0),
  passCount: integer("pass_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  flakeCount: integer("flake_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastFlakeAt: timestamp("last_flake_at", { withTimezone: true }),
  flaky: boolean("flaky").notNull().default(false),
  maintenanceIssueId: uuid("maintenance_issue_id").references(() => issues.id),
});

export type SpecMetadata = typeof specMetadata.$inferSelect;
export type NewSpecMetadata = typeof specMetadata.$inferInsert;
