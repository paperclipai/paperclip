import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Durable fail-closed ledger for terminal control-plane failures that the
 * worker cannot self-report (e.g. `process_lost`).
 *
 * This table is intentionally decoupled from any issue: a generic (issue-less)
 * timer run can still be recorded here, and each ledger row points to a
 * top-level internal report issue (`reportIssueId`) plus, when the failed run
 * carried issue context, a ledger comment on that issue (`ledgerCommentId`).
 *
 * Idempotency is enforced atomically by the DB via the unique index on
 * (company_id, dedupe_key). The dedupe key is
 * `agentId | canonicalRootRunId | normalizedFailureCause`, so an entire retry
 * lineage of the same failure collapses to exactly one ledger row and one
 * top-level report. Re-delivery bumps `redeliveryCount` via ON CONFLICT DO
 * UPDATE — never a new row and never a new report.
 */
export const terminalFailureLedger = pgTable(
  "terminal_failure_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    normalizedFailureCause: text("normalized_failure_cause").notNull(),
    failureCause: text("failure_cause").notNull(),
    // Canonical root run id of the retry lineage. Stored as text because it may
    // reference a run row that has since been pruned — the ledger is a durable
    // audit record and must survive run deletion.
    rootRunId: text("root_run_id").notNull(),
    runId: text("run_id").notNull(),
    // Audit pointers (no FK: the ledger must outlive the referenced rows).
    issueId: uuid("issue_id"),
    reportIssueId: uuid("report_issue_id"),
    ledgerCommentId: uuid("ledger_comment_id"),
    redeliveryCount: integer("redelivery_count").notNull().default(0),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    lastRedeliveredAt: timestamp("last_redelivered_at", { withTimezone: true }),
  },
  (table) => ({
    companyDedupeKeyUq: uniqueIndex("terminal_failure_ledger_company_dedupe_key_uq").on(
      table.companyId,
      table.dedupeKey,
    ),
    companyAgentIdx: index("terminal_failure_ledger_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
  }),
);
