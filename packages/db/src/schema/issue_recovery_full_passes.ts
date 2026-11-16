import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * When a task recovery queue last finished checking every task of a company.
 * Any server writes it and every server reads it, so a replaced or overlapping
 * server keeps the hourly full pass on schedule instead of starting a new one
 * at boot. A row missing or older than an hour means a full pass is due.
 */
export const issueRecoveryFullPasses = pgTable("issue_recovery_full_passes", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  queue: text("queue").notNull(),
  /** When the pass began loading; changes committed after this are seen by the next pass. */
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
}, table => ({
  pk: primaryKey({ name: "issue_recovery_full_passes_pk", columns: [table.companyId, table.queue] }),
}));

/**
 * A task whose recovery check deferred itself to a later deadline (a grace
 * period, a back-off, a live owner's lease). The row exists while a deferral
 * is pending, so the successor of a replaced or crashed server re-checks these
 * tasks at boot and keeps their deadlines without re-checking every task.
 * The boot check computes the deadline again from current state.
 */
export const issueRecoveryDeferrals = pgTable("issue_recovery_deferrals", {
  queue: text("queue").notNull(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  /** The deadline the check deferred to, as last saved; deletes name it, so a newer one is never removed. */
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
}, table => ({
  pk: primaryKey({ name: "issue_recovery_deferrals_pk", columns: [table.queue, table.issueId] }),
}));
