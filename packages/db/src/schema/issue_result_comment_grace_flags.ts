import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueResultCommentGraceFlags = pgTable(
  "issue_result_comment_grace_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    resultCommentId: uuid("result_comment_id").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    strandUq: uniqueIndex("issue_result_comment_grace_flags_strand_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.runId,
    ),
  }),
);
