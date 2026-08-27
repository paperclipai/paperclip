import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { IssueUserRecencyKind } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueUserRecency = pgTable(
  "issue_user_recency",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    lastInteractedAt: timestamp("last_interacted_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").$type<IssueUserRecencyKind>().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.userId, table.companyId, table.issueId],
      name: "issue_user_recency_user_company_issue_pk",
    }),
    companyUserRecentIdx: index("issue_user_recency_company_user_recent_idx").on(
      table.companyId,
      table.userId,
      table.lastInteractedAt.desc(),
    ),
    companyIssueIdx: index("issue_user_recency_company_issue_idx").on(table.companyId, table.issueId),
    kindCheck: check(
      "issue_user_recency_kind_check",
      sql`${table.kind} in ('created', 'commented', 'interaction', 'approval', 'edited', 'document')`,
    ),
  }),
);
