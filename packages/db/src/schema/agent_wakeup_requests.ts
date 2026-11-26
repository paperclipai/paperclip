import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    taskRetryIdempotencyUq: uniqueIndex("agent_wakeup_requests_task_retry_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'task-retry:%'`),
    companyAgentStatusIdx: index(
      "agent_wakeup_requests_company_agent_status_idx",
    ).on(table.companyId, table.agentId, table.status),
    companyRequestedIdx: index(
      "agent_wakeup_requests_company_requested_idx",
    ).on(table.companyId, table.requestedAt),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(
      table.agentId,
      table.requestedAt,
    ),
    companyRunIdx: index("agent_wakeup_requests_company_run_idx")
      .on(table.companyId, table.runId)
      .concurrently()
      .where(sql`${table.runId} IS NOT NULL`),
    reviewPathRecoveryIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_review_path_recovery_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} LIKE 'issue_review_path_lost:%' AND ${table.status} <> 'skipped'`,
      ),
    dispositionRepairIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_disposition_repair_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} LIKE 'issue_disposition_repair:%' AND ${table.status} <> 'skipped'`,
      ),
    questionResponseDeliveryIdempotencyUq: uniqueIndex(
      "agent_wakeup_requests_question_response_delivery_idempotency_uq",
    )
      .on(table.companyId, table.idempotencyKey)
      .where(sql`(${table.idempotencyKey} LIKE 'question-response:%' OR ${table.idempotencyKey} LIKE 'interaction:%') AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    // Sleep checks also need failed/cancelled/skipped receipts, which the
    // delivery idempotency fence deliberately excludes.
    questionResponseHistoryIdx: index("agent_wakeup_requests_question_response_history_idx")
      .on(table.companyId, table.idempotencyKey)
      .concurrently()
      .where(sql`${table.idempotencyKey} LIKE 'question-response:%'`),
    connectionIntentDeliveryIdempotencyUq: uniqueIndex("agent_wakeup_requests_connection_intent_delivery_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'connection-intent:%' AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    toolActionDeliveryIdempotencyUq: uniqueIndex("agent_wakeup_requests_tool_action_delivery_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'tool-action-response:%' AND ${table.status} NOT IN ('skipped', 'failed', 'cancelled')`),
    // A subtree pause owes its interrupted run one resume wake, ever. A stale
    // dispatcher that saves late must not repeat work a takeover already ran.
    treeHoldResumeIdempotencyUq: uniqueIndex("agent_wakeup_requests_tree_hold_resume_uq")
      .on(table.companyId, table.idempotencyKey)
      .concurrently()
      .where(sql`${table.idempotencyKey} LIKE 'tree-hold-resume:%' AND ${table.status} <> 'skipped'`),
    chatCompletionIdempotencyUq: uniqueIndex("agent_wakeup_requests_chat_completion_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'chat-completion:%'`),
    // One delivered or pending wake per stall (issue_blocker_stalled). Refused
    // wakes (skipped, failed, cancelled) are not covered, so a stall retries
    // once its agent takes wakes again; concurrent sweeps cannot both deliver.
    issueBlockerStalledIdempotencyUq: uniqueIndex("agent_wakeup_requests_issue_blocker_stalled_uq")
      .on(table.companyId, table.idempotencyKey)
      .concurrently()
      .where(sql`${table.idempotencyKey} LIKE 'issue_blocker_stalled:%' AND ${table.status} IN ('queued', 'deferred_issue_execution', 'claimed', 'coalesced', 'completed')`),
    companyPayloadIssueIdx: index("agent_wakeup_requests_company_payload_issue_idx").on(
      table.companyId,
      sql`(${table.payload} ->> 'issueId')`,
    ),
  }),
);
