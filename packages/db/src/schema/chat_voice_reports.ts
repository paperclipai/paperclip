import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, jsonb, foreignKey, check, index } from "drizzle-orm/pg-core";
import type { VoiceTranscriptEntry } from "@paperclipai/shared";
import { chatVoiceSessions } from "./chat_voice_sessions.js";
/** One report per bound call. Provider metadata and recording URLs are never stored. */
export const chatVoiceReports = pgTable("chat_voice_reports", {
  sessionId: uuid("session_id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  status: text("status").$type<"pending" | "available" | "unavailable">().notNull().default("pending"),
  transcript: jsonb("transcript").$type<VoiceTranscriptEntry[]>().notNull().default([]),
  costMicroUsd: text("cost_micro_usd"),
  durationSeconds: integer("duration_seconds"),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.companyId, t.sessionId], foreignColumns: [chatVoiceSessions.companyId, chatVoiceSessions.id], name: "chat_voice_reports_session_fk" }).onDelete("cascade"),
  index("chat_voice_reports_pending_idx").on(t.status, t.nextCheckAt),
  check("chat_voice_reports_status_check", sql`${t.status} in ('pending', 'available', 'unavailable')`),
  check("chat_voice_reports_cost_check", sql`${t.costMicroUsd} is null or ${t.costMicroUsd} ~ '^[0-9]{1,30}$'`),
  check("chat_voice_reports_duration_check", sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`),
  check("chat_voice_reports_attempts_check", sql`${t.attempts} >= 0`),
]);
