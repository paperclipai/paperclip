import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { verificationRuns } from "./verification_runs.js";

export const verificationOverrides = pgTable("verification_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  verificationRunId: uuid("verification_run_id").references(() => verificationRuns.id),
  userId: text("user_id").notNull(),
  justification: text("justification").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationOverride = typeof verificationOverrides.$inferSelect;
export type NewVerificationOverride = typeof verificationOverrides.$inferInsert;
