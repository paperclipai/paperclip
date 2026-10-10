import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { costEvents } from "./cost_events.js";

export const companyFastResponses = pgTable(
  "company_fast_responses",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id"),
    grantId: uuid("grant_id"),
    model: text("model"),
    provider: text("provider"),
    enabled: boolean("enabled").notNull().default(false),
    allowSponsored: boolean("allow_sponsored").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    configured: check(
      "company_fast_responses_configured",
      sql`(${t.connectionId} is null) = (${t.grantId} is null) and (not ${t.enabled} or (${t.connectionId} is not null and ${t.model} is not null))`,
    ),
  }),
);

/** Durable receipt job and content-free inference accounting. Never stores prompts or credentials. */
export const fastResponseRequests = pgTable(
  "fast_response_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    sourceCommentId: uuid("source_comment_id"),
    issueId: uuid("issue_id"),
    projectId: uuid("project_id"),
    agentId: uuid("agent_id"),
    responsibleUserId: text("responsible_user_id"),
    sponsored: boolean("sponsored").notNull().default(false),
    endpointId: uuid("endpoint_id"),
    conversationId: uuid("conversation_id"),
    deliveryId: uuid("delivery_id"),
    sessionGeneration: integer("session_generation"),
    status: text("status").notNull().default("pending"),
    publicationStatus: text("publication_status").notNull().default("pending"),
    connectionId: uuid("connection_id"),
    grantId: uuid("grant_id"),
    provider: text("provider"),
    model: text("model"),
    providerRequestId: text("provider_request_id"),
    costEventId: uuid("cost_event_id").references(() => costEvents.id),
    errorCode: text("error_code"),
    commentId: uuid("comment_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (t) => ({
    source: uniqueIndex("fast_response_requests_source_idx").on(
      t.companyId,
      t.sourceKey,
    ),
    history: index("fast_response_requests_history_idx").on(
      t.companyId,
      t.acceptedAt,
    ),
    work: index("fast_response_requests_work_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} in ('pending', 'running')`),
    status: check(
      "fast_response_requests_status_check",
      sql`${t.status} in ('pending', 'running', 'succeeded', 'failed', 'unknown', 'skipped')`,
    ),
  }),
);
