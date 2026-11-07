import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { costEvents } from "./cost_events.js";

export const companyPromptInjectionPrevention = pgTable("company_prompt_injection_prevention", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  // Archival selection: deletion must leave an explainable, replaceable preference.
  connectionId: uuid("connection_id"),
  grantId: uuid("grant_id"),
  enabled: boolean("enabled").notNull().default(false),
  model: text("model").notNull().default("openai/gpt-oss-safeguard-20b"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ configured: check("company_prompt_injection_configured", sql`(${t.connectionId} is null) = (${t.grantId} is null) and (not ${t.enabled} or ${t.connectionId} is not null)`) }));

/** Attribution references are archival: history survives deleted runs and connections. No input or answer content. */
export const promptInjectionInvocations = pgTable("prompt_injection_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  toolInvocationId: uuid("tool_invocation_id"),
  toolName: text("tool_name"),
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
  policyVersion: text("policy_version").notNull(),
  model: text("model").notNull(),
  violation: boolean("violation"),
  findings: jsonb("findings").$type<string[]>(),
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
  history: index("prompt_injection_invocations_company_started_idx").on(t.companyId, t.startedAt, t.id),
  pending: index("prompt_injection_invocations_pending_idx").on(t.startedAt).where(sql`${t.status} = 'running'`),
  cost: index("prompt_injection_invocations_cost_idx").on(t.costEventId),
  sourceCheck: check("prompt_injection_invocations_source_check", sql`${t.source} in ('gateway', 'settings_test')`),
  statusCheck: check("prompt_injection_invocations_status_check", sql`${t.status} in ('running', 'succeeded', 'failed', 'unknown')`),
}));
