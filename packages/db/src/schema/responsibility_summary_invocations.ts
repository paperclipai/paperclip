import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { costEvents } from "./cost_events.js";

/**
 * One model call that wrote a responsibility summary paragraph (experimental,
 * `enableResponsibilities`): content-free accounting like
 * `prompt_injection_invocations`. No facts, prompt or text are stored.
 * Attribution references are archival: history survives deleted
 * responsibilities, users and connections.
 */
export const responsibilitySummaryInvocations = pgTable("responsibility_summary_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  /** `where_things_stand` (an owner's dashboard) or `what_is_affecting_the_number` (one responsibility). */
  feature: text("feature").notNull(),
  /** The responsibility, for `what_is_affecting_the_number`. */
  responsibilityId: uuid("responsibility_id"),
  /** The owner whose responsibilities were summarized. */
  ownerUserId: text("owner_user_id"),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  responsibleUserId: text("responsible_user_id"),
  connectionId: uuid("connection_id").notNull(),
  grantId: uuid("grant_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
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
  history: index("responsibility_summary_invocations_company_started_idx").on(t.companyId, t.startedAt, t.id),
  pending: index("responsibility_summary_invocations_pending_idx").on(t.startedAt).where(sql`${t.status} = 'running'`),
  cost: index("responsibility_summary_invocations_cost_idx").on(t.costEventId),
  featureCheck: check("responsibility_summary_invocations_feature_check", sql`${t.feature} in ('where_things_stand', 'what_is_affecting_the_number')`),
  statusCheck: check("responsibility_summary_invocations_status_check", sql`${t.status} in ('running', 'succeeded', 'failed', 'unknown')`),
}));
