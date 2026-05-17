import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const environmentLeases = pgTable(
  "environment_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    leasePolicy: text("lease_policy").notNull().default("ephemeral"),
    provider: text("provider"),
    providerLeaseId: text("provider_lease_id"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    cleanupStatus: text("cleanup_status"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEnvironmentStatusIdx: index("environment_leases_company_environment_status_idx").on(
      table.companyId,
      table.environmentId,
      table.status,
    ),
    companyExecutionWorkspaceIdx: index("environment_leases_company_execution_workspace_idx").on(
      table.companyId,
      table.executionWorkspaceId,
    ),
    companyIssueIdx: index("environment_leases_company_issue_idx").on(table.companyId, table.issueId),
    heartbeatRunIdx: index("environment_leases_heartbeat_run_idx").on(table.heartbeatRunId),
    companyLastUsedIdx: index("environment_leases_company_last_used_idx").on(table.companyId, table.lastUsedAt),
    providerLeaseIdx: index("environment_leases_provider_lease_idx").on(table.providerLeaseId),
  }),
);
