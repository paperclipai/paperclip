import { sql } from "drizzle-orm";
import { bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { MuseStopBoundary } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
const time = (name: string) => timestamp(name, { withTimezone: true });

export const museAgentBindings = pgTable("muse_agent_bindings", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }), operatorId: text("operator_id").notNull(),
  generation: integer("generation").notNull().default(1), revision: integer("revision").notNull().default(1),
  status: text("status").$type<"pairing" | "connected" | "ready" | "revoked">().notNull().default("pairing"),
  ticketHash: text("ticket_hash"), ticketExpiresAt: time("ticket_expires_at"), pairedAt: time("paired_at"),
  challengeHash: text("challenge_hash"), challengeExpiresAt: time("challenge_expires_at"), verifiedReplyAt: time("verified_reply_at"),
  receiverContactAt: time("receiver_contact_at"), workerActivityAt: time("worker_activity_at"), clientVersion: text("client_version"),
  workerCursor: integer("worker_cursor").notNull().default(0),
  qualificationId: uuid("qualification_id"), qualificationStartedAt: time("qualification_started_at"), qualificationExpiresAt: time("qualification_expires_at"), deadlineEnforcedAt: time("deadline_enforced_at"), cadenceEvidenceIncompleteAt: time("cadence_evidence_incomplete_at"),
  cleanupExpiresAt: time("cleanup_expires_at"), detectorRemovalRequestedAt: time("detector_removal_requested_at"), detectorRemovedAt: time("detector_removed_at"), revokedAt: time("revoked_at"),
  createdAt: time("created_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_bindings_active_agent_uq").on(t.companyId, t.agentId).where(sql`${t.revokedAt} IS NULL`), uniqueIndex("muse_bindings_ticket_uq").on(t.ticketHash)]);

export const museCredentials = pgTable("muse_credentials", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => museAgentBindings.id, { onDelete: "cascade" }), bindingGeneration: integer("binding_generation").notNull(),
  kind: text("kind").$type<"access" | "refresh" | "signal" | "cleanup" | "detector_cleanup">().notNull(), familyId: uuid("family_id").notNull(),
  tokenHash: text("token_hash").notNull(), expiresAt: time("expires_at").notNull(), consumedAt: time("consumed_at"), revokedAt: time("revoked_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_credentials_hash_uq").on(t.tokenHash), index("muse_credentials_binding_idx").on(t.bindingId, t.bindingGeneration)]);

export const museRunnerAssignments = pgTable("muse_runner_assignments", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => museAgentBindings.id, { onDelete: "cascade" }), bindingGeneration: integer("binding_generation").notNull(),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }), agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  normalizedSessionId: text("normalized_session_id").notNull(), turnId: text("turn_id").notNull(), revision: integer("revision").notNull().default(1),
  controllerGeneration: integer("controller_generation").notNull(), catalogDigest: text("catalog_digest").notNull(),
  status: text("status").$type<"offered" | "claimed" | "accepted" | "settled" | "fenced">().notNull(),
  projection: jsonb("projection").$type<Record<string, unknown>>().notNull(),
  acceptBy: time("accept_by").notNull(), expiresAt: time("expires_at").notNull(), offeredAt: time("offered_at").notNull().defaultNow(),
  claimedAt: time("claimed_at"), nativeAcceptedAt: time("native_accepted_at"), acceptedResultAt: time("accepted_result_at"), finalizedAt: time("finalized_at"),
  lastActivityAt: time("last_activity_at").notNull().defaultNow(), createdAt: time("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_assignments_turn_uq").on(t.runId, t.turnId), uniqueIndex("muse_assignments_live_binding_uq").on(t.bindingId).where(sql`${t.status} IN ('offered','claimed','accepted')`), index("muse_assignments_company_idx").on(t.companyId)]);

export const museRunnerOperations = pgTable("muse_runner_operations", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  assignmentId: uuid("assignment_id").notNull().references(() => museRunnerAssignments.id, { onDelete: "cascade" }), requestId: uuid("request_id").notNull(),
  continuationReceiptId: uuid("continuation_receipt_id"), digest: text("digest").notNull(), command: jsonb("command").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<"reserved" | "dispatched" | "pending" | "settled" | "rejected" | "unknown">().notNull().default("reserved"),
  outcome: jsonb("outcome").$type<Record<string, unknown>>(), sourceEventId: text("source_event_id"),
  createdAt: time("created_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_operations_request_uq").on(t.assignmentId, t.requestId)]);

