import { deriveTaskKey } from "./run-preparation.js";
import { retryIdempotentDatabaseOperation } from "../../database-retry.js";
import { isConversation } from "../agent-conversations.js";
import fs from "node:fs/promises";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  type BillingType,
  type CostStatus,
} from "@paperclipai/shared";
import {
  agents,
  agentConfigRevisions,
  agentRuntimeState,
  agentTaskSessions,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { getServerAdapter } from "../../adapters/index.js";
import type {
  AdapterExecutionResult,
  AdapterSessionCodec,
  UsageSummary,
} from "../../adapters/index.js";
import {
  parseObject,
  asNumber,
} from "../../adapters/utils.js";
import {
  HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS,
  HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS,
  HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
  summarizeRunErrorForModel,
} from "../heartbeat-run-summary.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";
import { isUuidLike } from "@paperclipai/shared";
import { isUnsafeSessionWorkspaceCwd } from "../session-workspace-cwd.js";

export const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON =
  "execution_review_participant_recovery";

const heartbeatRunProcessGroupIdColumn =
  heartbeatRuns.processGroupId ?? sql<number | null>`NULL`.as("processGroupId");

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  responsibleUserId: heartbeatRuns.responsibleUserId,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  scopeKind: heartbeatRuns.scopeKind,
  issueId: heartbeatRuns.issueId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  inputTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'inputTokens')::numeric`.as("inputTokens"),
  cachedInputTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'cachedInputTokens')::numeric`.as("cachedInputTokens"),
  outputTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'outputTokens')::numeric`.as("outputTokens"),
  totalTokens: sql<number | null>`(${heartbeatRuns.usageJson} ->> 'totalTokens')::numeric`.as("totalTokens"),
  costUsd: sql<number | null>`coalesce(
    (${heartbeatRuns.resultJson} ->> 'costUsd')::numeric,
    (${heartbeatRuns.resultJson} ->> 'cost_usd')::numeric,
    (${heartbeatRuns.resultJson} ->> 'total_cost_usd')::numeric
  )`.as("costUsd"),
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processGroupId: heartbeatRunProcessGroupIdColumn,
  processStartedAt: heartbeatRuns.processStartedAt,
  lastOutputAt: heartbeatRuns.lastOutputAt,
  lastOutputSeq: heartbeatRuns.lastOutputSeq,
  lastOutputStream: heartbeatRuns.lastOutputStream,
  lastOutputBytes: heartbeatRuns.lastOutputBytes,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
  scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
  scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
  livenessState: heartbeatRuns.livenessState,
  livenessReason: heartbeatRuns.livenessReason,
  continuationAttempt: heartbeatRuns.continuationAttempt,
  lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
  nextAction: heartbeatRuns.nextAction,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

const heartbeatRunSummaryListColumns = {
  ...heartbeatRunListColumns,
  usageJson: sql<Record<string, unknown> | null>`NULL`.as("usageJson"),
  sessionIdBefore: sql<string | null>`NULL`.as("sessionIdBefore"),
  sessionIdAfter: sql<string | null>`NULL`.as("sessionIdAfter"),
  logStore: sql<string | null>`NULL`.as("logStore"),
  logRef: sql<string | null>`NULL`.as("logRef"),
  logSha256: sql<string | null>`NULL`.as("logSha256"),
  externalRunId: sql<string | null>`NULL`.as("externalRunId"),
  processPid: sql<number | null>`NULL`.as("processPid"),
  processGroupId: sql<number | null>`NULL`.as("processGroupId"),
  resultJson: sql<Record<string, unknown> | null>`NULL`.as("resultJson"),
} as const;

const heartbeatRunListContextColumns = {
  contextIssueId: sql<string | null>`coalesce(
    ${heartbeatRuns.issueId}::text,
    ${heartbeatRuns.contextSnapshot} ->> 'issueId'
  )`.as("contextIssueId"),
  contextTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`.as("contextTaskId"),
  contextTaskKey: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskKey'`.as("contextTaskKey"),
  contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
  contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
  contextWakeReason: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeReason'`.as("contextWakeReason"),
  contextWakeSource: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeSource'`.as("contextWakeSource"),
  contextWakeTriggerDetail: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeTriggerDetail'`.as("contextWakeTriggerDetail"),
} as const;

