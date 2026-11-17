import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const issueAccessGrants = pgTable(
  "issue_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    source: text("source").notNull(),
    grantedByUserId: text("granted_by_user_id"),
    grantedByAgentId: uuid("granted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    subjectTypeCheck: check(
      "issue_access_grants_subject_type_check",
      sql`${table.subjectType} in ('user', 'agent')`,
    ),
    sourceCheck: check(
      "issue_access_grants_source_check",
      sql`${table.source} in ('explicit', 'assignment', 'project')`,
    ),
    predicateIdx: index("issue_access_grants_subject_active_issue_idx").on(
      table.subjectType,
      table.subjectId,
      table.revokedAt,
      table.issueId,
    ),
    issueIdx: index("issue_access_grants_issue_idx").on(table.issueId, table.createdAt),
  }),
);
