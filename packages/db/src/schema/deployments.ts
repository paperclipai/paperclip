import { pgTable, uuid, text, timestamp, index, jsonb, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    environment: text("environment").notNull().default("staging"),
    status: text("status").notNull().default("pending"),
    url: text("url"),
    provider: text("provider"),
    deployLog: text("deploy_log"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    // Cloud deployment columns
    cloudProvider: text("cloud_provider"),
    cloudRegion: text("cloud_region"),
    cloudResourceId: text("cloud_resource_id"),
    cloudResourceType: text("cloud_resource_type"),
    cloudConfig: jsonb("cloud_config").$type<Record<string, unknown>>().default({}),
    healthStatus: text("health_status").default("unknown"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    healthMessage: text("health_message"),
    rollbackDeploymentId: uuid("rollback_deployment_id"),
    version: text("version"),
    commitSha: text("commit_sha"),
    dockerImage: text("docker_image"),
    domain: text("domain"),
    sslEnabled: boolean("ssl_enabled").notNull().default(false),
  },
  (table) => ({
    companyIdx: index("idx_deployments_company").on(table.companyId),
    projectIdx: index("idx_deployments_project").on(table.projectId),
    companyStatusIdx: index("idx_deployments_status").on(table.companyId, table.status),
    agentIdx: index("idx_deployments_agent").on(table.agentId),
  }),
);
