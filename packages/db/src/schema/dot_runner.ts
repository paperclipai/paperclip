import { sql } from "drizzle-orm";
import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { mcpOauthGrants } from "./public_mcp.js";

export const dotAgentBindings = pgTable("dot_agent_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  operatorId: text("operator_id").notNull(),
  grantId: uuid("grant_id").references(() => mcpOauthGrants.id, { onDelete: "set null" }),
  generation: integer("generation").notNull().default(1),
  status: text("status").$type<"pairing" | "connected" | "ready" | "revoked">().notNull().default("pairing"),
  pairingCodeHash: text("pairing_code_hash"),
  pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }),
  dotUrl: text("dot_url"),
  challengeHash: text("challenge_hash"),
  challengeExpiresAt: timestamp("challenge_expires_at", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("dot_bindings_active_agent_uq").on(t.companyId, t.agentId).where(sql`${t.revokedAt} IS NULL`),
  uniqueIndex("dot_bindings_active_grant_uq").on(t.grantId).where(sql`${t.revokedAt} IS NULL AND ${t.grantId} IS NOT NULL`),
  uniqueIndex("dot_bindings_pairing_code_uq").on(t.pairingCodeHash),
]);

export const dotRunnerAssignments = pgTable("dot_runner_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => dotAgentBindings.id, { onDelete: "cascade" }),
  bindingGeneration: integer("binding_generation").notNull(),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  normalizedSessionId: text("normalized_session_id").notNull(),
  turnId: text("turn_id").notNull(),
  revision: integer("revision").notNull().default(1),
  controllerGeneration: integer("controller_generation").notNull(),
  catalogDigest: text("catalog_digest").notNull(),
  status: text("status").$type<"offered" | "accepted" | "settled" | "fenced">().notNull(),
  projection: jsonb("projection").$type<Record<string, unknown>>().notNull(),
  acceptBy: timestamp("accept_by", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("dot_assignments_turn_uq").on(t.runId, t.turnId),
  uniqueIndex("dot_assignments_active_binding_uq").on(t.bindingId).where(sql`${t.status} IN ('offered', 'accepted')`),
  index("dot_assignments_company_idx").on(t.companyId),
]);

export const dotRunnerOperations = pgTable("dot_runner_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  assignmentId: uuid("assignment_id").notNull().references(() => dotRunnerAssignments.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  digest: text("digest").notNull(),
  command: jsonb("command").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<"reserved" | "admitted" | "completed" | "rejected" | "unknown">().notNull().default("reserved"),
  outcome: jsonb("outcome").$type<Record<string, unknown>>(),
  sourceEventId: text("source_event_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("dot_operations_request_uq").on(t.assignmentId, t.requestId)]);

export const dotMailboxItems = pgTable("dot_mailbox_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => dotAgentBindings.id, { onDelete: "cascade" }),
  bindingGeneration: integer("binding_generation").notNull(),
  assignmentId: uuid("assignment_id").references(() => dotRunnerAssignments.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"assignment" | "operation_result" | "authority_revoked" | "readiness_challenge" | "follow_up">().notNull(),
  sourceEventId: text("source_event_id").notNull(),
  // References only. Task content and tool results stay in authorized projections.
  references: jsonb("references").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("dot_mailbox_event_uq").on(t.bindingId, t.bindingGeneration, t.sourceEventId),
  index("dot_mailbox_binding_cursor_idx").on(t.bindingId, t.bindingGeneration, t.id),
]);
