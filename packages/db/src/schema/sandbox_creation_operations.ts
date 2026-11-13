import { index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { environments } from "./environments.js";

export const sandboxCreationOperations = pgTable("sandbox_creation_operations", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
  originalEnvironmentId: uuid("original_environment_id").notNull(),
  runId: uuid("run_id").notNull(),
  requestKey: text("request_key").notNull().default("run"),
  issueId: uuid("issue_id"),
  executionWorkspaceId: uuid("execution_workspace_id"),
  provider: text("provider").notNull(),
  pluginId: uuid("plugin_id"),
  driverKey: text("driver_key").notNull(),
  state: text("state").notNull().default("pending"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  leaseId: uuid("lease_id"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pendingDeadline: index("sandbox_creation_operations_pending_deadline_idx").on(table.nextAttemptAt).where(sql`${table.state} = 'pending'`),
  owner: uniqueIndex("sandbox_creation_operations_owner_idx").on(table.companyId, table.originalEnvironmentId, table.runId, table.requestKey),
}));