const heartbeatRunListResultColumns = {
  resultSummary: sql<
    string | null
  >`left(${heartbeatRuns.resultJson} ->> 'summary', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as(
    "resultSummary",
  ),
  resultResult: sql<
    string | null
  >`left(${heartbeatRuns.resultJson} ->> 'result', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as(
    "resultResult",
  ),
  resultMessage: sql<
    string | null
  >`left(${heartbeatRuns.resultJson} ->> 'message', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as(
    "resultMessage",
  ),
  resultError: sql<
    string | null
  >`left(${heartbeatRuns.resultJson} ->> 'error', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as(
    "resultError",
  ),
  resultTotalCostUsd: sql<
    string | null
  >`${heartbeatRuns.resultJson} ->> 'total_cost_usd'`.as("resultTotalCostUsd"),
  resultCostUsd: sql<
    string | null
  >`${heartbeatRuns.resultJson} ->> 'cost_usd'`.as("resultCostUsd"),
  resultCostUsdCamel: sql<
    string | null
  >`${heartbeatRuns.resultJson} ->> 'costUsd'`.as("resultCostUsdCamel"),
} as const;

// Reserve at most 9 KiB for diagnostics in the reduced result. An oversized
// multibyte field uses a conservative four-byte-per-character prefix, with a
// visible pointer to the full (adapter-bounded) run error and transcript.
const diagnosticRetrievalTitleBytes = 1024;

const diagnosticRetrievalDetailsBytes = 8192;

function boundedRunDiagnosticText(field: "title" | "details", maxBytes: number) {
  const value = sql`${heartbeatRuns.resultJson} #>> ARRAY['terminalSessionFailure', ${field}]`;
  return sql`case when octet_length(${value}) <= ${maxBytes} then ${value}
    else left(${value}, ${Math.floor((maxBytes - 100) / 4)})
      || E'\\n[truncated for run retrieval; full text in run error/transcript]' end`;
}

const heartbeatRunSafeResultJsonColumn = sql<Record<string, unknown> | null>`
  case
    when ${heartbeatRuns.resultJson} is null then null
    when pg_column_size(${heartbeatRuns.resultJson}) <= ${HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES}
      then ${heartbeatRuns.resultJson}
    else jsonb_strip_nulls(
      jsonb_build_object(
        'summary', left(${heartbeatRuns.resultJson} ->> 'summary', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS}),
        'result', left(${heartbeatRuns.resultJson} ->> 'result', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS}),
        'message', left(${heartbeatRuns.resultJson} ->> 'message', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS}),
        'error', left(${heartbeatRuns.resultJson} ->> 'error', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS}),
        'stdout', left(${heartbeatRuns.resultJson} ->> 'stdout', ${HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS}),
        'stderr', left(${heartbeatRuns.resultJson} ->> 'stderr', ${HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS}),
        'terminalSessionFailure', case when jsonb_typeof(${heartbeatRuns.resultJson} -> 'terminalSessionFailure') = 'object'
          then jsonb_strip_nulls(jsonb_build_object(
            'category', left(${heartbeatRuns.resultJson} #>> '{terminalSessionFailure,category}', 32),
            'title', ${boundedRunDiagnosticText("title", diagnosticRetrievalTitleBytes)},
            'details', ${boundedRunDiagnosticText("details", diagnosticRetrievalDetailsBytes)},
            'retrievalTruncated', case when
              octet_length(${heartbeatRuns.resultJson} #>> '{terminalSessionFailure,title}') > ${diagnosticRetrievalTitleBytes}
              or octet_length(${heartbeatRuns.resultJson} #>> '{terminalSessionFailure,details}') > ${diagnosticRetrievalDetailsBytes}
              then to_jsonb(true) end,
            'truncatedFields', case when ${heartbeatRuns.resultJson} #> '{terminalSessionFailure,truncatedFields}'
              in ('["title"]'::jsonb, '["details"]'::jsonb, '["title","details"]'::jsonb)
              then ${heartbeatRuns.resultJson} #> '{terminalSessionFailure,truncatedFields}' end
          )) end,
        'instructionSave', case when jsonb_typeof(${heartbeatRuns.resultJson} -> 'instructionSave') = 'object'
          then jsonb_strip_nulls(jsonb_build_object(
            'state', left(${heartbeatRuns.resultJson} #>> '{instructionSave,state}', 32),
            'contract', left(${heartbeatRuns.resultJson} #>> '{instructionSave,contract}', 32),
            'entryFile', left(${heartbeatRuns.resultJson} #>> '{instructionSave,entryFile}', 512),
            'errorCode', left(${heartbeatRuns.resultJson} #>> '{instructionSave,errorCode}', 128),
            'errorMessage', left(${heartbeatRuns.resultJson} #>> '{instructionSave,errorMessage}', 1024),
            'storageWarning', left(${heartbeatRuns.resultJson} #>> '{instructionSave,storageWarning}', 1024)
          )) end,
        'workspaceRestoreRecovery', case when ${heartbeatRuns.resultJson} #>> '{workspaceRestoreRecovery,schema}' = 'paperclip.workspace-restore-recovery.v1'
          then jsonb_build_object('schema', 'paperclip.workspace-restore-recovery.v1') end,
        'workspaceRestoreFailure', case when ${heartbeatRuns.resultJson} ->> 'workspaceRestoreFailure'
          in ('restore_permission_denied', 'restore_lock_timeout', 'restore_unsafe_archive', 'restore_failed')
          then ${heartbeatRuns.resultJson} -> 'workspaceRestoreFailure' end,
        'cancellation', case when jsonb_typeof(${heartbeatRuns.resultJson} -> 'cancellation') = 'object'
          then jsonb_strip_nulls(jsonb_build_object(
            'source', case when ${heartbeatRuns.resultJson} #>> '{cancellation,source}'
              in ('operator', 'queued_message', 'shutdown', 'provider', 'transport', 'control_plane', 'unknown')
              then ${heartbeatRuns.resultJson} #> '{cancellation,source}' end,
            'expected', case when jsonb_typeof(${heartbeatRuns.resultJson} #> '{cancellation,expected}') = 'boolean'
              then ${heartbeatRuns.resultJson} #> '{cancellation,expected}' end,
            'initiator', jsonb_strip_nulls(jsonb_build_object(
              'type', case when ${heartbeatRuns.resultJson} #>> '{cancellation,initiator,type}' in ('user', 'agent', 'system', 'provider')
                then ${heartbeatRuns.resultJson} #> '{cancellation,initiator,type}' end,
              'id', left(${heartbeatRuns.resultJson} #>> '{cancellation,initiator,id}', 128)
            )),
            'reason', left(${heartbeatRuns.resultJson} #>> '{cancellation,reason}', 512),
            'recordedAt', left(${heartbeatRuns.resultJson} #>> '{cancellation,recordedAt}', 64)
          )) end,
        'acpToolInventoryComplete', case when jsonb_typeof(${heartbeatRuns.resultJson} -> 'acpToolInventoryComplete') = 'boolean'
          then ${heartbeatRuns.resultJson} -> 'acpToolInventoryComplete' end,
        'acpPendingToolCount', case when jsonb_typeof(${heartbeatRuns.resultJson} -> 'acpPendingToolCount') = 'number'
          and length(${heartbeatRuns.resultJson} ->> 'acpPendingToolCount') < 16
          then ${heartbeatRuns.resultJson} -> 'acpPendingToolCount' end,
        'errorFamily', left(${heartbeatRuns.resultJson} ->> 'errorFamily', 32),
        'finalResponseRecorded', case when jsonb_typeof(${heartbeatRuns.resultJson} -> 'finalResponseRecorded') = 'boolean'
          then ${heartbeatRuns.resultJson} -> 'finalResponseRecorded' end,
        'executionBeforeRestore', case when jsonb_typeof(${heartbeatRuns.resultJson} -> 'executionBeforeRestore') = 'object'
          then jsonb_strip_nulls(jsonb_build_object(
            'errorCode', left(${heartbeatRuns.resultJson} #>> '{executionBeforeRestore,errorCode}', 128),
            'exitCode', case when jsonb_typeof(${heartbeatRuns.resultJson} #> '{executionBeforeRestore,exitCode}') = 'number'
              and length(${heartbeatRuns.resultJson} #>> '{executionBeforeRestore,exitCode}') < 16
              then ${heartbeatRuns.resultJson} #> '{executionBeforeRestore,exitCode}' end,
            'signal', left(${heartbeatRuns.resultJson} #>> '{executionBeforeRestore,signal}', 50),
            'timedOut', case when jsonb_typeof(${heartbeatRuns.resultJson} #> '{executionBeforeRestore,timedOut}') = 'boolean'
              then ${heartbeatRuns.resultJson} #> '{executionBeforeRestore,timedOut}' end
          )) end,
        'stdoutTruncated', case
          when length(${heartbeatRuns.resultJson} ->> 'stdout') > ${HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS}
            then to_jsonb(true)
          else null
        end,
        'stderrTruncated', case
          when length(${heartbeatRuns.resultJson} ->> 'stderr') > ${HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS}
            then to_jsonb(true)
          else null
        end,
        'costUsd', coalesce(
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'total_cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'total_cost_usd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd'
        ),
        'truncated', true,
        'truncationReason', 'oversized_result_json',
        'originalSizeBytes', pg_column_size(${heartbeatRuns.resultJson})
      )
    )
  end
`.as("resultJson");

// Execution admission needs retained server receipts even when presentation
// projection omits resultJson (SQL_ASCII or oversized provider output). Select
// only the evidence used by eligibility; never retrieve provider diagnostics.
const heartbeatRunExecutionEvidenceColumn = sql<Record<string, unknown> | null>`
  case when ${heartbeatRuns.resultJson} is null then null else jsonb_build_object(
    'startupCancellation', ${heartbeatRuns.resultJson} -> 'startupCancellation',
    'startupPreparationSettledAt', ${heartbeatRuns.resultJson} -> 'startupPreparationSettledAt',
    'stopReason', ${heartbeatRuns.resultJson} -> 'stopReason',
    'timeoutSource', ${heartbeatRuns.resultJson} -> 'timeoutSource',
    'workspaceRestoreFailure', ${heartbeatRuns.resultJson} -> 'workspaceRestoreFailure',
    'workspaceRestoreRecovery', ${heartbeatRuns.resultJson} -> 'workspaceRestoreRecovery',
    'executionCancellation', ${heartbeatRuns.resultJson} -> 'executionCancellation',
    'nativeCancellation', ${heartbeatRuns.resultJson} -> 'nativeCancellation',
    'cancelledByActorType', ${heartbeatRuns.resultJson} -> 'cancelledByActorType',
    'cancelledByUserId', ${heartbeatRuns.resultJson} -> 'cancelledByUserId',
    'conversationContinuation', ${heartbeatRuns.resultJson} -> 'conversationContinuation',
    'cancellation', ${heartbeatRuns.resultJson} -> 'cancellation',
    'acpToolInventoryComplete', ${heartbeatRuns.resultJson} -> 'acpToolInventoryComplete',
    'acpPendingToolCount', ${heartbeatRuns.resultJson} -> 'acpPendingToolCount'
  ) end
`.as("resultJson");

const heartbeatRunSafeColumns = {
  ...getTableColumns(heartbeatRuns),
  processGroupId: heartbeatRunProcessGroupIdColumn,
  resultJson: heartbeatRunSafeResultJsonColumn,
} as const;

const heartbeatRunSqlAsciiSafeColumns = {
  ...getTableColumns(heartbeatRuns),
  processGroupId: heartbeatRunProcessGroupIdColumn,
  error: sql<string | null>`NULL`.as("error"),
  resultJson: sql<Record<string, unknown> | null>`NULL`.as("resultJson"),
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
} as const;

const heartbeatRunLogAccessColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  scopeKind: heartbeatRuns.scopeKind,
  issueId: heartbeatRuns.issueId,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
} as const;

const heartbeatRunIssueSummaryColumns = {
  id: heartbeatRuns.id,
  runtimeMode: heartbeatRuns.runtimeMode,
  status: heartbeatRuns.status,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  contextCommentId: sql<
    string | null
  >`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
  contextWakeCommentId: sql<
    string | null
  >`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as(
    "contextWakeCommentId",
  ),
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  createdAt: heartbeatRuns.createdAt,
  agentId: heartbeatRuns.agentId,
  logBytes: heartbeatRuns.logBytes,
  processStartedAt: heartbeatRuns.processStartedAt,
  livenessState: heartbeatRuns.livenessState,
  livenessReason: heartbeatRuns.livenessReason,
  continuationAttempt: heartbeatRuns.continuationAttempt,
  lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
  nextAction: heartbeatRuns.nextAction,
  lastOutputAt: heartbeatRuns.lastOutputAt,
  lastOutputSeq: heartbeatRuns.lastOutputSeq,
  lastOutputStream: heartbeatRuns.lastOutputStream,
  lastOutputBytes: heartbeatRuns.lastOutputBytes,
  issueId: heartbeatRuns.issueId,
} as const;

export type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

export function summarizeHeartbeatRunContextSnapshot(
  contextSnapshot: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const summary: Record<string, unknown> = {};
  const allowedKeys = [
    "issueId",
    "taskId",
    "taskKey",
    "commentId",
    "wakeCommentId",
    "wakeReason",
    "wakeSource",
    "wakeTriggerDetail",
  ] as const;

  for (const key of allowedKeys) {
    const value = readNonEmptyString(contextSnapshot?.[key]);
    if (value) summary[key] = value;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function summarizeHeartbeatRunListResultJson(input: {
  summary?: string | null;
  result?: string | null;
  message?: string | null;
  error?: string | null;
  totalCostUsd?: string | null;
  costUsd?: string | null;
  costUsdCamel?: string | null;
}): Record<string, unknown> | null {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of [
    ["summary", input.summary],
    ["result", input.result],
    ["message", input.message],
    ["error", input.error],
  ] as const) {
    const normalized = readNonEmptyString(value);
    if (normalized) summary[key] = normalized;
  }

  for (const [key, value] of [
    ["total_cost_usd", input.totalCostUsd],
    ["cost_usd", input.costUsd],
    ["costUsd", input.costUsdCamel],
  ] as const) {
    const normalized = readNonEmptyString(value);
    if (!normalized) continue;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) summary[key] = parsed;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

export function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return (
    readNonEmptyString(result.biller) ??
    readNonEmptyString(result.provider) ??
    "unknown"
  );
}

export function normalizeBilledCostCents(
  costUsd: number | null | undefined,
  billingType: BillingType,
): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Number((costUsd * 100).toFixed(7)));
}

