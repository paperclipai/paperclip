import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const verificationChaosRuns = pgTable("verification_chaos_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  scenario: text("scenario").notNull(),
  expectedOutcome: text("expected_outcome").notNull(),
  actualOutcome: text("actual_outcome").notNull(),
  passed: boolean("passed").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationChaosRun = typeof verificationChaosRuns.$inferSelect;
