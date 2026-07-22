import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const issueTreeHolds = pgTable(
  "issue_tree_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    rootIssueId: uuid("root_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("active"),
    reason: text("reason"),
    releasePolicy: jsonb("release_policy").$type<Record<string, unknown>>(),
    createdByActorType: text("created_by_actor_type").notNull().default("system"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedByActorType: text("released_by_actor_type"),
    releasedByAgentId: uuid("released_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    releasedByUserId: text("released_by_user_id"),
    releasedByRunId: uuid("released_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    releaseReason: text("release_reason"),
    releaseMetadata: jsonb("release_metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRootStatusIdx: index("issue_tree_holds_company_root_status_idx").on(
      table.companyId,
      table.rootIssueId,
      table.status,
    ),
    companyStatusModeIdx: index("issue_tree_holds_company_status_mode_idx").on(table.companyId, table.status, table.mode),
  }),
);
