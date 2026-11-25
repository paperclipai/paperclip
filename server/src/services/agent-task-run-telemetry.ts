import { and, eq, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { agentHarnessName, requiresExecutionReconciliation } from "@paperclipai/shared";
import { PERMANENT_FAILURE_CODES, RESTART_CLASS_FAILURE_CODES, SETUP_FAILURE_CODES } from "./continuation-cause.js";
import { trackAgentTaskCompleted, trackAgentTaskRun } from "@paperclipai/shared/telemetry";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { resolveTelemetryPerson, withTelemetryActor } from "../telemetry-company-scope.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type TelemetryRun = Pick<HeartbeatRun,
  "id" | "companyId" | "agentId" | "status" | "startedAt" | "finishedAt" | "usageJson" | "contextSnapshot"
  | "errorCode" | "resultJson">
  & Partial<Pick<HeartbeatRun, "responsibleUserId">>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentRunFailureCause =
  | "missing_access"
  | "provider_limit"
  | "provider_error"
  | "waiting_for_person"
  | "task_changed"
  | "platform_error"
  | "agent_error"
  | "unknown";

const FAILURE_STATES = new Set(["failed", "timed_out", "interrupted"]);

const PLATFORM_FAILURE_CODES = new Set<string>([
  ...RESTART_CLASS_FAILURE_CODES,
  ...SETUP_FAILURE_CODES,
  ...PERMANENT_FAILURE_CODES,
  "workspace_validation_failed",
  "workspace_restore_failed",
  "remote_workspace_restore_failed",
  "workspace_busy",
  "runner_revision_mismatch",
  "storage_unavailable",
  "native_execution_ownership_unverified",
  "lease_released_before_terminal",
  "plugin_worker_unavailable",
  "native_workspace_sync_out_retry_exhausted",
  "queued_run_claim_rejected",
]);

const FAILURE_CAUSE_BY_ERROR_CODE: Record<string, AgentRunFailureCause> = {
  configuration_incomplete: "missing_access",
  slack_configuration_incomplete: "missing_access",
  signing_secret_unconfigured: "missing_access",
  user_secret_missing: "missing_access",
  user_secret_definition_missing: "missing_access",
  user_secret_definition_inactive: "missing_access",
  github_access_denied: "missing_access",
  github_app_installation_suspended: "missing_access",
  github_repo_outside_app_installations: "missing_access",
  github_repo_not_accessible: "missing_access",
  github_auth_required: "missing_access",
  project_access_denied: "missing_access",
  permission_denied: "missing_access",
  responsible_user_unauthorized: "missing_access",
  oauth_access_projection_disabled: "missing_access",
  acpx_auth_required: "missing_access",
  codex_auth_required: "missing_access",
  claude_auth_required: "missing_access",
  provider_auth_failed: "missing_access",
  hermes_gateway_auth_failed: "missing_access",
  connection_unavailable: "missing_access",
  provider_quota: "provider_limit",
  provider_limit_wait: "provider_limit",
  native_provider_usage_limit: "provider_limit",
  native_provider_overloaded: "provider_limit",
  github_rate_limited: "provider_limit",
  ai_connection_busy: "provider_limit",
  native_provider_model_rejected: "provider_error",
  provider_tool_definition_invalid: "provider_error",
  provider_transport_failed: "provider_error",
  codex_transient_upstream: "provider_error",
  provider_failed: "provider_error",
  issue_waiting_for_response: "waiting_for_person",
  issue_continuation_waiting_on_review: "waiting_for_person",
  approval_required: "waiting_for_person",
  formal_approval_unavailable: "waiting_for_person",
  budget_blocked: "waiting_for_person",
  budget_hard_stop: "waiting_for_person",
  budget_exceeded: "waiting_for_person",
  cancelled: "task_changed",
  operator_cancelled: "task_changed",
  operator_interrupted: "task_changed",
  interrupted: "task_changed",
  issue_cancelled: "task_changed",
  issue_paused: "task_changed",
  agent_paused: "task_changed",
  issue_reassigned: "task_changed",
  issue_assignee_changed: "task_changed",
  issue_terminal_status: "task_changed",
  issue_not_in_progress: "task_changed",
  issue_execution_lock_changed: "task_changed",
  issue_dependencies_blocked: "task_changed",
  issue_blocked: "task_changed",
  issue_not_found: "task_changed",
  issue_review_participant_changed: "task_changed",
  queued_comment_discarded: "task_changed",
  invalid_output: "agent_error",
  invalid_response: "agent_error",
  tool_error: "agent_error",
  acpx_turn_failed: "agent_error",
  test_run_failed: "agent_error",
  prompt_injection_blocked: "agent_error",
  tool_execution_outcome_unknown: "agent_error",
  turn_limit_exhausted: "agent_error",
  timeout: "agent_error",
  adapter_failed: "agent_error",
};

const FAILURE_CAUSE_BY_PROVIDER_CATEGORY: Record<string, AgentRunFailureCause> = {
  authentication: "missing_access",
  permission: "missing_access",
  rate_limit: "provider_limit",
  quota_exhausted: "provider_limit",
  overloaded: "provider_limit",
  model_unavailable: "provider_error",
  invalid_request: "provider_error",
  timeout: "provider_error",
  unknown: "provider_error",
};

const PROVIDER_CATEGORY_CODES = new Set(["adapter_failed", "provider_failed"]);

export function agentRunFailureCause(input: {
  errorCode: string | null | undefined;
  providerFailureCategory: string | null | undefined;
}): AgentRunFailureCause {
  const code = input.errorCode ?? null;
  if (code && (code === "execution_reconciliation_required" || requiresExecutionReconciliation(code))) {
    return "waiting_for_person";
  }
  const providerCause = input.providerFailureCategory
    ? FAILURE_CAUSE_BY_PROVIDER_CATEGORY[input.providerFailureCategory]
    : undefined;
  if (providerCause && (!code || PROVIDER_CATEGORY_CODES.has(code))) return providerCause;
  if (!code) return "unknown";
  if (FAILURE_CAUSE_BY_ERROR_CODE[code]) return FAILURE_CAUSE_BY_ERROR_CODE[code];
  return PLATFORM_FAILURE_CODES.has(code) ? "platform_error" : "unknown";
}

export function telemetryAdapterType(agent: { adapterType: string; adapterConfig: unknown }): string {
  return agentHarnessName(agent.adapterType, parseObject(agent.adapterConfig));
}

function providerFailureCategory(resultJson: unknown): string | null {
  const providerFailure = parseObject(parseObject(resultJson).providerFailure);
  return typeof providerFailure.category === "string" ? providerFailure.category : null;
}

function resolveFailureCause(run: TelemetryRun): AgentRunFailureCause | undefined {
  if (!FAILURE_STATES.has(run.status)) return undefined;
  return agentRunFailureCause({ errorCode: run.errorCode, providerFailureCategory: providerFailureCategory(run.resultJson) });
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readUsageToken(
  source: Record<string, unknown>,
  ...keys: string[]
): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
  }
  return 0;
}

