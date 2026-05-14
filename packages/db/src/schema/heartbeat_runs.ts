import { sql } from "drizzle-orm";
import { type AnyPgColumn, pgTable, uuid, text, timestamp, jsonb, index, integer, bigint, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    sessionIdBefore: text("session_id_before"),
    sessionIdAfter: text("session_id_after"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    externalRunId: text("external_run_id"),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastOutputSeq: integer("last_output_seq").notNull().default(0),
    lastOutputStream: text("last_output_stream"),
    lastOutputBytes: bigint("last_output_bytes", { mode: "number" }),
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),
    scheduledRetryAt: timestamp("scheduled_retry_at", { withTimezone: true }),
    scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
    scheduledRetryReason: text("scheduled_retry_reason"),
    issueCommentStatus: text("issue_comment_status").notNull().default("not_applicable"),
    issueCommentSatisfiedByCommentId: uuid("issue_comment_satisfied_by_comment_id"),
    issueCommentRetryQueuedAt: timestamp("issue_comment_retry_queued_at", { withTimezone: true }),
    livenessState: text("liveness_state"),
    livenessReason: text("liveness_reason"),
    continuationAttempt: integer("continuation_attempt").notNull().default(0),
    lastUsefulActionAt: timestamp("last_useful_action_at", { withTimezone: true }),
    nextAction: text("next_action"),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    // Generated stored columns mirroring the hot context_snapshot keys.
    // See migration 0079. Populated automatically by Postgres on insert /
    // update; do not write to these directly. Reading them avoids per-row
    // JSONB detoast on the heartbeat list query path.
    contextIssueId: text("context_issue_id").generatedAlwaysAs(sql`context_snapshot ->> 'issueId'`),
    contextTaskId: text("context_task_id").generatedAlwaysAs(sql`context_snapshot ->> 'taskId'`),
    contextTaskKey: text("context_task_key").generatedAlwaysAs(sql`context_snapshot ->> 'taskKey'`),
    contextCommentId: text("context_comment_id").generatedAlwaysAs(sql`context_snapshot ->> 'commentId'`),
    contextWakeCommentId: text("context_wake_comment_id").generatedAlwaysAs(sql`context_snapshot ->> 'wakeCommentId'`),
    contextWakeReason: text("context_wake_reason").generatedAlwaysAs(sql`context_snapshot ->> 'wakeReason'`),
    contextWakeSource: text("context_wake_source").generatedAlwaysAs(sql`context_snapshot ->> 'wakeSource'`),
    contextWakeTriggerDetail: text("context_wake_trigger_detail").generatedAlwaysAs(sql`context_snapshot ->> 'wakeTriggerDetail'`),
    // Generated stored columns mirroring the hot result_json keys (migration
    // 0080). Same per-row JSONB detoast cost as context_snapshot — see the
    // 0080 SQL header for context. Text fields are truncated to 500 chars at
    // write time (same bound the runtime list query was applying via
    // `left(..., HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS)`); cost fields are
    // small numeric strings stored full. Do not write to these directly.
    resultSummary: text("result_summary").generatedAlwaysAs(sql`left(result_json ->> 'summary', 500)`),
    resultResult: text("result_result").generatedAlwaysAs(sql`left(result_json ->> 'result', 500)`),
    resultMessage: text("result_message").generatedAlwaysAs(sql`left(result_json ->> 'message', 500)`),
    resultError: text("result_error").generatedAlwaysAs(sql`left(result_json ->> 'error', 500)`),
    resultTotalCostUsd: text("result_total_cost_usd").generatedAlwaysAs(sql`result_json ->> 'total_cost_usd'`),
    resultCostUsd: text("result_cost_usd").generatedAlwaysAs(sql`result_json ->> 'cost_usd'`),
    resultCostUsdCamel: text("result_cost_usd_camel").generatedAlwaysAs(sql`result_json ->> 'costUsd'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
    companyLivenessIdx: index("heartbeat_runs_company_liveness_idx").on(
      table.companyId,
      table.livenessState,
      table.createdAt,
    ),
    companyStatusLastOutputIdx: index("heartbeat_runs_company_status_last_output_idx").on(
      table.companyId,
      table.status,
      table.lastOutputAt,
    ),
    companyStatusProcessStartedIdx: index("heartbeat_runs_company_status_process_started_idx").on(
      table.companyId,
      table.status,
      table.processStartedAt,
    ),
  }),
);
