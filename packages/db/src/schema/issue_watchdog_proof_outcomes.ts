import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { issueWatchdogs } from "./issue_watchdogs.js";

export const issueWatchdogProofOutcomes = pgTable(
  "issue_watchdog_proof_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    watchdogId: uuid("watchdog_id").notNull().references(() => issueWatchdogs.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    watchdogIssueId: uuid("watchdog_issue_id").references(() => issues.id, { onDelete: "set null" }),
    targetIssueId: uuid("target_issue_id").references(() => issues.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull(),
    method: text("method").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    resultClassification: text("result_classification").notNull(),
    redactedDetails: jsonb("redacted_details").$type<Record<string, unknown>>().notNull().default({}),
    stopFingerprint: text("stop_fingerprint").notNull(),
    proofObligationFingerprint: text("proof_obligation_fingerprint").notNull(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWatchdogObservedIdx: index("issue_watchdog_proof_outcomes_company_watchdog_observed_idx").on(
      table.companyId,
      table.watchdogId,
      table.observedAt,
    ),
    companySourceIdx: index("issue_watchdog_proof_outcomes_company_source_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    uniqueProofIdx: uniqueIndex("issue_watchdog_proof_outcomes_unique_proof_uq").on(
      table.companyId,
      table.watchdogId,
      table.stopFingerprint,
      table.proofObligationFingerprint,
    ),
    outcomeCheck: check(
      "issue_watchdog_proof_outcomes_outcome_chk",
      sql`${table.outcome} IN ('accepted', 'restored', 'deferred', 'failed', 'dismissed')`,
    ),
  }),
);
