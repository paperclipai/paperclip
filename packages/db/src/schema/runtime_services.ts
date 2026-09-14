import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { RuntimeServiceCompanyPolicyConfig, RuntimeServiceEndpoint, RuntimeServiceLaunchSpec, RuntimeServiceProcessHandoff, RuntimeServicePolicy, RuntimeServiceStorageUsage } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { environmentLeases } from "./environment_leases.js";

/** Allocation identity and durable retention are independent of run ownership. */
export const runtimeServiceAllocations = pgTable("runtime_service_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  provider: text("provider").notNull(),
  reuseKey: text("reuse_key").notNull(),
  environmentLeaseId: uuid("environment_lease_id").references(() => environmentLeases.id, { onDelete: "restrict" }),
  executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id, { onDelete: "restrict" }),
  cwd: text("cwd").notNull(),
  storageUsage: jsonb("storage_usage").$type<RuntimeServiceStorageUsage>(),
  // A permanent admission fence; all allocations sharing deleted physical data
  // point at the same company-owned deletion job. Never clear it on failure.
  dataDeletionId: uuid("data_deletion_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  reuseIdx: uniqueIndex("runtime_service_allocations_company_reuse_idx").on(table.companyId, table.reuseKey),
  environmentIdx: index("runtime_service_allocations_environment_idx").on(table.environmentLeaseId),
  workspaceIdx: index("runtime_service_allocations_workspace_idx").on(table.executionWorkspaceId),
}));

export const runtimeServices = pgTable("runtime_services", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  allocationId: uuid("allocation_id").notNull().references(() => runtimeServiceAllocations.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  purpose: text("purpose").notNull(),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
  startedByRunId: uuid("started_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdByUserId: text("created_by_user_id"),
  creationKey: text("creation_key").notNull(),
  processHandoffKey: text("process_handoff_key"),
  processHandoff: jsonb("process_handoff").$type<RuntimeServiceProcessHandoff>(),
  spec: jsonb("spec").$type<RuntimeServiceLaunchSpec>().notNull(),
  policy: jsonb("policy").$type<RuntimeServicePolicy>().notNull(),
  state: text("state").notNull().default("pending"),
  desiredState: text("desired_state").notNull().default("running"),
  revision: integer("revision").notNull().default(0),
  // Server-private identity receipt; never serialized into service responses.
  processRef: jsonb("process_ref").$type<Record<string, unknown>>(),
  endpoints: jsonb("endpoints").$type<RuntimeServiceEndpoint[]>().notNull().default([]),
  restartCount: integer("restart_count").notNull().default(0),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  previewLastSignalAt: timestamp("preview_last_signal_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  error: text("error"),
  stopReason: text("stop_reason"),
  controllerId: text("controller_id"),
  controllerExpiresAt: timestamp("controller_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  creationIdx: uniqueIndex("runtime_services_company_creation_idx").on(table.companyId, table.creationKey),
  handoffIdx: uniqueIndex("runtime_services_company_handoff_idx").on(table.companyId, table.processHandoffKey),
  issueIdx: index("runtime_services_company_issue_idx").on(table.companyId, table.issueId),
  allocationIdx: index("runtime_services_allocation_idx").on(table.allocationId),
  reconcileIdx: index("runtime_services_reconcile_idx").on(table.desiredState, table.controllerExpiresAt),
}));

/** Stable workspace identity; an explicit task binding can be removed/replaced. */
export const runtimeServiceTaskWorkspaces = pgTable("runtime_service_task_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  allocationId: uuid("allocation_id").notNull().references(() => runtimeServiceAllocations.id, { onDelete: "restrict" }),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
  hostCwd: text("host_cwd").notNull(),
  previousTaskWorkspace: jsonb("previous_task_workspace").$type<Record<string, unknown>>(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  taskIdx: uniqueIndex("runtime_service_task_workspaces_task_idx").on(table.companyId, table.issueId),
  allocationIdx: uniqueIndex("runtime_service_task_workspaces_allocation_idx").on(table.allocationId),
}));

/** Intent is committed before any irreversible provider or filesystem action. */
export const runtimeServiceDataDeletions = pgTable("runtime_service_data_deletions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  allocationId: uuid("allocation_id").notNull().references(() => runtimeServiceAllocations.id, { onDelete: "restrict" }),
  serviceId: uuid("service_id").notNull().references(() => runtimeServices.id, { onDelete: "restrict" }),
  requestedByUserId: text("requested_by_user_id"),
  authorization: jsonb("authorization").$type<{ kind: "operator" } | { kind: "retention"; policyRevision: number; retainedDataSeconds: number; expiresAt: string }>().notNull().default({ kind: "operator" }),
  state: text("state").notNull().default("pending"),
  // Private immutable resource/mirror identities. Never serialize this receipt.
  target: jsonb("target").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  providerDeletedAt: timestamp("provider_deleted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  allocationIdx: uniqueIndex("runtime_service_data_deletions_allocation_idx").on(table.allocationId),
  pendingIdx: index("runtime_service_data_deletions_pending_idx").on(table.state, table.retryAt),
}));

