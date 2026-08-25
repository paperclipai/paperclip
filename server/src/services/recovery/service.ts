import { and, asc, desc, eq, gt, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
  ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type IssueGraphLivenessAutoRecoveryPreview,
  type IssueGraphLivenessAutoRecoveryPreviewItem,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  approvals,
  activityLog,
  companies,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueLabels,
  issueWorkProducts,
  issues,
  labels,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { HttpError, forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../local-service-supervisor.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactSensitiveText } from "../../redaction.js";
import { isUniqueViolation } from "../../db-errors.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { TERMINAL_HEARTBEAT_RUN_STATUSES, issueService } from "../issues.js";
import { hasExplicitExternalOwnerAction } from "../issue-blocked-gate.js";
import { measureCloseEvidence, type CloseEvidenceMeasurement } from "../issue-close-evidence.js";
import {
  applyIssueMonitorPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../issue-execution-policy.js";
import {
  DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
  findStillBlockedDependencyWakeSuppression,
} from "../issue-dependency-wakeups.js";
import {
  evaluateAgentInvokabilityFromDb,
  isRecoveryOwnerCandidateEligible,
} from "../agent-invokability.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  agentSatisfiesIssueToolRequirements,
  compareAgentsByIssueToolRequirements,
  inferIssueToolRequirements,
  type AgentCapabilityRoutingInput,
} from "../issue-capability-routing.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  hasEventDrivenHubIdlePath,
  isStandingExemptIssue,
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
  buildIssueGraphLivenessLeafKey,
  buildIssueGraphLivenessRootCauseKey,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "./origins.js";
import {
  classifyIssueGraphLiveness,
  type IssueLivenessFinding,
} from "./issue-graph-liveness.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import {
  INTENTIONAL_COMPANY_PAUSE_OUTCOME,
  evaluateRecoverySuppression,
  isIntentionalCompanyPauseReason,
} from "./pause-hold-guard.js";
import {
  RECOVERY_REVIEW_ESCALATION_THRESHOLD,
  bumpConsecutiveReviewCount,
  isCompanyRecoveryDormant,
  resetConsecutiveReviewCount,
  resolveCheapRecoveryReviewerAgentId,
} from "./cheap-reviewer.js";
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
export const DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS = 60 * 60 * 1000;
const ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES = 8 * 1024;
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
// Min idle (hours) before a blocked issue with no actionable blocker chain is
// flagged as a wedge by the issue-graph liveness classifier.
const ISSUE_GRAPH_LIVENESS_BLOCKED_STALE_HOURS = 48;
// Cap on NEW liveness escalations created per auto-recovery run, so a large
// stale backlog coming into scope drip-feeds rather than bursting (the churn
// that prompted pausing auto-recovery). Remaining findings are picked up on
// subsequent runs.
const ISSUE_GRAPH_LIVENESS_MAX_ESCALATIONS_PER_RUN = 10;
const ISSUE_GRAPH_LIVENESS_BASE_BACKOFF_MS = 15 * 60 * 1000;
const ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS = 3;
const STRANDED_NO_INVOKABLE_RECOVERY_OWNER_BASE_BACKOFF_MS = 15 * 60 * 1000;
const STRANDED_NO_INVOKABLE_RECOVERY_OWNER_MAX_ATTEMPTS = 3;
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
const RESTART_LANE_RECOVERY_BATCH_SIZE = 5;
const RESTART_LANE_RECOVERY_BATCH_TIMEOUT_MS = 30_000;
const RESTART_LANE_RECOVERY_ISSUE_TITLE = "Restart-lane recovery sweep — unrecoverable agents";
const RESTART_LANE_RECOVERY_ERROR_PREFIX = "restart_lane_recovery_unrecoverable:";
const RESTART_LANE_RECOVERY_SIGNATURE_RE = /(?:\bconnection_close(?:d)?\b|\bprocess_exit\b[\s\S]{0,240}\bsignal["':=\s]*SIGTERM\b|\bProcess lost -- child pid\b)/i;

// GGU-809: when a stranded `in_progress` issue would otherwise hit the
// `isRepeatedProductiveContinuationRecovery` escalation path, exempt the
// escalation if the assignee posted a comment or attachment within this window.
// Batch workflows (e.g. Image Spec multi-frame generation) make real progress
// every heartbeat and would otherwise trigger a recovery issue after just two
// productive heartbeats. Floor the override at 60s to keep the exemption from
// being effectively disabled by misconfiguration.
/**
 * TSMC-21406: minimum age of an assignment before the stranded healer may call it
 * stranded. TSMC-21384 was escalated to the board 108 seconds after creation.
 */
export const STRANDED_ASSIGNMENT_GRACE_MS = 15 * 60 * 1000;

/**
 * TSMC-21406: if the owning agent has succeeded at anything inside this window it
 * is alive, and a lost wake on one issue is not a lost execution path.
 */
export const STRANDED_LANE_LIVENESS_WINDOW_MS = 60 * 60 * 1000;

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

type StrandedRecoveryCause =
  | "close_evidence_unmet"
  | "stranded_assigned_issue"
  | "deliberate_wait_without_target"
  | "process_lost"
  | "provider_quota"
  | "detached_execution_required"
  | "codex_output_inactivity_monitor"
  | "workspace_validation_failed"
  | "configuration_incomplete"
  | "execution_review_participant_recovery"
  | "agent_not_invokable"
  | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;

/** Stable machine-readable cause stamped on assignee-outage blocks (TSMC-19827/19829). */
export const ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE = "assignee_not_invokable";
export const ASSIGNEE_NOT_INVOKABLE_UNBLOCK_ACTION =
  "Restore a live execution path after the assignee becomes invokable again (cause:assignee_not_invokable).";

export function buildAssigneeNotInvokableUnblockDescriptor() {
  return {
    owner: "board" as const,
    action: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_ACTION,
  };
}

export function isAssigneeNotInvokableUnblockDescriptor(descriptor: unknown): boolean {
  if (!descriptor || typeof descriptor !== "object") return false;
  const action = (descriptor as { action?: unknown }).action;
  return typeof action === "string" &&
    (
      action.includes(`cause:${ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE}`) ||
      action === ASSIGNEE_NOT_INVOKABLE_UNBLOCK_ACTION
    );
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
    case "agent_not_invokable":
      return "assignee not invokable";
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
  return /(?:usage|rate|quota) limit|quota (?:exceeded|reset)|try again after/i.test(latestRun.error ?? "");
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

// Open stale-active-run evaluation issue, keyed by the run it was raised for.
// `identifier` is nullable because issues.identifier is a nullable column — an
// issue can exist before its company prefix assigns one.
type OpenStaleRunEvaluation = {
  id: string;
  identifier: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  updatedAt: Date;
};

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

function isCodexUntrustedDirectoryFailure(latestRun: LatestIssueRun): boolean {
  return latestRun?.errorCode === "adapter_failed" &&
    CODEX_UNTRUSTED_DIRECTORY_ERROR_RE.test(latestRun.error ?? "");
}

function readConfigurationIncompleteRemediation(run: LatestIssueRun) {
  const configurationIncomplete = parseObject(parseObject(run?.resultJson).configurationIncomplete);
  return readNonEmptyString(configurationIncomplete.remediation);
}

export function summarizeRunFailureForIssueComment(run: LatestIssueRun) {
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

function isVerifiedOperatorInterruptedRunForIssue(latestRun: LatestIssueRun, issueId: string) {
  if (latestRun?.status !== "cancelled" || latestRun.errorCode !== "operator_interrupted") return false;

  const result = parseObject(latestRun.resultJson);
  const interruptionSource = readNonEmptyString(result.interruptionSource);
  return (
    asBoolean(result.operatorInterrupted, false) === true &&
    (interruptionSource === "issue_comment_interrupt" || interruptionSource === "heartbeat_run_cancel") &&
    readNonEmptyString(result.interruptedIssueId) === issueId
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
  // A bare non-zero agy exit has no diagnostic signature and is known to flake
  // across otherwise healthy lanes. Retry it with the normal bounded backoff
  // before recovery decides the issue needs intervention (TSMC-20910).
  "antigravity_transient_silent_exit",
  "provider_quota",
  "timeout",
]);

const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set<string>([
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  // Per-run adapter governors are a deliberate stop, not a transient failure.
  // Re-running the same large prompt automatically would only burn another
  // allowance; a human or manager must split/re-scope the work first.
  "token_budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
  "gemini_quota_exhausted",
  "antigravity_quota_exhausted",
]);

// A continuation cancelled with this code is a *deliberate wait* (the latest run
// reported it was parked for review/approval), not a lost execution path. When the
// issue has a real waiting target we convert it into a normal dependency wait rather
// than escalating it as stranded.
const CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE = "issue_continuation_waiting_on_review";
const CODEX_UNTRUSTED_DIRECTORY_ERROR_RE =
  /^Not inside a trusted directory and --skip-git-repo-check was not specified\.?$/i;
const INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS = 3;
const CONTINUATION_NO_PROGRESS_MAX_ATTEMPTS = 3;
const STANDING_EXEMPT_RECOVERY_ACTION_KINDS = new Set<string>(["missing_disposition", "stranded_assigned_issue"]);

// Hard ceiling on how many SEPARATE recovery actions one issue may burn for one cause before the
// board is asked instead of another agent cycle. `maxAttempts` bounds retries within a single
// action; this bounds the number of actions. TSMC-19481 consumed eight `missing_disposition`
// actions with no outstanding work — the lane could not DELIVER a disposition, so re-dispatching
// could never converge. Repeated identical failure is an escalation, not a retry.
const MAX_RECOVERY_ACTIONS_PER_ISSUE_KIND = 3;
// Rolling window for the cap count — see countPriorRecoveryActionsForIssue. Loops burn the cap
// within hours; legitimate repeated recoveries on a long-lived issue are spaced far wider.
const RECOVERY_LOOP_CAP_WINDOW_MS = 72 * 60 * 60 * 1000;

const CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3;
// A configured wall-clock timeout is a bounded execution contract, not an
// invitation to spend several more full windows on the same stuck task. The
// first timeout gets one clean continuation attempt (often enough for a
// transient host/provider stall); if that continuation also times out, the
// normal recovery path escalates it to blocked for an explicit re-scope.
const CONTINUATION_TIMEOUT_RECOVERY_MAX_ATTEMPTS = 1;
const CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS = 1;
const CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS = 60_000;
const SOURCE_SCOPED_RECOVERY_MIN_REFIRE_INTERVAL_MS = 60_000;
const MISSING_DISPOSITION_RECOVERY_MAX_ATTEMPTS = CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS;
export const PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

const PROVIDER_QUOTA_ERROR_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit(?: reached| exceeded)?|provider quota|quota (?:limit )?exceeded|model (?:is )?at capacity)/i;
const CONFIGURATION_INCOMPLETE_ERROR_RE =
  /(?:model_not_found|model [^\n]{0,120} not found|missing (?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing|no (?:api )?(?:key|credentials?) (?:was |were )?(?:found|configured|provided)|api key (?:is )?(?:not set|unavailable))/i;

export type AdapterFailureRecoveryClassification =
  | { kind: "provider_quota"; retryAt: Date; parsedResetTime: boolean }
  | { kind: "configuration_incomplete" }
  | null;

function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(
    /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i,
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
  if (isCodexUntrustedDirectoryFailure(latestRun)) {
    return { kind: "non_retryable", maxAttempts: 0, baseBackoffMs: 0, errorCode };
  }
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
      maxAttempts:
        errorCode === "timeout"
          ? CONTINUATION_TIMEOUT_RECOVERY_MAX_ATTEMPTS
          : CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
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

function isDetachedExecutionRequiredRun(latestRun: LatestIssueRun) {
  return readNonEmptyString(latestRun?.errorCode) === "max_turns_exhausted";
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

function readSuggestedCapabilityAgentIds(error: unknown): string[] {
  const details = parseObject((error as { details?: unknown } | null | undefined)?.details);
  const suggestedAgentIds = details?.suggestedAgentIds;
  if (!Array.isArray(suggestedAgentIds)) return [];
  return suggestedAgentIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function isToolCapabilityAssignmentError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; message?: unknown };
  return candidate.status === 422 &&
    candidate.message === "Assigned agent does not satisfy the issue's required tool capabilities";
}

function formatDuration(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
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

function unwrapDatabaseConflictError(error: unknown) {
  if (!error || typeof error !== "object") return null;

  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
    cause?: unknown;
  };

  if (
    typeof candidate.code === "string" ||
    typeof candidate.constraint === "string" ||
    typeof candidate.constraint_name === "string"
  ) {
    return candidate;
  }

  const cause = candidate.cause;
  if (!cause || typeof cause !== "object") return candidate;

  return cause as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
}

function isOperatorCancelledRun(latestRun: LatestIssueRun, issueId: string): boolean {
  return isVerifiedOperatorInterruptedRunForIssue(latestRun, issueId);
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

function parseLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  return parseIssueGraphLivenessIncidentKey(incidentKey);
}

function livenessRecoveryLeafIssueId(finding: IssueLivenessFinding) {
  return finding.recoveryIssueId;
}

function livenessRecoveryLeafFingerprint(finding: IssueLivenessFinding) {
  return buildIssueGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafIssueId: livenessRecoveryLeafIssueId(finding),
  });
}

function livenessRecoveryLeafKey(companyId: string, state: string, leafIssueId: string) {
  return buildIssueGraphLivenessLeafKey({ companyId, state, leafIssueId });
}

// TSMC-20489: `finding.issueId` is the top-level "source" issue the classifier
// is examining (== dependencyPath[0] — see `finding()` in issue-graph-liveness.ts,
// which seeds dependencyPath with `source` and stamps `issueId: source.id`). It
// stays constant across reconcile ticks for as long as the source issue remains
// in this state, even when the deepest blocker found (the "leaf"/recoveryIssueId)
// changes tick to tick as the blocker chain evolves. That makes it the right key
// for a coarser, source-scoped rollup above the existing per-leaf dedup.
function livenessRecoveryRootCauseFingerprint(finding: IssueLivenessFinding) {
  return buildIssueGraphLivenessRootCauseKey({
    companyId: finding.companyId,
    state: finding.state,
    sourceIssueId: finding.issueId,
  });
}

function isUniqueLivenessRecoveryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; constraint?: string; message?: string };
  return maybe.code === "23505" &&
    (
      maybe.constraint === "issues_active_liveness_recovery_incident_uq" ||
      maybe.constraint === "issues_active_liveness_recovery_leaf_uq" ||
      typeof maybe.message === "string" &&
        (
          maybe.message.includes("issues_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("issues_active_liveness_recovery_leaf_uq")
        )
    );
}

function formatDependencyPath(finding: IssueLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.issueId)
    .join(" -> ");
}

function buildLivenessEscalationDescription(finding: IssueLivenessFinding) {
  const source = finding.dependencyPath[0];
  const recovery = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
  const selectedOwner = finding.recommendedOwnerAgentId ?? "none";

  return [
    "Paperclip detected a harness-level issue graph liveness incident.",
    "",
    "## Source",
    "",
    `- Source issue: ${source?.identifier ?? source?.issueId ?? finding.issueId}`,
    `- Recovery target issue: ${recovery?.identifier ?? recovery?.issueId ?? finding.recoveryIssueId}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Detected invariant: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    "",
    "## Ownership",
    "",
    `- Selected owner agent: \`${selectedOwner}\``,
    `- Candidate owner agents: ${finding.recommendedOwnerCandidateAgentIds.length > 0 ? finding.recommendedOwnerCandidateAgentIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
    "## Next Action",
    "",
    finding.recommendedAction,
    "",
    "Resolve the blocked chain, then mark this escalation issue done so the original issue can resume when all blockers are cleared.",
  ].join("\n");
}

function buildLivenessOriginalIssueComment(finding: IssueLivenessFinding, escalation: typeof issues.$inferSelect) {
  return [
    "Paperclip detected a harness-level liveness incident in this issue's dependency graph.",
    "",
    `- Escalation issue: ${escalation.identifier ?? escalation.id}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Finding: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    `- Manager action requested: ${finding.recommendedAction}`,
    "",
    "This issue now keeps its existing blockers and is also blocked by the escalation issue so dependency wakeups remain explicit.",
  ].join("\n");
}

export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const interactionsSvc = issueThreadInteractionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();
  let resolvedDependencyWakeBackstopCandidateCursor: string | null = null;
  let restartLaneRecoverySweepInFlight: Promise<RestartLaneRecoverySweepResult> | null = null;

  type RestartLaneRecoverySweepResult = {
    candidates: number;
    reset: number;
    recovered: number;
    unrecoverable: number;
    skipped: number;
    batchSizes: number[];
    successorRunIds: string[];
    unrecoverableAgentIds: string[];
    issueIds: string[];
  };

  type RestartLaneCandidate = {
    agent: typeof agents.$inferSelect;
    failedRun: Pick<typeof heartbeatRuns.$inferSelect, "id" | "status" | "error" | "errorCode" | "resultJson" | "createdAt">;
  };

  type RestartLaneUnrecoverable = RestartLaneCandidate & {
    reason: string;
    attemptCount: number;
  };

  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  /**
   * TSMC-20760: a company pause is an operator decision, not a recovery failure.
   * Resolve an already-visible recovery action exactly once so the audit trail
   * explains why the automatic reassign/invoke/liveness path stopped.  We do not
   * create a fresh action merely to report a pause: that would itself be the
   * duplicate recovery/liveness work the pause is meant to prevent.
   */
  async function evaluateAutomaticRecoverySuppression(companyId: string, issueId: string) {
    const decision = await evaluateRecoverySuppression(db, companyId, issueId, treeControlSvc);
    if (!decision.suppressed || !isIntentionalCompanyPauseReason(decision.reason)) return decision;

    const activeAction = await recoveryActionsSvc.getActiveForIssue(companyId, issueId);
    if (activeAction) {
      const resolved = await recoveryActionsSvc.resolveActiveForIssue({
        companyId,
        sourceIssueId: issueId,
        actionId: activeAction.id,
        status: "resolved",
        outcome: INTENTIONAL_COMPANY_PAUSE_OUTCOME,
        resolutionNote: `Automatic recovery suppressed by intentional company pause (${decision.reason}).`,
      });
      if (resolved) {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "system",
          agentId: null,
          runId: null,
          action: "issue.recovery_suppressed",
          entityType: "issue",
          entityId: issueId,
          details: {
            outcome: INTENTIONAL_COMPANY_PAUSE_OUTCOME,
            suppressionReason: decision.reason,
            recoveryActionId: resolved.id,
          },
        });
      }
    }
    return decision;
  }

  async function listCompanyAgentsForToolRouting(companyId: string): Promise<AgentCapabilityRoutingInput[]> {
    return db
      .select({
        id: agents.id,
        name: agents.name,
        title: agents.title,
        capabilities: agents.capabilities,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
  }

  async function findCapabilityMatchedRecoveryOwner(input: {
    companyId: string;
    title: string;
    description?: string | null;
    labels?: string[] | null;
    excludeAgentIds?: string[];
  }) {
    const requirements = inferIssueToolRequirements({
      title: input.title,
      description: input.description ?? null,
      labels: input.labels ?? [],
    });
    if (!requirements.requiresMediaTools) return null;

    const excluded = new Set(input.excludeAgentIds ?? []);
    const candidates = await listCompanyAgentsForToolRouting(input.companyId);
    const capable = candidates
      .filter((candidate) => !excluded.has(candidate.id))
      .filter((candidate) => agentSatisfiesIssueToolRequirements(candidate, requirements))
      .sort((left, right) => compareAgentsByIssueToolRequirements(left, right, requirements));
    if (capable.length === 0) return {
      requirements,
      selectedAgentId: null,
      candidateAgentIds: [],
    };

    for (const candidate of capable) {
      const fullAgent = await getAgent(candidate.id);
      if (!fullAgent || fullAgent.companyId !== input.companyId) continue;
      if (!(await isAgentInvokable(fullAgent))) continue;
      return {
        requirements,
        selectedAgentId: fullAgent.id,
        candidateAgentIds: capable.map((entry) => entry.id),
      };
    }

    return {
      requirements,
      selectedAgentId: null,
      candidateAgentIds: capable.map((entry) => entry.id),
    };
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
        resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
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
          // Local (TSMC-13xxx): claimed/deferred wakes still cover the issue —
          // enqueueing another stranded-continuation wake would duplicate them.
          inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
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
          eq(issueThreadInteractions.status, "accepted"),
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
    // TSMC-20822: assignment-recovery re-enqueues are resume deltas — run
    // them on the status_only profile (cheap, no deliverable work) and let
    // resumeRequiresNormalModel hand real work back to the normal profile.
    // Continuations of in-progress work keep the normal profile.
    const requeuePayload = {
      issueId: input.issueId,
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      ...(input.extraContext ?? {}),
    };
    const requeueContext = {
      issueId: input.issueId,
      taskId: input.issueId,
      wakeReason: input.reason,
      retryReason: input.retryReason,
      source: input.source,
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      ...(input.extraContext ?? {}),
    };
    const statusOnlyRequeue = input.retryReason === "assignment_recovery";
    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: statusOnlyRequeue
        ? withRecoveryModelProfileHint(requeuePayload, "status_only")
        : withRecoveryModelProfileHint(requeuePayload, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: statusOnlyRequeue
        ? withRecoveryModelProfileHint(requeueContext, "status_only")
        : withRecoveryModelProfileHint(requeueContext, "normal_model"),
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
      payload: withRecoveryModelProfileHint({
        issueId: issue.id,
        // Keep automatic dispatch on the same stable task-session key used by
        // board-scoped issue wakes. `issue.id` remains the authority for issue
        // lookup; the human identifier is the session address.
        taskKey: issue.identifier,
        mutation: "assigned_todo_liveness_dispatch",
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: issue.id,
        taskId: issue.id,
        taskKey: issue.identifier,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }, "normal_model"),
    });
  }

  /**
   * TSMC-21406: is the owning lane demonstrably alive?
   *
   * The stranded healer escalates "no live execution path" to a BOARD decision.
   * On 2026-08-24 it did that to TSMC-21384 **108 seconds** after the card was
   * created, and the owning lane (Engineer-Codex) was `running` an hour later —
   * the wake had been lost, not the lane. Every such escalation costs an operator
   * decision; TSMC-21268 sat P-critical and unanswered for 18h as an earlier
   * output of the same path.
   *
   * A lane with a succeeded run inside the window is not stranded, whatever the
   * latest run for this one issue looks like. This is deliberately a check on the
   * AGENT, not on the issue: the issue's own evidence is exactly what a lost wake
   * makes misleading.
   */
  async function hasRecentSuccessfulAgentRun(agentId: string, windowMs: number) {
    const since = new Date(Date.now() - windowMs);
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "succeeded"),
          gt(heartbeatRuns.finishedAt, since),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
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
        payload: withRecoveryModelProfileHint({
          issueId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        }, "normal_model"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
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

  function staleActiveRunOriginFingerprint(companyId: string, runId: string) {
    return `stale_active_run:${companyId}:${runId}`;
  }

  function isTerminalIssueStatus(status: string | null | undefined) {
    return status === "done" || status === "cancelled";
  }

  function isRecoveryOriginIssue(issue: typeof issues.$inferSelect) {
    return Object.values(RECOVERY_ORIGIN_KINDS).includes(
      issue.originKind as typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS],
    );
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function latestActiveOutputQuietUntilDecision(companyId: string, runId: string, now = new Date()) {
    const [row] = await db
      .select()
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
      .limit(1);
    return row ?? null;
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
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

  async function latestActiveOutputQuietUntilDecisions(
    companyId: string,
    runIds: string[],
    now = new Date(),
  ) {
    if (runIds.length === 0) return new Map<string, typeof heartbeatRunWatchdogDecisions.$inferSelect>();

    const rows = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          inArray(heartbeatRunWatchdogDecisions.runId, runIds),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt));

    const map = new Map<string, typeof heartbeatRunWatchdogDecisions.$inferSelect>();
    for (const row of rows) {
      if (!map.has(row.runId)) {
        map.set(row.runId, row);
      }
    }
    return map;
  }

  async function findOpenStaleRunEvaluations(companyId: string, runIds: string[]) {
    if (runIds.length === 0) {
      return new Map<string, OpenStaleRunEvaluation>();
    }

    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
        originId: issues.originId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          inArray(issues.originId, runIds),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );

    const map = new Map<string, OpenStaleRunEvaluation>();
    for (const row of rows) {
      if (row.originId && !map.has(row.originId)) {
        map.set(row.originId, {
          id: row.id,
          identifier: row.identifier,
          status: row.status,
          priority: row.priority,
          assigneeAgentId: row.assigneeAgentId,
          updatedAt: row.updatedAt,
        });
      }
    }
    return map;
  }

  /**
   * Count how many silent-run review issues have ever been opened for the same
   * run (origin = the run id). Each closed-then-reopened review is one "review
   * cycle" on the same unresolved case. We use this to escalate to leadership
   * only after RECOVERY_REVIEW_ESCALATION_THRESHOLD consecutive cycles, instead
   * of paging the CEO/CTO on the very first silent run. `cancelled` reviews are
   * benign/self-resolved (per the silent-run-review skill) and do NOT count as
   * an unresolved cycle.
   */
  async function countStaleRunReviewCycles(companyId: string, runId: string) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["cancelled"]),
        ),
      );
    return Number(row?.count ?? 0);
  }

  /**
   * Has this run already been escalated to leadership at least once? Escalation
   * issues are titled "Escalated: silent active run ..."; we count any
   * non-cancelled review for the run with that title prefix. Used so escalation
   * fires ONCE per unresolved case and does not re-page leadership every cycle
   * after the threshold is first crossed.
   */
  async function hasEscalatedStaleRunReview(companyId: string, runId: string) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["cancelled"]),
          sql`${issues.title} like 'Escalated: silent active run%'`,
        ),
      );
    return Number(row?.count ?? 0) > 0;
  }

  // Returns a `done` stale-run evaluation issue for this run if one exists.
  // Used to detect when a reviewer closed an alert directly on the board without going through
  // the watchdog decision API — which would not leave a dismissed_false_positive decision record.
  //
  // Scoped to `done` only (not `cancelled`): cancellation is used by other system code paths
  // and does not imply a reviewer's "false positive" verdict. `done` is the explicit
  // board-close path used by reviewers acknowledging the alert. A cancelled evaluation is
  // allowed to re-fire on the next scan; if a reviewer wants permanent suppression they
  // should mark the alert done or record a watchdog decision.
  async function findClosedStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          visibleIssueCondition(),
          eq(issues.status, "done"),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1);
    return row ?? null;
  }

  // Returns true when a reviewer has already dismissed this run's silence as a false positive.
  // Used to prevent re-filing after a deliberate close — while still allowing legitimate
  // re-arm after a "continue" decision's snooze window expires.
  async function hasDismissedFalsePositiveDecision(companyId: string, runId: string) {
    const [row] = await db
      .select({ id: heartbeatRunWatchdogDecisions.id })
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          eq(heartbeatRunWatchdogDecisions.decision, "dismissed_false_positive"),
        ),
      )
      .limit(1);
    return row != null;
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    if (run.status !== "running") {
      return {
        lastOutputAt: run.lastOutputAt ?? null,
        lastOutputSeq: run.lastOutputSeq ?? 0,
        lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
          ? run.lastOutputStream
          : null,
        silenceStartedAt: silenceStartedAtForRun(run),
        silenceAgeMs: null,
        level: "not_applicable",
        suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
        snoozedUntil: null,
        evaluationIssueId: null,
        evaluationIssueIdentifier: null,
        evaluationIssueAssigneeAgentId: null,
      };
    }

    const [quietUntilDecision, evaluation] = await Promise.all([
      latestActiveOutputQuietUntilDecision(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = silenceAgeMsForRun(run, now);
    const level = quietUntilDecision
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
      snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  async function buildRunOutputSilenceBatch(
    runs: Array<Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >>,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary[]> {
    if (runs.length === 0) return [];

    const runningByCompany = new Map<string, string[]>();
    for (const run of runs) {
      if (run.status !== "running") continue;
      const existing = runningByCompany.get(run.companyId);
      if (existing) existing.push(run.id);
      else runningByCompany.set(run.companyId, [run.id]);
    }

    const quietDecisions = new Map<string, typeof heartbeatRunWatchdogDecisions.$inferSelect>();
    const evaluations = new Map<string, OpenStaleRunEvaluation>();

    await Promise.all(Array.from(runningByCompany.entries()).map(async ([companyId, runIds]) => {
      const [companyQuietDecisions, companyEvaluations] = await Promise.all([
        latestActiveOutputQuietUntilDecisions(companyId, runIds, now),
        findOpenStaleRunEvaluations(companyId, runIds),
      ]);
      for (const [runId, row] of companyQuietDecisions.entries()) {
        quietDecisions.set(runId, row);
      }
      for (const [runId, row] of companyEvaluations.entries()) {
        evaluations.set(runId, row);
      }
    }));

    return runs.map((run) => {
      const silenceStartedAt = silenceStartedAtForRun(run);
      if (run.status !== "running") {
        return {
          lastOutputAt: run.lastOutputAt ?? null,
          lastOutputSeq: run.lastOutputSeq ?? 0,
          lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
            ? run.lastOutputStream
            : null,
          silenceStartedAt,
          silenceAgeMs: null,
          level: "not_applicable",
          suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
          criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
          snoozedUntil: null,
          evaluationIssueId: null,
          evaluationIssueIdentifier: null,
          evaluationIssueAssigneeAgentId: null,
        };
      }

      const quietUntilDecision = quietDecisions.get(run.id) ?? null;
      const evaluation = evaluations.get(run.id) ?? null;
      const silenceAgeMs = silenceAgeMsForRun(run, now);
      const level = quietUntilDecision
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
        snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
        evaluationIssueId: evaluation?.id ?? null,
        evaluationIssueIdentifier: evaluation?.identifier ?? null,
        evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
      };
    });
  }

  function redactWatchdogEvidenceText(value: string, currentUserRedactionOptions: Awaited<ReturnType<typeof getCurrentUserRedactionOptions>>) {
    return redactSensitiveText(redactCurrentUserText(value, currentUserRedactionOptions));
  }

  function truncateEvidenceText(value: string, maxChars = 4000) {
    if (value.length <= maxChars) return value;
    return `${value.slice(value.length - maxChars)}\n[truncated earlier evidence]`;
  }

  async function readRunLogTailForEvidence(run: typeof heartbeatRuns.$inferSelect) {
    if (!run.logStore || !run.logRef || !run.logBytes) return "";
    try {
      const offset = Math.max(0, run.logBytes - ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES);
      const result = await runLogStore.read(
        { store: run.logStore as "local_file", logRef: run.logRef },
        { offset, limitBytes: ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES },
      );
      return result.content;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to read stale-run watchdog evidence tail");
      return "";
    }
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

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function appendRecoveryRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    event: {
      level: "info" | "warn" | "error";
      message: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq: await nextRunEventSeq(run.id),
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

  async function resolveStaleRunOwnerAgentId(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    excludeAgentIds?: string[];
  }) {
    const candidateIds: string[] = [];
    const excluded = new Set(input.excludeAgentIds ?? []);
    const sourceAssignee = input.sourceIssue?.assigneeAgentId
      ? await getAgent(input.sourceIssue.assigneeAgentId)
      : input.runningAgent;
    const recoverySource = {
      originKind: input.sourceIssue?.originKind,
      assigneeAdapterType: sourceAssignee?.adapterType ?? input.runningAgent.adapterType,
    };
    // Cheap-lane first: a silent-run review is a cheap triage, not leadership
    // work. Route it to the company's deterministic shell-handler Compiler /
    // Fallback-Compiler so the CEO/CTO is not paged on every silent run. The
    // leadership chain below stays as a fallback if no cheap reviewer exists.
    // When escalating (cycle >= threshold) the caller passes the cheap reviewer
    // in excludeAgentIds so this resolves to the next leadership candidate.
    const cheapReviewerId = await resolveCheapRecoveryReviewerAgentId(db, input.run.companyId);
    if (cheapReviewerId && !excluded.has(cheapReviewerId)) candidateIds.push(cheapReviewerId);
    // Leadership escalation is role-tiered, not a raw reportsTo hop. A
    // paused primary CEO may remain the direct manager while an invokable CTO
    // sister is available; selecting the manager first would both dead-letter
    // the work and skip the CTO tier.
    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, input.run.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      if (excluded.has(agentId)) continue;
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== input.run.companyId) continue;
      if (!isRecoveryOwnerCandidateEligible(candidate, recoverySource)) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.run.companyId, candidate.id, {
        issueId: input.sourceIssue?.id ?? null,
        projectId: input.sourceIssue?.projectId ?? null,
      });
      if (
        (await isAgentInvokable(candidate)) &&
        isHeartbeatWakeOnDemandEnabled(candidate) &&
        !budgetBlock
      ) {
        return candidate.id;
      }
    }

    return null;
  }

  async function collectStaleRunEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    now: Date;
  }) {
    const [tail, recentEvents, childIssues, blockers] = await Promise.all([
      readRunLogTailForEvidence(input.run),
      db
        .select({
          eventType: heartbeatRunEvents.eventType,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.run.companyId), eq(heartbeatRunEvents.runId, input.run.id)))
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(8),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, input.run.companyId), eq(issues.parentId, input.sourceIssue.id), visibleIssueCondition()))
          .orderBy(desc(issues.updatedAt))
          .limit(8)
        : Promise.resolve([]),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.issueId, issues.id))
          .where(
            and(
              eq(issueRelations.companyId, input.run.companyId),
              eq(issueRelations.relatedIssueId, input.sourceIssue.id),
              eq(issueRelations.type, "blocks"),
            ),
          )
          .limit(8)
        : Promise.resolve([]),
    ]);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const safeTail = truncateEvidenceText(redactWatchdogEvidenceText(tail, currentUserRedactionOptions));
    const silenceAgeMs = silenceAgeMsForRun(input.run, input.now);
    return {
      safeTail,
      silenceAgeMs,
      recentEvents: recentEvents.reverse().map((event) => ({
        eventType: event.eventType,
        level: event.level,
        createdAt: event.createdAt.toISOString(),
        message: event.message ? truncateEvidenceText(redactWatchdogEvidenceText(event.message, currentUserRedactionOptions), 300) : null,
      })),
      childIssues,
      blockers,
    };
  }

  function buildStaleRunEvaluationDescription(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    evidence: Awaited<ReturnType<typeof collectStaleRunEvidence>>;
    level: "suspicious" | "critical";
    now: Date;
  }) {
    const sourceIssue = input.sourceIssue
      ? issueUiLink({ identifier: input.sourceIssue.identifier, id: input.sourceIssue.id }, input.prefix)
      : "none";
    const recentEvents = input.evidence.recentEvents.length > 0
      ? input.evidence.recentEvents.map((event) =>
        `- ${event.createdAt} \`${event.eventType}\`${event.level ? ` ${event.level}` : ""}: ${event.message ?? "(no message)"}`,
      ).join("\n")
      : "- none";
    const childIssues = input.evidence.childIssues.length > 0
      ? input.evidence.childIssues.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    const blockers = input.evidence.blockers.length > 0
      ? input.evidence.blockers.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    return [
      `Paperclip detected ${input.level} output silence on an active heartbeat run.`,
      "",
      "## Run",
      "",
      `- Run: ${runUiLink(input.run, input.prefix)}`,
      `- Agent: ${input.runningAgent.name} (${input.runningAgent.adapterType})`,
      `- Invocation: ${input.run.invocationSource}${input.run.triggerDetail ? ` / ${input.run.triggerDetail}` : ""}`,
      `- Source issue: ${sourceIssue}`,
      `- Started at: ${input.run.startedAt?.toISOString() ?? "unknown"}`,
      `- Process started at: ${input.run.processStartedAt?.toISOString() ?? "unknown"}`,
      `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
      `- Last output sequence: ${input.run.lastOutputSeq ?? 0}`,
      `- Silent for: ${formatDuration(input.evidence.silenceAgeMs)}`,
      `- Thresholds: suspicious after ${formatDuration(ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS)}, critical after ${formatDuration(ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS)}`,
      `- Process metadata: pid \`${input.run.processPid ?? "unknown"}\`, process group \`${input.run.processGroupId ?? "unknown"}\`, in-memory handle \`${runningProcesses.has(input.run.id) ? "yes" : "no"}\``,
      "",
      "## Last Output Excerpt",
      "",
      input.evidence.safeTail ? `\`\`\`text\n${input.evidence.safeTail}\n\`\`\`` : "_No run-log tail was available._",
      "",
      "## Recent Run Events",
      "",
      recentEvents,
      "",
      "## Related Work",
      "",
      "Active child issues:",
      childIssues,
      "",
      "Current source blockers:",
      blockers,
      "",
      "## Decision Checklist",
      "",
      "- Continue or snooze if the run is intentionally quiet.",
      "- Ask the run owner for context if work may be delegated outside the transcript.",
      "- Preserve artifacts, branch state, and useful output before cancellation.",
      "- Cancel or recover through the explicit run recovery controls when authorized.",
      "- Close this issue as a false positive only after recording the reason.",
    ].join("\n");
  }

  function isUniqueStaleRunEvaluationConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stale_run_evaluation_uq" ||
        maybe.constraint_name === "issues_active_stale_run_evaluation_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stale_run_evaluation_uq")
      );
  }

  async function ensureSourceIssueCommentedForStaleEvaluation(input: {
    sourceIssue: typeof issues.$inferSelect | null;
    evaluationIssue: { id: string; identifier: string | null };
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    if (!input.sourceIssue || ["done", "cancelled"].includes(input.sourceIssue.status)) return false;
    // Idempotency guard: if we've already emitted the escalation comment for this
    // (sourceIssue, evaluationIssue) pair, skip. Without this, every subsequent scan
    // cycle while the evaluation issue is still open re-fires the comment and spams
    // the source-issue thread. The activity log row written below is the persistence
    // record we check against — a single row per pair is enough to suppress repeats
    // even after process restarts.
    const [priorEscalation] = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.sourceIssue.companyId),
          eq(activityLog.action, "heartbeat.output_stale_escalated"),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.sourceIssue.id),
          sql`${activityLog.details} ->> 'evaluationIssueId' = ${input.evaluationIssue.id}`,
        ),
      )
      .limit(1);
    if (priorEscalation) return false;
    // Evaluation issues are observability-only — do NOT add them to blockedByIssueIds.
    // They are already parented under the source issue. Adding them as hard blockers
    // creates a self-amplifying loop: block → silence → new alert → block again.
    await issuesSvc.addComment(input.sourceIssue.id, [
      "Paperclip detected critical output silence on this issue's active run.",
      "",
      `- Evaluation issue: ${input.evaluationIssue.identifier ?? input.evaluationIssue.id}`,
      `- Run: \`${input.run.id}\``,
      "",
      "Review the evaluation issue above. The active run has not been cancelled.",
    ].join("\n"), { runId: input.run.id });
    await logActivity(db, {
      companyId: input.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.run.id,
      action: "heartbeat.output_stale_escalated",
      entityType: "issue",
      entityId: input.sourceIssue.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationIssueId: input.evaluationIssue.id,
      },
    });
    return true;
  }

  async function releaseSourceIssueFromStaleEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    evaluationIssueId: string;
  }) {
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    if (!sourceIssue) return null;

    const blockerIds = await existingBlockerIssueIds(sourceIssue.companyId, sourceIssue.id);
    if (!blockerIds.includes(input.evaluationIssueId)) return sourceIssue;

    const nextBlockerIds = blockerIds.filter((blockerId) => blockerId !== input.evaluationIssueId);
    const nextStatus =
      sourceIssue.status === "blocked" &&
        nextBlockerIds.length === 0 &&
        sourceIssue.executionRunId === input.run.id &&
        input.run.status === "running"
        ? "in_progress"
        : undefined;
    await issuesSvc.update(sourceIssue.id, {
      ...(nextStatus ? { status: nextStatus } : {}),
      blockedByIssueIds: nextBlockerIds,
    });

    return sourceIssue;
  }

  async function createOrUpdateStaleRunEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (sourceIssue && isRecoveryOriginIssue(sourceIssue)) {
      await logActivity(db, {
        companyId: input.run.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.run.agentId,
        runId: input.run.id,
        action: "heartbeat.output_stale_recovery_recursion_refused",
        entityType: "heartbeat_run",
        entityId: input.run.id,
        details: {
          source: "recovery.scan_silent_active_runs",
          sourceIssueId: sourceIssue.id,
          sourceIssueIdentifier: sourceIssue.identifier,
          sourceIssueOriginKind: sourceIssue.originKind,
          existingEvaluationIssueId: existing?.id ?? null,
        },
      });
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

    // Idle output is expected when the source issue is blocked — skip ticket creation entirely.
    if (sourceIssue?.status === "blocked") return { kind: "skipped" as const };

    // Dedup: if a reviewer has dismissed this run's silence as a false positive, don't re-file.
    // A "continue" decision with a snooze window is allowed to re-arm normally — only an
    // explicit dismissed_false_positive blocks all further alerts for this run.
    if (await hasDismissedFalsePositiveDecision(input.run.companyId, input.run.id)) {
      return { kind: "skipped" as const };
    }

    // Dedup: if a prior evaluation issue for this run was closed `done` on the board
    // without going through the watchdog decision API, no dismissed_false_positive record exists
    // and the watchdog would re-fire every cycle. Auto-record the suppression now so future
    // cycles skip immediately via hasDismissedFalsePositiveDecision.
    //
    // Exception: if any watchdog decision exists (snooze/continue), a human explicitly opted
    // in to the watchdog lifecycle — honour that and allow re-arm as designed.
    //
    // Concurrency: the check-then-insert runs inside a transaction with a per-(company,run)
    // advisory lock so two overlapping scans cannot both observe `hasAnyDecision = false`
    // and both insert a dismissed_false_positive row. The table has no unique constraint
    // on (companyId, runId, decision), so the advisory lock is the serialization point.
    const closedEvaluation = await findClosedStaleRunEvaluation(input.run.companyId, input.run.id);
    if (closedEvaluation) {
      const autoDismissed = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`watchdog_dismiss:${input.run.companyId}:${input.run.id}`}, 0))`,
        );
        const hasAnyDecision = await tx
          .select({ id: heartbeatRunWatchdogDecisions.id })
          .from(heartbeatRunWatchdogDecisions)
          .where(
            and(
              eq(heartbeatRunWatchdogDecisions.companyId, input.run.companyId),
              eq(heartbeatRunWatchdogDecisions.runId, input.run.id),
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0);
        if (hasAnyDecision) return false;
        await tx.insert(heartbeatRunWatchdogDecisions).values({
          companyId: input.run.companyId,
          runId: input.run.id,
          evaluationIssueId: closedEvaluation.id,
          decision: "dismissed_false_positive",
          snoozedUntil: null,
          reason: `Auto-recorded: evaluation issue ${closedEvaluation.identifier} was closed as ${closedEvaluation.status} on the board without a watchdog decision.`,
          createdByAgentId: null,
          createdByUserId: null,
          createdByRunId: null,
        });
        return true;
      });
      if (autoDismissed) {
        return { kind: "skipped" as const };
      }
    }

    const prefix = await getCompanyIssuePrefix(input.run.companyId);
    const evidence = await collectStaleRunEvidence({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      now: input.now,
    });
    const level = (evidence.silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS ? "critical" : "suspicious";
    if (existing) {
      if (level === "critical" && existing.priority !== "high") {
        await issuesSvc.update(existing.id, {
          priority: "high",
        });
        await issuesSvc.addComment(existing.id, [
          "Critical output silence threshold crossed.",
          "",
          `- Run: \`${input.run.id}\``,
          `- Silent for: ${formatDuration(evidence.silenceAgeMs)}`,
          `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
        ].join("\n"), { runId: input.run.id });
        await ensureSourceIssueCommentedForStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
        return { kind: "escalated" as const, evaluationIssueId: existing.id };
      }
      if (level === "critical") {
        await ensureSourceIssueCommentedForStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
      }
      return { kind: "existing" as const, evaluationIssueId: existing.id };
    }

    // Consecutive-review escalation: count prior review cycles for THIS run
    // (closed reviews that did not resolve the silence). The cheap shell-handler
    // reviewer owns the first reviews; only once the case has come back
    // unresolved RECOVERY_REVIEW_ESCALATION_THRESHOLD times do we hand this
    // review to the leadership chain instead of the cheap lane, so escalation is
    // rare rather than per-failure. Escalation fires ONCE: if this run was
    // already escalated on a prior cycle, we keep it on the cheap lane rather
    // than re-paging leadership every subsequent cycle.
    const [priorReviewCycles, alreadyEscalated] = await Promise.all([
      countStaleRunReviewCycles(input.run.companyId, input.run.id),
      hasEscalatedStaleRunReview(input.run.companyId, input.run.id),
    ]);
    const reviewCycle = priorReviewCycles + 1;
    const escalateToLeadership =
      reviewCycle >= RECOVERY_REVIEW_ESCALATION_THRESHOLD && !alreadyEscalated;
    const cheapReviewerId = await resolveCheapRecoveryReviewerAgentId(db, input.run.companyId);
    // Both the normal and escalation ladders pass through the same adapter-aware
    // predicate. Generic invokability deliberately permits shell handlers for
    // routine dispatch, but a silent-run review is judgment work unless the
    // source itself is shell-owned routine execution. Do not assign cheapReviewerId
    // directly — that bypasses isRecoveryOwnerCandidateEligible.
    const ownerAgentId = await resolveStaleRunOwnerAgentId({
      run: input.run,
      runningAgent,
      sourceIssue,
      excludeAgentIds: escalateToLeadership && cheapReviewerId ? [cheapReviewerId] : [],
    });
    const description = buildStaleRunEvaluationDescription({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      evidence,
      level,
      now: input.now,
    });
    let evaluation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      evaluation = await issuesSvc.create(input.run.companyId, {
        title: escalateToLeadership
          ? `Escalated: silent active run for ${runningAgent.name} (review cycle ${reviewCycle})`
          : `Review silent active run for ${runningAgent.name}`,
        description,
        status: "todo",
        priority: escalateToLeadership || level === "critical" ? "high" : "medium",
        parentId: sourceIssue && !["done", "cancelled"].includes(sourceIssue.status) ? sourceIssue.id : null,
        projectId: sourceIssue?.projectId ?? null,
        goalId: sourceIssue?.goalId ?? null,
        billingCode: sourceIssue?.billingCode ?? null,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
        originId: input.run.id,
        originRunId: input.run.id,
        originFingerprint: staleActiveRunOriginFingerprint(input.run.companyId, input.run.id),
      });
    } catch (error) {
      if (!isUniqueStaleRunEvaluationConflict(error)) throw error;
      const raced = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
      if (!raced) throw error;
      return { kind: "existing" as const, evaluationIssueId: raced.id };
    }

    // Record the consecutive-review cycle marker on the review issue so the
    // count and escalation state are auditable on the issue itself.
    await bumpConsecutiveReviewCount(db, input.run.companyId, evaluation.id, {
      markEscalated: escalateToLeadership,
      now: input.now,
    });
    if (escalateToLeadership) {
      await issuesSvc.addComment(evaluation.id, [
        `Escalated to leadership after ${reviewCycle} consecutive unresolved review cycles on this run.`,
        "",
        `- Run: \`${input.run.id}\``,
        `- Escalation threshold: ${RECOVERY_REVIEW_ESCALATION_THRESHOLD} consecutive reviews`,
        `- Cheap-lane reviewer could not resolve this case; assigning the leadership chain.`,
      ].join("\n"), { runId: input.run.id });
    }

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: escalateToLeadership ? "heartbeat.output_stale_escalated" : "heartbeat.output_stale_detected",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        level,
        sourceIssueId: sourceIssue?.id ?? null,
        silenceAgeMs: evidence.silenceAgeMs,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
        reviewCycle,
        escalatedToLeadership: escalateToLeadership,
        cheapReviewerAgentId: cheapReviewerId,
      },
    });
    if (level === "critical") {
      await ensureSourceIssueCommentedForStaleEvaluation({
        sourceIssue,
        evaluationIssue: evaluation,
        run: input.run,
      });
    }
    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          taskId: evaluation.id,
          wakeReason: "issue_assigned",
          source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }, "status_only"),
      });
    }
    if (escalateToLeadership) {
      return { kind: "escalated" as const, evaluationIssueId: evaluation.id };
    }
    return { kind: "created" as const, evaluationIssueId: evaluation.id };
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
      dormantSkipped: 0,
      evaluationIssueIds: [] as string[],
    };

    // Respect dormancy: a company that is intentionally outside its activity
    // window ("dormant") has sleeping, not failing, agents. Do not generate
    // silent-run review churn for it — its runs will look silent precisely
    // because the company is asleep. Cache the per-company dormancy decision so
    // we hit the companies table at most once per company per scan.
    const dormancyCache = new Map<string, boolean>();
    const isDormant = async (companyId: string) => {
      const cached = dormancyCache.get(companyId);
      if (cached !== undefined) return cached;
      const dormant = await isCompanyRecoveryDormant(db, companyId);
      dormancyCache.set(companyId, dormant);
      return dormant;
    };

    for (const run of candidates) {
      if (await isDormant(run.companyId)) {
        result.dormantSkipped += 1;
        continue;
      }
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await createOrUpdateStaleRunEvaluation({ run, now });
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "escalated") result.escalated += 1;
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

    if (evaluationIssue) {
      await issuesSvc.update(evaluationIssue.id, { status: "done" });
      await issuesSvc.addComment(evaluationIssue.id, [
        "Watchdog decision recorded.",
        "",
        `- Decision: \`${input.decision}\``,
        `- Run: \`${run.id}\``,
        input.reason ? `- Reason: ${input.reason}` : "- Reason: none recorded",
        effectiveSnoozedUntil ? `- Quiet until: ${effectiveSnoozedUntil.toISOString()}` : null,
      ].filter((line): line is string => Boolean(line)).join("\n"), {
        runId: createdByRunId ?? undefined,
      });

      await releaseSourceIssueFromStaleEvaluation({
        run,
        evaluationIssueId: evaluationIssue.id,
      });
    }

    return row;
  }

  function isStrandedIssueRecoveryIssue(issue: typeof issues.$inferSelect) {
    return issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  }

  // Recovery escalations may block an issue that has no first-class blocker to link
  // (the block is on a human/board intervention, not another issue). The enter-blocked
  // guard in issuesSvc requires either an unresolved blocker relation or explicit
  // executionPolicy.externalWait, so stamp both description lines and the structured
  // wait path when they are missing. Returns undefined when the description already conforms.
  function withRecoveryExternalGateDescription(description: string | null | undefined): string | undefined {
    const base = typeof description === "string" ? description : "";
    if (hasExplicitExternalOwnerAction(base)) return undefined;
    const gateLines = [
      "External owner: board operator (stranded-work recovery)",
      "External action: restore a live execution path for this issue or record the manual resolution, then move it out of blocked.",
    ];
    return `${base.trimEnd()}\n\n${gateLines.join("\n")}\n`;
  }

  function withRecoveryExternalWaitPolicy(
    executionPolicy: typeof issues.$inferSelect["executionPolicy"] | null | undefined,
  ): Record<string, unknown> {
    const previous = normalizeIssueExecutionPolicy(executionPolicy ?? null);
    const nextCheckAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return {
      ...(previous ?? { mode: "normal" as const, commentRequired: true, stages: [] }),
      externalWait: {
        owner: "board operator (stranded-work recovery)",
        action: "restore a live execution path for this issue or record the manual resolution, then move it out of blocked",
        monitorOwner: "board",
        nextCheckAt,
      },
    };
  }

  function strandedBlockedGatePatch(input: {
    issue: typeof issues.$inferSelect;
    blockerIds: string[];
  }) {
    if (input.blockerIds.length > 0) return {};
    const description = withRecoveryExternalGateDescription(input.issue.description);
    return {
      ...(description !== undefined ? { description } : {}),
      executionPolicy: withRecoveryExternalWaitPolicy(input.issue.executionPolicy),
    };
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

  async function resolveStrandedRecoveryRouting(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }) {
    const originalAgentId = input.issue.assigneeAgentId ?? input.latestRun?.agentId ?? null;
    const sourceAssignee = input.issue.assigneeAgentId
      ? await getAgent(input.issue.assigneeAgentId)
      : null;
    const originalAgent = originalAgentId ? await getAgent(originalAgentId) : null;
    return {
      returnOwnerAgentId: isRecoveryOwnerCandidateEligible(originalAgent, {
        originKind: input.issue.originKind,
        assigneeAdapterType: sourceAssignee?.adapterType ?? null,
      }) ? originalAgentId : null,
    };
  }


  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    return cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "missing_disposition" as const
      : cause === "close_evidence_unmet"
        ? "close_evidence_unmet" as const
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
    closeEvidenceMeasurement?: CloseEvidenceMeasurement | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
    const workspaceValidation = input.recoveryCause === "workspace_validation_failed"
      ? readWorkspaceValidationPayload(input.latestRun)
      : null;
    // DELIVERY-FAULT PROVENANCE (2026-08-05, TSMC-19765). If the control plane restarted after
    // the run began, the run-scoped bridge dropped and any disposition/status write the agent
    // attempted may have been lost — 31% of steady-state missing_disposition issues carried
    // explicit bridge-failure evidence in-thread. Record the overlap so a delivery fault is
    // never silently indistinguishable from a silent agent. Evidence-only: routing is unchanged,
    // but the flag surfaces on the action and in board escalations.
    const controlPlaneBootedAt = new Date(Date.now() - process.uptime() * 1000);
    const latestRunStartedAt = input.latestRun?.startedAt ? new Date(input.latestRun.startedAt) : null;
    const controlPlaneRestartedSinceRunStart =
      latestRunStartedAt !== null && latestRunStartedAt < controlPlaneBootedAt;
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
      closeEvidenceMeasuredCount: input.closeEvidenceMeasurement?.measuredCount ?? null,
      closeEvidenceTargetCount: input.closeEvidenceMeasurement?.targetCount ?? null,
      closeEvidencePath: input.closeEvidenceMeasurement?.closeContract.evidencePath ?? null,
      controlPlaneRestartedSinceRunStart,
      ...(workspaceValidation ? { workspaceValidation } : {}),
    };
  }

  // How many recovery actions this issue has already burned for this cause, in any state. Counts
  // resolved ones deliberately: a resolved-but-ineffective action is exactly the loop we are
  // bounding — the action closed, the issue stayed stuck, and a fresh action was spawned.
  //
  // WINDOWED (2026-08-05): the count is bounded to a rolling window. A loop, whatever its
  // outcome shape, burns its cap within hours (the TSMC-19481 class took 8 actions in ~2 days;
  // the 07-27 churn took 3 in 3 minutes). A long-lived issue that legitimately recovered a few
  // times over weeks or months is NOT a loop, and a lifetime count would eventually board-escalate
  // its next unrelated recovery. Window >> loop cadence, window << legitimate-recovery spacing.
  async function countPriorRecoveryActionsForIssue(input: {
    companyId: string;
    sourceIssueId: string;
    kind: string;
  }) {
    const windowStart = new Date(Date.now() - RECOVERY_LOOP_CAP_WINDOW_MS);
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
          eq(issueRecoveryActions.kind, input.kind),
          gte(issueRecoveryActions.createdAt, windowStart),
        ),
      );
    return Number(row?.count ?? 0);
  }

  const RECOVERY_LOOP_CAP_ESCALATION_ORIGIN = "recovery_loop_cap_escalation";
  // The receipt is minted on EVERY non-quota stranded escalation now (upstream
  // f572e0867 made every such action board-owned), so concurrent reconciles of
  // sources sharing one signature can race the select-then-create below. There
  // is no unique index for this origin kind; serialize per signature in-process
  // so one sweep never mints twin receipts (TSMC-20961 meta-card class).
  const recoveryReceiptQueues = new Map<string, Promise<unknown>>();
  async function withRecoveryReceiptLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = recoveryReceiptQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    recoveryReceiptQueues.set(key, current);
    try {
      return await current;
    } finally {
      if (recoveryReceiptQueues.get(key) === current) recoveryReceiptQueues.delete(key);
    }
  }

  async function ensureRecoveryLoopCapEscalationIssue(input: {
    issue: typeof issues.$inferSelect;
    kind: string;
    recoveryCause: StrandedRecoveryCause;
    priorActionCount: number;
    // TSMC-20155/20183: the same signature-scoped board card carries both the
    // loop-cap hand-off and the no_invokable_recovery_owner hand-off. Default to
    // the historical reason so existing callers are unchanged; the title/body
    // reflect the actual reason so a pre-cap escalation is not mislabelled.
    escalationReason?: "recovery_loop_cap" | "no_invokable_recovery_owner" | "board_escalation_no_takeover";
  }) {
    const escalationReason = input.escalationReason ?? "recovery_loop_cap";
    const originId = `${input.kind}:${input.recoveryCause}`;
    return withRecoveryReceiptLock(`${input.issue.companyId}:${originId}`, async () => {
      const existing = await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, input.issue.companyId),
          eq(issues.originKind, RECOVERY_LOOP_CAP_ESCALATION_ORIGIN),
          eq(issues.originId, originId),
          notInArray(issues.status, ["done", "cancelled"]),
        ))
        .orderBy(desc(issues.updatedAt), desc(issues.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        // Backfill: an escalation raised before the interaction fix below shipped
        // (or one raced past it under a different lock generation) can still be
        // sitting open with no pending interaction. Without this it stays a
        // silent, unassigned card forever — see the note on
        // ensureBoardEscalationInteraction.
        await ensureBoardEscalationInteraction({
          issue: existing,
          escalationReason,
          kind: input.kind,
          recoveryCause: input.recoveryCause,
        });
        return existing;
      }

      const prefix = await getCompanyIssuePrefix(input.issue.companyId);
      const title = escalationReason === "no_invokable_recovery_owner"
        ? `BOARD ACTION REQUIRED: No invokable recovery owner — ${input.recoveryCause}`
        : escalationReason === "board_escalation_no_takeover"
          ? `BOARD ACTION REQUIRED: Stranded recovery needs a board decision — ${input.recoveryCause}`
        : `BOARD ACTION REQUIRED: Recovery loop cap reached — ${input.recoveryCause}`;
      const summaryLine = escalationReason === "no_invokable_recovery_owner"
        ? "Automatic recovery has no invokable owner to dispatch and has escalated to the board."
        : escalationReason === "board_escalation_no_takeover"
          ? "Automatic recovery keeps the source assignment unchanged and does not wake a substitute agent; the board must choose the next action."
        : "Automatic recovery has stopped after the same exit signature repeatedly failed.";
      const requiredBoardActionLine = escalationReason === "board_escalation_no_takeover"
        ? "Inspect the linked source evidence, then explicitly retry the original owner, reassign, repair the runtime, or record an intentional resolution. Automatic recovery never takes the source task over."
        : "Assign an invokable owner for the underlying runtime/exit-path defect, or record an intentional manual resolution.";
      const created = await issuesSvc.create(input.issue.companyId, {
        title,
        description: [
          summaryLine,
          "",
          "## Root signature",
          "",
          `- Escalation reason: \`${escalationReason}\``,
          `- Recovery kind: \`${input.kind}\``,
          `- Recovery cause: \`${input.recoveryCause}\``,
          ...(escalationReason === "recovery_loop_cap"
            ? [`- Cap: ${MAX_RECOVERY_ACTIONS_PER_ISSUE_KIND} prior actions`]
            : []),
          `- First source observed: ${issueUiLink(input.issue, prefix)}`,
          `- Prior actions on that source: ${input.priorActionCount}`,
          "",
          "## Required board action",
          "",
          `- ${requiredBoardActionLine}`,
          "- This is a single root escalation; additional sources with the same signature link here rather than creating more board cards.",
        ].join("\n"),
        status: "todo",
        priority: "critical",
        projectId: input.issue.projectId,
        goalId: input.issue.goalId,
        assigneeAgentId: null,
        originKind: RECOVERY_LOOP_CAP_ESCALATION_ORIGIN,
        originId,
        originFingerprint: [
          RECOVERY_LOOP_CAP_ESCALATION_ORIGIN,
          input.issue.companyId,
          originId,
        ].join(":"),
        billingCode: input.issue.billingCode,
      });
      // A "BOARD ACTION REQUIRED" title is not itself a control surface — the
      // Operator Console derives boardActionRequired strictly from a PENDING
      // request_confirmation-family interaction on the issue (issues.ts
      // computeBoardActionRequiredForIssues), never from title text. This
      // escalation is also created with assigneeAgentId: null by design (the
      // whole point of "no_takeover" is that automatic recovery must not wake a
      // substitute agent). Put those two facts together and, without an
      // interaction, the card was both undispatchable AND invisible: nothing
      // ever surfaced it to a human, so it silently blocked its source (and any
      // other issue that shared its recovery signature, via originId dedup
      // above) until someone found it by accident. Mint the interaction here so
      // the card is actually load-bearing.
      await ensureBoardEscalationInteraction({
        issue: created,
        escalationReason,
        kind: input.kind,
        recoveryCause: input.recoveryCause,
        requiredBoardActionLine,
        summaryLine,
      });
      return created;
    });
  }

  // Companion to ensureRecoveryLoopCapEscalationIssue: mints the
  // request_confirmation interaction that actually makes a board-escalation
  // issue show up in the Operator Console. Idempotent per issue (scoped by
  // idempotencyKey) and safe to call on an issue that already has a pending
  // interaction — it is a no-op in that case.
  async function ensureBoardEscalationInteraction(input: {
    issue: typeof issues.$inferSelect;
    escalationReason: "recovery_loop_cap" | "no_invokable_recovery_owner" | "board_escalation_no_takeover";
    kind: string;
    recoveryCause: StrandedRecoveryCause;
    requiredBoardActionLine?: string;
    summaryLine?: string;
  }) {
    const existingPending = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.issue.companyId),
        eq(issueThreadInteractions.issueId, input.issue.id),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existingPending) return existingPending;

    const requiredBoardActionLine = input.requiredBoardActionLine
      ?? (input.escalationReason === "board_escalation_no_takeover"
        ? "Inspect the linked source evidence, then explicitly retry the original owner, reassign, repair the runtime, or record an intentional resolution. Automatic recovery never takes the source task over."
        : "Assign an invokable owner for the underlying runtime/exit-path defect, or record an intentional manual resolution.");
    const summaryLine = input.summaryLine
      ?? (input.escalationReason === "no_invokable_recovery_owner"
        ? "Automatic recovery has no invokable owner to dispatch and has escalated to the board."
        : input.escalationReason === "board_escalation_no_takeover"
          ? "Automatic recovery keeps the source assignment unchanged and does not wake a substitute agent; the board must choose the next action."
          : "Automatic recovery has stopped after the same exit signature repeatedly failed.");

    return interactionsSvc.create(input.issue, {
      kind: "request_confirmation",
      resolverPolicy: "human_only",
      continuationPolicy: "none",
      idempotencyKey: `board_escalation_interaction:${input.issue.id}`,
      title: input.issue.title,
      summary: summaryLine,
      payload: {
        version: 1,
        prompt: requiredBoardActionLine,
        acceptLabel: "Reviewed — action taken",
        rejectLabel: "Keep open",
        rejectRequiresReason: false,
        allowDeclineReason: true,
        supersedeOnUserComment: false,
        detailsMarkdown: (input.issue.description ?? "").slice(0, 20000) || undefined,
      },
    }, {});
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    closeEvidenceMeasurement?: CloseEvidenceMeasurement | null;
  }) {
    const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);
    const routing = await resolveStrandedRecoveryRouting({
      issue: input.issue,
      latestRun: input.latestRun,
    });
    const isProviderQuotaWait = recoveryCause === "provider_quota";
    // RECOVERY-LOOP CAP (2026-08-05).
    //
    // `maxAttempts`/`attemptCount` already bound retries WITHIN one recovery action, but nothing
    // bounded how many SEPARATE actions one issue could burn through. TSMC-19481 consumed EIGHT
    // consecutive `missing_disposition` actions while no work was outstanding at all: the assigned
    // lane had a disposition each time and could not deliver it, because the run-scoped bridge drops
    // whenever the served tree reloads. Each undelivered disposition read as "no disposition given",
    // force-blocked the issue, and spawned a fresh action. The loop cannot converge, because
    // re-dispatching does not fix the exit.
    //
    // Upstream f572e0867 removed automatic stranded-task takeovers: every non-quota stranded
    // action is board-owned from the start and the source assignment stays unchanged. The cap is
    // kept as observability (evidence + log + card reason) so a create→fold→create loop is still
    // named as a loop instead of reading like a fresh failure each time.
    const priorActionCount = await countPriorRecoveryActionsForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: strandedRecoveryActionKind(recoveryCause),
    });
    const recoveryLoopCapExceeded = priorActionCount >= MAX_RECOVERY_ACTIONS_PER_ISSUE_KIND;
    // Give every board hand-off a board-visible receipt BEFORE the row is written.
    // A board owner is not an execution destination; without a linked recovery
    // issue the source goes silent (TSMC-19842 minted the receipt only on the
    // loop-cap branch; TSMC-20155/20183 were the inverse stranded-recovery class
    // with owner_type='board' and recovery_issue_id NULL). Provider-quota waits
    // are system-monitored and retry the original assignee, so they carry no card.
    const recoveryIssueId = isProviderQuotaWait
      ? null
      : (await ensureRecoveryLoopCapEscalationIssue({
        issue: input.issue,
        kind: strandedRecoveryActionKind(recoveryCause),
        recoveryCause,
        priorActionCount,
        escalationReason: recoveryLoopCapExceeded
          ? "recovery_loop_cap"
          : "board_escalation_no_takeover",
      })).id;
    if (recoveryLoopCapExceeded) {
      logger.warn(
        {
          service: "recovery",
          companyId: input.issue.companyId,
          issueId: input.issue.id,
          issueIdentifier: input.issue.identifier,
          kind: strandedRecoveryActionKind(recoveryCause),
          priorActionCount,
          cap: MAX_RECOVERY_ACTIONS_PER_ISSUE_KIND,
          recoveryCause,
        },
        "recovery loop cap reached; escalating to board instead of dispatching another agent recovery",
      );
    }
    const now = new Date();
    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      recoveryIssueId,
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
          closeEvidenceMeasurement: input.closeEvidenceMeasurement,
        }),
        failureSummary: summarizeRunFailureForIssueComment(input.latestRun)?.trim() ?? null,
        ...(recoveryLoopCapExceeded
          ? { recoveryLoopCap: { priorActionCount, cap: MAX_RECOVERY_ACTIONS_PER_ISSUE_KIND } }
          : {}),
      },
      evidenceOnCreate: isProviderQuotaWait
        ? {}
        : { routingPolicy: STRANDED_BOARD_ESCALATION_POLICY },
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Board operator: inspect the run evidence, then explicitly choose a valid issue disposition, retry the original owner, reassign, or intentionally resolve the task."
        : recoveryCause === "close_evidence_unmet"
          ? `Add governed-path evidence until the measured count reaches the target (${input.closeEvidenceMeasurement?.measuredCount ?? 0}/${input.closeEvidenceMeasurement?.targetCount ?? 0}).`
        : recoveryCause === "process_lost"
          ? "Board operator: inspect the retry history, then explicitly retry the original owner, reassign, or intentionally resolve the task."
        : recoveryCause === "provider_quota"
          ? "Wait for provider quota recovery, then retry the original assignee; do not wake a takeover owner."
        : recoveryCause === "detached_execution_required"
          ? "Relaunch the long-running job detached (`nohup … &`) with a durable result path, then resume from the recorded artifact instead of another synchronous heartbeat."
        : recoveryCause === "codex_output_inactivity_monitor"
          ? "Board operator: inspect the inactivity evidence, then explicitly retry the original owner, reassign, or intentionally resolve the task."
        : recoveryCause === "workspace_validation_failed"
          ? readWorkspaceValidationPayload(input.latestRun)?.reason === "git_worktree_branch_incoherence"
            ? "Board operator: repair the source task git worktree branch incoherence or choose a new execution workspace, then explicitly retry or reassign."
            : readWorkspaceValidationPayload(input.latestRun)?.reason === "git_worktree_base_materialization_failed"
              ? "Board operator: repair the project workspace repository URL or clone access, or configure a local checkout cwd, then explicitly retry or reassign."
              : "Board operator: repair the source task workspace link, project workspace cwd, or git checkout, then explicitly retry or reassign."
        : recoveryCause === "configuration_incomplete"
          ? (
            readConfigurationIncompleteRemediation(input.latestRun) ??
            "Board operator: bind the missing secret(s) named in the run failure, then explicitly retry the original owner or reassign."
          )
        : recoveryCause === "execution_review_participant_recovery"
          ? "Board operator: repair the failed review participant path, restore a live reviewer, explicitly reassign, or record an intentional resolution."
        : "Board operator: inspect the evidence, repair the runtime if appropriate, then explicitly retry the original owner, reassign, or intentionally resolve the task.",
      wakePolicy: isProviderQuotaWait
        ? {
          type: "monitor_only",
          reason: recoveryCause,
        }
        // Fork: a failed workspace validation is a deterministic manual repair,
        // not a board-routing decision; the policy type is what the fork's
        // tooling keys on. Owner stays null (no automatic takeover).
        : recoveryCause === "workspace_validation_failed"
        ? {
          type: "manual_repair_required",
          reason: recoveryCause,
          ownerAgentId: null,
          preservesSourceAssignee: true,
        }
        : {
          type: "board_escalation",
          reason: recoveryCause,
          preservesSourceAssignee: true,
          ...(recoveryLoopCapExceeded
            ? { escalationReason: "recovery_loop_cap", priorActionCount }
            : {}),
        },
      monitorPolicy: isProviderQuotaWait
        ? { type: "wait_recovery", retryAgentId: routing.returnOwnerAgentId }
        : null,
      maxAttempts: null,
      lastAttemptAt: now,
    });

    return action;
  }

  async function foldActiveRecoveryAction(input: {
    companyId: string;
    sourceIssueId: string;
    actionId: string;
    outcome: "false_positive" | "restored" | "cancelled";
    resolutionNote: string;
  }) {
    return recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      actionId: input.actionId,
      status: "resolved",
      outcome: input.outcome,
      resolutionNote: input.resolutionNote,
    });
  }

  async function foldStandingExemptRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    action: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>> | null;
  }) {
    const action = input.action;
    if (!action || !STANDING_EXEMPT_RECOVERY_ACTION_KINDS.has(action.kind)) return false;

    const resolutionNote = hasEventDrivenHubIdlePath(input.issue)
      ? "Missing-disposition recovery folded because the source issue exposes an event-driven hub idle path."
      : input.issue.workMode === "standing"
        ? "Recovery action folded because the source issue is standing-exempt (`workMode: \"standing\"`)."
        : "Recovery action folded because the source issue is standing-exempt (non-actionable standing anchor).";

    await foldActiveRecoveryAction({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: action.id,
      outcome: "false_positive",
      resolutionNote,
    });

    if (action.recoveryIssueId) {
      const recoveryIssue = await db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, input.issue.companyId), eq(issues.id, action.recoveryIssueId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (recoveryIssue && !isTerminalIssueStatus(recoveryIssue.status)) {
        await issuesSvc.update(recoveryIssue.id, { status: "cancelled" });
        await issuesSvc.addComment(
          recoveryIssue.id,
          [
            "Standing-anchor recovery fold.",
            "",
            `- Source issue: ${input.issue.identifier ?? input.issue.id}`,
            `- Recovery action: \`${action.id}\``,
            `- Outcome: false positive; standing-exempt issues do not participate in stranded-work recovery.`,
          ].join("\n"),
          {},
          { authorType: "system" },
        );
      }
    }

    return true;
  }

  async function sweepStandingExemptRecoveryActions() {
    // Standing anchors can be board-owned or already parked in `blocked`, so
    // they are intentionally absent from the normal assigned-work candidate
    // query below. Sweep their active recovery actions independently: merely
    // changing the marker must also retire recovery state created before the
    // exemption was applied.
    const candidates = await db
      .select({ issue: issues })
      .from(issueRecoveryActions)
      .innerJoin(
        issues,
        and(
          eq(issues.id, issueRecoveryActions.sourceIssueId),
          eq(issues.companyId, issueRecoveryActions.companyId),
        ),
      )
      .where(
        and(
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          inArray(issueRecoveryActions.kind, [...STANDING_EXEMPT_RECOVERY_ACTION_KINDS]),
        ),
      );

    const result = { folded: 0, issueIds: [] as string[] };
    for (const { issue } of candidates) {
      if (!isStandingExemptIssue(issue)) continue;
      const action = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
      if (!await foldStandingExemptRecoveryAction({ issue, action })) continue;
      result.folded += 1;
      result.issueIds.push(issue.id);
    }
    return result;
  }

  async function shouldFoldOrDelayMissingDispositionRecovery(input: {
    issue: typeof issues.$inferSelect;
    action: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>> | null;
  }) {
    const action = input.action;
    if (!action || action.kind !== "missing_disposition") return false;

    if (input.issue.status !== "in_progress") {
      if (input.issue.status === "blocked") {
        // Missing-disposition recovery itself commonly parks the source issue in
        // `blocked` while assigning a recovery owner. That self-created wait is
        // not independent evidence that the issue has a valid next action, so
        // keep the recovery action active instead of silently folding it away.
        return true;
      }
      await foldActiveRecoveryAction({
        companyId: input.issue.companyId,
        sourceIssueId: input.issue.id,
        actionId: action.id,
        outcome: "restored",
        resolutionNote: `Missing-disposition recovery folded because the source issue is now ${input.issue.status}.`,
      });
      return true;
    }

    // LATCH GUARD (2026-08-05, TSMC-19765). A board-owned missing-disposition action is a
    // terminal automatic-recovery state: the wake path is exhausted and a durable board card
    // (recovery_loop_cap escalation) carries the request. Keep it latched — the unique
    // active-per-source index is what prevents the detector from re-creating actions, so this
    // row must stay active until the source issue changes state (folded above) or the board
    // resolves it. Without this guard the sweep would fall through to
    // escalateStrandedAssignedIssue and re-upsert every tick.
    if (action.ownerType === "board") {
      return true;
    }

    if (hasEventDrivenHubIdlePath(input.issue)) {
      await foldActiveRecoveryAction({
        companyId: input.issue.companyId,
        sourceIssueId: input.issue.id,
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "Missing-disposition recovery folded because the source issue exposes an event-driven hub idle path.",
      });
      return true;
    }

    if (action.maxAttempts !== null && action.attemptCount >= action.maxAttempts) {
      // ROOT CAUSE OF THE 07-27..07-31 RUNAWAY (8,679 actions across 8 issues) AND THE
      // TSMC-19481 CLASS. This branch used to FOLD the exhausted action as `false_positive`.
      // Resolving it released the one-active-action-per-source unique index, the next 1-minute
      // sweep saw no active action for a still-eligible issue and minted a fresh one, and the
      // create→fold cycle ran once per minute for as long as the issue stayed `in_progress`
      // (verified: flat 60/hr per issue, p50 action lifetime 30s, churn ending exactly at
      // issue completion). Exhaustion means the wake path CANNOT converge — so keep the SAME
      // row latched and convert it to a board-owned escalation in place. No recreation cycle
      // can exist while the row stays active.
      const escalationIssue = await ensureRecoveryLoopCapEscalationIssue({
        issue: input.issue,
        kind: action.kind,
        recoveryCause: action.cause as StrandedRecoveryCause,
        priorActionCount: action.attemptCount,
      });
      await recoveryActionsSvc.upsertSourceScoped({
        companyId: input.issue.companyId,
        sourceIssueId: input.issue.id,
        recoveryIssueId: escalationIssue.id,
        kind: action.kind,
        ownerType: "board",
        ownerAgentId: null,
        previousOwnerAgentId: action.ownerAgentId ?? action.previousOwnerAgentId,
        returnOwnerAgentId: action.returnOwnerAgentId,
        cause: action.cause,
        fingerprint: action.fingerprint,
        evidence: {
          ...(action.evidence ?? {}),
          latchEscalatedAt: new Date().toISOString(),
          latchEscalationReason: "missing_disposition_wake_exhausted",
        },
        nextAction:
          "Board: choose a concrete disposition for the source issue or assign an owner for the underlying delivery fault. Automatic status-only wakes are exhausted and will not be retried.",
        wakePolicy: { type: "board_escalation", reason: "recovery_loop_cap", preservesSourceAssignee: true },
        maxAttempts: null,
      });
      logger.warn(
        {
          service: "recovery",
          companyId: input.issue.companyId,
          issueId: input.issue.id,
          issueIdentifier: input.issue.identifier,
          actionId: action.id,
          escalationIssueId: escalationIssue.id,
        },
        "missing-disposition wake exhausted; latched the action as a board escalation instead of folding it",
      );
      return true;
    }

    const lastAttemptAtMs = action.lastAttemptAt ? new Date(action.lastAttemptAt).getTime() : Number.NaN;
    if (
      Number.isFinite(lastAttemptAtMs) &&
      Date.now() - lastAttemptAtMs < SOURCE_SCOPED_RECOVERY_MIN_REFIRE_INTERVAL_MS
    ) {
      return true;
    }

    return false;
  }

  function isNoInvokableRecoveryOwnerAction(
    action: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>> | null,
  ) {
    if (!action || action.ownerAgentId || action.ownerType !== "board") return false;
    const wakePolicy = parseObject(action.wakePolicy);
    return readNonEmptyString(wakePolicy.type) === "board_escalation" &&
      readNonEmptyString(wakePolicy.reason) === "no_invokable_recovery_owner";
  }

  function strandedNoInvokableRecoveryOwnerBackoffMs(attemptCount: number) {
    return STRANDED_NO_INVOKABLE_RECOVERY_OWNER_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attemptCount - 1));
  }

  function shouldDelayNoInvokableRecoveryOwnerEscalation(
    action: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>> | null,
    now = Date.now(),
  ) {
    if (!action || !isNoInvokableRecoveryOwnerAction(action)) return false;
    const maxAttempts = action.maxAttempts ?? STRANDED_NO_INVOKABLE_RECOVERY_OWNER_MAX_ATTEMPTS;
    if (action.attemptCount >= maxAttempts) return true;
    const lastAttemptAtMs = action.lastAttemptAt ? new Date(action.lastAttemptAt).getTime() : Number.NaN;
    if (!Number.isFinite(lastAttemptAtMs)) return false;
    return now - lastAttemptAtMs < strandedNoInvokableRecoveryOwnerBackoffMs(action.attemptCount);
  }

  type RecentNoProgressContinuationSummary = {
    consecutive: number;
    runIds: string[];
    latestFinishedAt: Date | null;
    latestStopReason: string | null;
  };

  async function summarizeRecentNoProgressContinuationRuns(
    companyId: string,
    issueId: string,
    agentId: string,
    since: Date | null = null,
  ): Promise<RecentNoProgressContinuationSummary> {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
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

    const runIds: string[] = [];
    let consecutive = 0;
    let latestFinishedAt: Date | null = null;
    let latestStopReason: string | null = null;
    for (const row of rows) {
      const context = parseObject(row.contextSnapshot);
      if (readNonEmptyString(context.retryReason) !== "issue_continuation_needed") break;
      if (
        row.status !== "succeeded" &&
        !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
          row.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
        )
      ) {
        break;
      }

      consecutive += 1;
      runIds.push(row.id);
      if (latestFinishedAt === null) latestFinishedAt = row.finishedAt ?? null;
      if (latestStopReason === null) {
        latestStopReason =
          readNonEmptyString(row.errorCode) ??
          readNonEmptyString(row.livenessReason) ??
          row.status;
      }
    }

    return { consecutive, runIds, latestFinishedAt, latestStopReason };
  }

  async function escalateDetachedExecutionManagerReview(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    commentLead: string;
    recoveryCause?: StrandedRecoveryCause;
    runIds?: string[];
  }) {
    // Upstream f572e0867 removed automatic stranded-task takeovers: stranded
    // recovery actions are board-owned, so the former "hand the review to the
    // recovery owner" branch can never run. Route straight to the board
    // escalation (which ensures the source-scoped action itself).
    const recoveryCause = input.recoveryCause ?? "detached_execution_required";
    return escalateStrandedAssignedIssue({
      issue: input.issue,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
      comment: input.commentLead,
      recoveryCause,
    });
  }

  /**
   * TSMC-20058 / sibling of TSMC-17880.
   *
   * Folding a recovery action because its recovery *wrapper* went terminal is only
   * safe when the source already has an independent disposition. If the source is
   * still `blocked` and the terminal recovery issue was its only live wait path
   * (or the wait was pure recovery-stamped external-gate prose with no first-class
   * blockers), resolving the action without releasing the source recreates the
   * stranded-recovery-guard contradiction: blocked + no live blockers + resolved
   * recovery action. Release the source back to `todo` so the assignee pick-work
   * path can take it; keep it blocked only when independent unresolved blockers remain.
   */
  async function releaseSourceAfterTerminalRecoveryIssue(input: {
    companyId: string;
    sourceIssueId: string;
    recoveryIssueId: string | null;
  }): Promise<"released" | "still_blocked" | "unchanged"> {
    const source = await db
      .select({
        id: issues.id,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.sourceIssueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!source || source.status !== "blocked") return "unchanged";

    const unresolvedBlockerIds = await existingUnresolvedBlockerIssueIds(input.companyId, source.id);
    const independentUnresolvedBlockerIds = input.recoveryIssueId
      ? unresolvedBlockerIds.filter((blockerId) => blockerId !== input.recoveryIssueId)
      : unresolvedBlockerIds;

    // Always drop a terminal recovery wrapper from the wait set when present.
    // unresolved* already excludes done/cancelled rows, so a bare unresolved
    // check would leave the dead recovery edge attached while independent
    // blockers remain (test: keeps source blocked with independent blockers).
    const allBlockerIds = await existingBlockerIssueIds(input.companyId, source.id);
    const remainingBlockerIds = input.recoveryIssueId
      ? allBlockerIds.filter((blockerId) => blockerId !== input.recoveryIssueId)
      : allBlockerIds;
    const recoveryEdgePresent = Boolean(
      input.recoveryIssueId && allBlockerIds.includes(input.recoveryIssueId),
    );

    if (independentUnresolvedBlockerIds.length > 0) {
      if (recoveryEdgePresent) {
        await issuesSvc.update(source.id, { blockedByIssueIds: remainingBlockerIds });
      }
      return "still_blocked";
    }

    // No independent live wait remains. Drop the terminal recovery blocker (if any)
    // and restore the normal pick-work path. Do not leave recovery-stamped external
    // gate prose as a silent permanent block with no live recovery owner.
    await issuesSvc.update(source.id, {
      status: "todo",
      blockedByIssueIds: remainingBlockerIds,
    });
    return "released";
  }

  async function sweepStaleRecoveryActions() {
    const recoveryIssue = alias(issues, "stale_recovery_issue");
    const candidates = await db
      .select({
        actionId: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        kind: issueRecoveryActions.kind,
        sourceStatus: issues.status,
        recoveryIssueId: issueRecoveryActions.recoveryIssueId,
        recoveryIssueStatus: recoveryIssue.status,
      })
      .from(issueRecoveryActions)
      .innerJoin(
        issues,
        and(
          eq(issues.id, issueRecoveryActions.sourceIssueId),
          eq(issues.companyId, issueRecoveryActions.companyId),
        ),
      )
      .leftJoin(
        recoveryIssue,
        and(
          eq(recoveryIssue.id, issueRecoveryActions.recoveryIssueId),
          eq(recoveryIssue.companyId, issueRecoveryActions.companyId),
        ),
      )
      .where(
        and(
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          sql`(
            ${issues.status} in ('done', 'cancelled')
            or ${recoveryIssue.status} in ('done', 'cancelled')
            or (
              ${issueRecoveryActions.kind} = 'missing_disposition'
              and ${issues.status} in ('todo', 'in_review', 'done', 'cancelled')
            )
          )`,
        ),
      );

    const result = {
      folded: 0,
      actionIds: [] as string[],
      issueIds: [] as string[],
      sourcesReleased: 0,
    };

    for (const candidate of candidates) {
      const recoveryIssueTerminal = candidate.recoveryIssueStatus === "done" || candidate.recoveryIssueStatus === "cancelled";

      // Sibling of TSMC-17880: do not fold a terminal-recovery-issue action into
      // "restored" while leaving the source stranded blocked with no independent
      // wait path. Release first when needed, then fold.
      let sourceRelease: "released" | "still_blocked" | "unchanged" = "unchanged";
      if (recoveryIssueTerminal && candidate.sourceStatus === "blocked") {
        sourceRelease = await releaseSourceAfterTerminalRecoveryIssue({
          companyId: candidate.companyId,
          sourceIssueId: candidate.sourceIssueId,
          recoveryIssueId: candidate.recoveryIssueId,
        });
        if (sourceRelease === "released") result.sourcesReleased += 1;
      }

      const folded = await recoveryActionsSvc.resolveActiveForIssue({
        companyId: candidate.companyId,
        sourceIssueId: candidate.sourceIssueId,
        actionId: candidate.actionId,
        status: "resolved",
        outcome: "restored",
        resolutionNote: recoveryIssueTerminal
          ? sourceRelease === "released"
            ? `Recovery action swept because the recovery issue is now terminal (${candidate.recoveryIssueStatus}); source released to todo (no independent live blockers).`
            : `Recovery action swept because the recovery issue is now terminal (${candidate.recoveryIssueStatus}).`
          : candidate.kind === "missing_disposition"
            ? `Missing-disposition recovery swept because the source issue is now ${candidate.sourceStatus}.`
            : `Recovery action swept because the source issue is now terminal (${candidate.sourceStatus}).`,
      });
      if (!folded) continue;

      // A source that already has a terminal disposition is authoritative.  Do
      // not leave its visible recovery wrapper open merely because the action
      // row was folded by this background pass: that wrapper is otherwise seen
      // as fresh liveness work and can be re-escalated.  Cancel rather than
      // complete it when the source's normal execution path was restored; use
      // done only for a source that itself reached a terminal disposition.
      if (candidate.recoveryIssueId && !recoveryIssueTerminal) {
        const wrapperStatus = candidate.sourceStatus === "done" || candidate.sourceStatus === "cancelled"
          ? "done"
          : "cancelled";
        await issuesSvc.update(candidate.recoveryIssueId, { status: wrapperStatus });
      }

      result.folded += 1;
      result.actionIds.push(candidate.actionId);
      result.issueIds.push(candidate.sourceIssueId);

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.recovery_action_swept",
        entityType: "issue",
        entityId: candidate.sourceIssueId,
        details: {
          source: "recovery.sweep_stale_recovery_actions",
          recoveryActionId: candidate.actionId,
          recoveryActionKind: candidate.kind,
          sourceStatus: candidate.sourceStatus,
          recoveryIssueStatus: candidate.recoveryIssueStatus,
          sourceRelease,
        },
      });
    }

    return result;
  }

  /**
   * Close open stranded-recovery wrappers whose source issue already reached a
   * terminal disposition. The action-row sweep only folds wrappers linked to an
   * active recovery action; TSMC-19764 was left open after TSMC-19481 went done
   * with no remaining active action. Run this on every stranded reconcile pass.
   */
  async function sweepOpenRecoveryWrappersForTerminalSources() {
    const sourceIssue = alias(issues, "terminal_source_for_recovery_wrapper");
    const candidates = await db
      .select({
        wrapperId: issues.id,
        companyId: issues.companyId,
        sourceIssueId: issues.originId,
        sourceStatus: sourceIssue.status,
      })
      .from(issues)
      .innerJoin(
        sourceIssue,
        and(
          // originId is text (also stores non-uuid incident keys for other
          // origin kinds); cast the uuid PK to text for the join.
          sql`${sourceIssue.id}::text = ${issues.originId}`,
          eq(sourceIssue.companyId, issues.companyId),
        ),
      )
      .where(
        and(
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
          inArray(sourceIssue.status, ["done", "cancelled"]),
        ),
      );

    const result = {
      closed: 0,
      wrapperIds: [] as string[],
      sourceIssueIds: [] as string[],
    };

    for (const candidate of candidates) {
      if (!candidate.sourceIssueId) continue;
      const wrapperStatus = candidate.sourceStatus === "cancelled" ? "cancelled" : "done";
      try {
        await issuesSvc.update(candidate.wrapperId, { status: wrapperStatus });
      } catch (error) {
        logger.warn(
          {
            service: "recovery",
            wrapperId: candidate.wrapperId,
            sourceIssueId: candidate.sourceIssueId,
            err: error instanceof Error ? error.message : String(error),
          },
          "failed to close recovery wrapper for terminal source",
        );
        continue;
      }
      result.closed += 1;
      result.wrapperIds.push(candidate.wrapperId);
      result.sourceIssueIds.push(candidate.sourceIssueId);

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.recovery_wrapper_closed_terminal_source",
        entityType: "issue",
        entityId: candidate.wrapperId,
        details: {
          source: "recovery.sweep_open_recovery_wrappers_for_terminal_sources",
          sourceIssueId: candidate.sourceIssueId,
          sourceStatus: candidate.sourceStatus,
          wrapperStatus,
        },
      });
    }

    if (result.closed > 0) {
      logger.info(
        { closed: result.closed, wrapperIds: result.wrapperIds },
        "closed open recovery wrappers whose source is already terminal",
      );
    }

    return result;
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
          payload: withRecoveryModelProfileHint({
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
          contextSnapshot: withRecoveryModelProfileHint({
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
    const gatePatch = strandedBlockedGatePatch({ issue: input.issue, blockerIds: [] });
    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
      ...gatePatch,
    });
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
    const context = withRecoveryModelProfileHint({
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
            payload: withRecoveryModelProfileHint({
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
                payload: withRecoveryModelProfileHint({
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
    // Fork: a board owner is not an execution destination; every board hand-off
    // gets a board-visible receipt card, and the source blocks on it so the
    // blocked write carries a live wait path (blocked_state_requires_wait_path).
    const receipt = await ensureRecoveryLoopCapEscalationIssue({
      issue: input.issue,
      kind: action.kind,
      recoveryCause: action.cause as StrandedRecoveryCause,
      priorActionCount: input.attemptCount,
      escalationReason: "board_escalation_no_takeover",
    });
    const now = new Date();
    await db
      .update(issueRecoveryActions)
      .set({
        status: "active",
        ownerType: "board",
        ownerAgentId: null,
        ownerUserId: null,
        recoveryIssueId: receipt.id,
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

    const repairBlockerIds = [...new Set([
      ...await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id),
      receipt.id,
    ])];
    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
      blockedByIssueIds: repairBlockerIds,
      ...strandedBlockedGatePatch({ issue: input.issue, blockerIds: repairBlockerIds }),
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
        `- Recovery action: \`${action.id}\``,
        "- Recovery owner: board",
        `- Recovery receipt: ${receipt.identifier ?? receipt.id}`,
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
        recoveryIssueId: receipt.id,
        recoveryOwnerAgentId: null,
        recoveryOwnerType: "board",
        routingPolicy: STRANDED_BOARD_ESCALATION_POLICY,
        blockerIssueIds: repairBlockerIds,
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
    closeEvidenceMeasurement?: CloseEvidenceMeasurement | null;
  }) {

    // Re-verify the current status to avoid overwriting a terminal state reached in a race.
    const current = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, input.issue.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!current || isTerminalIssueStatus(current.status)) {
      return null;
    }
    if (isStrandedIssueRecoveryIssue(input.issue)) {
      return escalateStrandedRecoveryIssueInPlace({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
      });
    }

    const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);

    // Assignee-outage blocks must be re-checkable when the lane recovers. Use a
    // first-class unblockDescriptor and no blockedBy edges so the self-heal
    // sweep can return the issue to todo without human intervention (TSMC-19829).
    if (recoveryCause === "agent_not_invokable") {
      if (current.status === "blocked" && isAssigneeNotInvokableUnblockDescriptor(input.issue.unblockDescriptor)) {
        const unresolved = await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id);
        if (unresolved.length === 0) {
          return input.issue;
        }
      }

      const descriptor = buildAssigneeNotInvokableUnblockDescriptor();
      const updated = await issuesSvc.update(input.issue.id, {
        status: "blocked",
        blockedByIssueIds: [],
        assigneeAgentId: input.issue.assigneeAgentId,
        unblockDescriptor: descriptor,
      });
      if (!updated) return null;

      const commentBody = input.comment ??
        ("Paperclip cannot continue this assigned issue because the assignee is not invokable " +
          "and the issue has no live execution path. Moving it to `blocked` with a machine-readable " +
          "assignee-not-invokable descriptor so it can self-heal when the assignee becomes invokable again.");
      await issuesSvc.addComment(
        input.issue.id,
        commentBody,
        {},
        {
          authorType: "system",
          presentation: compactRecoveryPresentation("Recovery: assignee not invokable — moved to blocked"),
          metadata: recoveryNoticeMetadata({
            cause: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE,
            latestRun: input.latestRun,
            previousStatus: input.previousStatus,
          }),
        },
      );
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "recovery",
        agentId: input.issue.assigneeAgentId ?? null,
        runId: input.latestRun?.id ?? null,
        action: "issue.assignee_not_invokable_blocked",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          source: "recovery.escalate_stranded_assigned_issue",
          cause: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE,
          previousStatus: input.previousStatus,
          assigneeAgentId: input.issue.assigneeAgentId ?? null,
          latestRunId: input.latestRun?.id ?? null,
        },
      });
      return updated;
    }

    const recoveryAction = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
      recoveryCause,
      successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
      closeEvidenceMeasurement: input.closeEvidenceMeasurement,
    });

    // Deterministic manual-repair causes (workspace validation) never take the
    // keep-actionable todo path below; the board must repair the workspace first.
    const requiresDeterministicManualRepair =
      recoveryCause === "workspace_validation_failed";
    // No per-source takeover wrapper is minted any more (upstream f572e0867: no
    // automatic stranded-task takeovers). The board-visible receipt is the
    // signature-scoped recovery card linked on the action itself.
    const ensuredRecoveryIssueId: string | null = recoveryAction.recoveryIssueId ?? null;

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
    const blockerIds = [...new Set([
      ...await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id),
      // The root escalation is the source issue's durable wait path as well
      // as the recovery action's receipt. This keeps the source visible in
      // dependency views while the board-visible root is unresolved.
      ...(recoveryAction.recoveryIssueId ? [recoveryAction.recoveryIssueId] : []),
    ])];
    const strandedBlockedGate = strandedBlockedGatePatch({ issue: input.issue, blockerIds });

    let updated: Awaited<ReturnType<typeof issuesSvc.update>> | null = null;

    // TSMC-20885's law applied one level up (live 2026-08-15: TSR-5488 was
    // frozen two seconds after a SILENT corrective run): when an exhausted
    // missing-disposition recovery's only blocker would be its own recovery
    // issue, the card must stay ACTIONABLE. Silence earns the loud exhausted
    // notice below — it never manufactures a wait state. Real blockers
    // (independent blocker issues) still take the blocked path.
    // Compare against the receipt id the action carries (live 2026-08-15 16:26,
    // TSM-6676: a null comparison bypassed this guard and the card froze behind
    // its own recovery issue anyway).
    const onlySelfReferentialBlockers = blockerIds.every((id) => id === ensuredRecoveryIssueId);
    if (
      recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON &&
      onlySelfReferentialBlockers &&
      !requiresDeterministicManualRepair
    ) {
      // No assignee patch: upstream f572e0867 keeps both source assignee fields
      // unchanged during automatic escalation.
      updated = await issuesSvc.update(input.issue.id, { status: "todo" });
    }

    if (!updated) {
      // Board-owned escalation leaves the source assignee and user untouched
      // (no automatic stranded-task takeover). The fork's external-wait gate
      // keeps blocked-state accountability satisfied when no first-class
      // blocker exists.
      updated = await issuesSvc.update(input.issue.id, {
        status: "blocked",
        blockedByIssueIds: blockerIds,
        ...strandedBlockedGate,
      });
    }
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
    // Fork: the comment BODY keeps the recovery receipt lines (operator tooling
    // and tests grep the body); upstream carries the same facts as metadata rows.
    const recoveryLine = [
      "",
      `- Recovery action: \`${recoveryAction.id}\``,
      "- Recovery owner: board escalation, because automatic recovery keeps the source assignment unchanged and never wakes a substitute agent.",
      "- Next action: a board operator should inspect the evidence, then explicitly retry the original owner, reassign, repair the runtime, or record an intentional manual resolution.",
    ].join("\n");
    const escalationBody = `${escalationNotice.body}${recoveryLine}`;

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
          await issuesSvc.addComment(input.issue.id, escalationBody, {}, {
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
        status: updated.status,
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
      staleRecoveryActionsFolded: 0,
      // TSMC-20058: sources released from stranded blocked when a terminal recovery
      // wrapper was the only wait path (sibling of the missing_disposition 17880 exit).
      staleRecoverySourcesReleased: 0,
      terminalSourceWrappersClosed: 0,
      reviewParticipantRequeued: 0,
      escalated: 0,
      waitingOnReviewResolved: 0,
      providerQuotaMonitored: 0,
      recentProgressExempted: 0,
      operatorCancelExempted: 0,
      skipped: 0,
      issueIds: [] as string[],
    };

    const standingExemptRecoveryActions = await sweepStandingExemptRecoveryActions();
    result.staleRecoveryActionsFolded = standingExemptRecoveryActions.folded;
    result.issueIds.push(...standingExemptRecoveryActions.issueIds);

    const staleRecoveryActions = await sweepStaleRecoveryActions();
    result.staleRecoveryActionsFolded += staleRecoveryActions.folded;
    result.staleRecoverySourcesReleased += staleRecoveryActions.sourcesReleased;
    result.issueIds.push(...staleRecoveryActions.issueIds);

    const terminalSourceWrappers = await sweepOpenRecoveryWrappersForTerminalSources();
    result.terminalSourceWrappersClosed = terminalSourceWrappers.closed;
    result.issueIds.push(...terminalSourceWrappers.sourceIssueIds);

    for (const issue of candidates) {
      try {
        // Re-fetch to avoid stale data from the initial candidates query
        const freshIssue = await db
          .select()
          .from(issues)
          .where(eq(issues.id, issue.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!freshIssue || isTerminalIssueStatus(freshIssue.status)) {
          result.skipped += 1;
          continue;
        }
        if (isStandingExemptIssue(freshIssue)) {
          const action = await recoveryActionsSvc.getActiveForIssue(freshIssue.companyId, freshIssue.id);
          const folded = await foldStandingExemptRecoveryAction({ issue: freshIssue, action });
          if (folded) result.issueIds.push(freshIssue.id);
          result.skipped += 1;
          continue;
        }
        const executionState = freshIssue.status === "in_review"
          ? parseIssueExecutionState(freshIssue.executionState)
          : null;
        const pendingExecutionState = executionState?.status === "pending" ? executionState : null;
        const currentParticipant = pendingExecutionState
          ? pendingExecutionState.currentParticipant
          : null;
        const participantAgentId = currentParticipant?.type === "agent" ? currentParticipant.agentId : null;
        const agentId = freshIssue.status === "in_review" && participantAgentId
          ? participantAgentId
          : freshIssue.assigneeAgentId;
        if (!agentId) {
          result.skipped += 1;
          continue;
        }

        const agent = await getAgent(agentId);
        const agentInvokable = agent && agent.companyId === freshIssue.companyId
          ? await isAgentInvokable(agent)
          : false;

        if (await hasActiveExecutionPath(
          freshIssue.companyId,
          freshIssue.id,
          freshIssue.status === "in_review" ? agentId : null,
        )) {
          result.skipped += 1;
          continue;
        }

        if (await hasPendingWakeInteraction(freshIssue.companyId, freshIssue.id)) {
          result.skipped += 1;
          continue;
        }

        if ((await evaluateAutomaticRecoverySuppression(freshIssue.companyId, freshIssue.id)).suppressed) {
          result.skipped += 1;
          continue;
        }

        const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(freshIssue.companyId, freshIssue.id);
        // Local: fold/delay repeat missing-disposition recovery churn instead of
        // opening a new recovery issue every sweep.
        if (await shouldFoldOrDelayMissingDispositionRecovery({ issue: freshIssue, action: activeRecoveryAction })) {
          result.skipped += 1;
          continue;
        }

        let latestRun = await getLatestIssueRun(freshIssue.companyId, freshIssue.id);
        if (isOperatorCancelledRun(latestRun, freshIssue.id)) {
          result.operatorCancelExempted += 1;
          continue;
        }
        if (freshIssue.status !== "in_review" && !agentInvokable) {
          // A paused first-run assignee is an intentional containment state, not
          // evidence that the issue itself has failed. Leave untouched `todo`
          // work parked until the lane is resumed; only escalate non-invokable
          // work after execution has actually started or another state requires
          // an explicit recovery disposition.
          if (freshIssue.status === "todo" && !latestRun) {
            result.skipped += 1;
            continue;
          }
          if (shouldDelayNoInvokableRecoveryOwnerEscalation(activeRecoveryAction)) {
            result.skipped += 1;
            continue;
          }
          // Upstream (f572e0867): a disposition-repair attempt stranded on a
          // non-invokable lane is reconciled by the bounded repair ladder (board
          // escalation when exhausted) before the assignee-outage descriptor path.
          const notInvokableClassification = classifyContinuationFailure(latestRun);
          if (
            notInvokableClassification.kind === "deliberate_wait_without_target" ||
            readDispositionRepairAttempt(latestRun)
          ) {
            const outcome = await reconcileDispositionRepair(freshIssue, latestRun);
            if (outcome === "escalated") {
              result.escalated += 1;
              result.issueIds.push(freshIssue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue: freshIssue,
            previousStatus: freshIssue.status as StrandedPreviousStatus,
            latestRun,
            recoveryCause: "agent_not_invokable",
            comment:
              "Paperclip cannot continue this assigned issue because the assignee is not invokable " +
              "and the issue has no live execution path. Moving it to `blocked` with a machine-readable " +
              "assignee-not-invokable descriptor so it can self-heal when the assignee becomes invokable again." +
              `${failureSummary ?? ""}`,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(freshIssue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
        // Local: a queued/claimed/deferred wake or a future monitor wake is a live
        // continuation path — don't treat the issue as stranded. Exception: assigned
        // `todo` work whose latest run already failed still gets its one
        // assignment-recovery requeue even if an old queued wake row lingers.
        // in_review issues are excluded: the execution-review participant branch
        // below performs its own agent-scoped wake dedup (a wake queued for a
        // DIFFERENT agent must not starve the pending reviewer).
        const hasQueuedWake = freshIssue.status !== "in_review"
          ? await hasQueuedIssueWake(freshIssue.companyId, freshIssue.id)
          : false;
        const treatQueuedWakeAsLivePath =
          freshIssue.status !== "todo" || !latestRun || latestRun.status === "succeeded";
        if (
          freshIssue.status !== "in_review" &&
          ((treatQueuedWakeAsLivePath && hasQueuedWake) ||
            (freshIssue.monitorNextCheckAt && freshIssue.monitorNextCheckAt > new Date()))
        ) {
          result.skipped += 1;
          continue;
        }
        if (latestRun?.status === "succeeded" && await hasPersistedDurableWaitPath(freshIssue)) {
          result.skipped += 1;
          continue;
        }
        const recoveryNow = new Date();
        const participantLatestRunForRecovery = freshIssue.status === "in_review" && participantAgentId
          ? await getLatestIssueRunForAgent(freshIssue.companyId, freshIssue.id, participantAgentId)
          : null;
        const providerQuotaMonitorRun = freshIssue.status === "in_review"
          ? participantLatestRunForRecovery
          : latestRun;
        if (hasPendingProviderQuotaRecoveryMonitor(freshIssue, providerQuotaMonitorRun, recoveryNow)) {
          result.skipped += 1;
          continue;
        }
        // Upstream (f572e0867): an over-budget recovery target cannot be retried
        // automatically. A pending disposition repair is reconciled by the
        // bounded repair ladder (it escalates `owner_budget_blocked` to the
        // board itself). Fork law for everything else: a budget block is a
        // WAIT, not a stranded-work verdict — lane budgets reset on a schedule
        // here and a latched board escalation per budget window would flood the
        // operator console, so the generic case keeps the fork's skip semantics
        // (upstream escalates it via escalateStrandedAssignedIssue instead).
        if (await isInvocationBudgetBlocked(freshIssue, agentId)) {
          const budgetClassification = classifyContinuationFailure(latestRun);
          if (
            budgetClassification.kind === "deliberate_wait_without_target" ||
            readDispositionRepairAttempt(latestRun)
          ) {
            const outcome = await reconcileDispositionRepair(freshIssue, latestRun);
            if (outcome === "escalated") {
              result.escalated += 1;
              result.issueIds.push(freshIssue.id);
            } else {
              result.skipped += 1;
            }
          } else {
            result.skipped += 1;
          }
          continue;
        }
        if (isStrandedIssueRecoveryIssue(freshIssue) && isUnsuccessfulTerminalIssueRun(latestRun)) {
          const updated = await escalateStrandedRecoveryIssueInPlace({
            issue: freshIssue,
            previousStatus: freshIssue.status as StrandedPreviousStatus,
            latestRun,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(freshIssue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const adapterFailureClassification = freshIssue.status !== "in_review" && latestRun && isUnsuccessfulTerminalIssueRun(latestRun)
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
          // A todo card with an unresolved blocker relation is WAITING, not
          // stranded. Every wake enqueued for it is skipped at the heartbeat
          // gate as issue_dependencies_blocked, and because a skipped wake is
          // terminal it never counts as "queued" — so this reconciler re-fired
          // every tick: 1,440 dead wake rows per card per 6h on three cards
          // (2026-08-22). Skip here and let the blockers-resolved wake dispatch it.
          const todoReadiness = await issuesSvc
            .listDependencyReadiness(issue.companyId, [issue.id])
            .then((rows) => rows.get(issue.id) ?? null);
          if (todoReadiness && !todoReadiness.isDependencyReady) {
            result.skipped += 1;
            continue;
          }

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

          // An operator interruption is an explicit stop decision, not a lost
          // execution path. Its issue-bound metadata prevents an unrelated
          // cancelled run from disabling ordinary assignment recovery.
          if (isVerifiedOperatorInterruptedRunForIssue(latestRun, issue.id)) {
            result.skipped += 1;
            continue;
          }

          if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
            // TSMC-21406: do not turn a lost wake on a HEALTHY lane into a board
            // escalation. Verified live on TSMC-21384 — blocked 108 seconds after
            // the card was created, chained to a board decision, while the owning
            // lane was running normally an hour later.
            //
            // Two independent conditions, either of which means "not stranded":
            //   * the assignment is younger than the grace window — one missed
            //     wake is not a dead lane, and the dispatcher gets another pass;
            //   * the owning agent has succeeded at something recently — the lane
            //     is provably alive, so the execution path is not lost.
            //
            // Skipping only defers: the healer runs again, and a genuinely dead
            // lane still escalates on a later pass with the same evidence. The
            // asymmetry is deliberate — a late escalation costs one more sweep,
            // an early one costs an operator decision that should never have
            // existed, and those decisions were sitting unanswered for 18 hours.
            const assignmentAgeMs = Date.now() - new Date(issue.updatedAt ?? issue.createdAt).getTime();
            if (assignmentAgeMs < STRANDED_ASSIGNMENT_GRACE_MS) {
              result.skipped += 1;
              continue;
            }
            if (await hasRecentSuccessfulAgentRun(agentId, STRANDED_LANE_LIVENESS_WINDOW_MS)) {
              result.skipped += 1;
              continue;
            }
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

          const closeEvidenceMeasurement = await measureCloseEvidence({
            companyId: issue.companyId,
            attachmentsCount: await db
              .select({ count: sql<number>`count(*)::int` })
              .from(issueAttachments)
              .where(eq(issueAttachments.issueId, issue.id))
              .then((rows) => rows[0]?.count ?? 0),
            workProductsCount: await db
              .select({ count: sql<number>`count(*)::int` })
              .from(issueWorkProducts)
              .where(eq(issueWorkProducts.issueId, issue.id))
              .then((rows) => rows[0]?.count ?? 0),
            closeContract: issue.closeContract ?? null,
          });
          if (closeEvidenceMeasurement && closeEvidenceMeasurement.measuredCount < closeEvidenceMeasurement.targetCount) {
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_progress",
              latestRun: successfulRun,
              recoveryCause: "close_evidence_unmet",
              closeEvidenceMeasurement,
              comment:
                "Paperclip detected a stranded close-evidence quota issue: the latest continuation succeeded but the issue still measures " +
                `${closeEvidenceMeasurement.measuredCount}/${closeEvidenceMeasurement.targetCount} governed artifacts.`,
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
      } catch (error) {
        result.skipped += 1;
        logger.warn(
          {
            err: error,
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            companyId: issue.companyId,
            assigneeAgentId: issue.assigneeAgentId ?? null,
          },
          "skipped stranded issue after recovery reconcile error",
        );
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

  async function collectIssueGraphLivenessFindings() {
    const { issueGraphLivenessExcludedCompanyIds } = await instanceSettings.getExperimental();
    const excludedCompanyIds = new Set(issueGraphLivenessExcludedCompanyIds);
    const issueRowsPromise = Promise.resolve(db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorAttemptCount: issues.monitorAttemptCount,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          visibleIssueCondition(),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      ));

    const [
      issueRows,
      relationRows,
      issueLabelRows,
      agentRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryIssueRows,
    ] = await Promise.all([
      issueRowsPromise,
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(eq(issueRelations.type, "blocks")),
      issueRowsPromise.then((rows) => {
        const issueIds = rows.map((row) => row.id);
        return issueIds.length === 0
          ? []
          : db
            .select({
              issueId: issueLabels.issueId,
              name: labels.name,
            })
            .from(issueLabels)
            .innerJoin(labels, eq(issueLabels.labelId, labels.id))
            .where(inArray(issueLabels.issueId, issueIds));
      }),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          capabilities: agents.capabilities,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
          status: agents.status,
          reportsTo: agents.reportsTo,
        })
        .from(agents),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES])),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            visibleIssueCondition(),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.status, "pending")),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(inArray(approvals.status, ["pending", "revision_requested"])),
      db
        .select({
          companyId: issues.companyId,
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .where(
          and(
            visibleIssueCondition(),
            inArray(issues.originKind, [
              STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
              RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            ]),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        ),
    ]);

    const openRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
        if (!parsed || parsed.companyId !== row.companyId) return [];
        return [
          {
            companyId: row.companyId,
            issueId: parsed.issueId,
            status: row.status,
          },
          {
            companyId: row.companyId,
            issueId: parsed.leafIssueId,
            status: row.status,
          },
        ];
      }

      const issueId = readNonEmptyString(row.originId);
      if (!issueId) return [];
      return [{
        companyId: row.companyId,
        issueId,
        status: row.status,
      }];
    });

    const labelNamesByIssueId = new Map<string, string[]>();
    for (const row of issueLabelRows) {
      const existing = labelNamesByIssueId.get(row.issueId) ?? [];
      existing.push(row.name);
      labelNamesByIssueId.set(row.issueId, existing);
    }

    const scopedIssueRows = excludedCompanyIds.size === 0
      ? issueRows
      : issueRows.filter((row) => !excludedCompanyIds.has(row.companyId));

    return classifyIssueGraphLiveness({
      issues: scopedIssueRows.map((row) => ({
        ...row,
        labels: labelNamesByIssueId.get(row.id) ?? [],
      })),
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      openRecoveryIssues,
      now: new Date(),
      blockedStaleHours: ISSUE_GRAPH_LIVENESS_BLOCKED_STALE_HOURS,
    });
  }

  async function findOpenLivenessEscalation(companyId: string, incidentKey: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originId, incidentKey),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // TSMC-20155/20183: reuse an open liveness escalation that shares the coarser
  // leaf fingerprint (company+state+leaf) even when the incidentKey differs, so a
  // backfill/receipt write does not collide on issues_active_liveness_recovery_leaf_uq.
  async function findOpenLivenessEscalationByLeafFingerprint(companyId: string, leafFingerprint: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originFingerprint, leafFingerprint),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenLivenessRecoveryIssueForLeaf(finding: IssueLivenessFinding) {
    const byFingerprint = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byFingerprint) return byFingerprint;

    const leafIssueId = livenessRecoveryLeafIssueId(finding);
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafIssueId === leafIssueId;
    }) ?? null;
  }

  async function findOpenLivenessEscalationByRootCauseFingerprint(
    companyId: string,
    rootCauseFingerprint: string,
  ) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          sql`${issues.executionState} ->> 'livenessRootCauseFingerprint' = ${rootCauseFingerprint}`,
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // TSMC-20489: when a NEW leaf is discovered for a (company, source issue,
  // state) that already has an open root-cause escalation, attach it as a
  // linked dependent (a comment + recorded leaf fingerprint) instead of
  // minting another top-level ticket. Idempotent — each leaf fingerprint is
  // recorded once in the escalation's executionState, so repeat reconcile
  // ticks for the SAME leaf don't repost the comment.
  async function findOrAttachLivenessRootCauseEscalation(finding: IssueLivenessFinding) {
    const rootCauseFingerprint = livenessRecoveryRootCauseFingerprint(finding);
    const existing = await findOpenLivenessEscalationByRootCauseFingerprint(
      finding.companyId,
      rootCauseFingerprint,
    );
    if (!existing) return null;

    const leafFingerprint = livenessRecoveryLeafFingerprint(finding);
    const existingState = parseObject(existing.executionState);
    const attachedLeafFingerprints = Array.isArray(existingState.livenessAttachedLeafFingerprints)
      ? existingState.livenessAttachedLeafFingerprints.filter((value): value is string => typeof value === "string")
      : [];
    if (attachedLeafFingerprints.includes(leafFingerprint)) return existing;

    const leafEntry = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
    await db.insert(issueComments).values({
      companyId: finding.companyId,
      issueId: existing.id,
      body: [
        "Linked dependent — same root cause, rolled up here instead of opening a new top-level ticket (TSMC-20489).",
        "",
        `- New leaf: ${leafEntry?.identifier ?? leafEntry?.issueId ?? finding.recoveryIssueId}`,
        `- Detected invariant: \`${finding.state}\``,
        `- Dependency path: ${formatDependencyPath(finding)}`,
        `- Reason: ${finding.reason}`,
      ].join("\n"),
    });

    await issuesSvc.update(existing.id, {
      executionState: {
        ...existingState,
        livenessRootCauseFingerprint: rootCauseFingerprint,
        livenessAttachedLeafFingerprints: [...attachedLeafFingerprints, leafFingerprint],
      },
    });

    return existing;
  }

  function livenessRecoveryActionCause(finding: IssueLivenessFinding) {
    return `issue_graph_liveness:${finding.state}`;
  }

  function livenessRecoveryActionFingerprint(finding: IssueLivenessFinding) {
    return finding.incidentKey;
  }

  function normalizeRecoveryTimestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function livenessRecoveryBackoffMs(attemptCount: number) {
    return ISSUE_GRAPH_LIVENESS_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attemptCount - 1));
  }

  async function getLatestLivenessRecoveryAction(finding: IssueLivenessFinding) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, finding.companyId),
          eq(issueRecoveryActions.sourceIssueId, finding.issueId),
          eq(issueRecoveryActions.kind, "issue_graph_liveness"),
          eq(issueRecoveryActions.cause, livenessRecoveryActionCause(finding)),
          eq(issueRecoveryActions.fingerprint, livenessRecoveryActionFingerprint(finding)),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findRecentCompletedLivenessRecoveryIssue(
    finding: IssueLivenessFinding,
    now: Date,
    cooldownMs: number,
  ) {
    if (cooldownMs <= 0) return null;
    const cutoff = new Date(now.getTime() - cooldownMs);
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          or(
            eq(issues.originId, finding.incidentKey),
            eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          ),
          visibleIssueCondition(),
          eq(issues.status, "done"),
          gte(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function ensureLivenessNeedsHumanThrottle(input: {
    finding: IssueLivenessFinding;
    actionId: string;
    currentRecoveryIssueId: string | null;
    runId?: string | null;
  }) {
    const existingAction = await db
      .select({ evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, input.actionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const previousEvidence = parseObject(existingAction?.evidence);
    const alreadyCommented = asBoolean(previousEvidence.livenessNeedsHumanCommented, false);

    const [action] = await db
      .update(issueRecoveryActions)
      .set({
        ownerType: "board",
        ownerAgentId: null,
        recoveryIssueId: input.currentRecoveryIssueId,
        status: "escalated",
        maxAttempts: ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS,
        nextAction:
          `Manual intervention required. Automatic liveness retries stopped after ${ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS} attempts for ${input.finding.incidentKey}.`,
        evidence: {
          ...previousEvidence,
          incidentKey: input.finding.incidentKey,
          state: input.finding.state,
          dependencyPath: input.finding.dependencyPath,
          cappedAtAttempts: ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS,
          ...(alreadyCommented ? { livenessNeedsHumanCommented: true } : {}),
        },
        updatedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, input.actionId))
      .returning();

    if (!action) return;
    if (alreadyCommented) return;

    await issuesSvc.addComment(
      input.finding.issueId,
      [
        "Paperclip stopped automatic liveness retry creation for this incident.",
        "",
        `- Incident key: \`${input.finding.incidentKey}\``,
        `- Finding: \`${input.finding.state}\``,
        `- Attempts used: ${action.attemptCount}/${ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS}`,
        `- Next action: manual owner intervention is now required to unblock ${input.finding.identifier ?? input.finding.issueId}.`,
      ].join("\n"),
      { runId: input.runId ?? null },
    );

    await db
      .update(issueRecoveryActions)
      .set({
        evidence: {
          ...parseObject(action.evidence),
          livenessNeedsHumanCommented: true,
        },
        updatedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, input.actionId));
  }

  async function removeRecoveryBlockerFromSource(recovery: typeof issues.$inferSelect) {
    const parsed = parseLivenessIncidentKey(recovery.originId);
    if (!parsed) return false;
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, recovery.companyId), eq(issues.id, parsed.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return false;

    const blockerIds = await existingBlockerIssueIds(sourceIssue.companyId, sourceIssue.id);
    if (!blockerIds.includes(recovery.id)) return false;
    const remainingBlockerIds = blockerIds.filter((blockerId) => blockerId !== recovery.id);
    // TSMC-20058: when the recovery escalation was the only wait path, always
    // release the source. Recovery writers stamp external-gate prose so a bare
    // blocker-relation patch can succeed while leaving the source blocked with
    // no live owner — the stranded-recovery-guard contradiction. Prefer the
    // intentional release over relying on the enter-blocked 422 path.
    const unresolvedRemaining = await existingUnresolvedBlockerIssueIds(
      sourceIssue.companyId,
      sourceIssue.id,
    ).then((ids) => ids.filter((blockerId) => blockerId !== recovery.id));
    if (sourceIssue.status === "blocked" && unresolvedRemaining.length === 0) {
      await issuesSvc.update(sourceIssue.id, {
        blockedByIssueIds: remainingBlockerIds,
        status: "todo",
      });
      return true;
    }
    try {
      await issuesSvc.update(sourceIssue.id, { blockedByIssueIds: remainingBlockerIds });
    } catch (error) {
      // Entering-blocked gate: when dropping the escalation blocker leaves a
      // still-"blocked" source whose remaining blockers are all resolved (and
      // no external owner/action sanctions the block), the bare relation patch
      // is rejected with a 422 — and an uncaught throw here wedges the WHOLE
      // liveness reconcile every cycle. All-blockers-resolved means the issue
      // should not stay blocked, so release it to todo in the same patch,
      // matching the dependency-resolution path.
      if (!(error instanceof HttpError) || error.status !== 422 || sourceIssue.status !== "blocked") {
        throw error;
      }
      await issuesSvc.update(sourceIssue.id, {
        blockedByIssueIds: remainingBlockerIds,
        status: "todo",
      });
    }
    return true;
  }

  async function hasActiveRunForIssueId(companyId: string, issueId: string) {
    const [contextRun, issueRun] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
              OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.id, issueId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(contextRun || issueRun);
  }

  async function retireObsoleteLivenessRecoveryIssues(findings: IssueLivenessFinding[]) {
    const currentIncidentKeys = new Set(findings.map((finding) => finding.incidentKey));
    const currentLeafKeys = new Set(
      findings.map((finding) =>
        livenessRecoveryLeafKey(
          finding.companyId,
          finding.state,
          livenessRecoveryLeafIssueId(finding),
        ),
      ),
    );
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const result = {
      retired: 0,
      activeSkipped: 0,
      blockerRelationsRemoved: 0,
      retiredIssueIds: [] as string[],
    };

    for (const recovery of openRecoveries) {
      if (recovery.originId && currentIncidentKeys.has(recovery.originId)) continue;
      const parsed = parseLivenessIncidentKey(recovery.originId);
      if (!parsed) continue;
      if (
        currentLeafKeys.has(
          livenessRecoveryLeafKey(parsed.companyId, parsed.state, parsed.leafIssueId),
        )
      ) {
        continue;
      }
      const sourceIssue = await db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, parsed.companyId), eq(issues.id, parsed.issueId)))
        .then((rows) => rows[0] ?? null);
      if (sourceIssue && !["done", "cancelled"].includes(sourceIssue.status)) {
        const blockerIds = await existingBlockerIssueIds(parsed.companyId, sourceIssue.id);
        if (blockerIds.includes(recovery.id)) {
          result.activeSkipped += 1;
          continue;
        }
      }
      if (await removeRecoveryBlockerFromSource(recovery)) {
        result.blockerRelationsRemoved += 1;
      }
      if (await hasActiveRunForIssueId(recovery.companyId, recovery.id)) {
        result.activeSkipped += 1;
        continue;
      }
      await issuesSvc.update(recovery.id, { status: "cancelled" });
      result.retired += 1;
      result.retiredIssueIds.push(recovery.id);
    }

    return result;
  }

  async function retireDoneLivenessRecoveryBlockers() {
    const closedRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          inArray(issues.status, ["done", "cancelled"]),
        ),
      );

    let blockerRelationsRemoved = 0;
    for (const recovery of closedRecoveries) {
      if (await removeRecoveryBlockerFromSource(recovery)) {
        blockerRelationsRemoved += 1;
      }
    }

    return { blockerRelationsRemoved };
  }

  function normalizeIssueGraphLivenessAutoRecoveryLookbackHours(raw: unknown) {
    const numeric = Math.floor(asNumber(raw, DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS));
    return Math.min(
      MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
      Math.max(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS, numeric),
    );
  }

  function livenessDependencyIssueKey(companyId: string, issueId: string) {
    return `${companyId}:${issueId}`;
  }

  async function loadLivenessDependencyUpdatedAtByIssue(findings: IssueLivenessFinding[]) {
    const issueIds = [
      ...new Set(
        findings.flatMap((finding) => finding.dependencyPath.map((entry) => entry.issueId)),
      ),
    ];
    if (issueIds.length === 0) return new Map<string, Date>();
    const rows = await db
      .select({ id: issues.id, companyId: issues.companyId, updatedAt: issues.updatedAt })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    return new Map(rows.map((row) => [
      livenessDependencyIssueKey(row.companyId, row.id),
      row.updatedAt,
    ]));
  }

  function latestDependencyUpdatedAtForLivenessFinding(
    finding: IssueLivenessFinding,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const dependencyIssueIds = [...new Set(finding.dependencyPath.map((entry) => entry.issueId))];
    if (dependencyIssueIds.length === 0) return null;
    const timestamps = dependencyIssueIds.map((issueId) =>
      updatedAtByIssueKey.get(livenessDependencyIssueKey(finding.companyId, issueId)) ?? null
    );
    if (timestamps.some((timestamp) => !timestamp)) return null;
    const [firstTimestamp, ...remainingTimestamps] = timestamps as Date[];
    return remainingTimestamps.reduce((latest, updatedAt) =>
      updatedAt > latest ? updatedAt : latest,
    firstTimestamp!);
  }

  function isLivenessFindingInsideAutoRecoveryLookback(
    finding: IssueLivenessFinding,
    cutoff: Date,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const latestUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(finding, updatedAtByIssueKey);
    return Boolean(latestUpdatedAt && latestUpdatedAt >= cutoff);
  }

  async function buildIssueGraphLivenessAutoRecoveryPreview(
    opts?: { lookbackHours?: number; now?: Date },
  ): Promise<IssueGraphLivenessAutoRecoveryPreview> {
    const now = opts?.now ?? new Date();
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(opts?.lookbackHours);
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const findings = await collectIssueGraphLivenessFindings();
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);
    const issueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
    const recoveryRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
      : [];
    const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
    const items: IssueGraphLivenessAutoRecoveryPreviewItem[] = [];
    let skippedOutsideLookback = 0;

    for (const finding of findings) {
      const latestDependencyUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(
        finding,
        updatedAtByIssueKey,
      );
      if (!latestDependencyUpdatedAt || latestDependencyUpdatedAt < cutoff) {
        skippedOutsideLookback += 1;
        continue;
      }
      const recoveryIssue = recoveryById.get(finding.recoveryIssueId);
      items.push({
        issueId: finding.issueId,
        identifier: finding.identifier,
        title: finding.dependencyPath[0]?.title ?? finding.identifier ?? finding.issueId,
        state: finding.state,
        severity: finding.severity,
        reason: finding.reason,
        recoveryIssueId: finding.recoveryIssueId,
        recoveryIdentifier: recoveryIssue?.identifier ?? null,
        recoveryTitle: recoveryIssue?.title ?? null,
        recommendedOwnerAgentId: finding.recommendedOwnerAgentId,
        incidentKey: finding.incidentKey,
        latestDependencyUpdatedAt: latestDependencyUpdatedAt.toISOString(),
        dependencyPath: finding.dependencyPath,
      });
    }

    return {
      lookbackHours,
      cutoff: cutoff.toISOString(),
      generatedAt: now.toISOString(),
      findings: findings.length,
      recoverableFindings: items.length,
      skippedOutsideLookback,
      items,
    };
  }

  async function resolveEscalationOwnerAgentId(
    finding: IssueLivenessFinding,
    issue: typeof issues.$inferSelect,
  ) {
    const detailedCandidates = finding.recommendedOwnerCandidates.length > 0
      ? finding.recommendedOwnerCandidates
      : finding.recommendedOwnerCandidateAgentIds.map((agentId) => ({
        agentId,
        reason: "ordered_invokable_fallback" as const,
        sourceIssueId: finding.recoveryIssueId,
      }));
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    const budgetBlockedCandidateAgentIds: string[] = [];

    for (const candidate of candidates) {
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (!budgetBlock) {
        return {
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceIssueId: candidate.sourceIssueId,
          candidateAgentIds: candidates.map((entry) => entry.agentId),
          candidateReasons: candidates.map((entry) => ({
            agentId: entry.agentId,
            reason: entry.reason,
            sourceIssueId: entry.sourceIssueId,
          })),
          budgetBlockedCandidateAgentIds,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    return null;
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryIssueId === input.finding.issueId) return false;
    return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
  }

  async function ensureIssueBlockedByEscalation(input: {
    issue: typeof issues.$inferSelect;
    escalationIssueId: string;
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const blockerIds = await existingBlockerIssueIds(input.issue.companyId, input.issue.id);
    const nextBlockerIds = [...new Set([...blockerIds, input.escalationIssueId])];
    const isAlreadyBlockedByEscalation = blockerIds.includes(input.escalationIssueId);
    const isAlreadyBlocked = input.issue.status === "blocked";
    if (isAlreadyBlockedByEscalation && isAlreadyBlocked) {
      return input.issue;
    }

    const update: Partial<typeof issues.$inferInsert> & { blockedByIssueIds: string[] } = {
      blockedByIssueIds: nextBlockerIds,
    };
    if (!isAlreadyBlocked) {
      update.status = "blocked";
    }

    const updated = await issuesSvc.update(input.issue.id, update);
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "issue.blockers.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        blockerIssueIds: nextBlockerIds,
        escalationIssueId: input.escalationIssueId,
        status: update.status ?? input.issue.status,
        previousStatus: input.issue.status,
      },
    });

    return updated;
  }

  // TSMC-20155/20183: mint (or reuse) a BOARD-visible receipt issue for a capped
  // liveness incident. The normal escalation path (createIssueGraphLivenessEscalation)
  // only runs when an invokable owner exists; the attempt-cap branch has none, so it
  // handed the issue to the board with recovery_issue_id NULL — a silent escalation.
  // This creates a board-owned (unassigned) escalation issue deduped on the same
  // incidentKey/leaf-fingerprint keys the reconcile loop already uses, so the next
  // tick reuses it via findOpenLivenessEscalation instead of duplicating.
  async function ensureLivenessBoardEscalationIssue(input: {
    issue: typeof issues.$inferSelect;
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
  }) {
    const existing =
      await findOpenLivenessEscalation(input.issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding) ??
      await findOrAttachLivenessRootCauseEscalation(input.finding);
    if (existing) return existing;

    try {
      return await issuesSvc.create(input.issue.companyId, {
        title: `BOARD ACTION REQUIRED: Liveness incident needs a human owner — ${input.issue.identifier ?? input.issue.id}`,
        description: [
          buildLivenessEscalationDescription(input.finding),
          "",
          "## Board escalation",
          "",
          `- Automatic liveness retries were exhausted after ${ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS} attempts with no invokable recovery owner.`,
          "- This card is the board-visible receipt for that capped escalation; assign an invokable owner or record an intentional manual resolution.",
        ].join("\n"),
        status: "todo",
        priority: "high",
        parentId: input.recoveryIssue.id,
        projectId: input.recoveryIssue.projectId,
        goalId: input.recoveryIssue.goalId,
        assigneeAgentId: null,
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        executionState: {
          livenessRootCauseFingerprint: livenessRecoveryRootCauseFingerprint(input.finding),
          livenessAttachedLeafFingerprints: [],
        },
        billingCode: input.recoveryIssue.billingCode,
        executionWorkspaceId: null,
        executionWorkspacePreference: null,
        executionWorkspaceSettings: null,
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(input.issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding) ??
        await findOrAttachLivenessRootCauseEscalation(input.finding);
      if (!raced) throw error;
      return raced;
    }
  }

  async function createIssueGraphLivenessEscalation(input: {
    finding: IssueLivenessFinding;
    runId?: string | null;
    now: Date;
    reescalationCooldownMs: number;
  }) {
    const recoveryActionCause = livenessRecoveryActionCause(input.finding);
    const recoveryActionFingerprint = livenessRecoveryActionFingerprint(input.finding);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.finding.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if ((await evaluateAutomaticRecoverySuppression(issue.companyId, issue.id)).suppressed) {
      return { kind: "skipped" as const };
    }

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.finding.recoveryIssueId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryIssue) return { kind: "skipped" as const };

    const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
    if (activeRecoveryAction && activeRecoveryAction.kind !== "issue_graph_liveness") {
      return { kind: "skipped" as const };
    }
    const latestRecoveryAction = activeRecoveryAction?.kind === "issue_graph_liveness"
      ? activeRecoveryAction
      : await getLatestLivenessRecoveryAction(input.finding);

    const existing =
      await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding) ??
      await findOrAttachLivenessRootCauseEscalation(input.finding);
    if (existing) {
      if (!activeRecoveryAction) {
        await recoveryActionsSvc.upsertSourceScoped({
          companyId: issue.companyId,
          sourceIssueId: issue.id,
          recoveryIssueId: existing.id,
          kind: "issue_graph_liveness",
          ownerType: existing.assigneeAgentId ? "agent" : "board",
          ownerAgentId: existing.assigneeAgentId ?? null,
          cause: recoveryActionCause,
          fingerprint: recoveryActionFingerprint,
          evidence: {
            incidentKey: input.finding.incidentKey,
            state: input.finding.state,
            dependencyPath: input.finding.dependencyPath,
            openEscalationIssueId: existing.id,
          },
          nextAction: input.finding.recommendedAction,
          maxAttempts: ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS,
          initialAttemptCount: latestRecoveryAction?.attemptCount ?? 1,
          lastAttemptAt: normalizeRecoveryTimestamp(latestRecoveryAction?.lastAttemptAt ?? existing.updatedAt),
        });
      }
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: existing.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: existing.id };
    }
    if (await findRecentCompletedLivenessRecoveryIssue(
      input.finding,
      input.now,
      input.reescalationCooldownMs,
    )) {
      return { kind: "cooldown" as const };
    }

    if (latestRecoveryAction) {
      const maxAttempts = latestRecoveryAction.maxAttempts ?? ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS;
      if (latestRecoveryAction.attemptCount >= maxAttempts) {
        // TSMC-20155/20183: a capped liveness escalation is a board hand-off. The
        // upsert below and the throttle that follows previously wrote
        // owner_type='board' with recovery_issue_id NULL — a silent escalation the
        // Operator Console / first-class wait path cannot surface (the inverse
        // stranded-recovery class). Mint (or reuse) a board-visible receipt issue
        // BEFORE the upsert so both the durable action and the throttle carry a
        // non-null recovery_issue_id, and block the source by it so the wait is
        // first-class.
        const boardEscalation = await ensureLivenessBoardEscalationIssue({
          issue,
          finding: input.finding,
          recoveryIssue,
        });
        const durableAction = activeRecoveryAction?.kind === "issue_graph_liveness"
          ? activeRecoveryAction
          : await recoveryActionsSvc.upsertSourceScoped({
            companyId: issue.companyId,
            sourceIssueId: issue.id,
            recoveryIssueId: boardEscalation.id,
            kind: "issue_graph_liveness",
            ownerType: "board",
            ownerAgentId: null,
            cause: recoveryActionCause,
            fingerprint: recoveryActionFingerprint,
            evidence: {
              incidentKey: input.finding.incidentKey,
              state: input.finding.state,
              dependencyPath: input.finding.dependencyPath,
              cappedAtAttempts: maxAttempts,
              openEscalationIssueId: boardEscalation.id,
            },
            nextAction:
              `Manual intervention required. Automatic liveness retries stopped after ${maxAttempts} attempts for ${input.finding.incidentKey}.`,
            maxAttempts,
            initialAttemptCount: latestRecoveryAction.attemptCount,
            lastAttemptAt: normalizeRecoveryTimestamp(
              latestRecoveryAction.lastAttemptAt ?? latestRecoveryAction.updatedAt,
            ),
          });
        await ensureLivenessNeedsHumanThrottle({
          finding: input.finding,
          actionId: durableAction.id,
          // Always propagate the freshly ensured OPEN board receipt. Reaching the
          // capped branch means findOpenLivenessEscalation returned null, so any
          // pre-existing durableAction.recoveryIssueId points at a done/cancelled
          // escalation (stale) and must not be preserved (TSMC-20155/20183).
          currentRecoveryIssueId: boardEscalation.id,
          runId: input.runId ?? null,
        });
        await ensureIssueBlockedByEscalation({
          issue,
          escalationIssueId: boardEscalation.id,
          finding: input.finding,
          runId: input.runId ?? null,
        });
        return { kind: "capped" as const };
      }

      const lastAttemptAtMs = normalizeRecoveryTimestamp(
        latestRecoveryAction.lastAttemptAt ?? latestRecoveryAction.updatedAt,
      )?.getTime() ?? Date.now();
      const retryNotBefore = lastAttemptAtMs + livenessRecoveryBackoffMs(latestRecoveryAction.attemptCount);
      if (retryNotBefore > Date.now()) {
        return { kind: "rate_limited" as const, retryNotBefore: new Date(retryNotBefore).toISOString() };
      }
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryIssue);
    if (!ownerSelection) return { kind: "skipped" as const };
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryIssue,
      ownerAgentId: ownerSelection.agentId,
    });

    let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      escalation = await issuesSvc.create(issue.companyId, {
        title: `Unblock liveness incident for ${issue.identifier ?? issue.id}`,
        description: buildLivenessEscalationDescription(input.finding),
        status: "todo",
        priority: "high",
        parentId: recoveryIssue.id,
        projectId: recoveryIssue.projectId,
        goalId: recoveryIssue.goalId,
        assigneeAgentId: ownerSelection.agentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        executionState: {
          livenessRootCauseFingerprint: livenessRecoveryRootCauseFingerprint(input.finding),
          livenessAttachedLeafFingerprints: [],
        },
        billingCode: recoveryIssue.billingCode,
        ...(reuseRecoveryExecutionWorkspace
          ? { inheritExecutionWorkspaceFromIssueId: recoveryIssue.id }
          : {
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
          }),
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding) ??
        await findOrAttachLivenessRootCauseEscalation(input.finding);
      if (!raced) throw error;
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: raced.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: raced.id };
    }

    await recoveryActionsSvc.upsertSourceScoped({
      companyId: issue.companyId,
      sourceIssueId: issue.id,
      recoveryIssueId: escalation.id,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: ownerSelection.agentId,
      cause: recoveryActionCause,
      fingerprint: recoveryActionFingerprint,
      evidence: {
        incidentKey: input.finding.incidentKey,
        state: input.finding.state,
        dependencyPath: input.finding.dependencyPath,
        escalationIssueId: escalation.id,
        escalationIdentifier: escalation.identifier,
      },
      nextAction: input.finding.recommendedAction,
      maxAttempts: ISSUE_GRAPH_LIVENESS_MAX_ATTEMPTS,
      initialAttemptCount: latestRecoveryAction ? latestRecoveryAction.attemptCount + 1 : 1,
      lastAttemptAt: new Date(),
    });

    await ensureIssueBlockedByEscalation({
      issue,
      escalationIssueId: escalation.id,
      finding: input.finding,
      runId: input.runId ?? null,
    });

    await issuesSvc.addComment(
      issue.id,
      buildLivenessOriginalIssueComment(input.finding, escalation),
      { runId: input.runId ?? null },
    );

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerSelection.agentId,
      runId: input.runId ?? null,
      action: "issue.harness_liveness_escalation_created",
      entityType: "issue",
      entityId: escalation.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        recoveryIssueId: recoveryIssue.id,
        recoveryIdentifier: recoveryIssue.identifier,
        escalationIssueId: escalation.id,
        escalationIdentifier: escalation.identifier,
        dependencyPath: input.finding.dependencyPath,
        ownerSelection: {
          selectedAgentId: ownerSelection.agentId,
          selectedReason: ownerSelection.reason,
          selectedSourceIssueId: ownerSelection.sourceIssueId,
          candidateAgentIds: ownerSelection.candidateAgentIds,
          candidateReasons: ownerSelection.candidateReasons,
          budgetBlockedCandidateAgentIds: ownerSelection.budgetBlockedCandidateAgentIds,
        },
        workspaceSelection: {
          reuseRecoveryExecutionWorkspace,
          inheritedExecutionWorkspaceFromIssueId: reuseRecoveryExecutionWorkspace ? recoveryIssue.id : null,
          projectWorkspaceSourceIssueId: recoveryIssue.id,
        },
      },
    });

    const wake = await deps.enqueueWakeup(ownerSelection.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: escalation.id,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: escalation.id,
        taskId: escalation.id,
        wakeReason: "issue_assigned",
        source: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      sourceIssueId: issue.id,
      recoveryIssueId: recoveryIssue.id,
      escalationIssueId: escalation.id,
      ownerAgentId: ownerSelection.agentId,
      ownerSelectionReason: ownerSelection.reason,
      wakeupRunId: wake?.id ?? null,
    }, "created issue graph liveness escalation");

    return { kind: "created" as const, escalationIssueId: escalation.id };
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
        });
        const existingWake = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
          companyId,
          dependentIssueId: candidate.id,
          blockerIssueIds: readiness.blockerIssueIds,
          terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
        });
        if (existingWake) {
          result.existingWakeSkipped += 1;
          continue;
        }

        // TSMC-21321: backstop candidates are always status=blocked. If we already
        // delivered (or cancelled) a blockers_resolved wake for this dependent
        // recently — even under a different ready-state digest — hold further
        // backstop emits on the escalating cooldown so key-churn cannot burn the
        // fleet (TSR-5723). Route-time resolution of a brand-new blocker edge
        // still wakes via the issue update path.
        const stillBlockedHold = await findStillBlockedDependencyWakeSuppression(db, {
          companyId,
          dependentIssueId: candidate.id,
        });
        if (stillBlockedHold) {
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

        if ((await evaluateAutomaticRecoverySuppression(companyId, candidate.id)).suppressed) {
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

  async function reconcileIssueGraphLiveness(opts?: {
    runId?: string | null;
    force?: boolean;
    lookbackHours?: number;
    issueCreatedAtGte?: Date | null;
    now?: Date;
    reescalationCooldownMs?: number;
  }) {
    let findings = await collectIssueGraphLivenessFindings();
    if (opts?.issueCreatedAtGte) {
      const findingIssueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
      const eligibleIssueIds = new Set(
        findingIssueIds.length === 0
          ? []
          : (await db
              .select({ id: issues.id })
              .from(issues)
              .where(and(
                inArray(issues.id, findingIssueIds),
                gte(issues.createdAt, opts.issueCreatedAtGte),
              )))
              .map((issue) => issue.id),
      );
      findings = findings.filter((finding) => eligibleIssueIds.has(finding.recoveryIssueId));
    }
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableIssueGraphLivenessAutoRecovery,
      true,
    ) || opts?.force === true;
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(
      opts?.lookbackHours ?? experimentalSettings.issueGraphLivenessAutoRecoveryLookbackHours,
    );
    const now = opts?.now ?? new Date();
    const reescalationCooldownMs = Math.max(
      0,
      Math.floor(asNumber(opts?.reescalationCooldownMs, DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS)),
    );
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryIssues(findings);
    const doneRecoveryBlockerCleanup = await retireDoneLivenessRecoveryBlockers();
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);
    const result = {
      findings: findings.length,
      autoRecoveryEnabled,
      lookbackHours,
      cutoff: cutoff.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      skippedRateLimited: 0,
      rateLimited: false,
      skippedReescalationCooldown: 0,
      obsoleteRecoveriesRetired: obsoleteRecoveryCleanup.retired,
      obsoleteRecoveriesActiveSkipped: obsoleteRecoveryCleanup.activeSkipped,
      obsoleteRecoveryBlockerRelationsRemoved: obsoleteRecoveryCleanup.blockerRelationsRemoved,
      doneRecoveryBlockerRelationsRemoved: doneRecoveryBlockerCleanup.blockerRelationsRemoved,
      dependencyWakeBackstopChecked: 0,
      dependencyWakesHealed: 0,
      dependencyWakeExistingSkipped: 0,
      dependencyWakeLivePathSkipped: 0,
      dependencyWakeInteractionSkipped: 0,
      dependencyWakePauseHoldSkipped: 0,
      dependencyWakeNotReadySkipped: 0,
      dependencyWakeCandidateLimitSkipped: 0,
      dependencyWakeDeferredOrFailed: 0,
      dependencyWakeEnqueueFailed: 0,
      dependencyWakeIssueIds: [] as string[],
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      retiredRecoveryIssueIds: obsoleteRecoveryCleanup.retiredIssueIds,
    };

    const dependencyWakeBackstop = await reconcileResolvedDependencyWakeBackstop({
      runId: opts?.runId ?? null,
    });
    result.dependencyWakeBackstopChecked = dependencyWakeBackstop.checked;
    result.dependencyWakesHealed = dependencyWakeBackstop.healed;
    result.dependencyWakeExistingSkipped = dependencyWakeBackstop.existingWakeSkipped;
    result.dependencyWakeLivePathSkipped = dependencyWakeBackstop.livePathSkipped;
    result.dependencyWakeInteractionSkipped = dependencyWakeBackstop.interactionSkipped;
    result.dependencyWakePauseHoldSkipped = dependencyWakeBackstop.pauseHoldSkipped;
    result.dependencyWakeNotReadySkipped = dependencyWakeBackstop.notReadySkipped;
    result.dependencyWakeCandidateLimitSkipped = dependencyWakeBackstop.candidateLimitSkipped;
    result.dependencyWakeDeferredOrFailed = dependencyWakeBackstop.deferredOrFailed;
    result.dependencyWakeEnqueueFailed = dependencyWakeBackstop.enqueueFailed;
    result.dependencyWakeIssueIds = dependencyWakeBackstop.issueIds;

    if (!autoRecoveryEnabled) {
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    for (const finding of findings) {
      if (!isLivenessFindingInsideAutoRecoveryLookback(finding, cutoff, updatedAtByIssueKey)) {
        result.skippedOutsideLookback += 1;
        result.skipped += 1;
        continue;
      }
      if (result.escalationsCreated >= ISSUE_GRAPH_LIVENESS_MAX_ESCALATIONS_PER_RUN) {
        // Per-run cap reached — drip-feed the rest on subsequent runs rather
        // than bursting the whole backlog into escalations at once.
        result.rateLimited = true;
        break;
      }
      const escalation = await createIssueGraphLivenessEscalation({
        finding,
        runId: opts?.runId ?? null,
        now,
        reescalationCooldownMs,
      });
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "rate_limited" || escalation.kind === "capped") {
        result.skippedRateLimited += 1;
        result.skipped += 1;
        result.rateLimited = true;
      } else if (escalation.kind === "cooldown") {
        result.skippedReescalationCooldown += 1;
        result.skipped += 1;
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  function restartLaneFailureText(run: RestartLaneCandidate["failedRun"]) {
    return [
      run.error,
      run.errorCode,
      JSON.stringify(parseObject(run.resultJson)),
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  async function countRestartLaneAttempts(candidate: RestartLaneCandidate) {
    const rows = await db
      .select({ error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, candidate.agent.companyId),
        eq(heartbeatRuns.agentId, candidate.agent.id),
        inArray(heartbeatRuns.status, [...UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES]),
      ));
    return Math.max(1, rows.filter((run) => RESTART_LANE_RECOVERY_SIGNATURE_RE.test([
      run.error,
      run.errorCode,
      JSON.stringify(parseObject(run.resultJson)),
    ].filter(Boolean).join("\n"))).length);
  }

  async function recordRestartLaneUnrecoverable(entry: RestartLaneUnrecoverable) {
    const detail = `${RESTART_LANE_RECOVERY_ERROR_PREFIX}${entry.reason}; failed_run=${entry.failedRun.id}; attempts=${entry.attemptCount}`;
    await db
      .update(agents)
      .set({ status: "error", errorReason: detail, updatedAt: new Date() })
      .where(and(eq(agents.id, entry.agent.id), eq(agents.status, "error")));
  }

  async function createRestartLaneRecoveryIssues(entries: RestartLaneUnrecoverable[]) {
    const issueIds: string[] = [];
    const byCompany = new Map<string, RestartLaneUnrecoverable[]>();
    for (const entry of entries) {
      const companyEntries = byCompany.get(entry.agent.companyId) ?? [];
      companyEntries.push(entry);
      byCompany.set(entry.agent.companyId, companyEntries);
    }
    for (const [companyId, companyEntries] of byCompany) {
      const body = [
        "Automated restart-lane recovery could not obtain a successor heartbeat run for the lanes below.",
        "",
        ...companyEntries.map((entry) =>
          `- ${entry.agent.name} (agent \`${entry.agent.id}\`): ${entry.reason}; last error: ${restartLaneFailureText(entry.failedRun) || "none"}; run \`${entry.failedRun.id}\`; attempt ${entry.attemptCount}`,
        ),
        "",
        "A board operator should repair the affected lanes before another recovery sweep is attempted.",
      ].join("\n");
      const fingerprint = companyEntries
        .map((entry) => `${entry.agent.id}:${entry.failedRun.id}:${entry.attemptCount}`)
        .sort()
        .join(",");
      const issue = await issuesSvc.create(companyId, {
        title: RESTART_LANE_RECOVERY_ISSUE_TITLE,
        description: body,
        status: "backlog",
        priority: "high",
        originKind: "restart_lane_recovery",
        originId: companyId,
        originFingerprint: fingerprint,
        idempotencyKey: `restart-lane-recovery:${companyId}:${fingerprint}`,
      });
      issueIds.push(issue.id);
    }
    return issueIds;
  }

  async function runRestartLaneRecoverySweep(): Promise<RestartLaneRecoverySweepResult> {
    const result: RestartLaneRecoverySweepResult = {
      candidates: 0,
      reset: 0,
      recovered: 0,
      unrecoverable: 0,
      skipped: 0,
      batchSizes: [],
      successorRunIds: [],
      unrecoverableAgentIds: [],
      issueIds: [],
    };
    const erroredAgents = await db.select().from(agents).where(eq(agents.status, "error"));
    const candidates: RestartLaneCandidate[] = [];
    for (const agent of erroredAgents) {
      // A previous timed-out batch is terminal for that exact failure: a new
      // operator action/new failing run is required before it is considered again.
      if ((agent.errorReason ?? "").startsWith(RESTART_LANE_RECOVERY_ERROR_PREFIX)) {
        result.skipped += 1;
        continue;
      }
      const failedRun = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id)))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !failedRun ||
        !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
          failedRun.status as typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES[number],
        ) ||
        !RESTART_LANE_RECOVERY_SIGNATURE_RE.test(restartLaneFailureText(failedRun))
      ) {
        result.skipped += 1;
        continue;
      }
      candidates.push({ agent, failedRun });
    }
    result.candidates = candidates.length;
    const unrecoverable: RestartLaneUnrecoverable[] = [];

    for (let offset = 0; offset < candidates.length; offset += RESTART_LANE_RECOVERY_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + RESTART_LANE_RECOVERY_BATCH_SIZE);
      result.batchSizes.push(batch.length);
      const settled = await Promise.all(batch.map((candidate) => {
        const work = (async () => {
        const attemptCount = await countRestartLaneAttempts(candidate);
        const reset = await db
          .update(agents)
          .set({ status: "idle", errorReason: null, pauseReason: null, pausedAt: null, updatedAt: new Date() })
          .where(and(eq(agents.id, candidate.agent.id), eq(agents.status, "error")))
          .returning({ id: agents.id })
          .then((rows) => rows[0] ?? null);
        if (!reset) return { candidate, attemptCount, kind: "skipped" as const };
        const successor = await deps.enqueueWakeup(candidate.agent.id, {
          source: "automation",
          triggerDetail: "system",
          reason: "restart_lane_recovery",
          requestedByActorType: "system",
          requestedByActorId: "recovery",
          payload: { failedRunId: candidate.failedRun.id, mutation: "restart_lane_recovery" },
          idempotencyKey: `restart-lane-recovery:${candidate.agent.id}:${candidate.failedRun.id}`,
        });
        if (!successor || successor.id === candidate.failedRun.id || successor.createdAt <= candidate.failedRun.createdAt) {
          return { candidate, attemptCount, kind: "unrecoverable" as const, reason: "successor_run_not_created" };
        }
        return { candidate, attemptCount, kind: "recovered" as const, successorRunId: successor.id };
        })();
        return Promise.race([
          work,
          new Promise<{ candidate: RestartLaneCandidate; attemptCount: number; kind: "unrecoverable"; reason: string }>((resolve) => {
            setTimeout(() => resolve({
              candidate,
              attemptCount: 1,
              kind: "unrecoverable",
              reason: "batch_timeout",
            }), RESTART_LANE_RECOVERY_BATCH_TIMEOUT_MS);
          }),
        ]);
      }));

      const recoveredAgentIds: string[] = [];
      for (const entry of settled) {
        if (entry.kind === "recovered") {
          result.reset += 1;
          result.recovered += 1;
          result.successorRunIds.push(entry.successorRunId);
          recoveredAgentIds.push(entry.candidate.agent.id);
        } else if (entry.kind === "unrecoverable") {
          result.reset += 1;
          result.unrecoverable += 1;
          result.unrecoverableAgentIds.push(entry.candidate.agent.id);
          unrecoverable.push({ ...entry.candidate, reason: entry.reason, attemptCount: entry.attemptCount });
        } else {
          result.skipped += 1;
        }
      }

      // TSMC-19829: restart-lane recovery flips error→idle; heal outage-blocked issues.
      for (const agentId of recoveredAgentIds) {
        try {
          await healAssigneeNotInvokableBlockedIssues({
            agentId,
            source: "recovery.restart_lane",
          });
        } catch (err) {
          logger.warn({ err, agentId }, "failed assignee-not-invokable heal after restart-lane recovery");
        }
      }
    }
    for (const entry of unrecoverable) await recordRestartLaneUnrecoverable(entry);
    result.issueIds = await createRestartLaneRecoveryIssues(unrecoverable);
    return result;
  }

  /**
   * Self-heal issues that were blocked solely because their assignee was not
   * invokable (TSMC-19827/19829). Sweep only the stable assignee_not_invokable
   * unblockDescriptor and only issues with no open blockedBy edges. When the
   * assignee is invokable again, return them to todo and clear the descriptor.
   * Idempotent and race-safe: re-validates status/descriptor before update.
   */
  async function healAssigneeNotInvokableBlockedIssues(opts?: {
    agentId?: string | null;
    companyId?: string | null;
    source?: string;
    runId?: string | null;
  }) {
    const source = opts?.source ?? "recovery.heal_assignee_not_invokable";
    const result = {
      checked: 0,
      healed: 0,
      skipped: 0,
      issueIds: [] as string[],
    };

    const filters = [
      eq(issues.status, "blocked"),
      visibleIssueCondition(),
      sql`${issues.assigneeAgentId} is not null`,
      sql`(
        ${issues.unblockDescriptor} ->> 'action' = ${ASSIGNEE_NOT_INVOKABLE_UNBLOCK_ACTION}
        or coalesce(${issues.unblockDescriptor} ->> 'action', '') like ${`%cause:${ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE}%`}
      )`,
    ];
    if (opts?.agentId) filters.push(eq(issues.assigneeAgentId, opts.agentId));
    if (opts?.companyId) filters.push(eq(issues.companyId, opts.companyId));

    const candidates = await db
      .select()
      .from(issues)
      .where(and(...filters));
    result.checked = candidates.length;

    const invokableByAgentId = new Map<string, boolean>();

    for (const candidate of candidates) {
      try {
        const fresh = await db
          .select()
          .from(issues)
          .where(eq(issues.id, candidate.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!fresh || fresh.status !== "blocked") {
          result.skipped += 1;
          continue;
        }
        if (!isAssigneeNotInvokableUnblockDescriptor(fresh.unblockDescriptor)) {
          result.skipped += 1;
          continue;
        }

        const agentId = fresh.assigneeAgentId;
        if (!agentId) {
          result.skipped += 1;
          continue;
        }

        const unresolvedBlockers = await existingUnresolvedBlockerIssueIds(fresh.companyId, fresh.id);
        if (unresolvedBlockers.length > 0) {
          result.skipped += 1;
          continue;
        }

        if ((await evaluateAutomaticRecoverySuppression(fresh.companyId, fresh.id)).suppressed) {
          result.skipped += 1;
          continue;
        }

        let invokable = invokableByAgentId.get(agentId);
        if (invokable === undefined) {
          const agent = await getAgent(agentId);
          invokable = Boolean(
            agent &&
            agent.companyId === fresh.companyId &&
            (await isAgentInvokable(agent)),
          );
          invokableByAgentId.set(agentId, invokable);
        }
        if (!invokable) {
          result.skipped += 1;
          continue;
        }

        // issuesSvc.update clears unblockDescriptor when leaving blocked.
        const updated = await issuesSvc.update(fresh.id, {
          status: "todo",
          blockedByIssueIds: [],
        });
        if (!updated || updated.status !== "todo") {
          result.skipped += 1;
          continue;
        }

        await issuesSvc.addComment(
          fresh.id,
          "Paperclip restored this issue to `todo` because the assignee is invokable again. " +
            "The previous block was only the machine-readable assignee-not-invokable outage descriptor " +
            `(cause:${ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE}); no open blockedBy edges remained.`,
          {},
          {
            authorType: "system",
            presentation: compactRecoveryPresentation("Recovery: assignee invokable — returned to todo"),
            metadata: {
              version: 1,
              sourceRunId: opts?.runId ?? null,
              sections: [{
                title: "Recovery",
                rows: [
                  { type: "key_value", label: "Cause", value: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE },
                  { type: "key_value", label: "Source", value: source },
                  { type: "key_value", label: "Previous status", value: "blocked" },
                  { type: "key_value", label: "Next status", value: "todo" },
                ],
              }],
            },
          },
        );

        await logActivity(db, {
          companyId: fresh.companyId,
          actorType: "system",
          actorId: "recovery",
          agentId,
          runId: opts?.runId ?? null,
          action: "issue.assignee_not_invokable_healed",
          entityType: "issue",
          entityId: fresh.id,
          details: {
            source,
            cause: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE,
            previousStatus: "blocked",
            nextStatus: "todo",
            assigneeAgentId: agentId,
          },
        });

        // Best-effort assignment recovery wake so work resumes without waiting
        // for the next stranded/timer sweep. Failures here do not undo the heal.
        try {
          const blockedAtKey = fresh.blockedTransitionAt?.toISOString()
            ?? fresh.updatedAt?.toISOString()
            ?? "unknown";
          await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_assignment_recovery",
            payload: {
              issueId: fresh.id,
              taskKey: fresh.identifier,
              healedFrom: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE,
            },
            contextSnapshot: {
              issueId: fresh.id,
              taskId: fresh.id,
              taskKey: fresh.identifier,
              wakeReason: "issue_assignment_recovery",
              retryReason: "assignment_recovery",
              source,
              healedFrom: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE,
            },
            idempotencyKey: `assignee-not-invokable-heal:${fresh.id}:${blockedAtKey}`,
            requestedByActorType: "system",
            requestedByActorId: "recovery",
          });
        } catch (err) {
          logger.warn(
            { err, issueId: fresh.id, agentId, source },
            "failed to enqueue wake after assignee-not-invokable heal",
          );
        }

        result.healed += 1;
        result.issueIds.push(fresh.id);
      } catch (err) {
        result.skipped += 1;
        logger.warn(
          { err, issueId: candidate.id, source },
          "failed to heal assignee-not-invokable blocked issue",
        );
      }
    }

    if (result.healed > 0) {
      logger.warn(
        {
          healed: result.healed,
          checked: result.checked,
          skipped: result.skipped,
          issueIds: result.issueIds,
          source,
          agentId: opts?.agentId ?? null,
          companyId: opts?.companyId ?? null,
        },
        "healed assignee-not-invokable blocked issues",
      );
    }

    return result;
  }

  async function sweepRestartLaneRecovery(): Promise<RestartLaneRecoverySweepResult> {
    if (restartLaneRecoverySweepInFlight) return restartLaneRecoverySweepInFlight;
    restartLaneRecoverySweepInFlight = runRestartLaneRecoverySweep().finally(() => {
      restartLaneRecoverySweepInFlight = null;
    });
    return restartLaneRecoverySweepInFlight;
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

  /**
   * TSMC-20155/20183 ONE-TIME BACKFILL (idempotent, all companies).
   *
   * The two board-escalation writers above (Path A: no_invokable_recovery_owner;
   * Path B: liveness attempt-cap) historically minted owner_type='board' rows with
   * recovery_issue_id NULL — silent board escalations the Operator Console / first
   * class wait path cannot surface (the inverse stranded-recovery class). The code
   * fix stops NEW ones; this clears the EXISTING stock by minting/linking a
   * board-visible receipt for each, using the SAME dedup keys the live paths use so
   * a subsequent reconcile tick reuses (not duplicates) them.
   *
   * Idempotent: the query only matches rows still lacking a receipt, and the
   * ensure/find helpers reuse an open escalation for the incident/signature, so
   * re-running is a no-op. Safe to run repeatedly and across all companies.
   */
  async function backfillBoardOwnedRecoveryReceipts(opts?: {
    companyId?: string;
    limit?: number;
  }) {
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.ownerType, "board"),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        isNull(issueRecoveryActions.recoveryIssueId),
        ...(opts?.companyId ? [eq(issueRecoveryActions.companyId, opts.companyId)] : []),
      ))
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(opts?.limit ?? 500);

    const result = {
      scanned: rows.length,
      linked: 0,
      skipped: 0,
      linkedByKind: {} as Record<string, number>,
      links: [] as { actionId: string; sourceIssueId: string; kind: string; recoveryIssueId: string }[],
    };

    for (const action of rows) {
      const [sourceIssue] = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, action.companyId), eq(issues.id, action.sourceIssueId)))
        .limit(1);
      if (!sourceIssue) {
        result.skipped += 1;
        continue;
      }

      const evidence = parseObject(action.evidence);
      const incidentKey = readNonEmptyString(evidence.incidentKey);
      let receiptId: string | null = null;

      if (action.kind === "issue_graph_liveness" && incidentKey) {
        const parsed = parseIssueGraphLivenessIncidentKey(incidentKey);
        const state = readNonEmptyString(evidence.state) ?? parsed?.state ?? "unknown";
        const leafIssueId = parsed?.leafIssueId ?? sourceIssue.id;
        const leafFingerprint = buildIssueGraphLivenessLeafKey({
          companyId: action.companyId,
          state,
          leafIssueId,
        });
        // action.sourceIssueId is finding.issueId from the original upsertSourceScoped
        // call (see createIssueGraphLivenessEscalation above) — the same source/state
        // key the live root-cause rollup uses (TSMC-20489).
        const rootCauseFingerprint = buildIssueGraphLivenessRootCauseKey({
          companyId: action.companyId,
          state,
          sourceIssueId: sourceIssue.id,
        });
        // Dedup on all three keys the platform's liveness indexes/rollup use: the
        // exact incidentKey, the coarser leaf fingerprint (company+state+leaf), and
        // the coarsest root-cause fingerprint (company+state+source). A different
        // incident sharing the same leaf or the same root cause already has an open
        // escalation; reuse it rather than colliding on the leaf index or minting a
        // duplicate top-level ticket for a source already rolled up elsewhere.
        const findOpenReceipt = async () =>
          (await findOpenLivenessEscalation(action.companyId, incidentKey)) ??
          (await findOpenLivenessEscalationByLeafFingerprint(action.companyId, leafFingerprint)) ??
          (await findOpenLivenessEscalationByRootCauseFingerprint(action.companyId, rootCauseFingerprint));
        const existing = await findOpenReceipt();
        if (existing) {
          receiptId = existing.id;
        } else {
          try {
            const created = await issuesSvc.create(action.companyId, {
              title: `BOARD ACTION REQUIRED: Liveness incident needs a human owner — ${sourceIssue.identifier ?? sourceIssue.id}`,
              description: [
                "Automatic liveness retries were exhausted with no invokable recovery owner; this incident was handed to the board.",
                "",
                "## Root signature",
                "",
                `- Incident key: \`${incidentKey}\``,
                `- Detected invariant: \`${state}\``,
                `- Source issue: ${sourceIssue.identifier ?? sourceIssue.id}`,
                "",
                "## Required board action",
                "",
                "- Assign an invokable owner for the underlying liveness fault, or record an intentional manual resolution.",
                "- Backfilled receipt for a previously silent board escalation (TSMC-20155/20183).",
              ].join("\n"),
              status: "todo",
              priority: "high",
              projectId: sourceIssue.projectId,
              goalId: sourceIssue.goalId,
              assigneeAgentId: null,
              originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
              originId: incidentKey,
              originFingerprint: buildIssueGraphLivenessLeafKey({
                companyId: action.companyId,
                state,
                leafIssueId,
              }),
              executionState: {
                livenessRootCauseFingerprint: rootCauseFingerprint,
                livenessAttachedLeafFingerprints: [],
              },
              billingCode: sourceIssue.billingCode,
              executionWorkspaceId: null,
              executionWorkspacePreference: null,
              executionWorkspaceSettings: null,
            });
            receiptId = created.id;
          } catch (error) {
            if (!isUniqueLivenessRecoveryConflict(error)) throw error;
            const raced = await findOpenReceipt();
            if (!raced) throw error;
            receiptId = raced.id;
          }
        }
      } else {
        // stranded_assigned_issue and other stranded kinds — reuse the signature
        // scoped board card. escalationReason follows the row's own wake policy.
        const escalationReason = readNonEmptyString(parseObject(action.wakePolicy).reason) === "recovery_loop_cap"
          ? "recovery_loop_cap"
          : "no_invokable_recovery_owner";
        const receipt = await ensureRecoveryLoopCapEscalationIssue({
          issue: sourceIssue,
          kind: action.kind,
          recoveryCause: action.cause as StrandedRecoveryCause,
          priorActionCount: action.attemptCount ?? 0,
          escalationReason,
        });
        receiptId = receipt.id;
      }

      if (!receiptId) {
        result.skipped += 1;
        continue;
      }

      // Link idempotently: only stamp rows still lacking a receipt so a concurrent
      // reconcile that already linked one is not clobbered.
      const [linked] = await db
        .update(issueRecoveryActions)
        .set({ recoveryIssueId: receiptId, updatedAt: new Date() })
        .where(and(
          eq(issueRecoveryActions.id, action.id),
          isNull(issueRecoveryActions.recoveryIssueId),
        ))
        .returning({ id: issueRecoveryActions.id });

      if (linked) {
        result.linked += 1;
        result.linkedByKind[action.kind] = (result.linkedByKind[action.kind] ?? 0) + 1;
        result.links.push({
          actionId: action.id,
          sourceIssueId: action.sourceIssueId,
          kind: action.kind,
          recoveryIssueId: receiptId,
        });
      } else {
        result.skipped += 1;
      }
    }

    logger.warn(
      { scanned: result.scanned, linked: result.linked, skipped: result.skipped, linkedByKind: result.linkedByKind },
      "backfilled board-owned recovery receipts (TSMC-20155/20183)",
    );
    return result;
  }

  return {
    buildRunOutputSilenceBatch,
    buildRunOutputSilence,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    healAssigneeNotInvokableBlockedIssues,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    reconcileStrandedAssignedIssues,
    sweepRestartLaneRecovery,
    sweepStaleIssueLocks,
    buildIssueGraphLivenessAutoRecoveryPreview,
    reconcileResolvedDependencyWakeBackstop,
    reconcileIssueGraphLiveness,
    backfillBoardOwnedRecoveryReceipts,
    readRecoveryTimerIntervalMs,
  };
}