function resolveDurationSeconds(
  run: Pick<TelemetryRun, "startedAt" | "finishedAt">,
  now: Date,
): number | undefined {
  if (!run.startedAt) return undefined;
  const startedAtMs = new Date(run.startedAt).getTime();
  const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : now.getTime();
  return Math.max(0, Math.round((endMs - startedAtMs) / 1000));
}

/**
 * Emits one `agent.task_run` telemetry event for a run that a caller already
 * wrote to a terminal status. The native runtime and the legacy run engine
 * both call this function beside each terminal status write. Call this
 * function after the run commits.
 *
 * This function never throws. A telemetry failure must never fail a run.
 * Telemetry enrichment does an awaited database lookup, so treat this call
 * as best-effort background work: do not let a caller's own required
 * lifecycle work (publishing a live event, cancelling a wake, clearing an
 * issue lock, returning a response) wait behind it. Fire this call with
 * `void emitAgentTaskRun(...)` and never await it, even alongside other
 * required work with `Promise.all` — an awaited `Promise.all` still blocks
 * the caller's return on the slower of the two promises, so it does not
 * remove the delay.
 */
export async function emitAgentTaskRun(db: Db, run: TelemetryRun): Promise<void> {
  try {
    const client = getTelemetryClient();
    if (!client) return;

    const taskId =
      readNonEmptyString(parseObject(run.contextSnapshot).issueId) ??
      undefined;
    const taskRowId = taskId && UUID_RE.test(taskId) ? taskId : null;

    const agent = await db
      .select({
        role: agents.role,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        taskCreatedByUserId: issues.createdByUserId,
        taskResponsibleUserId: issues.responsibleUserId,
      })
      .from(agents)
      .leftJoin(
        issues,
        taskRowId
          ? and(eq(issues.id, taskRowId), eq(issues.companyId, run.companyId))
          : sql`false`,
      )
      .where(eq(agents.id, run.agentId))
      .then((rows) => rows[0] ?? null);

    const usage = parseObject(run.usageJson);
    const model =
      readNonEmptyString(usage.model) ??
      readNonEmptyString(parseObject(agent?.adapterConfig).model) ??
      undefined;

    const person = resolveTelemetryPerson({
      taskCreatedByUserId: agent?.taskCreatedByUserId,
      taskAssignedByUserId: agent?.taskResponsibleUserId,
      runOwnerUserId: run.responsibleUserId,
    });
    const failureCause = resolveFailureCause(run);

    withTelemetryActor({ companyId: run.companyId, person }, () => trackAgentTaskRun(client, {
      agentId: run.agentId,
      state: run.status,
      ...(agent
        ? { adapterType: telemetryAdapterType(agent), agentRole: agent.role }
        : {}),
      ...(model ? { model } : {}),
      ...(() => {
        const durationSeconds = resolveDurationSeconds(run, new Date());
        return durationSeconds === undefined ? {} : { durationSeconds };
      })(),
      ...(run.usageJson != null
        ? {
            inputTokens: readUsageToken(
              usage,
              "inputTokens",
              "input_tokens",
              "rawInputTokens",
              "raw_input_tokens",
            ),
            outputTokens: readUsageToken(
              usage,
              "outputTokens",
              "output_tokens",
              "rawOutputTokens",
              "raw_output_tokens",
            ),
            cachedTokens: readUsageToken(
              usage,
              "cachedInputTokens",
              "cached_input_tokens",
              "cacheReadInputTokens",
              "cache_read_input_tokens",
            ),
          }
        : {}),
      ...(taskId ? { taskId } : {}),
      ...(failureCause ? { failureCause } : {}),
    }));
  } catch (err) {
    logger.warn(
      { err, runId: run.id },
      "failed to emit agent.task_run telemetry",
    );
  }
}

