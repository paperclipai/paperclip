import { type AnyPgColumn, pgTable, uuid, text, timestamp, jsonb, index, integer, bigint, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

/**
 * Canonical status literals for the `heartbeat_runs.status` column. Exported
 * here (next to the schema) so every downstream consumer — the heartbeat
 * service, the delegation poller, tests, API projections — reads from one
 * source of truth.
 *
 * Previously each caller inlined its own literal set, and they drifted: the
 * delegation poller checked for `"done"` while the schema actually writes
 * `"succeeded"`, so `delegate_task` never detected child completion and spun
 * to timeout. Keep these constants authoritative; add here first if the set
 * ever changes.
 */
export const HEARTBEAT_RUN_EXECUTION_PATH_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

export const HEARTBEAT_RUN_CANCELLABLE_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

export const HEARTBEAT_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export const HEARTBEAT_RUN_UNSUCCESSFUL_TERMINAL_STATUSES = [
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type HeartbeatRunTerminalStatus =
  (typeof HEARTBEAT_RUN_TERMINAL_STATUSES)[number];

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
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
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
    parentRunIdx: index("heartbeat_runs_parent_run_idx").on(table.parentRunId),
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