export function resolveLedgerCostStatus(input: {
  costUsd: number | null | undefined;
  billingType?: BillingType;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): CostStatus {
  if (input.billingType === "subscription_included") return "reported";
  // A paused turn can have neither a token receipt nor a cost receipt. Zero
  // normalized counters do not establish that its billed cost was zero.
  return typeof input.costUsd === "number" &&
    Number.isFinite(input.costUsd) &&
    input.costUsd >= 0
    ? "reported"
    : "unpriced";
}

export function resolveCacheAdjustedCostUsd(input: {
  costUsd?: number | null;
  cacheAdjustedCostUsd?: number | null;
}) {
  const explicit = input.cacheAdjustedCostUsd;
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit >= 0
  ) {
    return explicit;
  }
  const reported = input.costUsd;
  if (
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported >= 0
  ) {
    return reported;
  }
  return null;
}

export async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
      billingCode: null,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      billingCode: issues.billingCode,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
    billingCode: issue?.billingCode ?? null,
  };
}

type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

export function buildExplicitResumeSessionOverride(input: {
  adapterType?: string | null;
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  resumeRunSessionParams?: Record<string, unknown> | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AdapterSessionCodec;
}) {
  const resumeRunSessionIdAfter = truncateDisplayId(
    input.resumeRunSessionIdAfter,
  );
  const resumeRunSessionIdBefore = truncateDisplayId(
    input.resumeRunSessionIdBefore,
  );
  const desiredDisplayId = requiresCanonicalSessionIds(input.adapterType)
    ? isCanonicalSessionIdForAdapter(input.adapterType, resumeRunSessionIdAfter)
      ? resumeRunSessionIdAfter
      : isCanonicalSessionIdForAdapter(
            input.adapterType,
            resumeRunSessionIdBefore,
          )
        ? resumeRunSessionIdBefore
        : null
    : (resumeRunSessionIdAfter ?? resumeRunSessionIdBefore);
  const runSessionParams = requiresCanonicalSessionIds(input.adapterType)
    ? normalizeResumeParamsForAdapter(
        input.adapterType,
        input.sessionCodec.deserialize(input.resumeRunSessionParams ?? null),
      )
    : null;
  const runSessionDisplayId = truncateDisplayId(
    readNonEmptyString(runSessionParams?.sessionId),
  );
  const taskSessionParams = normalizeResumeParamsForAdapter(
    input.adapterType,
    input.sessionCodec.deserialize(
      input.taskSession?.sessionParamsJson ?? null,
    ),
  );
  const taskSessionRawDisplayId = input.taskSession?.sessionDisplayId ?? null;
  const taskSessionDisplayId = truncateDisplayId(
    requiresCanonicalSessionIds(input.adapterType)
      ? (readNonEmptyString(taskSessionParams?.sessionId) ??
          (isCanonicalSessionIdForAdapter(
            input.adapterType,
            taskSessionRawDisplayId,
          )
            ? taskSessionRawDisplayId
            : null))
      : (taskSessionRawDisplayId ??
          (input.sessionCodec.getDisplayId
            ? input.sessionCodec.getDisplayId(taskSessionParams)
            : null) ??
          readNonEmptyString(taskSessionParams?.sessionId)),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (!requiresCanonicalSessionIds(input.adapterType) ||
      taskSessionParams != null) &&
    (input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId));
  const sessionParams = canReuseTaskSessionParams
    ? taskSessionParams
    : runSessionParams
      ? runSessionParams
      : desiredDisplayId
        ? { sessionId: desiredDisplayId }
        : null;
  const sessionDisplayId = canReuseTaskSessionParams
    ? taskSessionDisplayId
    : runSessionParams
      ? runSessionDisplayId
      : desiredDisplayId;

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

export function normalizeUsageTotals(
  usage: UsageSummary | null | undefined,
): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(
      0,
      Math.floor(asNumber(usage.cachedInputTokens, 0)),
    ),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(
      asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0)),
    ),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(
      asNumber(
        parsed.rawCachedInputTokens,
        asNumber(parsed.cachedInputTokens, 0),
      ),
    ),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(
      asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0)),
    ),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

