import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projectWorkspaces } from "./project_workspaces.js";

// Workspace checkouts track isolated issue-specific worktrees or fallback sessions for repo-backed project work.
export const workspaceCheckouts = pgTable(
  "workspace_checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectWorkspaceId: uuid("project_workspace_id").notNull().references(() => projectWorkspaces.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    branchName: text("branch_name"),
    worktreePath: text("worktree_path"),
    status: text("status").notNull().default("active"),
    baseRef: text("base_ref"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueAgentIdx: index("workspace_checkouts_issue_agent_idx").on(table.companyId, table.issueId, table.agentId, table.updatedAt),
    workspaceStatusIdx: index("workspace_checkouts_workspace_status_idx").on(table.projectWorkspaceId, table.status, table.updatedAt),
  }),
);
