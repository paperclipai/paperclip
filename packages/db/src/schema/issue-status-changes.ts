import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

export const issueStatusChanges = pgTable(
  "issue_status_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    changedByAgentId: uuid("changed_by_agent_id").references(() => agents.id),
    changedByUserId: text("changed_by_user_id").references(() => authUsers.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_status_changes_issue_idx").on(table.issueId),
    companyIdx: index("issue_status_changes_company_idx").on(table.companyId, table.changedAt),
  }),
);
