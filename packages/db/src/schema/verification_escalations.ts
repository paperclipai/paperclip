import { pgTable, uuid, integer, timestamp, text, index } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { verificationRuns } from "./verification_runs.js";

export type VerificationEscalationResolution = "passed" | "overridden" | "reverted";

export const verificationEscalations = pgTable(
  "verification_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    verificationRunId: uuid("verification_run_id").notNull().references(() => verificationRuns.id),
    currentRung: integer("current_rung").notNull().default(0),
    nextRungAt: timestamp("next_rung_at", { withTimezone: true }).notNull(),
    escalatedToManagerAt: timestamp("escalated_to_manager_at", { withTimezone: true }),
    escalatedToCeoAt: timestamp("escalated_to_ceo_at", { withTimezone: true }),
    escalatedToBoardAt: timestamp("escalated_to_board_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution").$type<VerificationEscalationResolution | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    openIdx: index("verification_escalations_open_idx").on(table.nextRungAt),
  }),
);

export type VerificationEscalation = typeof verificationEscalations.$inferSelect;
export type NewVerificationEscalation = typeof verificationEscalations.$inferInsert;