export const museMailboxItems = pgTable("muse_mailbox_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => museAgentBindings.id, { onDelete: "cascade" }), bindingGeneration: integer("binding_generation").notNull(),
  assignmentId: uuid("assignment_id").references(() => museRunnerAssignments.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"assignment" | "operation_result" | "authority_revoked" | "readiness_challenge" | "follow_up" | "input_available">().notNull(),
  signalAttempt: integer("signal_attempt").notNull().default(0), signalNotifiedAt: time("signal_notified_at"),
  sourceEventId: text("source_event_id").notNull(), references: jsonb("references").$type<Record<string, unknown>>().notNull(), createdAt: time("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_mailbox_event_uq").on(t.bindingId, t.bindingGeneration, t.sourceEventId), index("muse_mailbox_cursor_idx").on(t.bindingId, t.bindingGeneration, t.id)]);

/** Native input is not consumed by transport delivery; only an exact same-turn consume receipt can do that. */
export const museInputDeliveries = pgTable("muse_input_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  assignmentId: uuid("assignment_id").notNull().references(() => museRunnerAssignments.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(), turnId: text("turn_id").notNull(), inputDigest: text("input_digest").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(), sourceEventId: text("source_event_id").notNull(),
  consumedAt: time("consumed_at"), continuationReceiptId: uuid("continuation_receipt_id"), createdAt: time("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_input_request_uq").on(t.assignmentId, t.requestId), uniqueIndex("muse_input_source_uq").on(t.assignmentId, t.sourceEventId)]);

/** Retained independently of run/assignment deletion. Worker and native-effect uncertainty are separate barriers. */
export const externalAgentHolds = pgTable("external_agent_holds", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }), provider: text("provider").$type<"muse" | "openai_dot">().notNull(),
  assignmentId: uuid("assignment_id").notNull(), bindingId: uuid("binding_id").notNull(), bindingGeneration: integer("binding_generation").notNull(),
  runId: uuid("run_id").notNull(), workerUnknown: boolean("worker_unknown").notNull().default(true), nativeEffectsUnknown: boolean("native_effects_unknown").notNull().default(false),
  stopBoundary: jsonb("stop_boundary").$type<MuseStopBoundary>(), workerReportedAt: time("worker_reported_at"), operatorAttestedAt: time("operator_attested_at"),
  releasedAt: time("released_at"), createdAt: time("created_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("external_holds_assignment_uq").on(t.provider, t.assignmentId), index("external_holds_agent_idx").on(t.companyId, t.agentId)]);

export const museIdleReceipts = pgTable("muse_idle_receipts", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => museAgentBindings.id, { onDelete: "cascade" }), bindingGeneration: integer("binding_generation").notNull(),
  requestId: uuid("request_id").notNull(), digest: text("digest").notNull(), outcome: jsonb("outcome").$type<Record<string, unknown>>().notNull(), createdAt: time("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_idle_receipts_request_uq").on(t.bindingId,t.bindingGeneration,t.requestId)]);

export const museReceiverContactBuckets = pgTable("muse_receiver_contact_buckets", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").notNull().references(() => museAgentBindings.id, { onDelete: "cascade" }), bindingGeneration: integer("binding_generation").notNull(),
  replicaId: uuid("replica_id").notNull(), bucketAt: time("bucket_at").notNull(), firstAt: time("first_at").notNull(), lastAt: time("last_at").notNull(),
  timestamps: jsonb("timestamps").$type<string[]>().notNull().default([]), incomplete: boolean("incomplete").notNull().default(false),
  contacts: integer("contacts").notNull(), gapsAtMostSevenSeconds: integer("gaps_at_most_seven_seconds").notNull(), maxGapMs: integer("max_gap_ms").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("muse_contact_bucket_uq").on(t.bindingId,t.bindingGeneration,t.replicaId,t.bucketAt)]);