export function normalizeAdapterRunUsage(
  current: UsageTotals | null,
  previous: UsageTotals | null,
  usageBasis?: "per_run" | "session_cumulative" | null,
): UsageTotals | null {
  if (!current) return null;
  if (!previous || usageBasis !== "session_cumulative") return { ...current };

  const inputTokens =
    current.inputTokens >= previous.inputTokens
      ? current.inputTokens - previous.inputTokens
      : current.inputTokens;
  const cachedInputTokens =
    current.cachedInputTokens >= previous.cachedInputTokens
      ? current.cachedInputTokens - previous.cachedInputTokens
      : current.cachedInputTokens;
  const outputTokens =
    current.outputTokens >= previous.outputTokens
      ? current.outputTokens - previous.outputTokens
      : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(
  agent: typeof agents.$inferSelect,
): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig)
    .policy;
}

/**
 * Synthetic task key for timer/heartbeat wakes that have no issue context.
 * This allows timer wakes to participate in the `agentTaskSessions` system
 * and benefit from robust session resume, instead of relying solely on the
 * simpler `agentRuntimeState.sessionId` fallback.
 */
const HEARTBEAT_TASK_KEY = "__heartbeat__";

/**
 * Extended task key derivation that falls back to a stable synthetic key
 * for timer/heartbeat wakes. The synthetic key keeps the
 * `agentTaskSessions` row addressable across heartbeats so the row can be
 * cleared and re-keyed deterministically. Unscoped exploratory timer wakes
 * still start fresh to avoid accumulating low-value inbox scans, while timer
 * wakes scoped to a real issue reuse that issue's task session.
 *
 * The synthetic key is only used when:
 * - No explicit task/issue key exists in the context
 * - The wake source is "timer" (scheduled heartbeat)
 */
