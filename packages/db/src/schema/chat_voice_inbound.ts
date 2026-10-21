import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, boolean, unique, foreignKey, check, index } from "drizzle-orm/pg-core";
import { environments } from "./environments.js";
import { issues } from "./issues.js";
import { chatEndpoints } from "./chat_channels.js";
import { chatVoiceSessions } from "./chat_voice_sessions.js";
/** Only existing provider numbers selected by a connection manager may admit calls. */
export const chatVoicePhoneLines = pgTable("chat_voice_phone_lines", {
  endpointId: uuid("endpoint_id").primaryKey(), companyId: uuid("company_id").notNull(),
  providerNumberId: text("provider_number_id").notNull(), phoneNumber: text("phone_number").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  guestIntake: boolean("guest_intake").notNull().default(false),
  lowTrustEnvironmentId: uuid("low_trust_environment_id").references(() => environments.id),
  updatedAt: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
}, t => [
  unique("chat_voice_phone_lines_number_uq").on(t.providerNumberId),
  foreignKey({columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_voice_phone_lines_endpoint_fk"}).onDelete("cascade"),
  check("chat_voice_phone_lines_number_check", sql`${t.phoneNumber} ~ '^\\+[1-9][0-9]{6,14}$'`),
]);
/** Pending calls have NO private task binding. Caller ID never establishes authority. */
export const chatVoiceInboundCalls = pgTable("chat_voice_inbound_calls", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull(), endpointId: uuid("endpoint_id").notNull(),
  providerSessionId: text("provider_session_id").notNull(),
  state: text("state").$type<"guest_intake" | "awaiting_approval" | "approving" | "approved" | "denied" | "expired" | "ended">().notNull().default("awaiting_approval"),
  approvalCode: text("approval_code").notNull(), generation: integer("generation").notNull(), credentialFingerprint: text("credential_fingerprint").notNull(),
  toolTokenHash: text("tool_token_hash").notNull(), requestFingerprint: text("request_fingerprint").notNull(),
  approvedByUserId: text("approved_by_user_id"), callerAuthority: text("caller_authority"),
  intakeIssueId: uuid("intake_issue_id"),
  requestedIssueId: uuid("requested_issue_id"), sessionId: uuid("session_id"),
  expiresAt: timestamp("expires_at", {withTimezone: true}).notNull(),
  createdAt: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
}, t => [
  unique("chat_voice_inbound_provider_uq").on(t.providerSessionId),
  foreignKey({columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_voice_inbound_endpoint_fk"}).onDelete("cascade"),
  foreignKey({columns: [t.companyId, t.sessionId], foreignColumns: [chatVoiceSessions.companyId, chatVoiceSessions.id], name: "chat_voice_inbound_session_fk"}),
  foreignKey({columns: [t.companyId, t.intakeIssueId], foreignColumns: [issues.companyId, issues.id], name: "chat_voice_inbound_intake_fk"}),
  foreignKey({columns: [t.companyId, t.requestedIssueId], foreignColumns: [issues.companyId, issues.id], name: "chat_voice_inbound_requested_issue_fk"}),
  index("chat_voice_inbound_expiry_idx").on(t.state, t.expiresAt),
  check("chat_voice_inbound_state_check", sql`${t.state} in ('guest_intake', 'awaiting_approval', 'approving', 'approved', 'denied', 'expired', 'ended')`),
  check("chat_voice_inbound_token_check", sql`${t.toolTokenHash} ~ '^[a-f0-9]{64}$'`),
  check("chat_voice_inbound_code_check", sql`${t.approvalCode} ~ '^[0-9]{6}$'`),
  check("chat_voice_inbound_generation_check", sql`${t.generation} > 0`),
]);
