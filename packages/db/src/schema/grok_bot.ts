import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";
import { dotAgentBindings, dotRunnerAssignments } from "./dot_runner.js";
import { mcpOauthGrants } from "./public_mcp.js";

// Keep the shared binding/assignment tables and their unique ownership constraints.
// Routine material is one encrypted secret version, never an agent config field.
export const grokBotRoutines = pgTable("grok_bot_routines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => dotAgentBindings.id, { onDelete: "cascade" }),
  bindingGeneration: integer("binding_generation").notNull(),
  botName: text("bot_name").notNull(),
  secretId: uuid("secret_id").notNull().references(() => companySecrets.id),
  secretVersion: integer("secret_version").notNull(),
  revision: integer("revision").notNull().default(1),
  verifiedGrantId: uuid("verified_grant_id").references(() => mcpOauthGrants.id, { onDelete: "set null" }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  recoveryRequiredAt: timestamp("recovery_required_at", { withTimezone: true }),
  recoveryReason: text("recovery_reason").$type<"dispatch" | "work_session">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("grok_routines_binding_uq").on(t.bindingId), index("grok_routines_company_agent_idx").on(t.companyId, t.agentId)]);

export const grokBotDispatches = pgTable("grok_bot_dispatches", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  routineId: uuid("routine_id").notNull().references(() => grokBotRoutines.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => dotAgentBindings.id, { onDelete: "cascade" }),
  bindingGeneration: integer("binding_generation").notNull(),
  grantId: uuid("grant_id").notNull().references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
  routineRevision: integer("routine_revision").notNull(),
  assignmentId: uuid("assignment_id").references(() => dotRunnerAssignments.id, { onDelete: "cascade" }),
  sourceEventId: text("source_event_id").notNull(),
  kind: text("kind").$type<"verify" | "mailbox_updated" | "authority_revoked">().notNull(),
  // Closed references only. Challenge possession alone carries no authority.
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  challengeHash: text("challenge_hash"),
  status: text("status").$type<"prepared" | "sending" | "accepted" | "rejected" | "unknown" | "acknowledged" | "cancelled">().notNull().default("prepared"),
  httpStatus: integer("http_status"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("grok_dispatch_event_uq").on(t.bindingId, t.bindingGeneration, t.routineRevision, t.sourceEventId),
  index("grok_dispatch_company_status_idx").on(t.companyId, t.status),
  index("grok_dispatch_assignment_kind_idx").on(t.assignmentId, t.kind),
]);