export function deriveTaskKeyWithHeartbeatFallback(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const explicit = deriveTaskKey(contextSnapshot, payload);
  if (explicit) return explicit;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return HEARTBEAT_TASK_KEY;

  return null;
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON ||
    wakeReason === "execution_approval_requested" ||
    // PF-4: unscoped timer wakes are exploratory ("any new work?") and should
    // not accumulate low-value inbox scans. Issue-scoped timer wakes are
    // continuation work, so reuse their task session to avoid paying the full
    // session-start and re-orientation cost on every heartbeat.
    (wakeReason === "heartbeat_timer" && !deriveTaskKey(contextSnapshot, null))
  ) {
    return true;
  }
  return false;
}

export function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true)
    return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  if (wakeReason === EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON) {
    return `wake reason is ${EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON}`;
  }
  if (wakeReason === "execution_approval_requested")
    return "wake reason is execution_approval_requested";
  // PF-4: paired with shouldResetTaskSessionForWake — keep the reason wording
  // explicit so run logs make session reuse/reset behavior legible.
  if (
    wakeReason === "heartbeat_timer" &&
    !deriveTaskKey(contextSnapshot, null)
  ) {
    return "wake reason is heartbeat_timer (unscoped timer wake starts fresh)";
  }
  return null;
}

export function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString(
      (raw as Record<string, unknown> | null)?.sessionId,
    );
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

export function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

export function normalizeSessionParams(
  params: Record<string, unknown> | null | undefined,
) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

export type RunSessionOutcome =
  "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out";

const HERMES_ADAPTER_TYPE = "hermes_local";

