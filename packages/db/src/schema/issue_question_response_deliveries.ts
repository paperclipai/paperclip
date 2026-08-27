import { sql } from "drizzle-orm";
import {
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
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

/**
 * Durable, content-free delivery state for an answered question interaction.
 * The answer remains authoritative in issue_thread_interactions.result; this
 * row stores only routing state and a digest of the canonical delivery
 * envelope so retries cannot duplicate or silently change the message.
 */
export const issueQuestionResponseDeliveries = pgTable(
  "issue_question_response_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    interactionId: uuid("interaction_id").notNull().references(() => issueThreadInteractions.id, { onDelete: "cascade" }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    targetRunId: uuid("target_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    targetTurnId: text("target_turn_id"),
    correlationId: text("correlation_id").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    status: text("status").notNull().default("pending"),
    deliveryMode: text("delivery_mode"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    interactionUq: uniqueIndex("issue_question_response_deliveries_interaction_uq").on(table.interactionId),
    correlationUq: uniqueIndex("issue_question_response_deliveries_correlation_uq").on(table.correlationId),
    pendingIdx: index("issue_question_response_deliveries_pending_idx").on(table.status, table.createdAt),
    companyIssueIdx: index("issue_question_response_deliveries_company_issue_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    statusCheck: check(
      "issue_question_response_deliveries_status_check",
      sql`${table.status} IN ('pending', 'delivering', 'delivered', 'fallback_queued', 'failed')`,
    ),
    modeCheck: check(
      "issue_question_response_deliveries_mode_check",
      sql`${table.deliveryMode} IS NULL OR ${table.deliveryMode} IN ('steered', 'coalesced', 'wake_fallback')`,
    ),
  }),
);
