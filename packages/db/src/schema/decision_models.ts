import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { costEvents } from "./cost_events.js";

export const companyDecisionModels = pgTable("company_decision_models", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  // Retain company preferences when a connection/grant is deleted. Resolution
  // fails closed for stale IDs; choosing a replacement preserves sponsorship.
  connectionId: uuid("connection_id"),
  grantId: uuid("grant_id"),
  enabled: boolean("enabled").notNull().default(false),
  allowBackground: boolean("allow_background").notNull().default(true),
  provider: text("provider"),
  model: text("model"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ configured: check("company_decisions_configured", sql`(${t.connectionId} is null) = (${t.grantId} is null) and (not ${t.enabled} or (${t.connectionId} is not null and ${t.provider} is not null and ${t.model} is not null))`) }));

/** Attribution references are archival: history survives deleted runs and connections. No input or answer content. */
export const decisionInvocations = pgTable("decision_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  feature: text("feature").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  responsibleUserId: text("responsible_user_id"),
  agentId: uuid("agent_id"),
  issueId: uuid("issue_id"),
  projectId: uuid("project_id"),
  runId: uuid("run_id"),
  identityContextId: uuid("identity_context_id"),
  connectionId: uuid("connection_id").notNull(),
  grantId: uuid("grant_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  questionTypes: jsonb("question_types").$type<string[]>().notNull(),
  status: text("status").notNull().default("running"),
  errorCode: text("error_code"),
  providerRequestId: text("provider_request_id"),
  costEventId: uuid("cost_event_id").references(() => costEvents.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
}, t => ({
  history: index("decision_invocations_company_started_idx").on(t.companyId, t.startedAt, t.id),
  pending: index("decision_invocations_pending_idx").on(t.startedAt).where(sql`${t.status} = 'running'`),
  cost: index("decision_invocations_cost_idx").on(t.costEventId),
  statusCheck: check("decision_invocations_status_check", sql`${t.status} in ('running', 'succeeded', 'failed', 'unknown')`),
}));