const HERMES_SESSION_ID_REGEX =
  /^(?:\d{8}_\d{6}_[A-Za-z0-9_-]{4,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function requiresCanonicalSessionIds(adapterType: string | null | undefined) {
  return adapterType === HERMES_ADAPTER_TYPE;
}

export function isCanonicalSessionIdForAdapter(
  adapterType: string | null | undefined,
  sessionId: string | null | undefined,
) {
  if (!sessionId) return false;
  if (!requiresCanonicalSessionIds(adapterType)) return true;
  return HERMES_SESSION_ID_REGEX.test(sessionId);
}

export function normalizeResumeParamsForAdapter(
  adapterType: string | null | undefined,
  params: Record<string, unknown> | null | undefined,
) {
  const normalized = normalizeSessionParams(params);
  if (!normalized) return null;
  if (!requiresCanonicalSessionIds(adapterType)) return normalized;
  const sessionId = readNonEmptyString(normalized.sessionId);
  return isCanonicalSessionIdForAdapter(adapterType, sessionId)
    ? normalized
    : null;
}

export function resolveNextSessionState(input: {
  adapterType?: string | null;
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  outcome: RunSessionOutcome;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const {
    adapterType,
    codec,
    adapterResult,
    previousParams,
    previousDisplayId,
    previousLegacySessionId,
  } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  if (!requiresCanonicalSessionIds(adapterType)) {
    const explicitParams = adapterResult.sessionParams;
    const hasExplicitParams = adapterResult.sessionParams !== undefined;
    const hasExplicitSessionId = adapterResult.sessionId !== undefined;
    const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
    const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
    const explicitDisplayId = readNonEmptyString(
      adapterResult.sessionDisplayId,
    );
    const shouldUsePrevious =
      !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

    const candidateParams = hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? explicitSessionId
          ? { sessionId: explicitSessionId }
          : null
        : previousParams;

    const serialized = normalizeSessionParams(
      codec.serialize(normalizeSessionParams(candidateParams) ?? null),
    );
    const deserialized = normalizeSessionParams(codec.deserialize(serialized));

    const displayId = truncateDisplayId(
      explicitDisplayId ??
        (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
        readNonEmptyString(deserialized?.sessionId) ??
        (shouldUsePrevious ? previousDisplayId : null) ??
        explicitSessionId ??
        (shouldUsePrevious ? previousLegacySessionId : null),
    );

    const legacySessionId =
      explicitSessionId ??
      readNonEmptyString(deserialized?.sessionId) ??
      displayId ??
      (shouldUsePrevious ? previousLegacySessionId : null);

    return {
      params: serialized,
      displayId,
      legacySessionId,
    };
  }

  const previousSerializedParams = normalizeResumeParamsForAdapter(
    adapterType,
    codec.serialize(
      normalizeResumeParamsForAdapter(adapterType, previousParams),
    ),
  );
  const validPreviousDisplayId = isCanonicalSessionIdForAdapter(
    adapterType,
    previousDisplayId,
  )
    ? previousDisplayId
    : null;
  const validPreviousLegacySessionId = isCanonicalSessionIdForAdapter(
    adapterType,
    previousLegacySessionId,
  )
    ? previousLegacySessionId
    : null;
  const previousState = () => {
    const displayId = truncateDisplayId(
      readNonEmptyString(previousSerializedParams?.sessionId) ??
        validPreviousDisplayId ??
        validPreviousLegacySessionId,
    );
    return {
      params: previousSerializedParams,
      displayId,
      legacySessionId:
        readNonEmptyString(previousSerializedParams?.sessionId) ??
        displayId ??
        validPreviousLegacySessionId,
    };
  };

  if (input.outcome !== "succeeded") {
    return previousState();
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const validExplicitSessionId = isCanonicalSessionIdForAdapter(
    adapterType,
    explicitSessionId,
  )
    ? explicitSessionId
    : null;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const validExplicitDisplayId = isCanonicalSessionIdForAdapter(
    adapterType,
    explicitDisplayId,
  )
    ? explicitDisplayId
    : null;
  const explicitSerializedParams = hasExplicitParams
    ? normalizeResumeParamsForAdapter(
        adapterType,
        codec.serialize(normalizeSessionParams(explicitParams) ?? null),
      )
    : null;
  const explicitCanonicalSessionId =
    readNonEmptyString(explicitSerializedParams?.sessionId) ??
    validExplicitSessionId ??
    validExplicitDisplayId;

  if (!explicitCanonicalSessionId) {
    return previousState();
  }

  const serialized = normalizeResumeParamsForAdapter(
    adapterType,
    codec.serialize({ sessionId: explicitCanonicalSessionId }),
  );
  const displayId = truncateDisplayId(
    readNonEmptyString(serialized?.sessionId) ??
      (codec.getDisplayId ? codec.getDisplayId(serialized) : null) ??
      explicitCanonicalSessionId,
  );
  const legacySessionId =
    readNonEmptyString(serialized?.sessionId) ?? explicitCanonicalSessionId;

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Run retrieval and session persistence bound to one service database. */
export function createHeartbeatRunState(db: Db) {
  let unsafeTextProjectionPromise: Promise<boolean> | null = null;

  async function hasUnsafeTextProjectionDatabase() {
    if (!unsafeTextProjectionPromise) {
      unsafeTextProjectionPromise = db
        .execute(
          sql`select current_setting('server_encoding') as server_encoding`,
        )
        .then((rows) => {
          const first = Array.isArray(rows) ? rows[0] : null;
          const serverEncoding =
            typeof first === "object" && first !== null
              ? (first as Record<string, unknown>).server_encoding
              : null;
          return (
            typeof serverEncoding === "string" &&
            serverEncoding.toUpperCase() === "SQL_ASCII"
          );
        })
        .catch((err) => {
          logger.warn(
            { err },
            "failed to inspect database server encoding; using conservative heartbeat result projection",
          );
          return true;
        });
    }
    return unsafeTextProjectionPromise;
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(
    runId: string,
    opts?: { unsafeFullResultJson?: boolean; includeExecutionEvidence?: boolean },
  ) {
    const safeForLegacyEncoding =
      !opts?.unsafeFullResultJson && (await hasUnsafeTextProjectionDatabase());
    const columns = opts?.unsafeFullResultJson
      ? getTableColumns(heartbeatRuns)
      : safeForLegacyEncoding ? heartbeatRunSqlAsciiSafeColumns : heartbeatRunSafeColumns;
    return db
      .select(opts?.includeExecutionEvidence
        ? { ...columns, resultJson: heartbeatRunExecutionEvidenceColumn }
        : columns)
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRunLogAccess(runId: string) {
    return db
      .select(heartbeatRunLogAccessColumns)
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestAgentConfigRevision(
    companyId: string,
    agentId: string,
  ) {
    return db
      .select({
        id: agentConfigRevisions.id,
        changedKeys: agentConfigRevisions.changedKeys,
        createdAt: agentConfigRevisions.createdAt,
      })
      .from(agentConfigRevisions)
      .where(
        and(
          eq(agentConfigRevisions.companyId, companyId),
          eq(agentConfigRevisions.agentId, agentId),
        ),
      )
      .orderBy(
        desc(agentConfigRevisions.createdAt),
        desc(agentConfigRevisions.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select({
        id: heartbeatRuns.id,
        usageJson: heartbeatRuns.usageJson,
      })
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.sessionIdAfter, sessionId),
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
    usageBasis?: "per_run" | "session_cumulative" | null;
  }) {
    const { agentId, runId, sessionId, rawUsage, usageBasis } = input;
    // Adapters that declare per-run usage (e.g. the ACPX lane reports each
    // turn's tokens, not session totals) must not be session-delta'd, or
    // consecutive runs would be undercounted.
    if (!sessionId || !rawUsage || usageBasis !== "session_cumulative") {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, {
      excludeRunId: runId,
    });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    return {
      normalizedUsage: normalizeAdapterRunUsage(rawUsage, previousRawUsage, usageBasis),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
    continuationSummaryBody?: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(
      policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0,
      4,
    );
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        error: heartbeatRuns.error,
        terminalFailureCategory: sql<string | null>`case
          when jsonb_typeof(${heartbeatRuns.resultJson} -> 'terminalSessionFailure') = 'object'
          then coalesce(left(${heartbeatRuns.resultJson} #>> '{terminalSessionFailure,category}', 32), 'unknown') end`,
        ...heartbeatRunListResultColumns,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agent.id),
          eq(heartbeatRuns.sessionIdAfter, sessionId),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : (runs[runs.length - 1] ?? latestRun);
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    // Historical Codex/Gemini raw input includes cache reads. Only add the
    // separate cache counter when the writer explicitly saved exclusive input.
    const latestRawInputTokens = (latestRawUsage?.inputTokens ?? 0) +
      (latestRun?.usageJson?.rawInputIncludesCached === false ? latestRawUsage?.cachedInputTokens ?? 0 : 0);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() -
              new Date(oldestRun.createdAt).getTime()) /
              (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawInputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawInputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (
      policy.maxSessionAgeHours > 0 &&
      sessionAgeHours >= policy.maxSessionAgeHours
    ) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunListResultJson({
      summary: latestRun?.resultSummary,
      result: latestRun?.resultResult,
      message: latestRun?.resultMessage,
      error: latestRun?.resultError,
      totalCostUsd: latestRun?.resultTotalCostUsd,
      costUsd: latestRun?.resultCostUsd,
      costUsdCamel: latestRun?.resultCostUsdCamel,
    });
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(summarizeRunErrorForModel(latestRun.error, latestRun.terminalFailureCategory));

    const handoffMarkdown = [
      "Paperclip session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      input.continuationSummaryBody
        ? `- Issue continuation summary: ${input.continuationSummaryBody.slice(0, 1_500)}`
        : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function hasResolvableSessionWorkspaceCwd(
    sessionParams: Record<string, unknown> | null | undefined,
  ) {
    const cwd = readNonEmptyString(sessionParams?.cwd);
    if (!cwd || isUnsafeSessionWorkspaceCwd(cwd)) return false;
    return fs
      .stat(cwd)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
  }

  async function hasResolvablePriorSessionWorkspaceForWake(input: {
    agent: typeof agents.$inferSelect;
    contextSnapshot: Record<string, unknown>;
    taskKey: string | null;
    explicitResumeSession: Awaited<
      ReturnType<typeof resolveExplicitResumeSessionOverride>
    > | null;
  }) {
    if (
      await hasResolvableSessionWorkspaceCwd(
        input.explicitResumeSession?.sessionParams,
      )
    )
      return true;
    if (shouldResetTaskSessionForWake(input.contextSnapshot)) return false;
    if (!input.taskKey) return false;

    const codec = getAdapterSessionCodec(input.agent.adapterType);
    const taskSession = await getTaskSession(
      input.agent.companyId,
      input.agent.id,
      input.agent.adapterType,
      input.taskKey,
    );
    const taskSessionParams = normalizeResumeParamsForAdapter(
      input.agent.adapterType,
      codec.deserialize(taskSession?.sessionParamsJson ?? null),
    );
    return hasResolvableSessionWorkspaceCwd(taskSessionParams);
  }

  async function resolveExplicitResumeSessionOverride(
    agent: typeof agents.$inferSelect,
    payload: Record<string, unknown> | null,
    taskKey: string | null,
  ) {
    const resumeFromRunId = readNonEmptyString(payload?.resumeFromRunId);
    if (!resumeFromRunId) return null;

    const resumeRun = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        resultJson: heartbeatRuns.resultJson,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, resumeFromRunId),
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!resumeRun) return null;

    const resumeContext = parseObject(resumeRun.contextSnapshot);
    const resumeTaskKey = deriveTaskKey(resumeContext, null) ?? taskKey;
    const resumeTaskSession = resumeTaskKey
      ? await getTaskSession(
          agent.companyId,
          agent.id,
          agent.adapterType,
          resumeTaskKey,
        )
      : null;
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const resumeRunResult = parseObject(resumeRun.resultJson);
    const resumeRunSessionId = requiresCanonicalSessionIds(agent.adapterType)
      ? (readNonEmptyString(resumeRunResult.sessionId) ??
        readNonEmptyString(resumeRunResult.session_id))
      : null;
    const sessionOverride = buildExplicitResumeSessionOverride({
      adapterType: agent.adapterType,
      resumeFromRunId,
      resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
      resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
      resumeRunSessionParams: resumeRunSessionId
        ? { sessionId: resumeRunSessionId }
        : null,
      taskSession: resumeTaskSession,
      sessionCodec,
    });
    if (!sessionOverride) return null;

    return {
      resumeFromRunId,
      taskKey: resumeTaskKey,
      issueId: readNonEmptyString(resumeContext.issueId),
      taskId:
        readNonEmptyString(resumeContext.taskId) ??
        readNonEmptyString(resumeContext.issueId),
      sessionDisplayId: sessionOverride.sessionDisplayId,
      sessionParams: sessionOverride.sessionParams,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    return db.transaction(async (tx) => {
      const [issue] = await tx.select().from(issues).where(and(sql`${issues.id}::text = ${input.taskKey}`, eq(issues.companyId, input.companyId))).for("update");
      if (isConversation(issue)) {
        const [run] = input.lastRunId ? await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.lastRunId)) : [];
        if (run?.status === "cancelled" || run?.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration) return null;
      }
    const existing = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId), eq(agentTaskSessions.adapterType, input.adapterType), eq(agentTaskSessions.taskKey, input.taskKey))).then((rows) => rows[0] ?? null);
    if (existing) {
      return tx
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return tx
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    });
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: {
      taskKey?: string | null;
      adapterType?: string | null;
      expectedRunId?: string;
      includeIssueAliases?: boolean;
    },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      const exactTaskKey = eq(agentTaskSessions.taskKey, opts.taskKey);
      if (opts.includeIssueAliases) {
        const selectedIssue = isUuidLike(opts.taskKey)
          ? eq(issues.id, opts.taskKey)
          : eq(issues.identifier, opts.taskKey.toUpperCase());
        // Operator task resets accept the UUID sent by run detail and the
        // identifier used by some saved sessions. Resolve only from the current
        // same-company issue row, in this DELETE's snapshot; arbitrary custom
        // keys retain exact-match behavior and run/model context grants no alias.
        conditions.push(
          or(
            exactTaskKey,
            sql`exists (
              select 1 from ${issues}
              where ${issues.companyId} = ${companyId}
                and ${selectedIssue}
                and (${agentTaskSessions.taskKey} = ${issues.id}::text
                  or ${agentTaskSessions.taskKey} = ${issues.identifier})
            )`,
          )!,
        );
      } else {
        conditions.push(exactTaskKey);
      }
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db.transaction(async (tx) => {
      if (opts?.taskKey && opts.expectedRunId) {
        const [issue] = await tx.select().from(issues).where(sql`${issues.id}::text = ${opts.taskKey}`).for("update");
        if (isConversation(issue)) {
          const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, opts.expectedRunId));
          if (run?.status === "cancelled" || run?.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration) return 0;
        }
      }
      return tx.delete(agentTaskSessions).where(and(...conditions)).returning().then((rows) => rows.length);
    });
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    const inserted = await db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .onConflictDoNothing({
        target: agentRuntimeState.agentId,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (inserted) return inserted;

    const ensured = await getRuntimeState(agent.id);
    if (!ensured) {
      throw new Error(`Failed to ensure runtime state for agent ${agent.id}`);
    }
    return ensured;
  }

  return {
    getAgent,
    resolveSessionBeforeForWakeup,
    getRun,
    ensureRuntimeState,
    getTaskSession,
    getLatestAgentConfigRevision,
    evaluateSessionCompaction,
    upsertTaskSession,
    resolveNormalizedUsageForSession,
    clearTaskSessions,
    resolveExplicitResumeSessionOverride,
    hasResolvablePriorSessionWorkspaceForWake,
    getRunLogAccess,

    listRuns: async (
      companyId: string,
      agentId?: string,
      limit?: number,
      options: { summary?: boolean; offset?: number } = {},
    ) => {
      const safeForLegacyEncoding = await hasUnsafeTextProjectionDatabase();
      const summary = options.summary === true;
      const offset =
        typeof options.offset === "number" &&
        Number.isFinite(options.offset) &&
        options.offset > 0
          ? Math.floor(options.offset)
          : 0;
      const rows = await retryIdempotentDatabaseOperation(async () => {
        const query = db
          .select(
            summary
              ? {
                  ...heartbeatRunSummaryListColumns,
                  ...heartbeatRunListContextColumns,
                }
              : safeForLegacyEncoding
                ? {
                    ...heartbeatRunListColumns,
                    error: sql<string | null>`NULL`.as("error"),
                    ...heartbeatRunListContextColumns,
                  }
                : {
                    ...heartbeatRunListColumns,
                    ...heartbeatRunListContextColumns,
                    ...heartbeatRunListResultColumns,
                  },
          )
          .from(heartbeatRuns)
          .where(
            agentId
              ? and(
                  eq(heartbeatRuns.companyId, companyId),
                  eq(heartbeatRuns.agentId, agentId),
                )
              : eq(heartbeatRuns.companyId, companyId),
          )
          // The id tiebreak keeps page boundaries stable when runs share a
          // createdAt timestamp, so offset paging cannot repeat or skip rows.
          .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));

        const limited = limit ? query.limit(limit) : query;
        return offset ? await limited.offset(offset) : await limited;
      });
      return rows.map((row) => {
        const {
          contextIssueId,
          contextTaskId,
          contextTaskKey,
          contextCommentId,
          contextWakeCommentId,
          contextWakeReason,
          contextWakeSource,
          contextWakeTriggerDetail,
          resultSummary,
          resultResult,
          resultMessage,
          resultError,
          resultTotalCostUsd,
          resultCostUsd,
          resultCostUsdCamel,
          ...rest
        } = row as typeof row & {
          resultSummary?: string | null;
          resultResult?: string | null;
          resultMessage?: string | null;
          resultError?: string | null;
          resultTotalCostUsd?: string | null;
          resultCostUsd?: string | null;
          resultCostUsdCamel?: string | null;
        };

        return {
          ...rest,
          contextSnapshot: summarizeHeartbeatRunContextSnapshot({
            issueId: contextIssueId,
            taskId: contextTaskId,
            taskKey: contextTaskKey,
            commentId: contextCommentId,
            wakeCommentId: contextWakeCommentId,
            wakeReason: contextWakeReason,
            wakeSource: contextWakeSource,
            wakeTriggerDetail: contextWakeTriggerDetail,
          }),
          resultJson:
            safeForLegacyEncoding || summary
              ? null
              : summarizeHeartbeatRunListResultJson({
                  summary: resultSummary,
                  result: resultResult,
                  message: resultMessage,
                  error: resultError,
                  totalCostUsd: resultTotalCostUsd,
                  costUsd: resultCostUsd,
                  costUsdCamel: resultCostUsdCamel,
                }),
        };
      });
    },

    getRuntimeStateWithSessions: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, agent.companyId),
            eq(agentTaskSessions.agentId, agent.id),
          ),
        )
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId:
          latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, agent.companyId),
            eq(agentTaskSessions.agentId, agentId),
          ),
        )
        .orderBy(
          desc(agentTaskSessions.updatedAt),
          desc(agentTaskSessions.createdAt),
        );
    },

    resetRuntimeSession: async (
      agentId: string,
      opts?: { taskKey?: string | null },
    ) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey
          ? {
              taskKey,
              adapterType: agent.adapterType,
              includeIssueAliases: true,
            }
          : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, runId),
            gt(heartbeatRunEvents.seq, afterSeq),
          ),
        )
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    getRetryExhaustedReason: async (runId: string) => {
      const row = await db
        .select({
          message: heartbeatRunEvents.message,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, runId),
            eq(heartbeatRunEvents.eventType, "lifecycle"),
            sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
          ),
        )
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row?.message ?? null;
    },

    getRunIssueSummary: async (runId: string) => {
      const [run] = await db
        .select(heartbeatRunIssueSummaryColumns)
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      return run ?? null;
    },

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },

    getActiveRunIssueSummaryForAgent: async (agentId: string) => {
      const [run] = await db
        .select(heartbeatRunIssueSummaryColumns)
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
