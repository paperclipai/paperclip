import { sql } from "drizzle-orm";
import { check, pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const issueInboxArchives = pgTable(
  "issue_inbox_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    userId: text("user_id").notNull(),
    archivedByActorType: text("archived_by_actor_type").$type<"user" | "agent">().notNull().default("user"),
    // Agent-attributed writes must set both IDs; SET NULL preserves rows if referenced records are deleted.
    archivedByAgentId: uuid("archived_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    archivedByRunId: uuid("archived_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_inbox_archives_company_issue_idx").on(table.companyId, table.issueId),
    companyUserIdx: index("issue_inbox_archives_company_user_idx").on(table.companyId, table.userId),
    companyIssueUserUnique: uniqueIndex("issue_inbox_archives_company_issue_user_idx").on(
      table.companyId,
      table.issueId,
      table.userId,
    ),
    archivedByActorTypeCheck: check(
      "issue_inbox_archives_archived_by_actor_type_check",
      sql`${table.archivedByActorType} in ('user', 'agent')`,
    ),
  }),
);
