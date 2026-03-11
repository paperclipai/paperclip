import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const workspaceRuntimeServices = pgTable(
  "workspace_runtime_services",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    serviceName: text("service_name").notNull(),
    status: text("status").notNull(),
    lifecycle: text("lifecycle").notNull(),
    reuseKey: text("reuse_key"),
    command: text("command"),
    cwd: text("cwd"),
    port: integer("port"),
    url: text("url"),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    startedByRunId: uuid("started_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stopPolicy: jsonb("stop_policy").$type<Record<string, unknown>>(),
    healthStatus: text("health_status").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkspaceStatusIdx: index("workspace_runtime_services_company_workspace_status_idx").on(
      table.companyId,
      table.projectWorkspaceId,
      table.status,
    ),
    companyProjectStatusIdx: index("workspace_runtime_services_company_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    runIdx: index("workspace_runtime_services_run_idx").on(table.startedByRunId),
    companyUpdatedIdx: index("workspace_runtime_services_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
  }),
);
