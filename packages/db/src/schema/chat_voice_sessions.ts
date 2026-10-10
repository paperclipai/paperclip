import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, index, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import type { VoiceSessionState, VoiceSessionMode, VoiceCallerAuthority } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { chatEndpoints, chatConversations, chatDeliveries, chatPublications } from "./chat_channels.js";

export const chatVoiceSessions = pgTable("chat_voice_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  assignedAgentId: uuid("assigned_agent_id").notNull(),
  callerId: text("caller_id").notNull(),
  callerAuthority: text("caller_authority").$type<VoiceCallerAuthority>().notNull(),
  approvedByUserId: text("approved_by_user_id"),
  mode: text("mode").$type<VoiceSessionMode>().notNull(),
  state: text("state").$type<VoiceSessionState>().notNull().default("reserved"),
  generation: integer("generation").notNull(),
  credentialFingerprint: text("credential_fingerprint").notNull(),
  providerSessionId: text("provider_session_id"),
  toolTokenHash: text("tool_token_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  replyCursor: integer("reply_cursor").notNull().default(0),
  errorCode: text("error_code"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("chat_voice_sessions_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("chat_voice_sessions_provider_uq").on(t.providerSessionId),
  uniqueIndex("chat_voice_sessions_request_uq").on(t.companyId, t.callerId, t.idempotencyKey),
  uniqueIndex("chat_voice_sessions_live_caller_task_uq").on(t.companyId, t.callerId, t.issueId).where(sql`${t.state} not in ('ended', 'failed', 'expired')`),
  index("chat_voice_sessions_expiry_idx").on(t.state, t.expiresAt),
  foreignKey({ columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_voice_sessions_endpoint_fk" }),
  foreignKey({ columns: [t.companyId, t.conversationId], foreignColumns: [chatConversations.companyId, chatConversations.id], name: "chat_voice_sessions_conversation_fk" }),
  foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id], name: "chat_voice_sessions_issue_fk" }),
  foreignKey({ columns: [t.companyId, t.assignedAgentId], foreignColumns: [agents.companyId, agents.id], name: "chat_voice_sessions_agent_fk" }),
  check("chat_voice_sessions_state_check", sql`${t.state} in ('reserved', 'creating', 'creation_unknown', 'connecting', 'active', 'awaiting_approval', 'ending', 'ended', 'failed', 'expired')`),
  check("chat_voice_sessions_mode_check", sql`${t.mode} in ('browser', 'inbound_phone', 'outbound_phone')`),
  check("chat_voice_sessions_authority_check", sql`${t.callerAuthority} in ('member', 'instance_admin', 'local_board', 'guest_intake', 'pending_approval')`),
  check("chat_voice_sessions_counters_check", sql`${t.generation} >= 1 and ${t.replyCursor} >= 0`),
  check("chat_voice_sessions_token_check", sql`${t.toolTokenHash} ~ '^[a-f0-9]{64}$'`),
  check("chat_voice_sessions_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
]);

/** Each tool call has one durable result; inbound work points at the chat ledger. */
export const chatVoiceToolCalls = pgTable("chat_voice_tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  providerToolCallId: text("provider_tool_call_id").notNull(),
  webhookId: text("webhook_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  tool: text("tool").notNull(),
  deliveryId: uuid("delivery_id"),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chat_voice_tool_calls_tool_uq").on(t.sessionId, t.providerToolCallId),
  uniqueIndex("chat_voice_tool_calls_webhook_uq").on(t.companyId, t.webhookId),
  foreignKey({ columns: [t.companyId, t.sessionId], foreignColumns: [chatVoiceSessions.companyId, chatVoiceSessions.id], name: "chat_voice_tool_calls_session_fk" }),
  foreignKey({ columns: [t.companyId, t.deliveryId], foreignColumns: [chatDeliveries.companyId, chatDeliveries.id], name: "chat_voice_tool_calls_delivery_fk" }),
  check("chat_voice_tool_calls_tool_check", sql`${t.tool} in ('submit_request', 'get_updates', 'answer_question')`),
]);

/** Returning a publication to Speko is distinct from confirmed spoken playback. */
export const chatVoiceReplies = pgTable("chat_voice_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  publicationId: uuid("publication_id").notNull(),
  cursor: integer("cursor").notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  spokenAt: timestamp("spoken_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chat_voice_replies_publication_uq").on(t.sessionId, t.publicationId),
  uniqueIndex("chat_voice_replies_cursor_uq").on(t.sessionId, t.cursor),
  foreignKey({ columns: [t.companyId, t.sessionId], foreignColumns: [chatVoiceSessions.companyId, chatVoiceSessions.id], name: "chat_voice_replies_session_fk" }),
  foreignKey({ columns: [t.companyId, t.publicationId], foreignColumns: [chatPublications.companyId, chatPublications.id], name: "chat_voice_replies_publication_fk" }),
  check("chat_voice_replies_cursor_check", sql`${t.cursor} > 0`),
  check("chat_voice_replies_spoken_check", sql`${t.spokenAt} is null or ${t.deliveredAt} is not null`),
]);
