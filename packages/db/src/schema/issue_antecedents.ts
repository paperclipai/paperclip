import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const issueAntecedents = pgTable(
  "issue_antecedents",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    antecedentIssueId: uuid("antecedent_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.antecedentIssueId] }),
    antecedentIdx: index("issue_antecedents_antecedent_idx").on(table.antecedentIssueId),
  }),
);
