import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueDependencies = pgTable(
  "issue_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    blockingIssueId: uuid("blocking_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    dependentIssueId: uuid("dependent_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("issue_dependencies_pair_uq").on(
      t.blockingIssueId,
      t.dependentIssueId,
    ),
  }),
);
