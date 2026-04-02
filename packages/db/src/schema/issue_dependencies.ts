import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueDependencies = pgTable(
  "issue_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    blockerIssueId: uuid("blocker_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueEdge: uniqueIndex("issue_dependencies_unique_edge").on(table.issueId, table.blockerIssueId),
    companyIssueIdx: index("issue_dependencies_company_issue_idx").on(table.companyId, table.issueId),
    companyBlockerIdx: index("issue_dependencies_company_blocker_idx").on(table.companyId, table.blockerIssueId),
  }),
);
