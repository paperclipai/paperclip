import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
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
    // Detoast mirror columns: scalar projections from `context_snapshot` and
    // `result_json` so list queries don't have to detoast the full JSONB blob
    // to read a few fields. Populated by PostgreSQL on every INSERT/UPDATE.
    // See packages/db/src/migrations/0124_heartbeat_runs_detoast_generated_columns.sql
    // for the matching DDL.
    // NB: the `(): SQL => sql\`...\`` thunk is needed because Drizzle 0.45.2
    // evaluates the expression eagerly, but `heartbeatRuns` is not yet
    // assigned at the point these column definitions are evaluated. The
    // explicit `SQL` return type breaks the inference cycle (the same trick
    // is used by `retryOfRunId` above for `(): AnyPgColumn => heartbeatRuns.id`).
    contextIssueId: uuid("context_issue_id").generatedAlwaysAs(
      (): SQL => sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId')::uuid`,
    ),
    contextTaskId: uuid("context_task_id").generatedAlwaysAs(
      (): SQL => sql`(${heartbeatRuns.contextSnapshot} ->> 'taskId')::uuid`,
    ),
    contextTaskKey: text("context_task_key").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'taskKey'`,
    ),
    contextCommentId: uuid("context_comment_id").generatedAlwaysAs(
      (): SQL => sql`(${heartbeatRuns.contextSnapshot} ->> 'commentId')::uuid`,
    ),
    contextWakeCommentId: uuid("context_wake_comment_id").generatedAlwaysAs(
      (): SQL => sql`(${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId')::uuid`,
    ),
    contextWakeReason: text("context_wake_reason").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason'`,
    ),
    contextWakeSource: text("context_wake_source").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'wakeSource'`,
    ),
    contextWakeTriggerDetail: text("context_wake_trigger_detail").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'wakeTriggerDetail'`,
    ),
    resultSummary: text("result_summary").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'summary'`,
    ),
    resultResult: text("result_result").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'result'`,
    ),
    resultMessage: text("result_message").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'message'`,
    ),
    resultError: text("result_error").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'error'`,
    ),
    resultCostUsd: text("result_cost_usd").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'cost_usd'`,
    ),
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
    contextIssueIdIdx: index("heartbeat_runs_context_issue_id_idx")
      .on(table.contextIssueId)
      .where(sql`${table.contextIssueId} IS NOT NULL`),
  }),
);