export const runtimeServiceEvents = pgTable("runtime_service_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  serviceId: uuid("service_id").notNull().references(() => runtimeServices.id),
  requestKey: text("request_key"),
  kind: text("kind").notNull(),
  actor: jsonb("actor").$type<{ type: "board" | "agent" | "system"; id: string; runId?: string | null }>().notNull(),
  revision: integer("revision").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestIdx: uniqueIndex("runtime_service_events_request_idx").on(table.serviceId, table.requestKey),
  serviceIdx: index("runtime_service_events_service_time_idx").on(table.companyId, table.serviceId, table.createdAt),
}));

export const runtimeServiceShares = pgTable("runtime_service_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  serviceId: uuid("service_id").notNull().references(() => runtimeServices.id),
  endpointName: text("endpoint_name").notNull(),
  tokenHash: text("token_hash").notNull(),
  creationKey: text("creation_key"),
  createdByUserId: text("created_by_user_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenIdx: uniqueIndex("runtime_service_shares_token_idx").on(table.tokenHash),
  creationIdx: uniqueIndex("runtime_service_shares_creation_idx").on(table.serviceId, table.creationKey),
  serviceIdx: index("runtime_service_shares_service_idx").on(table.companyId, table.serviceId),
}));

export const runtimeServicePreviewSessions = pgTable("runtime_service_preview_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  serviceId: uuid("service_id").notNull().references(() => runtimeServices.id),
  endpointName: text("endpoint_name").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  runId: uuid("run_id").references(() => heartbeatRuns.id),
  shareId: uuid("share_id").references(() => runtimeServiceShares.id),
  ticketHash: text("ticket_hash").notNull(),
  ticketExpiresAt: timestamp("ticket_expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  sessionHash: text("session_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ticketIdx: uniqueIndex("runtime_service_preview_sessions_ticket_idx").on(table.ticketHash),
  sessionIdx: uniqueIndex("runtime_service_preview_sessions_session_idx").on(table.sessionHash),
  expiryIdx: index("runtime_service_preview_sessions_expiry_idx").on(table.expiresAt),
}));

/** Operator policy and an immutable ledger make lost-response retries safe. */
export const runtimeServiceCompanyPolicies = pgTable("runtime_service_company_policies", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id),
  revision: integer("revision").notNull().default(0),
  config: jsonb("config").$type<RuntimeServiceCompanyPolicyConfig>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runtimeServiceCompanyPolicyEvents = pgTable("runtime_service_company_policy_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  requestKey: text("request_key").notNull(),
  inputHash: text("input_hash").notNull(),
  revision: integer("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestIdx: uniqueIndex("runtime_service_company_policy_events_request_idx").on(table.companyId, table.requestKey),
}));
