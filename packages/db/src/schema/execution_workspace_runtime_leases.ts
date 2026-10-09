import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

// One durable exclusivity row per execution workspace. The unique constraint on
// execution_workspace_id is the atomicity anchor: concurrent claims from
// different server processes serialize on it instead of on per-process state.
export const executionWorkspaceRuntimeLeases = pgTable(
  "execution_workspace_runtime_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    executionWorkspaceId: uuid("execution_workspace_id")
      .notNull()
      .unique()
      .references(() => executionWorkspaces.id, { onDelete: "cascade" }),
    // Durable owner identity (`issue:<uuid>` or `run:<uuid>`). Kept as text so the
    // lease still identifies its owner after the FK columns are nulled out.
    ownerKey: text("owner_key").notNull(),
    ownerIssueId: uuid("owner_issue_id").references(() => issues.id, { onDelete: "set null" }),
    ownerRunId: uuid("owner_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    lastAction: text("last_action").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkspaceIdx: index("execution_workspace_runtime_leases_company_workspace_idx").on(
      table.companyId,
      table.executionWorkspaceId,
    ),
    companyOwnerIdx: index("execution_workspace_runtime_leases_company_owner_idx").on(
      table.companyId,
      table.ownerKey,
    ),
    expiresAtIdx: index("execution_workspace_runtime_leases_expires_at_idx").on(table.expiresAt),
  }),
);
