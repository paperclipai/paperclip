import { index, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const heartbeatRunSilenceState = pgTable(
  "heartbeat_run_silence_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    consecutiveFalsePositives: integer("consecutive_false_positives").notNull().default(0),
    backoffMultiplier: integer("backoff_multiplier").notNull().default(1),
    lastEvaluationIssueId: uuid("last_evaluation_issue_id").references(() => issues.id, { onDelete: "set null" }),
    lastClosedAt: timestamp("last_closed_at", { withTimezone: true }),
    nextEligibleScanAt: timestamp("next_eligible_scan_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunUq: uniqueIndex("heartbeat_run_silence_state_company_run_uq").on(table.companyId, table.runId),
    nextEligibleIdx: index("heartbeat_run_silence_state_next_eligible_idx").on(
      table.companyId,
      table.nextEligibleScanAt,
    ),
  }),
);
