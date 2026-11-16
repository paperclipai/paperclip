import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

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
