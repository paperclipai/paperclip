import { and, asc, desc, eq, gt, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
  ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  approvals,
  activityLog,
  companies,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../local-service-supervisor.js";
import { redactSensitiveText } from "../../redaction.js";
import { isUniqueViolation } from "../../db-errors.js";
import { logActivity } from "../activity-log.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { budgetService } from "../budgets.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { TERMINAL_HEARTBEAT_RUN_STATUSES, issueService } from "../issues.js";
import {
  applyIssueMonitorPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../issue-execution-policy.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "../issue-dependency-wakeups.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  isPluginManagedIssueLifecycle,
  noticeMetadataReferencesRecoveryAction,
  type SuccessfulRunHandoffNotice,
} from "./successful-run-handoff.js";
import {
  buildExecutionReviewParticipantRecoveryNoticeSeed,
  buildExecutionReviewParticipantUnavailableNoticeSeed,
  buildStrandedRecoveryEscalationNotice,
  type StrandedRecoveryNoticeSeed,
} from "./stranded-notice.js";
import {
  RECOVERY_ORIGIN_KINDS,
  isStrandedIssueRecoveryOriginKind,
} from "./origins.js";
import { withRecoveryContext } from "./status-only-context.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
import {
  collectDispositionRepairSourceState,
  dispositionRepairDelayMs,
  DISPOSITION_REPAIR_MAX_ATTEMPTS,
} from "./disposition-repair.js";

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["interrupted", "failed", "cancelled", "timed_out"] as const;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON = "execution_review_participant_recovery";
const STRANDED_BOARD_ESCALATION_POLICY = "board_escalation_no_takeover_v1";
const DISPOSITION_REPAIR_IDEMPOTENCY_INDEX = "agent_wakeup_requests_disposition_repair_idempotency_uq";
const RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT = 500;
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

// GGU-809: when a stranded `in_progress` issue would otherwise hit the
// `isRepeatedProductiveContinuationRecovery` escalation path, exempt the
// escalation if the assignee posted a comment or attachment within this window.
// Batch workflows (e.g. Image Spec multi-frame generation) make real progress
// every heartbeat and would otherwise trigger a recovery issue after just two
// productive heartbeats. Floor the override at 60s to keep the exemption from
// being effectively disabled by misconfiguration.
export const STRANDED_RECENT_PROGRESS_EXEMPTION_MS = Math.max(
  60_000,
  Number(process.env.STRANDED_RECENT_PROGRESS_EXEMPTION_MS) || 30 * 60 * 1000,
);

type RecoveryWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type RecoveryWakeup = (
  agentId: string,
  opts?: RecoveryWakeupOptions,
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type ResolvedDependencyWakeBackstopSource =
  | "issue_graph_liveness.backstop"
  | "workspace.finalize";

type ResolvedDependencyWakeBackstopOptions = {
  runId?: string | null;
  companyId?: string | null;
  blockerIssueId?: string | null;
  source?: ResolvedDependencyWakeBackstopSource;
};

type LatestIssueRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "agentId"
  | "status"
  | "error"
  | "errorCode"
  | "contextSnapshot"
  | "livenessState"
  | "startedAt"
  | "createdAt"
> & {
  resultJson?: unknown;
} | null;
type SuccessfulLatestIssueRun = NonNullable<LatestIssueRun> & { status: "succeeded" };

export type StrandedRecoveryCause =
  | "stranded_assigned_issue"
  | "deliberate_wait_without_target"
  | "process_lost"
  | "provider_quota"
  | "codex_output_inactivity_monitor"
  | "workspace_validation_failed"
  | "configuration_incomplete"
  | "native_session_interrupted"
  | "native_runner_process_exited"
  | "provider_transport_failed"
  | "provider_frame_too_large"
  | "execution_review_participant_recovery"
  | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;

const NATIVE_RUNNER_RECOVERY_CAUSES = new Set<StrandedRecoveryCause>([
  "native_session_interrupted",
  "native_runner_process_exited",
  "provider_transport_failed",
  "provider_frame_too_large",
]);

export function shouldRouteRecoveryToOriginalAgent(cause: StrandedRecoveryCause): boolean {
  return cause === "process_lost"
    || cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
    || cause === "codex_output_inactivity_monitor"
    || NATIVE_RUNNER_RECOVERY_CAUSES.has(cause);
}

type StrandedPreviousStatus = "todo" | "in_progress" | "in_review";

type SuccessfulRunHandoffRecoveryEvidence = {
  sourceRunId: string | null;
  correctiveRunId: string;
  missingDisposition: string;
  handoffAttempt: number;
  maxHandoffAttempts: number;
};

function compactRecoveryPresentation(title: string): IssueCommentPresentation {
  const normalizedTitle = title.trim();
  return {
    kind: "system_notice",
    tone: "warning",
    title: normalizedTitle.length > 160 ? `${normalizedTitle.slice(0, 159)}…` : normalizedTitle,
    detailsDefaultOpen: false,
    density: "compact",
  };
}

function recoveryCauseTitle(cause: StrandedRecoveryCause) {
  switch (cause) {
    case "process_lost":
      return "retries exhausted";
    case "codex_output_inactivity_monitor":
      return "output-inactivity retry exhausted";
    case "workspace_validation_failed":
      return "workspace validation failed";
    case "configuration_incomplete":
      return "configuration incomplete";
    case "execution_review_participant_recovery":
      return "reviewer recovery failed";
    case "provider_quota":
      return "provider quota unavailable";
    case SUCCESSFUL_RUN_MISSING_STATE_REASON:
      return "missing disposition recovery failed";
    default:
      return "execution path recovery failed";
  }
}

function recoveryNoticeMetadata(input: {
  cause: string;
  latestRun: LatestIssueRun;
  recoveryActionId?: string | null;
  previousStatus: string;
  recoveryOwner?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
}): IssueCommentMetadata {
  const rows: IssueCommentMetadata["sections"][number]["rows"] = [
    ...(input.recoveryActionId
      ? [{ type: "key_value" as const, label: "Recovery action", value: input.recoveryActionId }]
      : []),
    { type: "key_value", label: "Cause", value: input.cause },
    { type: "key_value", label: "Previous status", value: input.previousStatus },
    ...(input.recoveryOwner
      ? [{
          type: "agent_link" as const,
          label: "Recovery owner",
          agentId: input.recoveryOwner.id,
          name: input.recoveryOwner.name.slice(0, 160),
        }]
      : [{ type: "key_value" as const, label: "Recovery owner", value: "board" }]),
    ...(input.latestRun
      ? [{
          type: "run_link" as const,
          label: "Latest run",
          runId: input.latestRun.id,
          title: input.latestRun.status,
        }]
      : []),
  ];

  return {
    version: 1,
    sourceRunId: input.latestRun?.id ?? null,
    sections: [{ title: "Recovery", rows }],
  };
}

function readRecoveryRunErrorFamily(latestRun: LatestIssueRun) {
  const result = parseObject(latestRun?.resultJson);
  return readNonEmptyString(result.errorFamily);
}

function isProviderQuotaRecovery(latestRun: LatestIssueRun) {
  if (latestRun?.errorCode === "provider_quota") return true;
  if (readRecoveryRunErrorFamily(latestRun) === "provider_quota") return true;
  if (latestRun?.errorCode !== "adapter_failed") return false;
  return /(?:usage|rate|quota) limit|you(?:'|’)ve hit your (?:\w+ )?limit|quota (?:exceeded|reset)|try again after/i.test(latestRun.error ?? "");
}

function resolveStrandedRecoveryCause(
  latestRun: LatestIssueRun,
  explicitCause?: StrandedRecoveryCause,
): StrandedRecoveryCause {
  if (explicitCause) return explicitCause;
  if (isProviderQuotaRecovery(latestRun)) return "provider_quota";
  if (latestRun?.errorCode === "process_lost") return "process_lost";
  if (latestRun?.errorCode === "codex_output_inactivity_monitor") {
    return "codex_output_inactivity_monitor";
  }
  if (NATIVE_RUNNER_RECOVERY_CAUSES.has(latestRun?.errorCode as StrandedRecoveryCause)) {
    return latestRun!.errorCode as StrandedRecoveryCause;
  }
  return "stranded_assigned_issue";
}

function readWorkspaceValidationPayload(latestRun: LatestIssueRun): Record<string, unknown> | null {
  const payload = parseObject(parseObject(latestRun?.resultJson).workspaceValidation);
  return Object.keys(payload).length > 0 ? payload : null;
}

function readWorkspaceValidationFingerprint(latestRun: LatestIssueRun): string | null {
  const payload = readWorkspaceValidationPayload(latestRun);
  return readNonEmptyString(payload?.fingerprint);
}

function readConfigurationIncompleteFingerprint(latestRun: LatestIssueRun): string | null {
  const payload = parseObject(parseObject(latestRun?.resultJson).configurationIncomplete);
  return readNonEmptyString(payload?.fingerprint);
}

type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeRunFailureForIssueComment(run: LatestIssueRun) {
  if (!run) return null;

  if (readNonEmptyString(run.error) || readNonEmptyString(run.errorCode)) {
    return " Latest retry failure details were withheld from the issue thread; inspect the linked run for evidence.";
  }
  return null;
}


function didAutomaticRecoveryFail(
  latestRun: LatestIssueRun,
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
}

function isTerminalIssueRun(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  return TERMINAL_HEARTBEAT_RUN_STATUSES.has(latestRun.status);
}

const TRANSIENT_INFRA_CONTINUATION_ERROR_CODES = new Set<string>([
  "adapter_failed",
  "codex_transient_upstream",
  "codex_harness_crash",
  "claude_transient_upstream",
  "provider_quota",
  "timeout",
]);

const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set<string>([
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
]);

// A continuation cancelled with this code is a *deliberate wait* (the latest run
// reported it was parked for review/approval), not a lost execution path. When the
// issue has a real waiting target we convert it into a normal dependency wait rather
// than escalating it as stranded.
const CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE = "issue_continuation_waiting_on_review";
const INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS = 3;

const CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3;
const CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS = 1;
const CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS = 60_000;
export const PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

const PROVIDER_QUOTA_ERROR_RE =
  /(?:you(?:'|’)ve hit your (?:\w+ )?limit|usage limit(?: reached| exceeded)?|provider quota|quota (?:limit )?exceeded|model (?:is )?at capacity)/i;
const CONFIGURATION_INCOMPLETE_ERROR_RE =
  /(?:model_not_found|model [^\n]{0,120} not found|missing (?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing|no (?:api )?(?:key|credentials?) (?:was |were )?(?:found|configured|provided)|api key (?:is )?(?:not set|unavailable))/i;

export type AdapterFailureRecoveryClassification =
  | { kind: "provider_quota"; retryAt: Date; parsedResetTime: boolean }
  | { kind: "configuration_incomplete" }
  | null;

function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(
    /(?:try again at|resets?(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i,
  );
  if (!match) return null;

  const hourValue = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[4] ?? match[5])?.trim();
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  try {
    const wallClock = (date: Date) => Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(date).map((part) => [part.type, part.value]),
    );
    const nowParts = wallClock(now);
    const buildRetryAt = (dayOffset: number) => {
      const targetDay = new Date(Date.UTC(
        Number(nowParts.year),
        Number(nowParts.month) - 1,
        Number(nowParts.day) + dayOffset,
        hour,
        minute,
      ));
      let candidate = targetDay;
      const targetMs = targetDay.getTime();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = targetMs - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}

export function classifyAdapterFailureForRecovery(
  latestRun: Pick<NonNullable<LatestIssueRun>, "error" | "errorCode" | "resultJson">,
  now = new Date(),
): AdapterFailureRecoveryClassification {
  if (
    latestRun.errorCode !== "adapter_failed" &&
    latestRun.errorCode !== "provider_quota" &&
    latestRun.errorCode !== "configuration_incomplete"
  ) {
    return null;
  }
  const resultJson = parseObject(latestRun.resultJson);
  const error = [latestRun.errorCode ?? "", latestRun.error ?? "", JSON.stringify(resultJson)].join("\n");
  if (latestRun.errorCode === "configuration_incomplete" || CONFIGURATION_INCOMPLETE_ERROR_RE.test(error)) {
    return { kind: "configuration_incomplete" };
  }
  if (latestRun.errorCode !== "provider_quota" && !PROVIDER_QUOTA_ERROR_RE.test(error)) return null;

  const persistedRetryAt = readNonEmptyString(resultJson.retryNotBefore) ??
    readNonEmptyString(resultJson.transientRetryNotBefore) ??
    readNonEmptyString(resultJson.providerQuotaRetryNotBefore);
  const parsedPersistedRetryAt = persistedRetryAt ? new Date(persistedRetryAt) : null;
  if (parsedPersistedRetryAt && !Number.isNaN(parsedPersistedRetryAt.getTime()) && parsedPersistedRetryAt > now) {
    return { kind: "provider_quota", retryAt: parsedPersistedRetryAt, parsedResetTime: true };
  }

  const parsedClockReset = parseProviderQuotaClockReset(error, now);
  if (parsedClockReset) {
    return { kind: "provider_quota", retryAt: parsedClockReset, parsedResetTime: true };
  }
  return {
    kind: "provider_quota",
    retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
    parsedResetTime: false,
  };
}

type ContinuationRetryClassification = {
  kind: "transient_infra" | "non_retryable" | "deliberate_wait_without_target" | "default";
  maxAttempts: number;
  baseBackoffMs: number;
  errorCode: string | null;
};

export function classifyContinuationFailure(latestRun: LatestIssueRun): ContinuationRetryClassification {
  const errorCode = readNonEmptyString(latestRun?.errorCode);
  if (errorCode === CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE) {
    return {
      kind: "deliberate_wait_without_target",
      maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  if (errorCode && NON_RETRYABLE_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return { kind: "non_retryable", maxAttempts: 0, baseBackoffMs: 0, errorCode };
  }
  if (errorCode && TRANSIENT_INFRA_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return {
      kind: "transient_infra",
      maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  return {
    kind: "default",
    maxAttempts: CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs: 0,
    errorCode,
  };
}

function successfulRunHandoffRecoveryEvidence(latestRun: LatestIssueRun): SuccessfulRunHandoffRecoveryEvidence | null {
  if (!latestRun) return null;

  const context = parseObject(latestRun.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const handoffReason = readNonEmptyString(context.handoffReason);
  const isSuccessfulRunHandoff =
    wakeReason === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON ||
    handoffReason === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
    asBoolean(context.handoffRequired, false) === true;
  if (!isSuccessfulRunHandoff) return null;

  const handoffAttempt = asNumber(context.handoffAttempt, 1);
  const maxHandoffAttempts = asNumber(
    context.maxHandoffAttempts,
    DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  );
  return {
    sourceRunId: readNonEmptyString(context.sourceRunId) ?? readNonEmptyString(context.resumeFromRunId),
    correctiveRunId: latestRun.id,
    missingDisposition: readNonEmptyString(context.missingDisposition) ?? "clear_next_step",
    handoffAttempt,
    maxHandoffAttempts,
  };
}

function isExhaustedSuccessfulRunHandoff(latestRun: LatestIssueRun) {
  const evidence = successfulRunHandoffRecoveryEvidence(latestRun);
  if (!evidence) return null;
  if (evidence.handoffAttempt < evidence.maxHandoffAttempts) return { ...evidence, exhausted: false };
  return { ...evidence, exhausted: true };
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(nestedContext.issueId) ??
    readNonEmptyString(nestedContext.taskId);
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function agentUiLink(agent: { id: string; name: string | null } | null, prefix: string) {
  if (!agent) return "unknown";
  return `[${agent.name ?? agent.id}](/${prefix}/agents/${agent.id})`;
}

function formatIssueLinksForComment(relations: Array<{ identifier?: string | null }>) {
  const identifiers = [
    ...new Set(
      relations
        .map((relation) => relation.identifier)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  if (identifiers.length === 0) return "another open issue";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/issues/${identifier})`;
    })
    .join(", ");
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
}

/**
 * True when the issue's latest run was cancelled by a board operator (the
 * board cancel route stamps the attribution; interrupt-by-comment uses the
 * operator_interrupted error code). While such a run is the latest activity
 * on an issue, recovery stands down entirely: the operator deliberately
 * stopped the agent, and re-waking it — or escalating "stranding" — would
 * fight the human. Any newer run or wake supersedes the exemption.
 */
function isOperatorCancelledRun(latestRun: LatestIssueRun): boolean {
  if (!latestRun || latestRun.status !== "cancelled") return false;
  if (latestRun.errorCode === "operator_interrupted") return true;
  const result = parseObject(latestRun.resultJson);
  return result.cancelledByActorType === "user" || result.cancelledByActorType === "board";
}

function isUnsuccessfulTerminalIssueRun(latestRun: LatestIssueRun) {
  return Boolean(
    latestRun &&
      UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
        latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
      ),
  );
}

function isSuccessfulInProgressContinuationRun(latestRun: LatestIssueRun): latestRun is SuccessfulLatestIssueRun {
  return latestRun?.status === "succeeded";
}

function isProductiveContinuationRun(latestRun: LatestIssueRun) {
  return latestRun?.status === "succeeded" &&
    (latestRun.livenessState === "advanced" ||
      latestRun.livenessState === "completed" ||
      latestRun.livenessState === "blocked" ||
      latestRun.livenessState === "needs_followup");
}

function isRepeatedProductiveContinuationRecovery(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed" &&
    readNonEmptyString(latestContext.source) === "issue.productive_terminal_continuation_recovery" &&
    isProductiveContinuationRun(latestRun);
}

export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  let resolvedDependencyWakeBackstopCandidateCursor: string | null = null;

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
    return (await evaluateAgentInvokabilityFromDb(db, agent)).invokable;
  }

  async function getLatestIssueRun(companyId: string, issueId: string): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestIssueRunForAgent(
    companyId: string,
    issueId: string,
    agentId: string,
  ): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function summarizeRecentContinuationRetries(
    companyId: string,
    issueId: string,
    agentId: string,
    errorCodeToMatch: string | null,
    since: Date | null = null,
  ) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ...(since ? [or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since))] : []),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(10);

    let consecutive = 0;
    let latestFinishedAt: Date | null = null;
    for (const row of rows) {
      const ctx = parseObject(row.contextSnapshot);
      const retryReason = readNonEmptyString(ctx.retryReason);
      if (retryReason !== "issue_continuation_needed") break;
      if (
        !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
          row.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
        )
      ) {
        break;
      }

      const rowErrorCode = readNonEmptyString(row.errorCode);
      if (errorCodeToMatch !== rowErrorCode) {
        break;
      }

      consecutive += 1;
      if (latestFinishedAt === null) latestFinishedAt = row.finishedAt ?? null;
    }
    return { consecutive, latestFinishedAt };
  }

  async function hasActiveExecutionPath(companyId: string, issueId: string, agentId?: string | null) {
    const [run, deferredWake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            agentId ? eq(heartbeatRuns.agentId, agentId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
            agentId ? eq(agentWakeupRequests.agentId, agentId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return Boolean(run || deferredWake);
  }

  async function hasPendingWakeInteraction(companyId: string, issueId: string) {
    return db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
          inArray(issueThreadInteractions.continuationPolicy, ["wake_assignee", "wake_assignee_on_accept"]),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasPersistedDurableWaitPath(issue: typeof issues.$inferSelect) {
    if (issue.monitorNextCheckAt) return true;

    return db
      .select({ id: issueRelations.issueId })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, issue.companyId),
          eq(issueRelations.relatedIssueId, issue.id),
          eq(issueRelations.type, "blocks"),
          eq(issues.companyId, issue.companyId),
          notInArray(issues.status, ["done", "cancelled"]),
          isNull(issues.hiddenAt),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function wasTodoHandedBackDuringOrAfterLatestRun(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun,
  ) {
    if (issue.status !== "todo" || latestRun?.status !== "succeeded") return false;
    const runBeganAt = latestRun.startedAt ?? latestRun.createdAt;

    return db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, issue.companyId),
          eq(issueRecoveryActions.sourceIssueId, issue.id),
          eq(issueRecoveryActions.status, "resolved"),
          eq(issueRecoveryActions.outcome, "handed_back"),
          gte(issueRecoveryActions.resolvedAt, runBeganAt),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasQueuedIssueWake(companyId: string, issueId: string, agentId?: string | null) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
          agentId ? eq(agentWakeupRequests.agentId, agentId) : sql`true`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function getLatestAcceptedContinuationInteraction(companyId: string, issueId: string) {
    return db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        continuationPolicy: issueThreadInteractions.continuationPolicy,
        sourceRunId: issueThreadInteractions.sourceRunId,
        resolvedAt: issueThreadInteractions.resolvedAt,
        updatedAt: issueThreadInteractions.updatedAt,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          inArray(issueThreadInteractions.status, ["accepted", "answered"]),
          inArray(issueThreadInteractions.continuationPolicy, ["wake_assignee", "wake_assignee_on_accept"]),
        ),
      )
      .orderBy(desc(sql`coalesce(${issueThreadInteractions.resolvedAt}, ${issueThreadInteractions.updatedAt})`), desc(issueThreadInteractions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasSuccessfulIssueRunSince(
    companyId: string,
    issueId: string,
    agentId: string,
    since: Date,
    interactionId?: string | null,
  ) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "succeeded"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          interactionId
            ? sql`${heartbeatRuns.contextSnapshot} ->> 'interactionId' = ${interactionId}`
            : sql`true`,
          or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since)),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function getLatestIssueRunSince(companyId: string, issueId: string, agentId: string, since: Date): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since)),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // GGU-809: visible-progress signal for stranded-recovery escalation guard.
  // Returns true if the assignee posted a comment, OR any attachment was added
  // to the issue, within `windowMs`. Used to suppress false-positive recovery
  // issues for batch workflows that genuinely advance every heartbeat.
  async function hasRecentVisibleProgress(
    companyId: string,
    issueId: string,
    assigneeAgentId: string,
    windowMs: number,
  ) {
    const since = new Date(Date.now() - windowMs);
    const [comment, attachment] = await Promise.all([
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            eq(issueComments.authorAgentId, assigneeAgentId),
            gt(issueComments.createdAt, since),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .where(
          and(
            eq(issueAttachments.companyId, companyId),
            eq(issueAttachments.issueId, issueId),
            gt(issueAttachments.createdAt, since),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(comment || attachment);
  }

  async function enqueueStrandedIssueRecovery(input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON;
    retryReason: "assignment_recovery" | "issue_continuation_needed" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON;
    source: string;
    retryOfRunId?: string | null;
    extraContext?: Record<string, unknown>;
  }) {
    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: withRecoveryContext({
        issueId: input.issueId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(input.extraContext ?? {}),
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryContext({
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(input.extraContext ?? {}),
      }, "normal_model"),
    });

    if (queued && input.retryOfRunId) {
      return db
        .update(heartbeatRuns)
        .set({
          retryOfRunId: input.retryOfRunId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, queued.id))
        .returning()
        .then((rows) => rows[0] ?? queued);
    }

    return queued;
  }

  async function enqueueInitialAssignedTodoDispatch(issue: typeof issues.$inferSelect, agentId: string) {
    return deps.enqueueWakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryContext({
        issueId: issue.id,
        mutation: "assigned_todo_liveness_dispatch",
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryContext({
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }, "normal_model"),
    });
  }

  async function isInvocationBudgetBlocked(issue: typeof issues.$inferSelect, agentId: string) {
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, agentId, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return Boolean(budgetBlock);
  }

  async function reconcileUnassignedBlockingIssues() {
    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issues.status, ["todo", "blocked"]),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          sql`${issues.createdByAgentId} is not null`,
          sql`exists (
            select 1
            from issues blocked_issue
            where blocked_issue.id = ${issueRelations.relatedIssueId}
              and blocked_issue.company_id = ${issues.companyId}
              and blocked_issue.status not in ('done', 'cancelled')
          )`,
        ),
      );

    let assigned = 0;
    let skipped = 0;
    const issueIds: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const creatorAgentId = candidate.createdByAgentId;
      if (!creatorAgentId) {
        skipped += 1;
        continue;
      }
      const creatorAgent = await getAgent(creatorAgentId);
      if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !(await isAgentInvokable(creatorAgent))) {
        skipped += 1;
        continue;
      }

      const relations = await issuesSvc.getRelationSummaries(candidate.id);
      const blockingLinks = formatIssueLinksForComment(relations.blocks);
      const updated = await issuesSvc.update(candidate.id, {
        assigneeAgentId: creatorAgent.id,
        assigneeUserId: null,
      });
      if (!updated) {
        skipped += 1;
        continue;
      }

      await issuesSvc.addComment(
        candidate.id,
        [
          "## Assigned Orphan Blocker",
          "",
          `Paperclip found this issue is blocking ${blockingLinks} but had no assignee, so no heartbeat could pick it up.`,
          "",
          "- Assigned it back to the agent that created the blocker.",
          "- Next action: resolve this blocker or reassign it to the right owner.",
        ].join("\n"),
        {},
      );

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          assigneeAgentId: creatorAgent.id,
          source: "recovery.reconcile_unassigned_blocking_issue",
        },
      });

      const queued = await deps.enqueueWakeup(creatorAgent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryContext({
          issueId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        }, "normal_model"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryContext({
          issueId: candidate.id,
          taskId: candidate.id,
          wakeReason: "issue_assigned",
          source: "issue.unassigned_blocker_recovery",
        }, "normal_model"),
      });

      if (queued) {
        assigned += 1;
        issueIds.push(candidate.id);
      } else {
        skipped += 1;
      }
    }

    return { assigned, skipped, issueIds };
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  function isTerminalIssueStatus(status: string | null | undefined) {
    return status === "done" || status === "cancelled";
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function activeOutputDecisionState(companyId: string, runId: string, now = new Date()) {
    const [quietUntilRows, dismissedRows] = await Promise.all([
      db
        .select({
          decision: heartbeatRunWatchdogDecisions.decision,
          snoozedUntil: heartbeatRunWatchdogDecisions.snoozedUntil,
        })
        .from(heartbeatRunWatchdogDecisions)
        .where(
          and(
            eq(heartbeatRunWatchdogDecisions.companyId, companyId),
            eq(heartbeatRunWatchdogDecisions.runId, runId),
            inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
            gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
          ),
        )
        .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
        .limit(1),
      db
        .select({ id: heartbeatRunWatchdogDecisions.id })
        .from(heartbeatRunWatchdogDecisions)
        .where(
          and(
            eq(heartbeatRunWatchdogDecisions.companyId, companyId),
            eq(heartbeatRunWatchdogDecisions.runId, runId),
            eq(heartbeatRunWatchdogDecisions.decision, "dismissed_false_positive"),
          ),
        )
        .limit(1),
    ]);
    return {
      dismissedFalsePositive: dismissedRows.length > 0,
      quietUntilDecision: quietUntilRows[0] ?? null,
    };
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    const [decisionState, evaluation] = await Promise.all([
      activeOutputDecisionState(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const { dismissedFalsePositive, quietUntilDecision } = decisionState;
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
      ? "not_applicable"
      : dismissedFalsePositive
        ? "not_applicable"
        : quietUntilDecision
          ? "snoozed"
          : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS
            ? "critical"
            : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS
              ? "suspicious"
              : "ok";
    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
        ? run.lastOutputStream
        : null,
      silenceStartedAt,
      silenceAgeMs,
      level,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      snoozedUntil: dismissedFalsePositive ? null : quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  async function resolveStaleRunSourceIssue(run: typeof heartbeatRuns.$inferSelect) {
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueId) return null;
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), visibleIssueCondition()))
      .limit(1);
    return issue ?? null;
  }

  async function latestSameRunSourceTerminalEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidenceAfter: Date | null;
  }) {
    if (!isTerminalIssueStatus(input.sourceIssue.status)) return null;
    const after = input.evidenceAfter ?? input.run.startedAt ?? input.run.createdAt ?? null;
    const activityPredicates = [
      eq(activityLog.companyId, input.run.companyId),
      eq(activityLog.runId, input.run.id),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.sourceIssue.id),
      sql`${activityLog.details} ->> 'status' = ${input.sourceIssue.status}`,
    ];
    if (after) {
      activityPredicates.push(gte(activityLog.createdAt, after));
    }

    const activity = await db
      .select({
        id: activityLog.id,
        createdAt: activityLog.createdAt,
        action: activityLog.action,
      })
      .from(activityLog)
      .where(and(...activityPredicates))
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (activity) {
      return {
        kind: "activity" as const,
        id: activity.id,
        createdAt: activity.createdAt,
        action: activity.action,
      };
    }
    return null;
  }

  async function appendRecoveryRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    event: {
      level: "info" | "warn" | "error";
      message: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await appendHeartbeatRunEvent(db, {
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      eventType: "lifecycle",
      stream: "system",
      level: event.level,
      message: event.message,
      payload: event.payload ?? null,
    });
  }

  async function cleanupSourceResolvedRunProcess(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
  }) {
    if (!SESSIONED_LOCAL_ADAPTERS.has(input.runningAgent.adapterType)) {
      return {
        attempted: false,
        outcome: "skipped_non_local_adapter",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const running = runningProcesses.get(input.run.id);
    const pid = running?.child.pid ?? input.run.processPid ?? null;
    const processGroupId = running?.processGroupId ?? input.run.processGroupId ?? null;
    if (typeof pid !== "number" && typeof processGroupId !== "number") {
      return {
        attempted: false,
        outcome: "no_process_metadata",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const wasAlive =
      (typeof pid === "number" && isPidAlive(pid)) ||
      (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
    if (!wasAlive) {
      runningProcesses.delete(input.run.id);
      return {
        attempted: false,
        outcome: "not_running",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    }

    try {
      await terminateLocalService(
        {
          pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0
            ? pid
            : (processGroupId ?? 0),
          processGroupId: typeof processGroupId === "number" && Number.isInteger(processGroupId) && processGroupId > 0
            ? processGroupId
            : null,
        },
        running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
      );
      runningProcesses.delete(input.run.id);
      const stillAlive =
        (typeof pid === "number" && isPidAlive(pid)) ||
        (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
      return {
        attempted: true,
        outcome: stillAlive ? "termination_sent_still_running" : "terminated",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    } catch (error) {
      return {
        attempted: true,
        outcome: "failed",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function finalizeAgentAfterSourceResolvedRun(run: typeof heartbeatRuns.$inferSelect, status: "succeeded" | "cancelled") {
    const [runningCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running")));
    const runningCount = Number(runningCountRow?.count ?? 0);
    const nextStatus = runningCount > 0 ? "running" : status === "succeeded" || status === "cancelled" ? "idle" : "error";
    await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, run.agentId), notInArray(agents.status, ["paused", "terminated"])));
  }

  async function foldSourceResolvedStaleRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidence: Awaited<ReturnType<typeof latestSameRunSourceTerminalEvidence>>;
    existingEvaluation: Awaited<ReturnType<typeof findOpenStaleRunEvaluation>>;
    silenceStartedAt: Date | null;
    silenceAgeMs: number | null;
    now: Date;
  }) {
    if (!input.evidence) return { kind: "skipped" as const };
    const cleanup = await cleanupSourceResolvedRunProcess({ run: input.run, runningAgent: input.runningAgent });
    const finalRunStatus = input.sourceIssue.status === "cancelled" ? "cancelled" : "succeeded";
    const resultJson = {
      ...parseObject(input.run.resultJson),
      sourceResolvedWatchdogFold: {
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        silenceStartedAt: input.silenceStartedAt?.toISOString() ?? null,
        silenceAgeMs: input.silenceAgeMs,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        evaluationIssueIdentifier: input.existingEvaluation?.identifier ?? null,
        cleanup,
      },
    };
    const finalizedRun = await db.transaction(async (tx) => {
      const [updatedRun] = await tx
        .update(heartbeatRuns)
        .set({
          status: finalRunStatus,
          finishedAt: input.now,
          error: null,
          errorCode: null,
          resultJson,
          updatedAt: input.now,
        })
        .where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId), eq(heartbeatRuns.status, "running")))
        .returning();
      if (!updatedRun) return null;

      if (input.run.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: finalRunStatus === "succeeded" ? "completed" : "cancelled",
            finishedAt: input.now,
            error: null,
            updatedAt: input.now,
          })
          .where(and(eq(agentWakeupRequests.id, input.run.wakeupRequestId), eq(agentWakeupRequests.companyId, input.run.companyId)));
      }

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(issues.id, input.sourceIssue.id),
            eq(issues.companyId, input.run.companyId),
            eq(issues.executionRunId, input.run.id),
          ),
        );

      return updatedRun;
    });
    if (!finalizedRun) return { kind: "skipped" as const };

    if (input.existingEvaluation && !isTerminalIssueStatus(input.existingEvaluation.status)) {
      await issuesSvc.update(input.existingEvaluation.id, { status: "done" });
      await issuesSvc.addComment(input.existingEvaluation.id, [
        "Source-resolved watchdog fold.",
        "",
        `- Source issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
        `- Run: \`${input.run.id}\``,
        `- Same-run evidence: \`${input.evidence.kind}:${input.evidence.id}\` at ${input.evidence.createdAt.toISOString()}`,
        "- Outcome: false positive; the source issue already reached a terminal disposition from this run.",
      ].join("\n"), { runId: input.run.id });
    }

    const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(input.run.companyId, input.sourceIssue.id);
    if (activeRecoveryAction?.kind === "active_run_watchdog") {
      await recoveryActionsSvc.resolveActiveForIssue({
        companyId: input.run.companyId,
        sourceIssueId: input.sourceIssue.id,
        actionId: activeRecoveryAction.id,
        status: "resolved",
        outcome: "false_positive",
        resolutionNote: "Source issue reached a terminal disposition through durable same-run activity; watchdog folded as source-resolved.",
      });
    }

    const [decision] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: input.run.companyId,
        runId: input.run.id,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        decision: "dismissed_false_positive",
        reason: "Source issue already reached a terminal disposition through durable same-run activity.",
        createdByRunId: input.run.id,
      })
      .returning();

    await appendRecoveryRunEvent(finalizedRun, {
      level: cleanup.outcome === "failed" ? "warn" : "info",
      message: "Source-resolved watchdog fold finalized stale active run",
      payload: resultJson.sourceResolvedWatchdogFold,
    });
    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.run.agentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_source_resolved",
      entityType: "heartbeat_run",
      entityId: input.run.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        watchdogDecisionId: decision.id,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        cleanup,
      },
    });
    await finalizeAgentAfterSourceResolvedRun(finalizedRun, finalRunStatus);
    return { kind: "folded" as const, evaluationIssueId: input.existingEvaluation?.id ?? null };
  }

  async function inspectSilentActiveRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
    dismissedFalsePositive: boolean;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (
      sourceIssue &&
      Object.values(RECOVERY_ORIGIN_KINDS).includes(
        sourceIssue.originKind as typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS],
      )
    ) {
      return { kind: "skipped" as const };
    }
    const silenceStartedAt = silenceStartedAtForRun(input.run);
    if (sourceIssue && isTerminalIssueStatus(sourceIssue.status)) {
      const terminalEvidence = await latestSameRunSourceTerminalEvidence({
        run: input.run,
        sourceIssue,
        evidenceAfter: silenceStartedAt,
      });
      if (terminalEvidence) {
        return foldSourceResolvedStaleRun({
          run: input.run,
          runningAgent,
          sourceIssue,
          evidence: terminalEvidence,
          existingEvaluation: existing,
          silenceStartedAt,
          silenceAgeMs: silenceAgeMsForRun(input.run, input.now),
          now: input.now,
        });
      }
    }

    // Blocked source work can be intentionally quiet. The issue state already carries
    // the durable waiting signal, so the cleanup scan has nothing to do.
    if (sourceIssue?.status === "blocked") return { kind: "skipped" as const };

    if (input.dismissedFalsePositive) {
      return { kind: "skipped" as const };
    }

    return existing
      ? { kind: "existing" as const, evaluationIssueId: existing.id }
      : { kind: "skipped" as const };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string; issueCreatedAtGte?: Date | null }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    let candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${suspicionBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    if (opts?.issueCreatedAtGte) {
      const issueIds = [...new Set(candidates.flatMap((run) => {
        const context = parseObject(run.contextSnapshot);
        const issueId = context.issueId ?? context.taskId;
        return typeof issueId === "string" && issueId.length > 0 ? [issueId] : [];
      }))];
      const eligibleIssueIds = new Set(
        issueIds.length > 0
          ? (await db.select({ id: issues.id }).from(issues).where(and(
              inArray(issues.id, issueIds),
              gte(issues.createdAt, opts.issueCreatedAtGte),
            ))).map((issue) => issue.id)
          : [],
      );
      candidates = candidates.filter((run) => {
        const context = parseObject(run.contextSnapshot);
        const issueId = context.issueId ?? context.taskId;
        return typeof issueId === "string" && eligibleIssueIds.has(issueId);
      });
    }

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      folded: 0,
      snoozed: 0,
      skipped: 0,
      evaluationIssueIds: [] as string[],
    };

    for (const run of candidates) {
      const decisionState = await activeOutputDecisionState(run.companyId, run.id, now);
      if (decisionState.quietUntilDecision) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await inspectSilentActiveRun({
        run,
        now,
        dismissedFalsePositive: decisionState.dismissedFalsePositive,
      });
      if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "folded") result.folded += 1;
      else result.skipped += 1;
      if ("evaluationIssueId" in outcome && outcome.evaluationIssueId) {
        result.evaluationIssueIds.push(outcome.evaluationIssueId);
      }
    }

    return result;
  }

  async function recordWatchdogDecision(input: {
    runId: string;
    actor: WatchdogDecisionActor;
    decision: "snooze" | "continue" | "dismissed_false_positive";
    evaluationIssueId?: string | null;
    reason?: string | null;
    snoozedUntil?: Date | null;
    createdByRunId?: string | null;
    now?: Date;
  }) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");

    let evaluationIssue: {
      id: string;
      assigneeAgentId: string | null;
      companyId: string;
      originKind: string;
      originId: string | null;
      hiddenAt: Date | null;
      status: string;
    } | null = null;
    if (input.evaluationIssueId) {
      evaluationIssue = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          companyId: issues.companyId,
          originKind: issues.originKind,
          originId: issues.originId,
          hiddenAt: issues.hiddenAt,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, input.evaluationIssueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!evaluationIssue) throw notFound("Evaluation issue not found");
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue?.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation issue is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationIssue) {
      throw forbidden("Agent watchdog decisions require the target evaluation issue");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const [creatorRun] = await db
        .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, createdByRunId))
        .limit(1);
      const sameCompany = creatorRun?.companyId === run.companyId;
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameCompany || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS)
        : null;

    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: run.companyId,
        runId: run.id,
        evaluationIssueId: input.evaluationIssueId ?? null,
        decision: input.decision,
        snoozedUntil: effectiveSnoozedUntil,
        reason: input.reason ?? null,
        createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId: run.companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: run.id,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId ?? null,
        snoozedUntil: effectiveSnoozedUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });

    return row;
  }

  function isStrandedIssueRecoveryIssue(issue: typeof issues.$inferSelect) {
    return issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  }

  async function buildNestedStrandedRecoveryLine(issue: typeof issues.$inferSelect, prefix: string) {
    const sourceIssueId = readNonEmptyString(issue.originId);
    const sourceIssue = sourceIssueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, sourceIssueId)))
        .then((rows) => rows[0] ?? null)
      : null;
    const sourceLine = sourceIssue
      ? `- Original source issue: ${issueUiLink(sourceIssue, prefix)}`
      : sourceIssueId
        ? `- Original source issue: \`${sourceIssueId}\``
        : "- Original source issue: unknown";

    return [
      "",
      "- Nested recovery: suppressed because this issue is already a `stranded_issue_recovery` issue.",
      sourceLine,
      "- Next action: the assigned recovery owner or board operator should fix the runtime/adapter problem, resolve or reassign the original source issue, then mark this recovery issue done or cancelled.",
    ].join("\n");
  }

  function resolveStrandedRecoveryRouting(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }) {
    const originalAgentId = input.issue.assigneeAgentId ?? input.latestRun?.agentId ?? null;
    return {
      returnOwnerAgentId: originalAgentId,
    };
  }


  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    return cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "missing_disposition" as const
      : cause === "deliberate_wait_without_target"
        ? "deliberate_wait_without_target" as const
      : cause === "workspace_validation_failed"
        ? "workspace_validation" as const
      : cause === "configuration_incomplete"
        ? "configuration_validation" as const
      : "stranded_assigned_issue" as const;
  }

  function strandedRecoveryActionFingerprint(input: {
    issue: typeof issues.$inferSelect;
    recoveryCause: StrandedRecoveryCause;
    latestRun: LatestIssueRun;
  }) {
    if (input.recoveryCause === "workspace_validation_failed") {
      const workspaceFingerprint = readWorkspaceValidationFingerprint(input.latestRun);
      if (workspaceFingerprint) {
        return [
          "source_scoped_recovery",
          input.issue.companyId,
          input.issue.id,
          input.recoveryCause,
          workspaceFingerprint,
        ].join(":");
      }
    }
    // A configuration-incomplete failure that carries a stable identity (for
    // example an unresolved workspace base ref) dedupes per that identity, so a
    // different requested ref makes a new recovery action while the same ref
    // reuses one. Configuration gaps with no fingerprint fall back to the
    // issue-and-cause scope below.
    if (input.recoveryCause === "configuration_incomplete") {
      const configurationFingerprint = readConfigurationIncompleteFingerprint(input.latestRun);
      if (configurationFingerprint) {
        return [
          "source_scoped_recovery",
          input.issue.companyId,
          input.issue.id,
          input.recoveryCause,
          configurationFingerprint,
        ].join(":");
      }
    }
    return [
      "source_scoped_recovery",
      input.issue.companyId,
      input.issue.id,
      input.recoveryCause,
    ].join(":");
  }

  function buildStrandedRecoveryActionEvidence(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
    const workspaceValidation = input.recoveryCause === "workspace_validation_failed"
      ? readWorkspaceValidationPayload(input.latestRun)
      : null;
    return {
      sourceIssueId: input.issue.id,
      sourceIdentifier: input.issue.identifier,
      previousStatus: input.previousStatus,
      latestIssueStatus: input.issue.status,
      latestRunId: input.latestRun?.id ?? null,
      latestRunStatus: input.latestRun?.status ?? null,
      latestRunErrorCode: input.latestRun?.errorCode ?? null,
      retryReason: readNonEmptyString(context.retryReason) ?? null,
      recoveryCause: input.recoveryCause,
      sourceRunId: input.successfulRunHandoffEvidence?.sourceRunId ?? null,
      correctiveRunId: input.successfulRunHandoffEvidence?.correctiveRunId ?? null,
      missingDisposition: input.successfulRunHandoffEvidence?.missingDisposition ?? null,
      handoffAttempt: input.successfulRunHandoffEvidence?.handoffAttempt ?? null,
      maxHandoffAttempts: input.successfulRunHandoffEvidence?.maxHandoffAttempts ?? null,
      ...(workspaceValidation ? { workspaceValidation } : {}),
    };
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);
    const routing = resolveStrandedRecoveryRouting({
      issue: input.issue,
      latestRun: input.latestRun,
    });
    const isProviderQuotaWait = recoveryCause === "provider_quota";
    const now = new Date();
    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      // A configuration-incomplete failure carries a per-identity fingerprint
      // (for example the unresolved workspace base ref). A different ref is a
      // distinct blocker, so it must get a new recovery action and notify the
      // operator, not overwrite the active action of the prior ref.
      supersedeOnIdentityChange: recoveryCause === "configuration_incomplete",
      preserveExistingOwner: true,
      kind: strandedRecoveryActionKind(recoveryCause),
      ownerType: isProviderQuotaWait ? "system" : "board",
      ownerAgentId: null,
      ownerUserId: null,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: routing.returnOwnerAgentId,
      cause: recoveryCause,
      fingerprint: strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
        latestRun: input.latestRun,
      }),
      evidence: {
        ...buildStrandedRecoveryActionEvidence({
          issue: input.issue,
          latestRun: input.latestRun,
          previousStatus: input.previousStatus,
          recoveryCause,
          successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
        }),
        failureSummary: summarizeRunFailureForIssueComment(input.latestRun)?.trim() ?? null,
      },
      evidenceOnCreate: isProviderQuotaWait
        ? {}
        : { routingPolicy: STRANDED_BOARD_ESCALATION_POLICY },
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Board operator: inspect the run evidence, then explicitly choose a valid issue disposition, retry the original owner, reassign, or intentionally resolve the task."
        : recoveryCause === "process_lost"
          ? "Board operator: inspect the retry history, then explicitly retry the original owner, reassign, or intentionally resolve the task."
        : recoveryCause === "provider_quota"
          ? "Wait for provider quota recovery, then retry the original assignee; do not wake a takeover owner."
        : recoveryCause === "codex_output_inactivity_monitor"
          ? "Board operator: inspect the inactivity evidence, then explicitly retry the original owner, reassign, or intentionally resolve the task."
        : recoveryCause === "workspace_validation_failed"
          ? readWorkspaceValidationPayload(input.latestRun)?.reason === "git_worktree_branch_incoherence"
            ? "Board operator: repair the source task git worktree branch incoherence or choose a new execution workspace, then explicitly retry or reassign."
            : readWorkspaceValidationPayload(input.latestRun)?.reason === "git_worktree_base_materialization_failed"
              ? "Board operator: repair the project workspace repository URL or clone access, or configure a local checkout cwd, then explicitly retry or reassign."
              : "Board operator: repair the source task workspace link, project workspace cwd, or git checkout, then explicitly retry or reassign."
        : recoveryCause === "configuration_incomplete"
          ? "Board operator: bind the missing secret(s) named in the run failure, then explicitly retry the original owner or reassign."
        : recoveryCause === "execution_review_participant_recovery"
          ? "Board operator: repair the failed review participant path, restore a live reviewer, explicitly reassign, or record an intentional resolution."
        : "Board operator: inspect the evidence, repair the runtime if appropriate, then explicitly retry the original owner, reassign, or intentionally resolve the task.",
      wakePolicy: isProviderQuotaWait
        ? {
          type: "monitor_only",
          reason: recoveryCause,
        }
        : {
          type: "board_escalation",
          reason: recoveryCause,
          preservesSourceAssignee: true,
        },
      monitorPolicy: isProviderQuotaWait
        ? { type: "wait_recovery", retryAgentId: routing.returnOwnerAgentId }
        : null,
      maxAttempts: null,
      lastAttemptAt: now,
    });

    return action;
  }

  function readProviderQuotaRetryAt(latestRun: LatestIssueRun, now: Date) {
    const result = parseObject(latestRun?.resultJson);
    const context = parseObject(latestRun?.contextSnapshot);
    const raw = result.providerQuotaRetryNotBefore ??
      result.retryNotBefore ??
      result.transientRetryNotBefore ??
      context.providerQuotaRetryNotBefore ??
      context.transientRetryNotBefore;
    if (typeof raw === "string" || typeof raw === "number" || raw instanceof Date) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) return parsed;
    }
    return new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS);
  }

  async function ensureProviderQuotaWaitRecoveryMonitor(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    actionId: string;
    agentId: string;
  }) {
    const existing = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.issue.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issue.id}`,
      ))
      .orderBy(desc(heartbeatRuns.scheduledRetryAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const retryAt = readProviderQuotaRetryAt(input.latestRun, now);
    return db.transaction(async (tx) => {
      const wakeup = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: input.issue.companyId,
          agentId: input.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "provider_quota_recovery",
          payload: withRecoveryContext({
            issueId: input.issue.id,
            retryOfRunId: input.latestRun?.id ?? null,
            retryReason: "provider_quota_recovery",
            providerQuotaRetryNotBefore: retryAt.toISOString(),
          }, "normal_model"),
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          idempotencyKey: `provider_quota_recovery:${input.issue.id}:${retryAt.toISOString()}`,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]!);
      const scheduledRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: input.issue.companyId,
          agentId: input.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "scheduled_retry",
          wakeupRequestId: wakeup.id,
          retryOfRunId: input.latestRun?.id ?? null,
          scheduledRetryAt: retryAt,
          scheduledRetryAttempt: 1,
          scheduledRetryReason: "provider_quota_recovery",
          contextSnapshot: withRecoveryContext({
            issueId: input.issue.id,
            taskId: input.issue.id,
            wakeReason: "provider_quota_recovery",
            retryReason: "provider_quota_recovery",
            providerQuotaRetryNotBefore: retryAt.toISOString(),
          }, "normal_model"),
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]!);
      await tx
        .update(agentWakeupRequests)
        .set({ runId: scheduledRun.id, updatedAt: now })
        .where(eq(agentWakeupRequests.id, wakeup.id));
      await tx
        .update(issueRecoveryActions)
        .set({
          monitorPolicy: {
            type: "wait_recovery",
            retryAgentId: input.agentId,
            scheduledRunId: scheduledRun.id,
            retryAt: retryAt.toISOString(),
          },
          timeoutAt: retryAt,
          updatedAt: now,
        })
        .where(eq(issueRecoveryActions.id, input.actionId));
      return scheduledRun;
    });
  }

  function buildRecoveryIssueInPlaceEscalationComment(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    prefix: string;
  }) {
    const runLink = input.latestRun
      ? runUiLink({ id: input.latestRun.id, agentId: input.latestRun.agentId }, input.prefix)
      : "none";
    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "none";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip stopped automatic stranded-work recovery for this recovery issue.",
      "",
      `- Recovery issue: ${issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix)}`,
      `- Previous status: \`${input.previousStatus}\``,
      `- Latest run: ${runLink}`,
      `- Latest run status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "- Guard: recovery issues do not create nested `stranded_issue_recovery` issues.",
      "",
      "Next action: the current recovery owner should inspect the failed run evidence, restore a live execution path or record the manual resolution, then move this recovery issue out of `blocked`.",
    ].join("\n");
  }

  async function escalateStrandedRecoveryIssueInPlace(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
  }) {
    const updated = await issuesSvc.update(input.issue.id, { status: "blocked" });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    await issuesSvc.addComment(
      input.issue.id,
      buildRecoveryIssueInPlaceEscalationComment({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        prefix,
      }),
      {},
      {
        authorType: "system",
        presentation: compactRecoveryPresentation("Recovery: recovery attempt failed — remains blocked"),
        metadata: {
          version: 1,
          sourceRunId: input.latestRun?.id ?? null,
          sections: [{
            title: "Recovery",
            rows: [
              { type: "key_value", label: "Cause", value: "recovery_issue_failed" },
              { type: "key_value", label: "Previous status", value: input.previousStatus },
              ...(input.latestRun
                ? [{
                    type: "run_link" as const,
                    label: "Latest run",
                    runId: input.latestRun.id,
                    title: input.latestRun.status,
                  }]
                : []),
            ],
          }],
        },
      },
    );

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: "recovery.reconcile_stranded_recovery_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        originKind: input.issue.originKind,
        originId: input.issue.originId,
      },
    });

    return updated;
  }

  async function existingBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function existingUnresolvedBlockerIssues(companyId: string, issueId: string) {
    return db
      .select({ id: issueRelations.issueId, identifier: issues.identifier })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueRelations.companyId),
          eq(issues.id, issueRelations.issueId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
  }

  async function existingUnresolvedBlockerIssueIds(companyId: string, issueId: string) {
    return existingUnresolvedBlockerIssues(companyId, issueId).then((rows) => rows.map((row) => row.id));
  }

  async function openChildIssues(issue: typeof issues.$inferSelect) {
    return db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.parentId, issue.id),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
  }

  async function healthyOpenChildIssues(issue: typeof issues.$inferSelect) {
    const childCandidates = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.parentId, issue.id),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const openChildren = [] as Array<{ id: string; identifier: string | null }>;
    for (const child of childCandidates) {
      const childState = await collectDispositionRepairSourceState(db, { issue: child });
      if (childState.hasActiveExecutionPath || childState.hasDurableWaitingPath) {
        openChildren.push({ id: child.id, identifier: child.identifier });
      }
    }
    return openChildren;
  }

  async function resolveContinuationWaitingOnReview(issue: typeof issues.$inferSelect) {
    const [existingBlockers, openChildren] = await Promise.all([
      existingUnresolvedBlockerIssues(issue.companyId, issue.id),
      openChildIssues(issue),
    ]);
    const blockedByIssueIds = [...new Set([...existingBlockers.map((row) => row.id), ...openChildren.map((row) => row.id)])];
    if (blockedByIssueIds.length === 0) return null;

    const updated = await issuesSvc.update(issue.id, { status: "blocked", blockedByIssueIds });
    if (!updated) return null;

    const waitingOn = formatIssueLinksForComment([...openChildren, ...existingBlockers]);
    await issuesSvc.addComment(
      issue.id,
      `This task is waiting on ${waitingOn} to finish. ` +
        "It will continue automatically when that work is done — there's nothing you need to do. " +
        "(It was paused because the latest run reported it was waiting for review/approval; " +
        "Paperclip turned that into a normal dependency wait instead of flagging it as stuck.)",
      {},
      {
        authorType: "system",
        presentation: compactRecoveryPresentation("Recovery: waiting on dependencies — moved to blocked"),
        metadata: {
          version: 1,
          sections: [{
            title: "Recovery",
            rows: [
              { type: "key_value", label: "Cause", value: "continuation_waiting_on_review" },
              { type: "key_value", label: "Previous status", value: issue.status },
              {
                type: "key_value",
                label: "Blocking issues",
                value: blockedByIssueIds.join(", ").slice(0, 2000),
              },
            ],
          }],
        },
      },
    );
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        status: "blocked",
        previousStatus: issue.status,
        source: "recovery.reconcile_continuation_waiting_on_review",
        blockedByIssueIds,
      },
    });
    return updated;
  }

  function readDispositionRepairAttempt(latestRun: LatestIssueRun) {
    if (!latestRun) return null;
    const context = parseObject(latestRun.contextSnapshot);
    if (readNonEmptyString(context.retryReason) !== ISSUE_DISPOSITION_REPAIR_RETRY_REASON) return null;
    return {
      attempt: Math.max(1, Math.floor(asNumber(context.dispositionRepairAttempt, 1))),
      fingerprint: readNonEmptyString(context.dispositionRepairFingerprint),
    };
  }

  async function resolveDispositionRepairActionAsCovered(
    issue: typeof issues.$inferSelect,
    reason: string,
  ) {
    const active = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
    if (!active || active.kind !== "deliberate_wait_without_target") return;
    await recoveryActionsSvc.resolveActiveForIssue({
      companyId: issue.companyId,
      sourceIssueId: issue.id,
      actionId: active.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: reason,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: null,
      runId: null,
      action: "issue.disposition_repair_resolved",
      entityType: "issue_recovery_action",
      entityId: active.id,
      details: {
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        reason,
      },
    });
  }

  async function ensureDispositionRepairAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    fingerprint: string;
    attemptCount: number;
  }) {
    let active = await recoveryActionsSvc.getActiveForIssue(input.issue.companyId, input.issue.id);
    if (active && (
      active.kind !== "deliberate_wait_without_target" ||
      active.fingerprint !== input.fingerprint
    )) {
      await recoveryActionsSvc.resolveActiveForIssue({
        companyId: input.issue.companyId,
        sourceIssueId: input.issue.id,
        actionId: active.id,
        status: "cancelled",
        outcome: "cancelled",
        resolutionNote: "source_state_changed",
      });
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "recovery",
        agentId: null,
        runId: input.latestRun?.id ?? null,
        action: "issue.disposition_repair_fingerprint_reset",
        entityType: "issue_recovery_action",
        entityId: active.id,
        details: {
          sourceIssueId: input.issue.id,
          previousFingerprint: active.fingerprint,
          nextFingerprint: input.fingerprint,
          terminalReason: "source_state_changed",
        },
      });
      active = null;
    }

    if (active && active.attemptCount >= input.attemptCount) return active;

    return recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: "deliberate_wait_without_target",
      ownerType: "agent",
      ownerAgentId: input.issue.assigneeAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: input.issue.assigneeAgentId,
      cause: "deliberate_wait_without_target",
      fingerprint: input.fingerprint,
      evidence: {
        sourceIssueId: input.issue.id,
        sourceIdentifier: input.issue.identifier,
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        sourceStateFingerprint: input.fingerprint,
        terminalReason: null,
      },
      nextAction:
        "The original owner must replace the parked summary with a terminal, live, blocked, monitored, or typed waiting disposition.",
      wakePolicy: {
        type: "bounded_owner_disposition_repair",
        retryAgentId: input.issue.assigneeAgentId,
        attempt: input.attemptCount,
        maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      },
      maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      attemptCount: input.attemptCount,
      lastAttemptAt: new Date(),
    });
  }

  async function scheduleDispositionRepairAttempt(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    action: Awaited<ReturnType<typeof ensureDispositionRepairAction>>;
    fingerprint: string;
    attempt: number;
  }) {
    const agentId = input.issue.assigneeAgentId;
    if (!agentId) return null;
    const timing = dispositionRepairDelayMs(input.attempt, input.fingerprint);
    const now = new Date();
    const retryAt = new Date(now.getTime() + timing.delayMs);
    const idempotencyKey = `issue_disposition_repair:${input.issue.id}:${input.fingerprint}:${input.attempt}`;
    const context = withRecoveryContext({
      issueId: input.issue.id,
      taskId: input.issue.id,
      wakeReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
      retryReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
      source: "issue.deliberate_wait_disposition_repair",
      retryOfRunId: input.latestRun?.id ?? null,
      recoveryActionId: input.action.id,
      dispositionRepairFingerprint: input.fingerprint,
      dispositionRepairAttempt: input.attempt,
      dispositionRepairMaxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      bypassContinuationSummaryPark: true,
      dispositionRepairInstruction:
        "Revalidate the issue and replace the invalid parked summary with a durable disposition. Continue productive work when appropriate.",
    }, "normal_model");

    const findScheduledRun = () => db
      .select({ run: heartbeatRuns })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
      .where(and(
        eq(agentWakeupRequests.companyId, input.issue.companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        sql`${agentWakeupRequests.status} <> 'skipped'`,
      ))
      .limit(1)
      .then((rows) => rows[0]?.run ?? null);

    let scheduledRun = await findScheduledRun();
    let created = false;
    if (!scheduledRun) {
      try {
        if (timing.delayMs === 0) {
          const enqueuedRun = await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
            idempotencyKey,
            payload: withRecoveryContext({
              issueId: input.issue.id,
              retryOfRunId: input.latestRun?.id ?? null,
              recoveryActionId: input.action.id,
              dispositionRepairFingerprint: input.fingerprint,
              dispositionRepairAttempt: input.attempt,
              bypassContinuationSummaryPark: true,
            }, "normal_model"),
            requestedByActorType: "system",
            requestedByActorId: null,
            contextSnapshot: context,
          });
          scheduledRun = enqueuedRun ?? (await findScheduledRun());
          created = Boolean(enqueuedRun);
        } else {
          scheduledRun = await db.transaction(async (tx) => {
            const wakeup = await tx
              .insert(agentWakeupRequests)
              .values({
                companyId: input.issue.companyId,
                agentId,
                source: "automation",
                triggerDetail: "system",
                reason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
                payload: withRecoveryContext({
                  issueId: input.issue.id,
                  retryOfRunId: input.latestRun?.id ?? null,
                  recoveryActionId: input.action.id,
                  dispositionRepairFingerprint: input.fingerprint,
                  dispositionRepairAttempt: input.attempt,
                  bypassContinuationSummaryPark: true,
                }, "normal_model"),
                status: "queued",
                requestedByActorType: "system",
                requestedByActorId: null,
                idempotencyKey,
                updatedAt: now,
              })
              .returning()
              .then((rows) => rows[0]!);
            const run = await tx
              .insert(heartbeatRuns)
              .values({
                companyId: input.issue.companyId,
                agentId,
                invocationSource: "automation",
                triggerDetail: "system",
                status: "scheduled_retry",
                wakeupRequestId: wakeup.id,
                retryOfRunId: input.latestRun?.id ?? null,
                scheduledRetryAt: retryAt,
                scheduledRetryAttempt: input.attempt,
                scheduledRetryReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
                contextSnapshot: context,
                updatedAt: now,
              })
              .returning()
              .then((rows) => rows[0]!);
            await tx
              .update(agentWakeupRequests)
              .set({ runId: run.id, updatedAt: now })
              .where(eq(agentWakeupRequests.id, wakeup.id));
            return run;
          });
          created = true;
        }
      } catch (error) {
        if (!isUniqueViolation(error, DISPOSITION_REPAIR_IDEMPOTENCY_INDEX)) throw error;
        const winningRun = await findScheduledRun();
        if (!winningRun) throw error;
        scheduledRun = winningRun;
      }
    }

    if (!scheduledRun) return null;

    await db
      .update(issueRecoveryActions)
      .set({
        attemptCount: input.attempt,
        wakePolicy: {
          type: "bounded_owner_disposition_repair",
          retryAgentId: agentId,
          attempt: input.attempt,
          maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
          baseBackoffMs: timing.baseDelayMs,
          jitterMs: timing.jitterMs,
          retryAt: retryAt.toISOString(),
          scheduledRunId: scheduledRun.id,
        },
        timeoutAt: retryAt,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(issueRecoveryActions.id, input.action.id),
        eq(issueRecoveryActions.companyId, input.issue.companyId),
      ));

    if (created) {
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "recovery",
        agentId: null,
        runId: input.latestRun?.id ?? null,
        action: "issue.disposition_repair_scheduled",
        entityType: "issue_recovery_action",
        entityId: input.action.id,
        details: {
          sourceIssueId: input.issue.id,
          sourceIdentifier: input.issue.identifier,
          ownerAgentId: agentId,
          sourceStateFingerprint: input.fingerprint,
          attempt: input.attempt,
          maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
          baseBackoffMs: timing.baseDelayMs,
          jitterMs: timing.jitterMs,
          retryAt: retryAt.toISOString(),
          scheduledRunId: scheduledRun.id,
        },
      });
    }

    return scheduledRun;
  }

  async function latestRecoveryActionRun(action: typeof issueRecoveryActions.$inferSelect) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, action.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${action.id}`,
      ))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function sourceHasNewPathOutsideRecoveryAction(
    action: typeof issueRecoveryActions.$inferSelect,
  ) {
    const [run, wake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, action.companyId),
          inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId') = ${action.sourceIssueId}`,
          sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId', '') <> ${action.id}`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, action.companyId),
          inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
          sql`coalesce(${agentWakeupRequests.payload} ->> 'issueId', ${agentWakeupRequests.payload} ->> 'taskId') = ${action.sourceIssueId}`,
          sql`coalesce(${agentWakeupRequests.payload} ->> 'recoveryActionId', '') <> ${action.id}`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(run || wake);
  }


  async function reconcileActiveRecoveryActions() {
    const rows = await db
      .select({ action: issueRecoveryActions, issue: issues })
      .from(issueRecoveryActions)
      .innerJoin(
        issues,
        and(
          eq(issues.id, issueRecoveryActions.sourceIssueId),
          eq(issues.companyId, issueRecoveryActions.companyId),
        ),
      )
      .where(inArray(issueRecoveryActions.status, ["active", "escalated"]));

    const result = { requeued: 0, escalated: 0, resolved: 0, skipped: 0, issueIds: [] as string[] };
    for (const { action, issue } of rows) {
      const wakePolicy = parseObject(action.wakePolicy);
      const wakePolicyType = readNonEmptyString(wakePolicy.type);
      if (
        wakePolicyType !== "bounded_recovery_owner" &&
        wakePolicyType !== "bounded_owner_disposition_repair" &&
        action.ownerType !== "board"
      ) {
        continue;
      }

      if (issue.status === "done" || issue.status === "cancelled") {
        const resolved = await recoveryActionsSvc.resolveActiveForIssue({
          companyId: action.companyId,
          sourceIssueId: action.sourceIssueId,
          actionId: action.id,
          status: "resolved",
          outcome: "restored",
          resolutionNote: "source_terminal",
        });
        if (resolved) {
          result.resolved += 1;
          result.issueIds.push(issue.id);
        }
        continue;
      }

      const [sourceState, healthyChildren, hasNewSourcePath] = await Promise.all([
        collectDispositionRepairSourceState(db, { issue }),
        healthyOpenChildIssues(issue),
        sourceHasNewPathOutsideRecoveryAction(action),
      ]);
      const durablePathRestored = action.ownerType !== "board" && sourceState.hasDurableWaitingPath;
      if (durablePathRestored || healthyChildren.length > 0 || hasNewSourcePath) {
        if (healthyChildren.length > 0 && !sourceState.hasDurableWaitingPath) {
          const blockerIds = await existingUnresolvedBlockerIssueIds(issue.companyId, issue.id);
          await issuesSvc.update(issue.id, {
            status: "blocked",
            blockedByIssueIds: [...new Set([
              ...blockerIds,
              ...healthyChildren.map((child) => child.id),
            ])],
          });
        }
        const resolved = await recoveryActionsSvc.resolveActiveForIssue({
          companyId: action.companyId,
          sourceIssueId: action.sourceIssueId,
          actionId: action.id,
          status: "resolved",
          outcome: "restored",
          resolutionNote: durablePathRestored
            ? `durable_path_restored:${sourceState.durablePathReason ?? "unknown"}`
            : healthyChildren.length > 0
              ? "durable_path_restored:healthy_child"
              : "new_source_execution_path",
        });
        if (resolved) {
          result.resolved += 1;
          result.issueIds.push(issue.id);
        }
        continue;
      }

      if (wakePolicyType === "bounded_owner_disposition_repair") {
        if (await isAutomaticRecoverySuppressedByPauseHold(
          db,
          issue.companyId,
          issue.id,
          treeControlSvc,
        )) {
          result.skipped += 1;
          continue;
        }

        const latestRun = await latestRecoveryActionRun(action);
        const persistedAttempt = Math.max(
          action.attemptCount,
          Math.max(0, Math.floor(asNumber(wakePolicy.attempt, action.attemptCount))),
        );
        const outcome = await reconcileDispositionRepair(issue, latestRun, {
          historicalAttemptCount: persistedAttempt,
        });
        if (outcome === "queued") {
          result.requeued += 1;
          result.issueIds.push(issue.id);
        } else if (outcome === "escalated") {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (action.ownerType === "board") continue;

      // Legacy takeover actions remain readable and resolvable, but recovery no
      // longer schedules another agent-owned wake for them.
      result.skipped += 1;
    }
    return result;
  }

  async function escalateDispositionRepair(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    fingerprint: string;
    attemptCount: number;
    terminalReason: string;
  }) {
    const action = await ensureDispositionRepairAction({
      issue: input.issue,
      latestRun: input.latestRun,
      fingerprint: input.fingerprint,
      attemptCount: input.attemptCount,
    });
    const now = new Date();
    await db
      .update(issueRecoveryActions)
      .set({
        status: "active",
        ownerType: "board",
        ownerAgentId: null,
        ownerUserId: null,
        maxAttempts: null,
        evidence: {
          ...action.evidence,
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          terminalReason: input.terminalReason,
          sourceAttemptCount: input.attemptCount,
          sourceMaxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
          routingPolicy: STRANDED_BOARD_ESCALATION_POLICY,
        },
        nextAction:
          "Inspect the evidence and choose whether to repair, retry the original owner, explicitly reassign, or resolve the source issue.",
        wakePolicy: {
          type: "board_escalation",
          reason: input.terminalReason,
          preservesSourceAssignee: true,
        },
        timeoutAt: null,
        resolutionNote: input.terminalReason,
        updatedAt: now,
      })
      .where(and(
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.companyId, input.issue.companyId),
      ));

    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
    });
    if (!updated) return null;
    const sourceAssigneePreserved =
      updated.assigneeAgentId === input.issue.assigneeAgentId &&
      updated.assigneeUserId === input.issue.assigneeUserId;

    await issuesSvc.addComment(
      input.issue.id,
      [
        "Paperclip exhausted the bounded original-owner disposition repair without a durable source-state change.",
        "",
        `- Attempts: ${input.attemptCount}/${DISPOSITION_REPAIR_MAX_ATTEMPTS}`,
        `- Terminal reason: \`${input.terminalReason}\``,
        "- Recovery owner: board",
        "- Source ownership: unchanged; reassignment requires an explicit decision or a policy-defined serious failure.",
        "",
        "Next action: repair the liveness disposition or request an explicit source-owner decision.",
      ].join("\n"),
      {},
      {
        authorType: "system",
        presentation: compactRecoveryPresentation("Recovery: disposition repair escalated — source owner preserved"),
        metadata: recoveryNoticeMetadata({
          cause: "deliberate_wait_without_target",
          latestRun: input.latestRun,
          recoveryActionId: action.id,
          previousStatus: input.issue.status,
          recoveryOwner: null,
        }),
      },
    );

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: null,
      runId: input.latestRun?.id ?? null,
      action: "issue.disposition_repair_escalated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.issue.status,
        sourceStateFingerprint: input.fingerprint,
        attemptCount: input.attemptCount,
        maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
        terminalReason: input.terminalReason,
        recoveryActionId: action.id,
        recoveryOwnerAgentId: null,
        recoveryOwnerType: "board",
        routingPolicy: STRANDED_BOARD_ESCALATION_POLICY,
        sourceAssigneeBefore: {
          agentId: input.issue.assigneeAgentId,
          userId: input.issue.assigneeUserId,
        },
        sourceAssigneeAfter: {
          agentId: updated.assigneeAgentId,
          userId: updated.assigneeUserId,
        },
        sourceAssigneePreserved,
      },
    });
    if (!sourceAssigneePreserved) {
      logger.error({
        issueId: input.issue.id,
        beforeAssigneeAgentId: input.issue.assigneeAgentId,
        afterAssigneeAgentId: updated.assigneeAgentId,
        beforeAssigneeUserId: input.issue.assigneeUserId,
        afterAssigneeUserId: updated.assigneeUserId,
      }, "automatic disposition recovery observed a concurrent source-owner change");
    }
    return updated;
  }

  async function reconcileDispositionRepair(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun,
    options: { historicalAttemptCount?: number } = {},
  ): Promise<"queued" | "escalated" | "covered" | "skipped"> {
    const current = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!current || current.status === "done" || current.status === "cancelled") return "skipped";

    const dependencyWait = await resolveContinuationWaitingOnReview(current);
    if (dependencyWait) {
      await resolveDispositionRepairActionAsCovered(current, "dependency_wait_created");
      return "covered";
    }

    const state = await collectDispositionRepairSourceState(db, { issue: current });
    if (state.hasActiveExecutionPath) return "skipped";
    if (state.hasDurableWaitingPath) {
      await resolveDispositionRepairActionAsCovered(
        current,
        `durable_path_restored:${state.durablePathReason ?? "unknown"}`,
      );
      return "covered";
    }

    const ownerAgentId = current.assigneeAgentId;
    const ownerAgent = ownerAgentId ? await getAgent(ownerAgentId) : null;
    const ownerInvokable = ownerAgent && ownerAgent.companyId === current.companyId
      ? (await isAgentInvokable(ownerAgent)) && isHeartbeatWakeOnDemandEnabled(ownerAgent)
      : false;
    const budgetBlocked = ownerAgentId ? await isInvocationBudgetBlocked(current, ownerAgentId) : true;
    const previousAttempt = readDispositionRepairAttempt(latestRun);
    const activeRepairAction = await recoveryActionsSvc.getActiveForIssue(current.companyId, current.id);
    const runAttempt = previousAttempt?.fingerprint === state.fingerprint
      ? previousAttempt.attempt
      : 0;
    const persistedAttempt = activeRepairAction?.kind === "deliberate_wait_without_target" &&
      activeRepairAction.fingerprint === state.fingerprint
      ? activeRepairAction.attemptCount
      : 0;
    // Upgrade compatibility: pre-fingerprint continuation parks already spent
    // attempts against this unchanged source state. Seed the durable counter
    // from that consecutive legacy history instead of granting five fresh
    // attempts merely because the recovery-action row did not exist yet.
    const historicalAttempt = Math.min(
      DISPOSITION_REPAIR_MAX_ATTEMPTS,
      Math.max(0, Math.floor(options.historicalAttemptCount ?? 0)),
    );
    const sameFingerprintAttempt = Math.max(runAttempt, persistedAttempt, historicalAttempt);
    if (!ownerInvokable || budgetBlocked) {
      const escalated = await escalateDispositionRepair({
        issue: current,
        latestRun,
        fingerprint: state.fingerprint,
        attemptCount: sameFingerprintAttempt,
        terminalReason: !ownerInvokable ? "owner_not_invokable" : "owner_budget_blocked",
      });
      return escalated ? "escalated" : "skipped";
    }

    if (sameFingerprintAttempt >= DISPOSITION_REPAIR_MAX_ATTEMPTS) {
      const escalated = await escalateDispositionRepair({
        issue: current,
        latestRun,
        fingerprint: state.fingerprint,
        attemptCount: sameFingerprintAttempt,
        terminalReason: "unchanged_source_state_exhausted",
      });
      return escalated ? "escalated" : "skipped";
    }

    const nextAttempt = sameFingerprintAttempt + 1;
    const action = await ensureDispositionRepairAction({
      issue: current,
      latestRun,
      fingerprint: state.fingerprint,
      attemptCount: sameFingerprintAttempt,
    });
    const scheduled = await scheduleDispositionRepairAttempt({
      issue: current,
      latestRun,
      action,
      fingerprint: state.fingerprint,
      attempt: nextAttempt,
    });
    return scheduled ? "queued" : "skipped";
  }

  async function escalateStrandedAssignedIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    comment?: string;
    notice?: StrandedRecoveryNoticeSeed | null;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) {
      return escalateStrandedRecoveryIssueInPlace({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
      });
    }

    const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);
    const recoveryAction = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
      recoveryCause,
      successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
    });
    const isProviderQuotaWait = recoveryCause === "provider_quota" &&
      !recoveryAction.ownerAgentId &&
      Boolean(recoveryAction.returnOwnerAgentId);
    if (isProviderQuotaWait && recoveryAction.returnOwnerAgentId) {
      await ensureProviderQuotaWaitRecoveryMonitor({
        issue: input.issue,
        latestRun: input.latestRun,
        actionId: recoveryAction.id,
        agentId: recoveryAction.returnOwnerAgentId,
      });
    }
    const blockerIds = await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id);
    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
      blockedByIssueIds: blockerIds,
    });
    if (!updated) return null;
    if (isProviderQuotaWait) return updated;
    const sourceAssigneePreserved =
      updated.assigneeAgentId === input.issue.assigneeAgentId &&
      updated.assigneeUserId === input.issue.assigneeUserId;

    const recoveryOwner = recoveryAction.ownerAgentId ? await getAgent(recoveryAction.ownerAgentId) : null;
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    let notice: SuccessfulRunHandoffNotice | null = null;
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON && input.successfulRunHandoffEvidence) {
      const [sourceRun] = input.successfulRunHandoffEvidence.sourceRunId
        ? await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            agentId: heartbeatRuns.agentId,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, input.successfulRunHandoffEvidence.sourceRunId),
            eq(heartbeatRuns.companyId, input.issue.companyId),
          ))
          .limit(1)
        : [];
      notice = buildSuccessfulRunHandoffExhaustedNotice({
        issue: input.issue,
        sourceRun: sourceRun ?? null,
        correctiveRun: input.latestRun
          ? { id: input.latestRun.id, status: input.latestRun.status, agentId: input.latestRun.agentId }
          : null,
        sourceAssignee,
        recoveryIssue: null,
        recoveryActionId: recoveryAction.id,
        recoveryOwner,
        latestIssueStatus: input.issue.status,
        latestHandoffRunStatus: input.latestRun?.status ?? "unknown",
        missingDisposition: input.successfulRunHandoffEvidence.missingDisposition,
      });
    }
    const escalationNotice = buildStrandedRecoveryEscalationNotice({
      seed: input.notice,
      fallbackBody: input.comment,
      recoveryCause,
      recoveryActionId: recoveryAction.id,
      recoveryOwner: recoveryAction.ownerAgentId && recoveryOwner
        ? { id: recoveryOwner.id, name: recoveryOwner.name }
        : null,
      sourceRun: input.latestRun
        ? {
            id: input.latestRun.id,
            agentId: input.latestRun.agentId,
            status: input.latestRun.status,
            errorCode: input.latestRun.errorCode,
            errorSummary: input.latestRun.error ? redactSensitiveText(input.latestRun.error) : null,
          }
        : null,
    });

    const shouldPostEscalationComment =
      recoveryAction.attemptCount === 1 ||
      input.recoveryCause === "workspace_validation_failed" ||
      input.recoveryCause === "configuration_incomplete";
    if (shouldPostEscalationComment) {
      const escalationCommentMarker = `Recovery action: \`${recoveryAction.id}\``;

      const hasEscalationComment = await db
        .select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, input.issue.id),
            eq(issueComments.authorType, "system"),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(50)
        .then((rows) => rows.some((row) =>
          noticeMetadataReferencesRecoveryAction(row.metadata, recoveryAction.id) ||
          (row.body ?? "").includes(escalationCommentMarker),
        ));

      if (!hasEscalationComment) {
        if (notice) {
          await issuesSvc.addComment(input.issue.id, notice.body, {}, {
            authorType: "system",
            presentation: notice.presentation,
            metadata: notice.metadata,
          });
        } else {
          await issuesSvc.addComment(input.issue.id, escalationNotice.body, {}, {
            authorType: "system",
            presentation: escalationNotice.presentation,
            metadata: escalationNotice.metadata,
          });
        }
      }
    }

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "issue.successful_run_handoff_escalated"
        : "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? "recovery.reconcile_successful_run_handoff_missing_state"
          : input.recoveryCause === "workspace_validation_failed"
            ? "recovery.reconcile_workspace_validation_failed"
          : input.recoveryCause === "configuration_incomplete"
            ? "recovery.reconcile_configuration_incomplete"
          : input.recoveryCause === "execution_review_participant_recovery"
            ? "recovery.reconcile_execution_review_participant"
          : "recovery.reconcile_stranded_assigned_issue",
        recoveryCause: input.recoveryCause ?? "stranded_assigned_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        recoveryActionId: recoveryAction.id,
        recoveryOwnerType: recoveryAction.ownerType,
        recoveryOwnerAgentId: recoveryAction.ownerAgentId,
        previousOwnerAgentId: recoveryAction.previousOwnerAgentId,
        returnOwnerAgentId: recoveryAction.returnOwnerAgentId,
        routingPolicy: parseObject(recoveryAction.evidence).routingPolicy ?? null,
        sourceAssigneeBefore: {
          agentId: input.issue.assigneeAgentId,
          userId: input.issue.assigneeUserId,
        },
        sourceAssigneeAfter: {
          agentId: updated.assigneeAgentId,
          userId: updated.assigneeUserId,
        },
        sourceAssigneePreserved,
        blockerIssueIds: blockerIds,
      },
    });

    if (!sourceAssigneePreserved) {
      logger.error({
        issueId: input.issue.id,
        beforeAssigneeAgentId: input.issue.assigneeAgentId,
        afterAssigneeAgentId: updated.assigneeAgentId,
        beforeAssigneeUserId: input.issue.assigneeUserId,
        afterAssigneeUserId: updated.assigneeUserId,
      }, "automatic stranded recovery observed a concurrent source-owner change");
    }

    return updated;
  }

  async function persistAdapterFailureRecoveryClassification(
    latestRun: NonNullable<LatestIssueRun>,
    classification: NonNullable<AdapterFailureRecoveryClassification>,
  ): Promise<NonNullable<LatestIssueRun>> {
    const classifiedRun = withAdapterFailureRecoveryClassification(latestRun, classification);

    await db
      .update(heartbeatRuns)
      .set({
        errorCode: classifiedRun.errorCode,
        resultJson: parseObject(classifiedRun.resultJson),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, latestRun.id));

    return classifiedRun;
  }

  function withAdapterFailureRecoveryClassification(
    latestRun: NonNullable<LatestIssueRun>,
    classification: NonNullable<AdapterFailureRecoveryClassification>,
  ): NonNullable<LatestIssueRun> {
    const resultJson = parseObject(latestRun.resultJson);
    const providerQuotaMetadata = classification.kind === "provider_quota"
      ? {
          errorFamily: "provider_quota",
          retryNotBefore: classification.retryAt.toISOString(),
          transientRetryNotBefore: classification.retryAt.toISOString(),
          providerQuotaRetryNotBefore: classification.retryAt.toISOString(),
        }
      : { errorFamily: "configuration_incomplete" };
    const errorCode = classification.kind;

    return {
      ...latestRun,
      errorCode,
      resultJson: {
        ...resultJson,
        ...providerQuotaMetadata,
        recoveryClassification: errorCode,
      },
    };
  }

  async function scheduleProviderQuotaRecoveryMonitor(input: {
    issue: typeof issues.$inferSelect;
    latestRun: NonNullable<LatestIssueRun>;
    classification: Extract<NonNullable<AdapterFailureRecoveryClassification>, { kind: "provider_quota" }>;
  }) {
    if (input.issue.status !== "in_progress" && input.issue.status !== "in_review") return null;

    const targetAgentId = getAdapterFailureRecoveryTargetAgentId(input.issue);
    if (!targetAgentId || input.latestRun.agentId !== targetAgentId) return null;

    const previousPolicy = normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
    const retryTargetDescription = input.issue.status === "in_review"
      ? "the active review participant"
      : "the original assignee";
    const policy = {
      ...(previousPolicy ?? { mode: "normal" as const, commentRequired: true, stages: [] }),
      monitor: {
        nextCheckAt: input.classification.retryAt.toISOString(),
        notes: input.classification.parsedResetTime
          ? `Provider usage quota reached; retry ${retryTargetDescription} at the provider reset time.`
          : `Provider usage quota reached; retry ${retryTargetDescription} after the default recovery backoff.`,
        scheduledBy: "assignee" as const,
        kind: "external_service" as const,
        serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
        externalRef: input.latestRun.id,
        timeoutAt: null,
        maxAttempts: null,
        recoveryPolicy: "wake_owner" as const,
      },
    };
    const transition = applyIssueMonitorPolicyTransition({
      issue: input.issue,
      policy,
      previousPolicy,
      requestedStatus: input.issue.status,
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: null },
      monitorExplicitlyUpdated: true,
    });
    const updated = await issuesSvc.update(input.issue.id, {
      ...transition.patch,
      executionPolicy: policy,
    });
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: null,
      runId: input.latestRun.id,
      action: "issue.monitor_scheduled",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        source: "recovery.provider_quota",
        latestRunId: input.latestRun.id,
        errorCode: "provider_quota",
        nextCheckAt: input.classification.retryAt.toISOString(),
        parsedResetTime: input.classification.parsedResetTime,
        targetAgentId,
      },
    });

    return updated;
  }

  function getAdapterFailureRecoveryTargetAgentId(issue: typeof issues.$inferSelect) {
    if (issue.status !== "in_review") return issue.assigneeAgentId;

    const pendingExecutionState = parseIssueExecutionState(issue.executionState);
    const participant = pendingExecutionState?.status === "pending"
      ? pendingExecutionState.currentParticipant
      : null;
    return participant?.type === "agent" ? participant.agentId : null;
  }

  function hasPendingProviderQuotaRecoveryMonitor(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun,
    now: Date,
  ) {
    if (!latestRun || !issue.monitorNextCheckAt || issue.monitorNextCheckAt.getTime() <= now.getTime()) return false;
    const monitor = parseObject(parseObject(issue.executionPolicy).monitor);
    return readNonEmptyString(monitor.serviceName) === PROVIDER_QUOTA_MONITOR_SERVICE_NAME &&
      readNonEmptyString(monitor.externalRef) === latestRun.id;
  }

  async function reconcileStrandedAssignedIssues(opts?: { issueCreatedAtGte?: Date | null }) {
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress", "in_review"]),
          or(
            sql`${issues.assigneeAgentId} is not null`,
            eq(issues.status, "in_review"),
          ),
          opts?.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
        ),
      );

    const result = {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      dispositionRepairRequeued: 0,
      productiveContinuationObserved: 0,
      successfulContinuationObserved: 0,
      orphanBlockersAssigned: 0,
      successfulRunHandoffEscalated: 0,
      reviewParticipantRequeued: 0,
      escalated: 0,
      waitingOnReviewResolved: 0,
      providerQuotaMonitored: 0,
      recentProgressExempted: 0,
      operatorCancelExempted: 0,
      skipped: 0,
      issueIds: [] as string[],
    };

    for (const issue of candidates) {
      const executionState = issue.status === "in_review"
        ? parseIssueExecutionState(issue.executionState)
        : null;
      const pendingExecutionState = executionState?.status === "pending" ? executionState : null;
      const currentParticipant = pendingExecutionState
        ? pendingExecutionState.currentParticipant
        : null;
      const participantAgentId = currentParticipant?.type === "agent" ? currentParticipant.agentId : null;
      const agentId = issue.status === "in_review" && participantAgentId
        ? participantAgentId
        : issue.assigneeAgentId;
      if (!agentId) {
        result.skipped += 1;
        continue;
      }

      let latestRun = await getLatestIssueRun(issue.companyId, issue.id);

      const agent = await getAgent(agentId);
      const agentInvokable = agent && agent.companyId === issue.companyId
        ? await isAgentInvokable(agent)
        : false;
      if (issue.status !== "in_review" && !agentInvokable) {
        const classification = classifyContinuationFailure(latestRun);
        if (
          classification.kind === "deliberate_wait_without_target" ||
          readDispositionRepairAttempt(latestRun)
        ) {
          const outcome = await reconcileDispositionRepair(issue, latestRun);
          if (outcome === "escalated") {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        } else {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: issue.status as StrandedPreviousStatus,
            latestRun,
            comment:
              "Paperclip cannot safely continue automatic recovery because the original assignee is not invokable. " +
              "The source assignment is unchanged and the board must choose the next action.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        }
        continue;
      }

      if (await hasActiveExecutionPath(
        issue.companyId,
        issue.id,
        issue.status === "in_review" ? agentId : null,
      )) {
        result.skipped += 1;
        continue;
      }

      if (await hasPendingWakeInteraction(issue.companyId, issue.id)) {
        result.skipped += 1;
        continue;
      }

      // A board-owned recovery action is already the durable, human-owned
      // continuation path. Generic stranded-work recovery must not race that
      // authority by launching another provider turn (most importantly after
      // bounded native-session recovery has reached terminal exhaustion).
      const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(
        issue.companyId,
        issue.id,
      );
      if (activeRecoveryAction?.ownerType === "board") {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      if (isOperatorCancelledRun(latestRun)) {
        result.operatorCancelExempted += 1;
        continue;
      }
      if (await isInvocationBudgetBlocked(issue, agentId)) {
        const classification = classifyContinuationFailure(latestRun);
        if (
          classification.kind === "deliberate_wait_without_target" ||
          readDispositionRepairAttempt(latestRun)
        ) {
          const outcome = await reconcileDispositionRepair(issue, latestRun);
          if (outcome === "escalated") {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        } else {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: issue.status as StrandedPreviousStatus,
            latestRun,
            recoveryCause: issue.status === "in_review"
              ? EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON
              : undefined,
            comment:
              "Paperclip cannot safely continue automatic recovery because the original recovery target is over budget. " +
              "The source assignment is unchanged and the board must choose the next action.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        }
        continue;
      }
      if (latestRun?.status === "succeeded" && await hasPersistedDurableWaitPath(issue)) {
        result.skipped += 1;
        continue;
      }
      const recoveryNow = new Date();
      const participantLatestRunForRecovery = issue.status === "in_review" && participantAgentId
        ? await getLatestIssueRunForAgent(issue.companyId, issue.id, participantAgentId)
        : null;
      const providerQuotaMonitorRun = issue.status === "in_review"
        ? participantLatestRunForRecovery
        : latestRun;
      if (hasPendingProviderQuotaRecoveryMonitor(issue, providerQuotaMonitorRun, recoveryNow)) {
        result.skipped += 1;
        continue;
      }
      if (isStrandedIssueRecoveryIssue(issue) && isUnsuccessfulTerminalIssueRun(latestRun)) {
        const updated = await escalateStrandedRecoveryIssueInPlace({
          issue,
          previousStatus: issue.status as StrandedPreviousStatus,
          latestRun,
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const adapterFailureClassification = issue.status !== "in_review" && latestRun && isUnsuccessfulTerminalIssueRun(latestRun)
        ? classifyAdapterFailureForRecovery(latestRun, recoveryNow)
        : null;
      if (latestRun && adapterFailureClassification) {
        const targetAgentId = getAdapterFailureRecoveryTargetAgentId(issue);
        if (!targetAgentId || latestRun.agentId !== targetAgentId) {
          result.skipped += 1;
          continue;
        }

        if (adapterFailureClassification.kind === "provider_quota") {
          const monitored = await scheduleProviderQuotaRecoveryMonitor({
            issue,
            latestRun,
            classification: adapterFailureClassification,
          });
          if (monitored) {
            latestRun = await persistAdapterFailureRecoveryClassification(latestRun, adapterFailureClassification);
            result.providerQuotaMonitored += 1;
            result.issueIds.push(issue.id);
            continue;
          }
          result.skipped += 1;
          continue;
        } else {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: issue.status as StrandedPreviousStatus,
            latestRun,
            recoveryCause: "configuration_incomplete",
            comment:
              "Paperclip classified the latest adapter failure as `configuration_incomplete`. " +
              "Moving the issue to `blocked` with the configuration fix recorded instead of creating a recovery takeover.",
          });
          if (updated) {
            latestRun = await persistAdapterFailureRecoveryClassification(latestRun, adapterFailureClassification);
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

      const acceptedContinuationInteraction = await getLatestAcceptedContinuationInteraction(issue.companyId, issue.id);
      const acceptedInteractionResolvedAt = acceptedContinuationInteraction
        ? acceptedContinuationInteraction.resolvedAt ?? acceptedContinuationInteraction.updatedAt
        : null;
      if (acceptedContinuationInteraction && acceptedInteractionResolvedAt && !pendingExecutionState) {
        const legacyReviewParkAttempts = await summarizeRecentContinuationRetries(
          issue.companyId,
          issue.id,
          agentId,
          CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE,
          acceptedInteractionResolvedAt,
        );
        const successfulRunSinceResolution = await hasSuccessfulIssueRunSince(
          issue.companyId,
          issue.id,
          agentId,
          acceptedInteractionResolvedAt,
          acceptedContinuationInteraction.id,
        );

        if (!successfulRunSinceResolution) {
          if (!agentInvokable) {
            result.skipped += 1;
            continue;
          }

          if (await hasQueuedIssueWake(issue.companyId, issue.id, agentId)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const latestPostResolutionRun = await getLatestIssueRunSince(
            issue.companyId,
            issue.id,
            agentId,
            acceptedInteractionResolvedAt,
          );
          if (
            classifyContinuationFailure(latestPostResolutionRun).kind ===
            "deliberate_wait_without_target"
          ) {
            const resolved = await resolveContinuationWaitingOnReview(issue);
            if (resolved) {
              result.waitingOnReviewResolved += 1;
              result.issueIds.push(issue.id);
              continue;
            }
            const outcome = await reconcileDispositionRepair(issue, latestPostResolutionRun, {
              historicalAttemptCount: legacyReviewParkAttempts.consecutive,
            });
            if (outcome === "queued") {
              result.continuationRequeued += 1;
              result.dispositionRepairRequeued += 1;
              result.issueIds.push(issue.id);
            } else if (outcome === "escalated") {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }
          const { consecutive } = legacyReviewParkAttempts;
          if (consecutive >= INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS && latestPostResolutionRun) {
            const resolved = await resolveContinuationWaitingOnReview(issue);
            if (resolved) {
              result.waitingOnReviewResolved += 1;
              result.issueIds.push(issue.id);
              continue;
            }

            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: issue.status as StrandedPreviousStatus,
              latestRun: latestPostResolutionRun,
              comment:
                `Paperclip stopped requeueing accepted interaction \`${acceptedContinuationInteraction.id}\` after ` +
                `${consecutive} consecutive continuation wakes were cancelled while waiting on review. ` +
                "Moving the issue to `blocked` so the missing execution path is visible for intervention.",
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          const queued = await enqueueStrandedIssueRecovery({
            issueId: issue.id,
            agentId,
            reason: "issue_continuation_needed",
            retryReason: "issue_continuation_needed",
            source: "issue.interaction_continuation_recovery",
            retryOfRunId: latestPostResolutionRun?.id ?? acceptedContinuationInteraction.sourceRunId ?? latestRun?.id ?? null,
            extraContext: {
              mutation: "interaction",
              interactionId: acceptedContinuationInteraction.id,
              interactionKind: acceptedContinuationInteraction.kind,
              interactionStatus: acceptedContinuationInteraction.status,
              interactionContinuationPolicy: acceptedContinuationInteraction.continuationPolicy,
              interactionResolvedAt: acceptedInteractionResolvedAt.toISOString(),
            },
          });
          if (queued) {
            result.continuationRequeued += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

      if (issue.status === "in_review") {
        if (!participantAgentId || !pendingExecutionState) {
          result.skipped += 1;
          continue;
        }
        const participantLatestRun = participantLatestRunForRecovery;

        if (!participantLatestRun || !isTerminalIssueRun(participantLatestRun)) {
          if (!agentInvokable) {
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_review",
              latestRun: participantLatestRun,
              notice: buildExecutionReviewParticipantUnavailableNoticeSeed(),
              recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const participantAdapterFailureClassification = isUnsuccessfulTerminalIssueRun(participantLatestRun)
          ? classifyAdapterFailureForRecovery(participantLatestRun, recoveryNow)
          : null;
        if (participantAdapterFailureClassification?.kind === "provider_quota") {
          const monitored = await scheduleProviderQuotaRecoveryMonitor({
            issue,
            latestRun: participantLatestRun,
            classification: participantAdapterFailureClassification,
          });
          if (monitored) {
            latestRun = await persistAdapterFailureRecoveryClassification(
              participantLatestRun,
              participantAdapterFailureClassification,
            );
            result.providerQuotaMonitored += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
        if (participantAdapterFailureClassification?.kind === "configuration_incomplete") {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            recoveryCause: "configuration_incomplete",
            comment:
              "Paperclip classified the active review participant's latest adapter failure as " +
              "`configuration_incomplete`. Moving the issue to `blocked` with the configuration fix " +
              "recorded instead of repeatedly requeueing the reviewer.",
          });
          if (updated) {
            latestRun = await persistAdapterFailureRecoveryClassification(
              participantLatestRun,
              participantAdapterFailureClassification,
            );
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (!agentInvokable) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            notice: buildExecutionReviewParticipantUnavailableNoticeSeed(),
            recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (didAutomaticRecoveryFail(participantLatestRun, EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON)) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            notice: buildExecutionReviewParticipantRecoveryNoticeSeed(),
            recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await hasQueuedIssueWake(issue.companyId, issue.id, participantAgentId)) {
          result.skipped += 1;
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, participantAgentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId: participantAgentId,
          reason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          source: "issue.execution_review_recovery",
          retryOfRunId: participantLatestRun.id,
          extraContext: {
            currentStageId: pendingExecutionState.currentStageId ?? null,
            currentStageType: pendingExecutionState.currentStageType ?? null,
            reviewRecoveryInstruction:
              "The previous reviewer run ended while this execution-review stage was still pending. Submit the review decision now, or mark the issue blocked with the exact unblock action.",
          },
        });
        if (queued) {
          result.reviewParticipantRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (issue.status === "todo") {
        if (!latestRun) {
          if (await hasQueuedIssueWake(issue.companyId, issue.id)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const queued = await enqueueInitialAssignedTodoDispatch(issue, agentId);
          if (queued) {
            result.assignmentDispatched += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (
          latestRun.status === "succeeded" &&
          !(await wasTodoHandedBackDuringOrAfterLatestRun(issue, latestRun))
        ) {
          result.skipped += 1;
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            notice: {
              body:
                "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
                "but it still has no live execution path. " +
                "Moving it to `blocked` so it is visible for intervention.",
              title: "No live execution path",
              tone: "danger",
            },
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_assignment_recovery",
          retryReason: "assignment_recovery",
          source: "issue.assignment_recovery",
          retryOfRunId: latestRun.id,
        });
        if (queued) {
          result.dispatchRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (!latestRun && !issue.checkoutRunId && !issue.executionRunId) {
        result.skipped += 1;
        continue;
      }
      if (readDispositionRepairAttempt(latestRun)) {
        const outcome = await reconcileDispositionRepair(issue, latestRun);
        if (outcome === "queued") {
          result.continuationRequeued += 1;
          result.dispositionRepairRequeued += 1;
          result.issueIds.push(issue.id);
        } else if (outcome === "escalated") {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      const handoffEvidence = isExhaustedSuccessfulRunHandoff(latestRun);
      if (handoffEvidence) {
        if (isPluginManagedIssueLifecycle(issue)) {
          result.skipped += 1;
          continue;
        }
        if (!handoffEvidence.exhausted) {
          result.skipped += 1;
          continue;
        }

        const updated = await escalateStrandedAssignedIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
          successfulRunHandoffEvidence: handoffEvidence,
        });
        if (updated) {
          result.successfulRunHandoffEscalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isSuccessfulInProgressContinuationRun(latestRun)) {
        const successfulRun = latestRun;

        if (!isProductiveContinuationRun(successfulRun)) {
          result.successfulContinuationObserved += 1;
          result.skipped += 1;
          continue;
        }

        if (isRepeatedProductiveContinuationRecovery(successfulRun)) {
          // GGU-809: skip escalation if the assignee has shown visible progress
          // (comment or attachment) within the exemption window. Falling
          // through here lets the normal continuation-retry path enqueue the
          // next wake, which is the correct behaviour for batch workflows.
          const exempted = await hasRecentVisibleProgress(
            issue.companyId,
            issue.id,
            agentId,
            STRANDED_RECENT_PROGRESS_EXEMPTION_MS,
          );
          if (!exempted) {
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_progress",
              latestRun: successfulRun,
              comment:
                "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry " +
                "made progress, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.",
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }
          result.recentProgressExempted += 1;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.productive_terminal_continuation_recovery",
          retryOfRunId: successfulRun.id,
        });
        if (queued) {
          result.continuationRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isUnsuccessfulTerminalIssueRun(latestRun)) {
        const classification = classifyContinuationFailure(latestRun);

        if (classification.errorCode === CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE) {
          const resolved = await resolveContinuationWaitingOnReview(issue);
          if (resolved) {
            result.waitingOnReviewResolved += 1;
            result.issueIds.push(issue.id);
            continue;
          }

          const outcome = await reconcileDispositionRepair(issue, latestRun);
          if (outcome === "queued") {
            result.continuationRequeued += 1;
            result.dispositionRepairRequeued += 1;
            result.issueIds.push(issue.id);
          } else if (outcome === "escalated") {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (classification.kind === "non_retryable") {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun,
            notice: {
              body:
                "Paperclip detected a non-retryable failure on this issue's continuation run " +
                `(\`${classification.errorCode}\`). Skipping automatic retries and moving it to \`blocked\` ` +
                "so it is visible for intervention.",
              title: "Continuation failed",
              tone: "danger",
            },
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")) {
          const { consecutive, latestFinishedAt } = await summarizeRecentContinuationRetries(
            issue.companyId,
            issue.id,
            agentId,
            classification.errorCode,
          );
          if (consecutive >= classification.maxAttempts) {
            const attemptCopy = consecutive <= 1 ? "" : ` (${consecutive}× attempts)`;
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_progress",
              latestRun,
              notice: {
                body:
                  "Paperclip automatically retried continuation for this assigned `in_progress` issue after its live " +
                  `execution disappeared, but it still has no live execution path${attemptCopy}. ` +
                  "Moving it to `blocked` so it is visible for intervention.",
                title: "No live execution path",
                tone: "danger",
              },
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          if (classification.baseBackoffMs > 0 && latestFinishedAt) {
            const elapsed = Date.now() - latestFinishedAt.getTime();
            const requiredDelay = classification.baseBackoffMs *
              Math.pow(2, Math.max(0, consecutive - 1));
            if (elapsed < requiredDelay) {
              result.skipped += 1;
              continue;
            }
          }
        }
      }

      if (await isInvocationBudgetBlocked(issue, agentId)) {
        result.skipped += 1;
        continue;
      }

      const queued = await enqueueStrandedIssueRecovery({
        issueId: issue.id,
        agentId,
        reason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        retryOfRunId: latestRun?.id ?? issue.checkoutRunId ?? null,
      });
      if (queued) {
        result.continuationRequeued += 1;
        result.issueIds.push(issue.id);
      } else {
        result.skipped += 1;
      }
    }

    const orphanBlockerRecovery = await reconcileUnassignedBlockingIssues();
    result.orphanBlockersAssigned = orphanBlockerRecovery.assigned;
    result.skipped += orphanBlockerRecovery.skipped;
    result.issueIds.push(...orphanBlockerRecovery.issueIds);

    const activeRecovery = await reconcileActiveRecoveryActions();
    result.continuationRequeued += activeRecovery.requeued;
    result.escalated += activeRecovery.escalated;
    result.skipped += activeRecovery.skipped;
    result.issueIds.push(...activeRecovery.issueIds);
    result.issueIds = [...new Set(result.issueIds)];

    return result;
  }

  async function reconcileResolvedDependencyWakeBackstop(opts?: ResolvedDependencyWakeBackstopOptions) {
    const result = {
      checked: 0,
      healed: 0,
      existingWakeSkipped: 0,
      livePathSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
      notReadySkipped: 0,
      candidateLimitSkipped: 0,
      deferredOrFailed: 0,
      enqueueFailed: 0,
      issueIds: [] as string[],
    };

    const source = opts?.source ?? "issue_graph_liveness.backstop";
    const requestedByActorId = source === "workspace.finalize"
      ? "heartbeat_finalize"
      : "issue_graph_liveness_backstop";
    const payloadBackstop = source === "workspace.finalize"
      ? "workspace_finalize_reconciliation"
      : "issue_graph_liveness_reconciliation";
    const useCursor = !opts?.blockerIssueId;

    const queryCandidates = (afterIssueId: string | null) => {
      const filters = [
        eq(issues.status, "blocked"),
        visibleIssueCondition(),
        sql`${issues.assigneeAgentId} is not null`,
      ];
      if (opts?.companyId) filters.push(eq(issues.companyId, opts.companyId));
      if (afterIssueId) filters.push(gt(issues.id, afterIssueId));

      if (opts?.blockerIssueId) {
        filters.push(
          eq(issueRelations.companyId, issues.companyId),
          eq(issueRelations.type, "blocks"),
          eq(issueRelations.issueId, opts.blockerIssueId),
          eq(issueRelations.relatedIssueId, issues.id),
        );
        return db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            identifier: issues.identifier,
            assigneeAgentId: issues.assigneeAgentId,
            blockedTransitionAt: issues.blockedTransitionAt,
            totalCount: sql<number>`count(*) over()::int`,
          })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
          .where(and(...filters))
          .orderBy(asc(issues.id))
          .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
      }

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          assigneeAgentId: issues.assigneeAgentId,
          blockedTransitionAt: issues.blockedTransitionAt,
          totalCount: sql<number>`count(*) over()::int`,
        })
        .from(issues)
        .where(and(...filters))
        .orderBy(asc(issues.id))
        .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
    };

    let candidateRows = await queryCandidates(useCursor ? resolvedDependencyWakeBackstopCandidateCursor : null);
    if (useCursor && candidateRows.length === 0 && resolvedDependencyWakeBackstopCandidateCursor) {
      resolvedDependencyWakeBackstopCandidateCursor = null;
      candidateRows = await queryCandidates(null);
    }
    const totalCandidateCount = candidateRows[0]?.totalCount ?? 0;
    const candidates = candidateRows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    result.checked = candidates.length;
    result.candidateLimitSkipped = Math.max(0, totalCandidateCount - candidates.length);
    const lastCandidate = candidates[candidates.length - 1] ?? null;
    if (useCursor) {
      resolvedDependencyWakeBackstopCandidateCursor =
        result.candidateLimitSkipped > 0 && lastCandidate ? lastCandidate.id : null;
    }
    if (result.candidateLimitSkipped > 0) {
      logger.warn(
        {
          processed: candidates.length,
          skipped: result.candidateLimitSkipped,
          limit: RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT,
          nextCursor: useCursor ? resolvedDependencyWakeBackstopCandidateCursor : null,
          source,
          blockerIssueId: opts?.blockerIssueId ?? null,
        },
        "issue graph liveness backstop deferred resolved dependency wake candidates past page limit",
      );
    }

    const candidatesByCompany = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const companyCandidates = candidatesByCompany.get(candidate.companyId) ?? [];
      companyCandidates.push(candidate);
      candidatesByCompany.set(candidate.companyId, companyCandidates);
    }

    for (const [companyId, companyCandidates] of candidatesByCompany.entries()) {
      const readinessMap = await issuesSvc.listDependencyReadiness(
        companyId,
        companyCandidates.map((candidate) => candidate.id),
      );

      for (const candidate of companyCandidates) {
        const agentId = candidate.assigneeAgentId;
        if (!agentId) continue;

        const readiness = readinessMap.get(candidate.id);
        const resolvedBlockerIssueId = readiness?.blockerIssueIds[0] ?? null;
        if (
          !readiness ||
          !readiness.isDependencyReady ||
          readiness.blockerIssueIds.length === 0 ||
          !resolvedBlockerIssueId
        ) {
          result.notReadySkipped += 1;
          continue;
        }

        // Level-triggered dedup: key on the full blocker set (the current ready
        // state), not on any single resolved edge. An older completed per-edge
        // wake for an earlier partial resolution has a different key, so it does
        // not suppress this wake. The shared helper still suppresses a duplicate
        // wake for the SAME ready state, which bounds reconciliation.
        const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: candidate.id,
          blockerIssueIds: readiness.blockerIssueIds,
          blockedTransitionAt: candidate.blockedTransitionAt,
        });
        const existingWake = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
          companyId,
          dependentIssueId: candidate.id,
          blockerIssueIds: readiness.blockerIssueIds,
          blockedTransitionAt: candidate.blockedTransitionAt,
        });
        if (existingWake) {
          result.existingWakeSkipped += 1;
          continue;
        }

        if (
          await hasActiveExecutionPath(companyId, candidate.id, agentId) ||
          await hasQueuedIssueWake(companyId, candidate.id, agentId)
        ) {
          result.livePathSkipped += 1;
          continue;
        }

        if (await hasPendingWakeInteraction(companyId, candidate.id)) {
          result.interactionSkipped += 1;
          continue;
        }

        if (await isAutomaticRecoverySuppressedByPauseHold(db, companyId, candidate.id, treeControlSvc)) {
          result.pauseHoldSkipped += 1;
          continue;
        }

        try {
          const wake = await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            payload: {
              issueId: candidate.id,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
              backstop: payloadBackstop,
            },
            idempotencyKey,
            requestedByActorType: "system",
            requestedByActorId,
            contextSnapshot: {
              issueId: candidate.id,
              taskId: candidate.id,
              wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
              source,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
            },
          });
          if (!wake) {
            // enqueueWakeup returns null for normal deferred/skipped paths
            // such as disabled wake-on-demand or concurrency gating. That is
            // not an enqueue error, but the backstop still did not heal now.
            result.deferredOrFailed += 1;
            continue;
          }

          result.healed += 1;
          result.issueIds.push(candidate.id);

          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "issue_graph_liveness_backstop",
            agentId,
            runId: opts?.runId ?? null,
            action: "issue.blockers_resolved_wake_emitted",
            entityType: "issue",
            entityId: candidate.id,
            details: {
              source,
              wakeupRunId: wake.id,
              idempotencyKey,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
            },
          });
        } catch (err) {
          result.deferredOrFailed += 1;
          result.enqueueFailed += 1;
          logger.warn(
            { err, issueId: candidate.id, agentId, idempotencyKey, source },
            "failed to enqueue dependency wake from issue graph liveness backstop",
          );
        }
      }
    }

    if (result.healed > 0) {
      logger.warn(
        { healed: result.healed, issueIds: result.issueIds, source, blockerIssueId: opts?.blockerIssueId ?? null },
        "issue graph liveness backstop healed resolved blocked dependency wakes",
      );
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  // Backstop reconciler: terminalizes a "running" run that can no longer reach a
  // terminal status on its own. The run finalizer writes the terminal status in
  // a step that is separate from the agent status=done PATCH. When the teardown
  // stops between the two steps, heartbeat_runs.status stays "running" forever.
  // The UI reads liveness from that row, so the task shows "Live" forever. This
  // function forces the run to a terminal status and records a run event, so the
  // state is auditable. It never overwrites a status that another path already
  // made terminal.
  //
  // Two independent authorities terminalize the run. Either one is enough:
  //
  // - Issue-terminal authority: the run's issue already reached a terminal
  //   status (done or cancelled), but the run row is still "running". A healthy
  //   run always terminalizes its own row before or just after the issue reaches
  //   a terminal status, so a lasting "running" row under a terminal issue is
  //   orphaned. This authority does not depend on process death. It is the only
  //   authority that catches the reuse-lease path: the release stops the sandbox
  //   but keeps the server process alive, so the in-memory handle and the
  //   recorded pid can both persist.
  // - Process-death authority: the run has no in-memory handle and its recorded
  //   process and process group are both gone. This catches a hard server crash
  //   that skipped the graceful teardown, even when the issue is not terminal.
  async function terminalizeOrphanedRunningRun(
    run: typeof heartbeatRuns.$inferSelect,
    options?: {
      // The terminal run status implied by a referencing issue. The caller
      // passes it when it already knows the issue that holds the run in a lock
      // column. It maps issue "done" to "succeeded" and issue "cancelled" to
      // "cancelled". A null value means the referencing issue is not terminal.
      referencingIssueTerminalStatus?: "succeeded" | "cancelled" | null;
      // True when an active (non-terminal) issue still holds this run in a lock
      // column. The run is live for that active issue, so the caller forbids the
      // issue-terminal authority. This flag also suppresses the context-snapshot
      // fallback below. Without it, a terminal issue named in the run context
      // snapshot would still terminalize the shared run and defeat the guard.
      runReferencedByActiveIssue?: boolean;
    },
  ): Promise<{ terminalized: boolean; status: string }> {
    // Act only on a run in "running" status. A "queued" run has no process yet,
    // and a "scheduled_retry" run has no process on purpose because it waits to
    // retry. Neither is orphaned, so this function must not terminalize them.
    if (run.status !== "running") return { terminalized: false, status: run.status };

    const pid = run.processPid ?? null;
    const processGroupId = run.processGroupId ?? null;

    // Issue-terminal authority. When the run's issue is terminal, the run row is
    // orphaned regardless of process or handle state. Prefer the referencing
    // issue status that the caller passed, because a lock column is the direct
    // link from the stuck "Live" issue to this run. Fall back to the issue id in
    // the run context snapshot when the caller passed nothing. Skip the fallback
    // when an active issue still references the run. The run is live for that
    // active issue, so a terminal issue named in the context snapshot must not
    // terminalize it.
    let issueTerminalStatus: "succeeded" | "cancelled" | null =
      options?.referencingIssueTerminalStatus ?? null;
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueTerminalStatus && !options?.runReferencedByActiveIssue && issueId) {
      const issueStatus = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]?.status ?? null);
      if (issueStatus === "done") issueTerminalStatus = "succeeded";
      else if (issueStatus === "cancelled") issueTerminalStatus = "cancelled";
    }

    // Process-death authority. The run is live only when a process still backs
    // it. Check the in-memory handle first, then the recorded pid and process
    // group. Require recorded process metadata, so this authority never fires on
    // a run that has not yet stored its pid.
    let processGone = false;
    if (!runningProcesses.get(run.id)) {
      if (typeof pid === "number" || typeof processGroupId === "number") {
        const processAlive =
          (typeof pid === "number" && isPidAlive(pid)) ||
          (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
        processGone = !processAlive;
      }
    }

    // A result-less native run may intentionally have no live provider process
    // while the native finalization coordinator waits to resume the same
    // provider session. That coordinator, rather than this generic
    // process-death backstop, owns retryable/resumed attempts. Preserve issue
    // terminality as the stronger authority, but never interrupt coordinator-
    // owned recovery merely because the provider process has exited.
    if (!issueTerminalStatus && processGone && run.runtimeMode === "native") {
      const coordinator = await db
        .select({
          phase: nativeRunFinalizations.phase,
          resultId: nativeRunFinalizations.resultId,
          attempt: nativeRunFinalizations.attempt,
        })
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, run.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const nativeResumeOwnsRun = coordinator?.resultId === null && (
        coordinator.phase === "retryable_failure"
        || (coordinator.phase === "observed" && coordinator.attempt > 0)
      );
      if (nativeResumeOwnsRun) {
        return { terminalized: false, status: run.status };
      }
    }

    // Neither authority applies. The run is still live, so leave it alone.
    if (!issueTerminalStatus && !processGone) {
      return { terminalized: false, status: run.status };
    }

    const authority = issueTerminalStatus ? "issue_terminal" : "process_gone";
    const terminalStatus = issueTerminalStatus ?? "interrupted";
    const errorCode = issueTerminalStatus
      ? "orphaned_running_run_issue_terminal"
      : "orphaned_running_run";
    const message =
      authority === "issue_terminal"
        ? "run terminalized by recovery backstop: issue reached a terminal status while heartbeat_runs.status stayed live"
        : "run terminalized by recovery backstop: process and sandbox gone while heartbeat_runs.status stayed live";

    const now = new Date();
    const updated = await db
      .update(heartbeatRuns)
      .set({
        status: terminalStatus,
        finishedAt: run.finishedAt ?? now,
        error: run.error ?? (terminalStatus === "interrupted" ? message : null),
        errorCode: run.errorCode ?? (terminalStatus === "interrupted" ? errorCode : null),
        updatedAt: now,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) {
      // Another path finalized the run between the read and this write. Keep
      // that terminal outcome authoritative.
      const [current] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id));
      return { terminalized: false, status: current?.status ?? run.status };
    }

    runningProcesses.delete(run.id);
    // The run update above already committed the terminal status. The audit
    // event is best-effort: if the insert fails, the caller must still treat
    // the run as terminalized and clear the lock in the same sweep. So catch
    // the failure, log it, and continue. A thrown error here would abort the
    // sweep and leave the stale lock in place.
    try {
      await appendRecoveryRunEvent(updated, {
        level: "warn",
        message,
        payload: {
          source: "recovery.sweep_stale_issue_locks",
          authority,
          previousStatus: run.status,
          terminalStatus,
          ...(issueId ? { issueId } : {}),
          pid,
          processGroupId,
        },
      });
    } catch (error) {
      logger.error(
        { err: error, runId: run.id, previousStatus: run.status },
        "failed to append recovery run event after terminalizing orphaned run; run stays terminal and the sweep clears the lock",
      );
    }
    logger.warn(
      { runId: run.id, authority, previousStatus: run.status, terminalStatus, issueId, pid, processGroupId },
      "terminalized orphaned running heartbeat run in stale-lock sweep",
    );
    return { terminalized: true, status: updated.status };
  }

  // Backstop sweeper: clears stale lock columns on issues whose checkoutRunId
  // or executionRunId points at a heartbeat_runs row that is either missing or
  // in a terminal status. Provides self-heal for stale locks that fell outside
  // releaseIssueExecutionAndPromote / clearCheckoutRunIfTerminal / adoption.
  // Before it evaluates cleanability, it terminalizes any referenced run that
  // still claims to be live but can no longer reach a terminal status on its
  // own, so a stuck "running" run can no longer block the sweep. Idempotent and
  // safe: clears at most one row's worth of lock columns per candidate.
  async function sweepStaleIssueLocks() {
    const result = {
      cleared: 0,
      issueIds: [] as string[],
      terminalizedRunIds: [] as string[],
    };

    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(
        sql`(${issues.checkoutRunId} is not null or ${issues.executionRunId} is not null)`,
      );

    const referencedRunIds = [
      ...new Set(
        candidates
          .flatMap((issue) => [issue.checkoutRunId, issue.executionRunId])
          .filter((id): id is string => !!id),
      ),
    ];
    const runRows =
      referencedRunIds.length > 0
        ? await db
            .select()
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.id, referencedRunIds))
        : [];
    const runStatusById = new Map<string, string>();
    for (const row of runRows) runStatusById.set(row.id, row.status);

    // Collect the runs that a non-terminal issue still references. Such a run is
    // the live run of an active issue. A different, terminal issue can also hold
    // the same run id in a stale lock column. The terminal reference alone must
    // not terminalize a run that an active issue still owns, so exclude these
    // runs from the issue-terminal authority below.
    const runIdsReferencedByActiveIssue = new Set<string>();
    for (const issue of candidates) {
      if (issue.status === "done" || issue.status === "cancelled") continue;
      for (const runId of [issue.checkoutRunId, issue.executionRunId]) {
        if (runId) runIdsReferencedByActiveIssue.add(runId);
      }
    }

    // Map each referenced run to the terminal run status implied by its
    // referencing issue. When a terminal issue still holds the run in a lock
    // column, that run is orphaned: the issue is the stuck "Live" task the UI
    // shows. A "done" issue implies "succeeded"; a "cancelled" issue implies
    // "cancelled". Skip a run that an active issue also references, because that
    // run is still live for the active issue.
    const issueTerminalStatusByRunId = new Map<string, "succeeded" | "cancelled">();
    for (const issue of candidates) {
      const implied =
        issue.status === "done"
          ? "succeeded"
          : issue.status === "cancelled"
            ? "cancelled"
            : null;
      if (!implied) continue;
      for (const runId of [issue.checkoutRunId, issue.executionRunId]) {
        if (runId && !runIdsReferencedByActiveIssue.has(runId)) {
          issueTerminalStatusByRunId.set(runId, implied);
        }
      }
    }

    // Pre-pass: terminalize any referenced run that still claims to be live but
    // can no longer reach a terminal status on its own. This lets the sweep
    // clear the lock in the same pass instead of waiting for the run to reach a
    // terminal status by another route.
    for (const row of runRows) {
      const outcome = await terminalizeOrphanedRunningRun(row, {
        referencingIssueTerminalStatus: issueTerminalStatusByRunId.get(row.id) ?? null,
        runReferencedByActiveIssue: runIdsReferencedByActiveIssue.has(row.id),
      });
      runStatusById.set(row.id, outcome.status);
      if (outcome.terminalized) result.terminalizedRunIds.push(row.id);
    }

    const isCleanable = (runId: string | null) => {
      if (!runId) return true;
      const status = runStatusById.get(runId);
      if (!status) return true; // missing run row → no real claim
      return TERMINAL_HEARTBEAT_RUN_STATUSES.has(status);
    };

    for (const issue of candidates) {
      if (!isCleanable(issue.checkoutRunId) || !isCleanable(issue.executionRunId)) {
        continue;
      }

      const updated = await db
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issue.id),
            issue.checkoutRunId
              ? eq(issues.checkoutRunId, issue.checkoutRunId)
              : isNull(issues.checkoutRunId),
            issue.executionRunId
              ? eq(issues.executionRunId, issue.executionRunId)
              : isNull(issues.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      if (!updated) continue;

      result.cleared += 1;
      result.issueIds.push(updated.id);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.stale_lock_cleared",
        entityType: "issue",
        entityId: updated.id,
        details: {
          source: "recovery.sweep_stale_issue_locks",
          clearedCheckoutRunId: issue.checkoutRunId,
          clearedExecutionRunId: issue.executionRunId,
          referencedRunStatuses: Object.fromEntries(runStatusById),
        },
      });
    }

    if (result.cleared > 0 || result.terminalizedRunIds.length > 0) {
      logger.warn(
        {
          cleared: result.cleared,
          issueIds: result.issueIds,
          terminalizedRunIds: result.terminalizedRunIds,
        },
        "swept stale issue lock columns",
      );
    }

    return result;
  }

  return {
    buildRunOutputSilence,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    reconcileStrandedAssignedIssues,
    sweepStaleIssueLocks,
    reconcileResolvedDependencyWakeBackstop,
    readRecoveryTimerIntervalMs,
  };
}
