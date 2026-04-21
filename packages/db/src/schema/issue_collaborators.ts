import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueCollaborators = pgTable(
  "issue_collaborators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    reason: text("reason").notNull().default("explicit"),
    addedByAgentId: uuid("added_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrincipalUq: uniqueIndex("issue_collaborators_issue_principal_uq").on(
      table.issueId,
      table.principalType,
      table.principalId,
    ),
    companyIssueIdx: index("issue_collaborators_company_issue_idx").on(table.companyId, table.issueId),
    principalIdx: index("issue_collaborators_principal_idx").on(table.principalType, table.principalId),
  }),
);