/** Loads a committed run before emitting telemetry, keeping database rows out of application contracts. */
export async function emitAgentTaskRunById(
  db: Db,
  input: { runId: string; companyId: string },
): Promise<void> {
  try {
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        usageJson: heartbeatRuns.usageJson,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId')`,
        errorCode: heartbeatRuns.errorCode,
        resultJson: sql<Record<string, unknown> | null>`jsonb_build_object('providerFailure', jsonb_build_object('category', ${heartbeatRuns.resultJson}->'providerFailure'->'category'))`,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (run) await emitAgentTaskRun(db, run);
  } catch (err) {
    logger.warn({ err, runId: input.runId }, "failed to load run for agent.task_run telemetry");
  }
}

export async function emitAgentTaskCompleted(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    taskCreatedByUserId?: string | null;
    taskAssignedByUserId?: string | null;
    runOwnerUserId?: string | null;
  },
): Promise<void> {
  try {
    const client = getTelemetryClient();
    if (!client) return;

    const agent = await db
      .select({
        id: agents.id,
        role: agents.role,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) return;

    const model = readNonEmptyString(parseObject(agent.adapterConfig).model) ?? undefined;
    const person = resolveTelemetryPerson({
      taskCreatedByUserId: input.taskCreatedByUserId,
      taskAssignedByUserId: input.taskAssignedByUserId,
      runOwnerUserId: input.runOwnerUserId,
    });
    withTelemetryActor({ companyId: input.companyId, person }, () => trackAgentTaskCompleted(client, {
      agentRole: agent.role,
      agentId: agent.id,
      adapterType: telemetryAdapterType(agent),
      ...(model ? { model } : {}),
      taskId: input.issueId,
    }));
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId },
      "failed to emit agent.task_completed telemetry",
    );
  }
}
