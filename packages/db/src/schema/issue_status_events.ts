import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * TSMC-20879: durable status-transition history for issues.
 *
 * Rows are written by a DATABASE TRIGGER on `issues` (migration 9012), never by
 * application code: 61+ code paths update `issues.status` across 8 services, and
 * any missed call-site would silently corrupt closure counts again (the
 * 2026-08-15 `updated_at`-as-proxy defect inflated closures by 25%). The trigger
 * records every INSERT (from_status null) and every status-changing UPDATE for
 * every writer, including future ones.
 *
 * No FKs on purpose: the events are an audit log that must survive issue
 * deletion, and the trigger must never fail an issue write because of a
 * constraint on the log table.
 */
export const issueStatusEvents = pgTable(
  "issue_status_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_status_events_issue_idx").on(table.issueId, table.createdAt),
    companyIdx: index("issue_status_events_company_idx").on(table.companyId, table.createdAt),
    toStatusIdx: index("issue_status_events_to_status_idx").on(
      table.companyId,
      table.toStatus,
      table.createdAt,
    ),
  }),
);
