import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueDependencies = pgTable(
  "issue_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    blockedIssueId: uuid("blocked_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    blockingIssueId: uuid("blocking_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    source: text("source").notNull().default("manual"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    blockedIdx: index("idx_deps_blocked").on(table.blockedIssueId),
    blockingIdx: index("idx_deps_blocking").on(table.blockingIssueId),
    companyIdx: index("idx_deps_company").on(table.companyId),
    uniqueDep: uniqueIndex("idx_deps_unique").on(table.blockedIssueId, table.blockingIssueId),
  }),
);
