import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  type IssueGraphLivenessAutoRecoveryPreview,
  type IssueGraphLivenessAutoRecoveryPreviewItem,
} from "@paperclipai/shared";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  issueComments,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { forbidden, HttpError, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { issueService } from "../issues.js";
import { publishLiveEvent } from "../live-events.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  noticeMetadataReferencesRecoveryAction,
  type SuccessfulRunHandoffNotice,
} from "./successful-run-handoff.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessLeafKey,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "./origins.js";
import {
  classifyIssueGraphLiveness,
  hasScheduledMonitor,
  issueLivenessPendingInteractionExpiresAt,
  type IssueLivenessFinding,
} from "./issue-graph-liveness.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["failed", "cancelled", "timed_out"] as const;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
const ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES = 8 * 1024;
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const ISSUE_GRAPH_LIVENESS_RECOVERY_ACTION_OWNER_STATUSES = new Set(["active", "idle", "running"]);
export const TERMINAL_LIVENESS_RECOVERY_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const STRANDED_RECOVERY_ACTION_TIMEOUT_MS = 15 * 60 * 1000;
const legacyRecoveryReconciliationInFlight = new WeakMap<object, Promise<unknown>>();

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

type LatestIssueRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "agentId" | "status" | "error" | "errorCode" | "contextSnapshot" | "livenessState"
> | null;
type SuccessfulLatestIssueRun = NonNullable<LatestIssueRun> & { status: "succeeded" };

type StrandedRecoveryCause = "stranded_assigned_issue" | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;

type SuccessfulRunHandoffRecoveryEvidence = {
  sourceRunId: string | null;
  correctiveRunId: string;
  missingDisposition: string;
  handoffAttempt: number;
  maxHandoffAttempts: number;
};

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
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed",
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
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

function primarySourceRecoveryRunPredicate(actionId: string, sourceIssueId: string) {
  return sql`(
    ${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${actionId}
    and ${heartbeatRuns.contextSnapshot} ->> 'source' = 'issue_recovery_action'
    and ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${sourceIssueId}
    and ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${sourceIssueId}
    and ${heartbeatRuns.contextSnapshot} ->> 'sourceIssueId' = ${sourceIssueId}
  )`;
}

function isPrimarySourceRecoveryRunContext(
  contextSnapshot: unknown,
  actionId: string,
  sourceIssueId: string,
) {
  const context = parseObject(contextSnapshot);
  return context.recoveryActionId === actionId &&
    context.source === "issue_recovery_action" &&
    context.issueId === sourceIssueId &&
    context.taskId === sourceIssueId &&
    context.sourceIssueId === sourceIssueId;
}

function primarySourceRecoveryWakePredicate(actionId: string, sourceIssueId: string) {
  return sql`(
    (
      ${agentWakeupRequests.payload} ->> 'recoveryActionId' = ${actionId}
      and ${agentWakeupRequests.payload} ->> 'issueId' = ${sourceIssueId}
      and ${agentWakeupRequests.payload} ->> 'sourceIssueId' = ${sourceIssueId}
      and ${agentWakeupRequests.payload} ->> 'managerEscalation' is distinct from 'true'
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' is null
      and ${agentWakeupRequests.payload} ->> 'commentId' is null
      and ${agentWakeupRequests.payload} ->> 'wakeCommentId' is null
      and ${agentWakeupRequests.payload} -> 'wakeCommentIds' is null
    )
    or (
      ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'recoveryActionId' = ${actionId}
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${sourceIssueId}
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'sourceIssueId' = ${sourceIssueId}
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'source' = 'issue_recovery_action'
      and ${agentWakeupRequests.payload} ->> 'managerEscalation' is distinct from 'true'
      and ${agentWakeupRequests.payload} ->> 'commentId' is null
      and ${agentWakeupRequests.payload} ->> 'wakeCommentId' is null
      and ${agentWakeupRequests.payload} -> 'wakeCommentIds' is null
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'commentId' is null
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'wakeCommentId' is null
      and ${agentWakeupRequests.payload} -> '_paperclipWakeContext' -> 'wakeCommentIds' is null
      and (
        ${agentWakeupRequests.status} <> 'deferred_issue_execution'
        or coalesce(${agentWakeupRequests.coalescedCount}, 0) = 0
      )
    )
  )`;
}

function isPrimarySourceRecoveryWakePayload(
  payload: unknown,
  actionId: string,
  sourceIssueId: string,
  wakeup?: { status: string; coalescedCount: number | null } | null,
) {
  if (
    wakeup?.status === "deferred_issue_execution" &&
    (wakeup.coalescedCount ?? 0) > 0
  ) return false;
  const parsed = parseObject(payload);
  if (parsed.managerEscalation === true || parsed.managerEscalation === "true") return false;
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  const hasNestedContext = Object.keys(nestedContext).length > 0;
  const hasHumanCommentSignal = Boolean(
    readNonEmptyString(parsed.commentId) ||
    readNonEmptyString(parsed.wakeCommentId) ||
    (Array.isArray(parsed.wakeCommentIds) && parsed.wakeCommentIds.length > 0) ||
    readNonEmptyString(nestedContext.commentId) ||
    readNonEmptyString(nestedContext.wakeCommentId) ||
    (Array.isArray(nestedContext.wakeCommentIds) && nestedContext.wakeCommentIds.length > 0),
  );
  const rootMatches = !hasNestedContext && !hasHumanCommentSignal && (
    parsed.recoveryActionId === actionId &&
    parsed.issueId === sourceIssueId &&
    parsed.sourceIssueId === sourceIssueId
  );
  const nestedMatches = hasNestedContext && !hasHumanCommentSignal && (
    nestedContext.recoveryActionId === actionId &&
    nestedContext.issueId === sourceIssueId &&
    nestedContext.sourceIssueId === sourceIssueId &&
    nestedContext.source === "issue_recovery_action"
  );
  return rootMatches || nestedMatches;
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

function isLivenessEscalationPlacementError(error: unknown): error is HttpError {
  if (!(error instanceof HttpError) || error.status !== 422) return false;
  return error.message ===
    "Execution lanes cannot create sub-issues. Paperclip supports only one child level under a main parent issue." ||
    /^Parent issue already has the maximum \d+ direct execution lanes\.$/.test(error.message);
}

function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
  return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
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
  const target = escalation.identifier ?? escalation.id;
  return `Action needed: ${target} is handling a blocked work path.`;
}

function livenessOriginalIssueCommentMetadata(
  finding: IssueLivenessFinding,
  escalation: typeof issues.$inferSelect,
) {
  const recovery = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
  return {
    version: 1 as const,
    sections: [{
      title: "Recovery details",
      rows: [
        {
          type: "issue_link" as const,
          label: "Unblock task",
          issueId: escalation.id,
          identifier: escalation.identifier,
          title: escalation.title,
        },
        {
          type: "key_value" as const,
          label: "Blocked work",
          value: recovery?.identifier ?? finding.recoveryIssueId,
        },
        { type: "key_value" as const, label: "Reason", value: finding.reason },
        { type: "key_value" as const, label: "Next action", value: finding.recommendedAction },
        { type: "code" as const, label: "Incident key", code: finding.incidentKey },
      ],
    }],
  };
}

type LivenessBoardEscalationCause =
  | "no_invokable_same_company_candidate"
  | "stranded_assignee_is_only_invokable_candidate"
  | "all_same_company_candidates_budget_blocked";

function livenessBoardEscalationIdempotencyKeyBase(finding: IssueLivenessFinding) {
  // Multiple blocked sources can converge on the same stranded leaf. The board
  // owns one decision for that leaf/state, not one duplicate decision per path.
  const digest = createHash("sha256").update(livenessRecoveryLeafFingerprint(finding)).digest("hex");
  return `harness-liveness-board:${digest}`;
}

type RecoveryRunCancellation = (
  runId: string,
  options: {
    reason: string;
    suppressImmediateRecovery: boolean;
    force: boolean;
    errorCode?: string;
    requireTransition?: boolean;
  },
) => Promise<unknown>;

export function recoveryService(
  db: Db,
  deps: { enqueueWakeup: RecoveryWakeup; cancelRun?: RecoveryRunCancellation },
) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const interactionsSvc = issueThreadInteractionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();

  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
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

  async function getActiveExecutionRun(companyId: string, issueId: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasActiveExecutionPath(companyId: string, issueId: string) {
    return Boolean(await getActiveExecutionRun(companyId, issueId));
  }

  async function failOrphanedDeferredIssueWakes(companyId: string, issueId: string) {
    if (await getActiveExecutionRun(companyId, issueId)) return [];
    const now = new Date();
    return db
      .update(agentWakeupRequests)
      .set({
        status: "failed",
        finishedAt: now,
        error:
          "Deferred issue execution wake was orphaned after the issue lost its active execution run; stranded issue recovery will requeue the current assignee.",
        updatedAt: now,
      })
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .returning({ id: agentWakeupRequests.id });
  }

  async function hasQueuedIssueWake(companyId: string, issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function enqueueStrandedIssueRecovery(input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed";
    retryReason: "assignment_recovery" | "issue_continuation_needed";
    source: string;
    retryOfRunId?: string | null;
  }) {
    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: withRecoveryModelProfileHint({
        issueId: input.issueId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }),
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
        mutation: "assigned_todo_liveness_dispatch",
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }),
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
      if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !isAgentInvokable(creatorAgent)) {
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
        }),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: candidate.id,
          taskId: candidate.id,
          wakeReason: "issue_assigned",
          source: "issue.unassigned_blocker_recovery",
        }),
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
          isNull(issues.hiddenAt),
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
    const [quietUntilDecision, evaluation] = await Promise.all([
      latestActiveOutputQuietUntilDecision(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
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
      snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
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
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), isNull(issues.hiddenAt)))
      .limit(1);
    return issue ?? null;
  }

  async function resolveStaleRunOwnerAgentId(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
  }) {
    const candidateIds: string[] = [];
    if (input.sourceIssue?.assigneeAgentId) {
      const sourceAssignee = await getAgent(input.sourceIssue.assigneeAgentId);
      if (sourceAssignee?.reportsTo) candidateIds.push(sourceAssignee.reportsTo);
    }
    if (input.runningAgent.reportsTo) candidateIds.push(input.runningAgent.reportsTo);
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
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== input.run.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.run.companyId, candidate.id, {
        issueId: input.sourceIssue?.id ?? null,
        projectId: input.sourceIssue?.projectId ?? null,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
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
          .where(and(eq(issues.companyId, input.run.companyId), eq(issues.parentId, input.sourceIssue.id), isNull(issues.hiddenAt)))
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

  function isUniqueStrandedIssueRecoveryConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stranded_issue_recovery_uq" ||
        maybe.constraint_name === "issues_active_stranded_issue_recovery_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stranded_issue_recovery_uq")
      );
  }

  async function ensureSourceIssueBlockedByStaleEvaluation(input: {
    sourceIssue: typeof issues.$inferSelect | null;
    evaluationIssue: { id: string; identifier: string | null };
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    if (!input.sourceIssue || ["done", "cancelled"].includes(input.sourceIssue.status)) return false;
    const blockerIds = await existingBlockerIssueIds(input.sourceIssue.companyId, input.sourceIssue.id);
    if (blockerIds.includes(input.evaluationIssue.id)) return false;
    const nextBlockerIds = [...blockerIds, input.evaluationIssue.id];
    await issuesSvc.update(input.sourceIssue.id, {
      ...(input.sourceIssue.status === "blocked" ? {} : { status: "blocked" }),
      blockedByIssueIds: nextBlockerIds,
    });
    await issuesSvc.addComment(input.sourceIssue.id, [
      "Paperclip detected critical output silence on this issue's active run.",
      "",
      `- Evaluation issue: ${input.evaluationIssue.identifier ?? input.evaluationIssue.id}`,
      `- Run: \`${input.run.id}\``,
      "",
      "This blocks the source issue on the explicit review task without cancelling the active process.",
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
        blockerIssueIds: nextBlockerIds,
      },
    });
    return true;
  }

  async function createOrUpdateStaleRunEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    const prefix = await getCompanyIssuePrefix(input.run.companyId);
    const evidence = await collectStaleRunEvidence({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      now: input.now,
    });
    const level = (evidence.silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS ? "critical" : "suspicious";
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
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
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
        return { kind: "escalated" as const, evaluationIssueId: existing.id };
      }
      if (level === "critical") {
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
      }
      return { kind: "existing" as const, evaluationIssueId: existing.id };
    }

    const ownerAgentId = await resolveStaleRunOwnerAgentId({ run: input.run, runningAgent, sourceIssue });
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
        title: `Review silent active run for ${runningAgent.name}`,
        description,
        status: "todo",
        priority: level === "critical" ? "high" : "medium",
        parentId: sourceIssue && !["done", "cancelled"].includes(sourceIssue.status) ? sourceIssue.id : null,
        projectId: sourceIssue?.projectId ?? null,
        goalId: sourceIssue?.goalId ?? null,
        billingCode: sourceIssue?.billingCode ?? null,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
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

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_detected",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        level,
        sourceIssueId: sourceIssue?.id ?? null,
        silenceAgeMs: evidence.silenceAgeMs,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
      },
    });
    if (level === "critical") {
      await ensureSourceIssueBlockedByStaleEvaluation({
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
        }),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          taskId: evaluation.id,
          wakeReason: "issue_assigned",
          source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }),
      });
    }
    return { kind: "created" as const, evaluationIssueId: evaluation.id };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    const candidates = await db
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

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      snoozed: 0,
      skipped: 0,
      evaluationIssueIds: [] as string[],
    };

    for (const run of candidates) {
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await createOrUpdateStaleRunEvaluation({ run, now });
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "escalated") result.escalated += 1;
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

  async function findOpenStrandedIssueRecoveryIssue(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
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

  async function resolveStrandedIssueRecoveryOwnerAgentId(issue: typeof issues.$inferSelect) {
    const candidateIds: string[] = [];
    if (issue.assigneeAgentId) {
      const assignee = await getAgent(issue.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (issue.createdByAgentId) {
      const creator = await getAgent(issue.createdByAgentId);
      if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
      candidateIds.push(issue.createdByAgentId);
    }

    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));
    if (issue.assigneeAgentId) candidateIds.push(issue.assigneeAgentId);

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== issue.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  function buildStrandedIssueRecoveryDescription(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    prefix: string;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    sourceAssignee?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
  }) {
    const sourceIssue = issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix);
    const runLink = input.latestRun
      ? `[\`${input.latestRun.id}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${input.latestRun.id})`
      : "none";
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON) {
      const sourceRunId = input.successfulRunHandoffEvidence?.sourceRunId;
      const sourceRunLink = sourceRunId && input.latestRun
        ? `[\`${sourceRunId}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${sourceRunId})`
        : "unknown";
      const missingDisposition = input.successfulRunHandoffEvidence?.missingDisposition ?? "clear_next_step";
      return [
        "Paperclip exhausted the bounded corrective handoff for a successful run that still has no valid issue disposition.",
        "",
        "This is not a runtime/adapter crash report. The source run succeeded; the remaining problem is the missing `done`, `in_review`, `blocked`, delegated follow-up, or explicit continuation path.",
        "",
        "## Safe Evidence",
        "",
        `- Source issue: ${sourceIssue}`,
        `- Source run: ${sourceRunLink}`,
        `- Corrective handoff run: ${runLink}`,
        `- Source assignee: ${agentUiLink(input.sourceAssignee ?? null, input.prefix)}`,
        `- Latest issue status: \`${input.issue.status}\``,
        `- Latest handoff run status: \`${input.latestRun?.status ?? "unknown"}\``,
        `- Normalized cause: \`${SUCCESSFUL_RUN_MISSING_STATE_REASON}\``,
        `- Missing disposition: \`${missingDisposition}\``,
        "- Suggested manager action: choose and record a valid issue disposition without copying transcript content.",
        "",
        "## Required Action",
        "",
        "- Inspect the source issue and run metadata, not raw transcript excerpts.",
        "- Choose a valid issue disposition: `done`/`cancelled`, `in_review` with an owner, `blocked` with first-class blockers, delegated follow-up work, or an explicit continuation path.",
        "- When the source issue has a clear owner and disposition, mark this recovery issue done.",
      ].join("\n");
    }

    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "unknown";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip exhausted automatic recovery for an assigned issue and created this explicit recovery task.",
      "",
      "## Source",
      "",
      `- Source issue: ${sourceIssue}`,
      `- Previous source status: \`${input.previousStatus}\``,
      `- Latest retry run: ${runLink}`,
      `- Latest retry status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Detected invariant: \`stranded_assigned_issue\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "",
      "## Ownership",
      "",
      "- Selected owner: the first invokable manager/creator/executive candidate with budget available.",
      "",
      "## Required Action",
      "",
      "- Inspect the latest run and source issue state.",
      "- Fix the runtime/adapter problem, reassign the source issue, or convert the source issue into a clear manual-review state.",
      "- When the source issue has a live execution path or has been intentionally resolved, mark this recovery issue done.",
    ].join("\n");
  }

  async function ensureStrandedIssueRecoveryIssue(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) return null;

    const existing = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
    if (existing) return existing;

    const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
    if (!ownerAgentId) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    let recovery: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      recovery = await issuesSvc.create(input.issue.companyId, {
        title: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? `Recover missing next step ${input.issue.identifier ?? input.issue.title}`
          : `Recover stalled issue ${input.issue.identifier ?? input.issue.title}`,
        description: buildStrandedIssueRecoveryDescription({
          issue: input.issue,
          latestRun: input.latestRun,
          previousStatus: input.previousStatus,
          prefix,
          recoveryCause,
          successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
          sourceAssignee,
        }),
        status: "todo",
        priority: input.issue.priority,
        parentId: input.issue.id,
        projectId: input.issue.projectId,
        goalId: input.issue.goalId,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
        originId: input.issue.id,
        originRunId: input.latestRun?.id ?? null,
        originFingerprint: [
          STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
          input.issue.companyId,
          input.issue.id,
          recoveryCause,
          input.latestRun?.id ?? "no-run",
        ].join(":"),
        billingCode: input.issue.billingCode,
        inheritExecutionWorkspaceFromIssueId: input.issue.id,
      });
    } catch (error) {
      if (!isUniqueStrandedIssueRecoveryConflict(error)) throw error;
      const raced = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
      if (!raced) throw error;
      return raced;
    }

    await deps.enqueueWakeup(ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: recovery.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: recovery.id,
        taskId: recovery.id,
        wakeReason: "issue_assigned",
        source: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause,
      }),
    });

    return recovery;
  }

  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    return cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "missing_disposition" as const
      : "stranded_assigned_issue" as const;
  }

  function strandedRecoveryActionFingerprint(input: {
    issue: typeof issues.$inferSelect;
    recoveryCause: StrandedRecoveryCause;
  }) {
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
    previousStatus: "todo" | "in_progress";
    recoveryCause: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
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
    };
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
    const now = new Date();
    const timeoutAt = ownerAgentId
      ? new Date(now.getTime() + STRANDED_RECOVERY_ACTION_TIMEOUT_MS)
      : null;
    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: strandedRecoveryActionKind(recoveryCause),
      ownerType: ownerAgentId ? "agent" : "board",
      ownerAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: input.issue.assigneeAgentId,
      cause: recoveryCause,
      fingerprint: strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
      }),
      evidence: buildStrandedRecoveryActionEvidence({
        issue: input.issue,
        latestRun: input.latestRun,
        previousStatus: input.previousStatus,
        recoveryCause,
        successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
      }),
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Choose and record a valid issue disposition without copying transcript content."
        : "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
      wakePolicy: ownerAgentId
        ? {
          type: "wake_owner",
          reason: "source_scoped_recovery_action",
          ownerAgentId,
          maxAttempts: 1,
          timeoutAt: timeoutAt!.toISOString(),
        }
        : {
          type: "board_escalation",
          reason: "no_invokable_recovery_owner",
      },
      monitorPolicy: null,
      maxAttempts: ownerAgentId ? 1 : null,
      timeoutAt,
      lastAttemptAt: now,
    });

    // `upsertSourceScoped` preserves typed routine-termination authority if it
    // won a race with this generic reconciler. Treat that as a skip instead of
    // emitting generic comments/wakes against the typed action.
    return action.cause === recoveryCause ? action : null;
  }

  async function enqueueSourceScopedStrandedRecoveryWake(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
  }) {
    if (!input.action.ownerAgentId) return;
    await deps.enqueueWakeup(input.action.ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "source_scoped_recovery_action",
      idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}`,
      payload: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        sourceIssueId: input.issue.id,
        recoveryActionId: input.action.id,
        recoveryAttempt: input.action.attemptCount,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: "source_scoped_recovery_action",
        skipIssueComment: true,
        source: "issue_recovery_action",
        recoveryActionId: input.action.id,
        recoveryAttempt: input.action.attemptCount,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }),
    });
  }

  async function resolveSourceScopedRecoveryManagerTarget(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
  }) {
    const candidates: Array<{
      issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "identifier" | "title" | "status" | "projectId" | "assigneeAgentId">;
      managerAgentId: string;
      route: "parent_manager" | "return_owner";
    }> = [];

    if (input.issue.parentId) {
      const parent = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          projectId: issues.projectId,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, input.issue.companyId),
          eq(issues.id, input.issue.parentId),
          isNull(issues.hiddenAt),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (parent?.assigneeAgentId && !["done", "cancelled"].includes(parent.status)) {
        candidates.push({
          issue: parent,
          managerAgentId: parent.assigneeAgentId,
          route: "parent_manager",
        });
      }
    } else if (
      input.action.returnOwnerAgentId &&
      input.action.returnOwnerAgentId !== input.action.ownerAgentId
    ) {
      candidates.push({
        issue: {
          id: input.issue.id,
          companyId: input.issue.companyId,
          identifier: input.issue.identifier,
          title: input.issue.title,
          status: input.issue.status,
          projectId: input.issue.projectId,
          assigneeAgentId: input.action.returnOwnerAgentId,
        },
        managerAgentId: input.action.returnOwnerAgentId,
        route: "return_owner",
      });
    }

    for (const candidate of candidates) {
      if (candidate.managerAgentId === input.action.ownerAgentId) continue;
      const manager = await getAgent(candidate.managerAgentId);
      if (!manager || manager.companyId !== input.issue.companyId || !isAgentInvokable(manager)) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.issue.companyId, manager.id, {
        issueId: candidate.issue.id,
        projectId: candidate.issue.projectId,
      });
      if (budgetBlock) continue;
      return { ...candidate, manager };
    }

    return null;
  }

  function buildManagerRecoveryEscalationComment(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
    prefix: string;
    recoveryOwner: { id: string; name: string | null } | null;
    route: "parent_manager" | "return_owner";
  }) {
    const sourceIssue = issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix);
    const runLink = input.latestRun ? runUiLink({ id: input.latestRun.id, agentId: input.latestRun.agentId }, input.prefix) : "none";
    const routeLabel = input.route === "parent_manager" ? "parent manager lane" : "return owner lane";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);
    return [
      "Paperclip escalated a stranded execution lane to the manager path.",
      "",
      `- Source issue: ${sourceIssue}`,
      `- Recovery action: \`${input.action.id}\``,
      `- Recovery owner: ${agentUiLink(input.recoveryOwner, input.prefix)}`,
      `- Route: \`${routeLabel}\``,
      `- Cause: \`${input.recoveryCause}\``,
      `- Latest run: ${runLink}`,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "",
      "Manager next action: inspect the source issue and decide how to unblock it. Reassign it, create/repair the blocker path, escalate to board if an outside decision is needed, or record an intentional manual resolution. Do not leave the child lane silently blocked.",
      "",
      `Manager recovery wake: \`${input.action.id}\``,
    ].join("\n");
  }

  async function enqueueSourceScopedRecoveryManagerWake(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
  }) {
    const target = await resolveSourceScopedRecoveryManagerTarget({
      action: input.action,
      issue: input.issue,
    });
    if (!target) return;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const recoveryOwner = input.action.ownerAgentId ? await getAgent(input.action.ownerAgentId) : null;
    const marker = `Manager recovery wake: \`${input.action.id}\``;
    const existingComment = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.issue.companyId),
        eq(issueComments.issueId, target.issue.id),
        sql`${issueComments.body} like ${`%${marker}%`}`,
      ))
      .orderBy(desc(issueComments.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const comment = existingComment ?? await issuesSvc.addComment(
      target.issue.id,
      buildManagerRecoveryEscalationComment({
        action: input.action,
        issue: input.issue,
        latestRun: input.latestRun,
        recoveryCause: input.recoveryCause,
        prefix,
        recoveryOwner,
        route: target.route,
      }),
      {},
      { authorType: "system" },
    );

    await deps.enqueueWakeup(target.managerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      idempotencyKey: `source_scoped_recovery_manager_escalation:${input.action.id}:${input.action.attemptCount}:${target.managerAgentId}`,
      payload: {
        issueId: target.issue.id,
        commentId: comment.id,
        sourceIssueId: input.issue.id,
        recoveryActionId: input.action.id,
        managerEscalation: true,
      },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: {
        issueId: target.issue.id,
        taskId: target.issue.id,
        commentId: comment.id,
        wakeCommentId: comment.id,
        wakeReason: "issue_commented",
        source: "issue.comment",
        recoveryActionId: input.action.id,
        sourceIssueId: input.issue.id,
        sourceIssueIdentifier: input.issue.identifier,
        sourceIssueTitle: input.issue.title,
        sourceIssueStatus: input.issue.status,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
        recoveryOwnerAgentId: input.action.ownerAgentId,
        returnOwnerAgentId: input.action.returnOwnerAgentId,
        managerEscalationRoute: target.route,
      },
    });
  }

  function buildRecoveryIssueInPlaceEscalationComment(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
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
    previousStatus: "todo" | "in_progress";
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

  async function existingUnresolvedBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
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
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function escalateStrandedAssignedIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    comment?: string;
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

    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    const recoveryAction = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
      recoveryCause,
      successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
    });
    if (!recoveryAction) return null;
    const blockerIds = await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id);
    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
      blockedByIssueIds: blockerIds,
      assigneeAgentId: recoveryAction.ownerAgentId ?? input.issue.assigneeAgentId,
    });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const recoveryOwner = recoveryAction.ownerAgentId ? await getAgent(recoveryAction.ownerAgentId) : null;
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    let notice: SuccessfulRunHandoffNotice | null = null;
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON && input.successfulRunHandoffEvidence) {
      notice = buildSuccessfulRunHandoffExhaustedNotice({
        issue: input.issue,
        sourceRun: input.successfulRunHandoffEvidence.sourceRunId
          ? { id: input.successfulRunHandoffEvidence.sourceRunId, status: "succeeded" }
          : null,
        correctiveRun: input.latestRun ? { id: input.latestRun.id, status: input.latestRun.status } : null,
        sourceAssignee,
        recoveryIssue: null,
        recoveryActionId: recoveryAction.id,
        recoveryOwner,
        latestIssueStatus: input.issue.status,
        latestHandoffRunStatus: input.latestRun?.status ?? "unknown",
        missingDisposition: input.successfulRunHandoffEvidence.missingDisposition,
      });
    }
    const recoveryLine = recoveryAction.ownerAgentId
      ? [
        "",
        `- Recovery action: \`${recoveryAction.id}\``,
        `- Recovery owner: ${agentUiLink(recoveryOwner, prefix)}`,
        "- Next action: the recovery owner should either restore a live execution path or record the manual resolution on the source issue.",
      ].join("\n")
      : [
        "",
        `- Recovery action: \`${recoveryAction.id}\``,
        "- Recovery owner: board escalation, because Paperclip could not find an invokable manager, creator, or executive owner with budget available.",
        "- Next action: a board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
      ].join("\n");

    if (recoveryAction.attemptCount === 1) {
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
          (row.body ?? "").includes(escalationCommentMarker) ||
          noticeMetadataReferencesRecoveryAction(row.metadata, recoveryAction.id),
        ));

      if (!hasEscalationComment) {
        if (notice) {
          await issuesSvc.addComment(input.issue.id, notice.body, {}, {
            authorType: "system",
            presentation: notice.presentation,
            metadata: notice.metadata,
          });
        } else {
          await issuesSvc.addComment(input.issue.id, `${input.comment ?? ""}${recoveryLine}`, {}, {
            authorType: "system",
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
          : "recovery.reconcile_stranded_assigned_issue",
        recoveryCause: input.recoveryCause ?? "stranded_assigned_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        recoveryActionId: recoveryAction.id,
        recoveryOwnerAgentId: recoveryAction.ownerAgentId,
        previousOwnerAgentId: recoveryAction.previousOwnerAgentId,
        returnOwnerAgentId: recoveryAction.returnOwnerAgentId,
        blockerIssueIds: blockerIds,
      },
    });

    await enqueueSourceScopedStrandedRecoveryWake({
      action: recoveryAction,
      issue: input.issue,
      latestRun: input.latestRun,
      recoveryCause,
    });
    await enqueueSourceScopedRecoveryManagerWake({
      action: recoveryAction,
      issue: updated,
      latestRun: input.latestRun,
      recoveryCause,
    });

    if (recoveryAction.ownerAgentId && recoveryAction.ownerAgentId === input.issue.assigneeAgentId) {
      const [currentIssue] = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      if (
        currentIssue &&
        (currentIssue.status !== "blocked" ||
          currentIssue.assigneeAgentId !== recoveryAction.ownerAgentId)
      ) {
        const reblocked = await issuesSvc.update(input.issue.id, {
          status: "blocked",
          blockedByIssueIds: blockerIds,
          assigneeAgentId: recoveryAction.ownerAgentId,
        });
        if (reblocked) return reblocked;
      }
    }

    return updated;
  }

  async function reconcileStrandedAssignedIssues() {
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
        ),
      );

    const dependencyBlockedIssueIds = new Set<string>();
    const candidateIdsByCompany = new Map<string, string[]>();
    for (const issue of candidates) {
      const issueIds = candidateIdsByCompany.get(issue.companyId) ?? [];
      issueIds.push(issue.id);
      candidateIdsByCompany.set(issue.companyId, issueIds);
    }
    for (const [companyId, issueIds] of candidateIdsByCompany) {
      const readinessByIssueId = await issuesSvc.listDependencyReadiness(companyId, issueIds);
      for (const [issueId, readiness] of readinessByIssueId) {
        if (!readiness.isDependencyReady) dependencyBlockedIssueIds.add(issueId);
      }
    }

    const typedRoutineRecoveryCandidateIds = candidates
      .filter((issue) =>
        issue.originKind === "harness_liveness_escalation" &&
        issue.originId?.startsWith("agent_termination_routine_handoff:"),
      )
      .map((issue) => issue.id);
    const typedRoutineRecoveryAuthorityIssueIds = new Set(
      typedRoutineRecoveryCandidateIds.length > 0
        ? await db
            .select({ issueId: issueRecoveryActions.sourceIssueId })
            .from(issueRecoveryActions)
            .where(
              and(
                inArray(issueRecoveryActions.sourceIssueId, typedRoutineRecoveryCandidateIds),
                eq(issueRecoveryActions.cause, "terminated_routine_owner"),
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
              ),
            )
            .then((rows) => rows.map((row) => row.issueId))
        : [],
    );

    const result = {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      dependencyStatusCorrected: 0,
      productiveContinuationObserved: 0,
      successfulContinuationObserved: 0,
      orphanBlockersAssigned: 0,
      orphanedDeferredWakesFailed: 0,
      successfulRunHandoffEscalated: 0,
      escalated: 0,
      skipped: 0,
      issueIds: [] as string[],
    };

    for (const issue of candidates) {
      const agentId = issue.assigneeAgentId;
      if (!agentId) {
        result.skipped += 1;
        continue;
      }

      // Typed routine handoffs already have a bounded recovery authority and
      // watchdog. Feeding them through generic assignment recovery would
      // create an unbounded second lane and could overwrite the typed action's
      // cause/fingerprint after that retry fails.
      if (typedRoutineRecoveryAuthorityIssueIds.has(issue.id)) {
        result.skipped += 1;
        continue;
      }

      // The heartbeat dependency gate keeps these issues parked and wakes them
      // when the last blocker resolves. If an issue was nevertheless left
      // `in_progress` after its execution disappeared, normalize the workflow
      // state to `blocked` instead of silently skipping a contradictory state.
      // A genuinely active run wins during transition races.
      if (dependencyBlockedIssueIds.has(issue.id)) {
        if (
          issue.status === "in_progress" &&
          !await hasActiveExecutionPath(issue.companyId, issue.id)
        ) {
          const updated = await issuesSvc.update(issue.id, { status: "blocked" });
          if (updated) {
            await logActivity(db, {
              companyId: issue.companyId,
              actorType: "system",
              actorId: "system",
              agentId: null,
              runId: null,
              action: "issue.dependency_wait_status_corrected",
              entityType: "issue",
              entityId: issue.id,
              details: {
                identifier: issue.identifier,
                status: "blocked",
                previousStatus: "in_progress",
                source: "recovery.reconcile_stranded_assigned_issue",
                recoveryCause: "in_progress_without_live_execution_while_dependency_blocked",
              },
            });
            result.dependencyStatusCorrected += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const agent = await getAgent(agentId);
      if (!agent || agent.companyId !== issue.companyId || !isAgentInvokable(agent)) {
        result.skipped += 1;
        continue;
      }

      // A valid future monitor is an explicit waiting path, not stranded work.
      // The shared predicate also rejects overdue, exhausted, or unbounded
      // blocked monitors so genuine recovery is not suppressed indefinitely.
      if (hasScheduledMonitor(issue, Date.now())) {
        result.skipped += 1;
        continue;
      }

      if (await hasActiveExecutionPath(issue.companyId, issue.id)) {
        result.skipped += 1;
        continue;
      }
      const orphanedDeferredWakes = await failOrphanedDeferredIssueWakes(issue.companyId, issue.id);
      result.orphanedDeferredWakesFailed += orphanedDeferredWakes.length;

      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      const latestRun = await getLatestIssueRun(issue.companyId, issue.id);
      if (isStrandedIssueRecoveryIssue(issue) && isUnsuccessfulTerminalIssueRun(latestRun)) {
        const updated = await escalateStrandedRecoveryIssueInPlace({
          issue,
          previousStatus: issue.status as "todo" | "in_progress",
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

        if (latestRun.status === "succeeded") {
          result.skipped += 1;
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            comment:
              "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
              `but it still has no live execution path.${failureSummary ?? ""} ` +
              "Moving it to `blocked` so it is visible for intervention.",
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
      const handoffEvidence = isExhaustedSuccessfulRunHandoff(latestRun);
      if (handoffEvidence) {
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
      if (didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")) {
        const failureSummary = summarizeRunFailureForIssueComment(latestRun);
        const updated = await escalateStrandedAssignedIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          comment:
            "Paperclip automatically retried continuation for this assigned `in_progress` issue after its live " +
            `execution disappeared, but it still has no live execution path.${failureSummary ?? ""} ` +
            "Moving it to `blocked` so it is visible for intervention.",
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

    return result;
  }

  async function collectIssueGraphLivenessFindings(now = new Date()) {
    const issueRowsPromise = Promise.resolve(db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
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
      })
      .from(issues)
      .where(
        and(
          isNull(issues.hiddenAt),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      ));

    const [
      issueRows,
      relationRows,
      agentRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryIssueRows,
      recoveryActionRows,
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
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
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
            isNull(issues.hiddenAt),
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
          createdAt: issueThreadInteractions.createdAt,
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
            isNull(issues.hiddenAt),
            inArray(issues.originKind, [
              STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
              RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            ]),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        ),
      issueRowsPromise.then((rows) => {
        const issueIdsUnderAnalysis = rows.map((row) => row.id);
        return issueIdsUnderAnalysis.length === 0
          ? []
          : db
            .select({
              companyId: issueRecoveryActions.companyId,
              issueId: issueRecoveryActions.sourceIssueId,
              status: issueRecoveryActions.status,
              ownerAgentId: issueRecoveryActions.ownerAgentId,
              ownerUserId: issueRecoveryActions.ownerUserId,
              timeoutAt: issueRecoveryActions.timeoutAt,
              ownerAgentCompanyId: agents.companyId,
              ownerAgentStatus: agents.status,
            })
            .from(issueRecoveryActions)
            .leftJoin(agents, eq(agents.id, issueRecoveryActions.ownerAgentId))
            .where(
              and(
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                inArray(issueRecoveryActions.sourceIssueId, issueIdsUnderAnalysis),
              ),
            );
      }),
    ]);

    const openRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        // The escalation is the durable response to a liveness finding, not
        // evidence that the underlying issue or dependency became healthy. If
        // it masks its own finding, obsolete-recovery cleanup retires it on the
        // next pass and a later pass recreates the same comment and wake. Keep
        // the finding live so incident/leaf dedupe retains exactly one recovery
        // until the real dependency or action-path state changes.
        return [];
      }

      const issueId = readNonEmptyString(row.originId);
      if (!issueId) return [];
      return [{
        companyId: row.companyId,
        issueId,
        status: row.status,
      }];
    });
    const activeRecoveryActionWaitingPaths = recoveryActionRows.flatMap((row) => {
      if (row.timeoutAt && row.timeoutAt <= now) return [];
      if (row.ownerUserId) {
        return [{ companyId: row.companyId, issueId: row.issueId, status: row.status }];
      }
      if (
        row.ownerAgentId &&
        row.ownerAgentCompanyId === row.companyId &&
        row.ownerAgentStatus &&
        ISSUE_GRAPH_LIVENESS_RECOVERY_ACTION_OWNER_STATUSES.has(row.ownerAgentStatus)
      ) {
        return [{ companyId: row.companyId, issueId: row.issueId, status: row.status }];
      }
      return [];
    });

    return classifyIssueGraphLiveness({
      issues: issueRows,
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
      openRecoveryIssues: openRecoveryIssues.concat(activeRecoveryActionWaitingPaths),
      now,
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
          isNull(issues.hiddenAt),
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
          isNull(issues.hiddenAt),
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
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafIssueId === leafIssueId;
    }) ?? null;
  }

  /**
   * A terminal liveness escalation suppresses immediate duplicate delivery,
   * not all future recovery. If the leaf is still stranded after the cooldown,
   * a new bounded recovery attempt is allowed. This retains anti-spam behavior
   * without turning a mistaken terminal disposition into permanent abandonment.
   */
  async function findTerminalLivenessEscalationForLeaf(finding: IssueLivenessFinding) {
    const leafIssueId = livenessRecoveryLeafIssueId(finding);
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.id));

    return candidates.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.leafIssueId === leafIssueId;
    }) ?? null;
  }

  /**
   * A blocked agent task can be healthy when it is waiting on a named human or
   * external system. Those waits do not have an issue-relation edge, but a
   * recent structured handoff comment is still a real continuation contract.
   * Without this guard, the liveness loop wakes managers to rediscover an
   * already-recorded OAuth, account, vendor, or customer dependency.
   */
  async function hasRecentExplicitExternalWait(finding: IssueLivenessFinding, now: Date) {
    if (finding.state !== "blocked_without_action_path") return false;
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, finding.companyId),
          eq(issueComments.issueId, finding.recoveryIssueId),
          gt(issueComments.createdAt, cutoff),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(12);

    return comments.some(({ body }) => {
      const text = body ?? "";
      const hasExternalOwner = /\b(account owner|workspace administrator|human owner|customer|vendor|third[- ]party|external owner)\b/i.test(text);
      const hasWakeContract = /\b(next wake path|resume (when|after)|waiting for|provide (the |a )?(valid |approved )?(identity|session|oauth|access)|approved (identity|session|oauth|access))\b/i.test(text);
      return hasExternalOwner && hasWakeContract;
    });
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
    await issuesSvc.update(sourceIssue.id, {
      blockedByIssueIds: blockerIds.filter((blockerId) => blockerId !== recovery.id),
    });
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
          isNull(issues.hiddenAt),
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

  async function loadLivenessDependencyActivityAtByIssue(
    findings: IssueLivenessFinding[],
    now: Date,
  ) {
    const issueIds = [
      ...new Set(
        findings.flatMap((finding) => finding.dependencyPath.map((entry) => entry.issueId)),
      ),
    ];
    if (issueIds.length === 0) return new Map<string, Date>();
    const [issueRows, pendingInteractionRows] = await Promise.all([
      db
        .select({ id: issues.id, companyId: issues.companyId, updatedAt: issues.updatedAt })
        .from(issues)
        .where(inArray(issues.id, issueIds)),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          createdAt: issueThreadInteractions.createdAt,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.status, "pending"),
          inArray(issueThreadInteractions.issueId, issueIds),
        )),
    ]);
    const activityAtByIssueKey = new Map(issueRows.map((row) => [
      livenessDependencyIssueKey(row.companyId, row.id),
      row.updatedAt,
    ]));

    // Lease expiry changes liveness even though no write occurs at that instant.
    // Treat that transition as recent activity so the auto-recovery lookback does
    // not discard a finding at the same boundary where the interaction stops
    // masking it.
    for (const interaction of pendingInteractionRows) {
      const expiredAt = issueLivenessPendingInteractionExpiresAt(interaction.createdAt);
      if (!expiredAt || expiredAt > now) continue;
      const key = livenessDependencyIssueKey(interaction.companyId, interaction.issueId);
      const current = activityAtByIssueKey.get(key);
      if (!current || expiredAt > current) activityAtByIssueKey.set(key, expiredAt);
    }

    return activityAtByIssueKey;
  }

  function latestDependencyActivityAtForLivenessFinding(
    finding: IssueLivenessFinding,
    activityAtByIssueKey: Map<string, Date>,
  ) {
    const dependencyIssueIds = [...new Set(finding.dependencyPath.map((entry) => entry.issueId))];
    if (dependencyIssueIds.length === 0) return null;
    const timestamps = dependencyIssueIds.map((issueId) =>
      activityAtByIssueKey.get(livenessDependencyIssueKey(finding.companyId, issueId)) ?? null
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
    activityAtByIssueKey: Map<string, Date>,
  ) {
    const latestActivityAt = latestDependencyActivityAtForLivenessFinding(
      finding,
      activityAtByIssueKey,
    );
    return Boolean(latestActivityAt && latestActivityAt >= cutoff);
  }

  async function buildIssueGraphLivenessAutoRecoveryPreview(
    opts?: { lookbackHours?: number; now?: Date },
  ): Promise<IssueGraphLivenessAutoRecoveryPreview> {
    const now = opts?.now ?? new Date();
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(opts?.lookbackHours);
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const rawFindings = await collectIssueGraphLivenessFindings(now);
    const findings: IssueLivenessFinding[] = [];
    for (const finding of rawFindings) {
      if (await hasRecentExplicitExternalWait(finding, now)) {
        logger.info({
          incidentKey: finding.incidentKey,
          recoveryIssueId: finding.recoveryIssueId,
        }, "suppressed liveness escalation for explicit external wait");
        continue;
      }
      findings.push(finding);
    }
    const activityAtByIssueKey = await loadLivenessDependencyActivityAtByIssue(findings, now);
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
      const latestDependencyActivityAt = latestDependencyActivityAtForLivenessFinding(
        finding,
        activityAtByIssueKey,
      );
      if (!latestDependencyActivityAt || latestDependencyActivityAt < cutoff) {
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
        // Keep the existing API field name; lease expiry is also a dependency
        // liveness transition even though it is not an issue-row update.
        latestDependencyUpdatedAt: latestDependencyActivityAt.toISOString(),
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
    const companyAgentRows = await db
      .select({
        id: agents.id,
        status: agents.status,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(eq(agents.companyId, issue.companyId))
      .orderBy(asc(agents.id));
    const companyAgentById = new Map(companyAgentRows.map((agent) => [agent.id, agent]));
    const selfEscalationAgentId = finding.state === "blocked_without_action_path"
      ? issue.assigneeAgentId
      : null;
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    for (const agent of companyAgentRows) {
      if (
        seenCandidates.has(agent.id) ||
        agent.id === selfEscalationAgentId ||
        !ISSUE_GRAPH_LIVENESS_RECOVERY_ACTION_OWNER_STATUSES.has(agent.status)
      ) {
        continue;
      }
      seenCandidates.add(agent.id);
      candidates.push({
        agentId: agent.id,
        reason: "ordered_invokable_fallback" as const,
        sourceIssueId: finding.recoveryIssueId,
      });
    }
    const budgetBlockedCandidateAgentIds: string[] = [];
    const candidateEvidence: Array<{
      agentId: string;
      reason: string;
      sourceIssueId: string;
      status: string | null;
      reportsTo: string | null;
      eligible: boolean;
      excludedReason: "stranded_assignee_self_escalation" | "not_invokable" | null;
      budgetBlock: {
        scopeType: string;
        scopeId: string;
        reason: string;
      } | null;
    }> = [];

    for (const candidate of candidates) {
      const currentAgent = companyAgentById.get(candidate.agentId) ?? null;
      const excludedReason = candidate.agentId === selfEscalationAgentId
        ? "stranded_assignee_self_escalation" as const
        : !currentAgent || !ISSUE_GRAPH_LIVENESS_RECOVERY_ACTION_OWNER_STATUSES.has(currentAgent.status)
          ? "not_invokable" as const
          : null;
      if (excludedReason) {
        candidateEvidence.push({
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceIssueId: candidate.sourceIssueId,
          status: currentAgent?.status ?? null,
          reportsTo: currentAgent?.reportsTo ?? null,
          eligible: false,
          excludedReason,
          budgetBlock: null,
        });
        continue;
      }

      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      const budgetEvidence = budgetBlock
        ? {
          scopeType: budgetBlock.scopeType,
          scopeId: budgetBlock.scopeId,
          reason: budgetBlock.reason,
        }
        : null;
      candidateEvidence.push({
        agentId: candidate.agentId,
        reason: candidate.reason,
        sourceIssueId: candidate.sourceIssueId,
        status: currentAgent!.status,
        reportsTo: currentAgent!.reportsTo,
        eligible: true,
        excludedReason: null,
        budgetBlock: budgetEvidence,
      });
      if (!budgetBlock) {
        return {
          kind: "agent" as const,
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
          candidateEvidence,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    const invokableCompanyAgents = companyAgentRows.filter((agent) =>
      ISSUE_GRAPH_LIVENESS_RECOVERY_ACTION_OWNER_STATUSES.has(agent.status)
    );
    const onlyInvokableAgentIsStrandedAssignee = Boolean(
      selfEscalationAgentId &&
      invokableCompanyAgents.length === 1 &&
      invokableCompanyAgents[0]?.id === selfEscalationAgentId,
    );
    const eligibleCandidateCount = candidateEvidence.filter((candidate) => candidate.eligible).length;
    const cause: LivenessBoardEscalationCause = eligibleCandidateCount > 0
      ? "all_same_company_candidates_budget_blocked"
      : onlyInvokableAgentIsStrandedAssignee
        ? "stranded_assignee_is_only_invokable_candidate"
        : "no_invokable_same_company_candidate";

    return {
      kind: "board" as const,
      cause,
      candidateAgentIds: candidates.map((entry) => entry.agentId),
      candidateReasons: candidates.map((entry) => ({
        agentId: entry.agentId,
        reason: entry.reason,
        sourceIssueId: entry.sourceIssueId,
      })),
      budgetBlockedCandidateAgentIds,
      candidateEvidence,
      companyAgentEvidence: companyAgentRows.map((agent) => ({
        agentId: agent.id,
        status: agent.status,
        reportsTo: agent.reportsTo,
        invokable: ISSUE_GRAPH_LIVENESS_RECOVERY_ACTION_OWNER_STATUSES.has(agent.status),
        excludedAsStrandedAssignee: agent.id === selfEscalationAgentId,
      })),
    };
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryIssueId === input.finding.issueId) return false;
    return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
  }

  type LivenessBoardOwnerSelection = Extract<
    Awaited<ReturnType<typeof resolveEscalationOwnerAgentId>>,
    { kind: "board" }
  >;

  async function findLivenessBoardInteractionByKey(input: {
    companyId: string;
    issueId: string;
    idempotencyKey: string;
  }) {
    return db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.idempotencyKey, input.idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function listLivenessBoardInteractionGenerations(input: {
    companyId: string;
    issueId: string;
    idempotencyKeyBase: string;
  }) {
    return db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        sql`${issueThreadInteractions.idempotencyKey} LIKE ${`${input.idempotencyKeyBase}:%`}`,
      ))
      .orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id));
  }

  async function createIssueGraphLivenessBoardEscalation(input: {
    finding: IssueLivenessFinding;
    sourceFindings: IssueLivenessFinding[];
    issue: typeof issues.$inferSelect;
    recoveryIssue: typeof issues.$inferSelect;
    ownerSelection: LivenessBoardOwnerSelection;
    runId?: string | null;
  }) {
    const idempotencyKeyBase = livenessBoardEscalationIdempotencyKeyBase(input.finding);
    const generations = await listLivenessBoardInteractionGenerations({
      companyId: input.issue.companyId,
      issueId: input.recoveryIssue.id,
      idempotencyKeyBase,
    });
    const pending = generations.find((interaction) => interaction.status === "pending");
    if (pending) {
      return { kind: "board_existing" as const, interactionId: pending.id };
    }
    const previousGeneration = generations.reduce((highest, interaction) => {
      const suffix = interaction.idempotencyKey?.slice(idempotencyKeyBase.length + 1) ?? "";
      const parsed = /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : 0;
      return Math.max(highest, parsed);
    }, 0);
    const generation = previousGeneration + 1;
    const idempotencyKey = `${idempotencyKeyBase}:${generation}`;
    const sourceIncidents = [...new Map(
      input.sourceFindings
        .filter((finding) =>
          finding.companyId === input.finding.companyId &&
          finding.state === input.finding.state &&
          finding.recoveryIssueId === input.finding.recoveryIssueId
        )
        .map((finding) => [finding.incidentKey, finding] as const),
    ).values()]
      .sort((left, right) => left.incidentKey.localeCompare(right.incidentKey))
      .map((finding) => {
        const source = finding.dependencyPath.find((entry) => entry.issueId === finding.issueId) ??
          finding.dependencyPath[0] ?? null;
        return {
          incidentKey: finding.incidentKey,
          findingState: finding.state,
          sourceIssue: {
            id: finding.issueId,
            identifier: finding.identifier ?? source?.identifier ?? null,
            title: source?.title ?? null,
          },
          recoveryIssueId: finding.recoveryIssueId,
          reason: finding.reason,
          dependencyPath: finding.dependencyPath,
        };
      });

    const continuationOptions = [
      {
        id: "assign_or_restore_owner",
        label: "Assign or restore owner",
        description:
          "Assign an invokable same-company recovery owner, then submit this choice so reconciliation can continue safely.",
      },
      {
        id: "restore_budget_then_continue",
        label: "Restore budget",
        description:
          "Resolve the applicable budget hard-stop, then submit this choice so reconciliation can select a safe owner.",
      },
      {
        id: "record_typed_waiting_path",
        label: "Record waiting path",
        description:
          "Add the real dependency, approval, user owner, or bounded monitor that now owns the next action.",
      },
      {
        id: "resolve_or_reclassify_issue",
        label: "Resolve or reclassify",
        description:
          "Move the recovery issue to the status matching reality, including done or cancelled when appropriate.",
      },
    ];
    const interactionInput = {
      kind: "ask_user_questions" as const,
      idempotencyKey,
      title: `Board recovery required for ${input.recoveryIssue.identifier ?? input.recoveryIssue.title}`,
      summary:
        "Paperclip exhausted the reporting chain and every safe same-company recovery candidate. Make the state change matching your selected continuation before submitting it.",
      // Never wake the deliberately excluded stranded assignee merely because
      // the board answered or cancelled this interaction. Assignment/budget/
      // dependency mutations own their normal wake behavior; reconciliation
      // evaluates the resulting state independently.
      continuationPolicy: "none" as const,
      payload: {
        version: 1 as const,
        title: "Choose the durable continuation path",
        submitLabel: "Continue recovery",
        context: {
          kind: "issue_graph_liveness_board_escalation",
          version: 1,
          generation,
          cause: input.ownerSelection.cause,
          incidentKey: input.finding.incidentKey,
          findingState: input.finding.state,
          companyId: input.issue.companyId,
          sourceIssue: {
            id: input.issue.id,
            identifier: input.issue.identifier,
          },
          sourceIncidents,
          sourceIncidentCount: sourceIncidents.length,
          recoveryIssue: {
            id: input.recoveryIssue.id,
            identifier: input.recoveryIssue.identifier,
          },
          dependencyPath: input.finding.dependencyPath,
          candidates: input.ownerSelection.candidateEvidence,
          companyAgents: input.ownerSelection.companyAgentEvidence,
          budgetBlockedCandidateAgentIds: input.ownerSelection.budgetBlockedCandidateAgentIds,
          continuation: {
            issueId: input.recoveryIssue.id,
            policy: "none",
            questionId: "continuation_path",
            optionIds: continuationOptions.map((option) => option.id),
            boardStateChangeRequiredBeforeSubmit: true,
            automaticWake: false,
          },
        },
        questions: [{
          id: "continuation_path",
          prompt:
            "Which durable continuation did you put in place for this liveness incident?",
          helpText:
            "Apply the matching assignment, budget, dependency, approval, monitor, or status change first. This response never wakes the stranded assignee automatically.",
          selectionMode: "single" as const,
          required: true,
          options: continuationOptions,
        }],
      },
    };

    let interaction: Awaited<ReturnType<typeof interactionsSvc.create>>;
    try {
      interaction = await interactionsSvc.create(
        { id: input.recoveryIssue.id, companyId: input.issue.companyId },
        interactionInput,
        {},
      );
    } catch (error) {
      const raced = await findLivenessBoardInteractionByKey({
        companyId: input.issue.companyId,
        issueId: input.recoveryIssue.id,
        idempotencyKey,
      });
      if (raced) {
        return { kind: "board_existing" as const, interactionId: raced.id };
      }
      throw error;
    }

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "issue.harness_liveness_board_escalation_created",
      entityType: "issue",
      entityId: input.recoveryIssue.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        cause: input.ownerSelection.cause,
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: input.issue.id,
        sourceIdentifier: input.issue.identifier,
        recoveryIssueId: input.recoveryIssue.id,
        recoveryIdentifier: input.recoveryIssue.identifier,
        sourceIncidents,
        sourceIncidentCount: sourceIncidents.length,
        interactionId: interaction.id,
        idempotencyKey,
        generation,
        candidateEvidence: input.ownerSelection.candidateEvidence,
        companyAgentEvidence: input.ownerSelection.companyAgentEvidence,
        budgetBlockedCandidateAgentIds: input.ownerSelection.budgetBlockedCandidateAgentIds,
        continuation: {
          issueId: input.recoveryIssue.id,
          interactionId: interaction.id,
          policy: interaction.continuationPolicy,
          questionId: "continuation_path",
        },
      },
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      cause: input.ownerSelection.cause,
      sourceIssueId: input.issue.id,
      recoveryIssueId: input.recoveryIssue.id,
      interactionId: interaction.id,
    }, "created issue graph liveness board escalation");

    return { kind: "board_created" as const, interactionId: interaction.id };
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

  async function createIssueGraphLivenessEscalation(input: {
    finding: IssueLivenessFinding;
    sourceFindings?: IssueLivenessFinding[];
    runId?: string | null;
  }) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.finding.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
      return { kind: "skipped" as const };
    }

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.finding.recoveryIssueId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryIssue) return { kind: "skipped" as const };

    const existing =
      await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding);
    if (existing) {
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: existing.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: existing.id };
    }

    const terminalIncident = await findTerminalLivenessEscalationForLeaf(input.finding);
    if (
      terminalIncident &&
      Date.now() - terminalIncident.updatedAt.getTime() < TERMINAL_LIVENESS_RECOVERY_RETRY_COOLDOWN_MS
    ) {
      logger.warn({
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        terminalEscalationIssueId: terminalIncident.id,
        terminalEscalationStatus: terminalIncident.status,
        retryAfter: new Date(
          terminalIncident.updatedAt.getTime() + TERMINAL_LIVENESS_RECOVERY_RETRY_COOLDOWN_MS,
        ).toISOString(),
      }, "deferred repeated liveness escalation during terminal recovery cooldown");
      return { kind: "suppressed_terminal_incident" as const, escalationIssueId: terminalIncident.id };
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryIssue);
    if (ownerSelection.kind === "board") {
      return createIssueGraphLivenessBoardEscalation({
        finding: input.finding,
        sourceFindings: input.sourceFindings ?? [input.finding],
        issue,
        recoveryIssue,
        ownerSelection,
        runId: input.runId ?? null,
      });
    }
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryIssue,
      ownerAgentId: ownerSelection.agentId,
    });
    let escalationParentIssueId: string | null = recoveryIssue.parentId ?? recoveryIssue.id;
    let escalationParentSource: "recovery_issue" | "recovery_issue_parent" | "top_level_fallback" =
      recoveryIssue.parentId ? "recovery_issue_parent" : "recovery_issue";
    let escalationParentFallbackReason: string | null = null;

    async function findOpenEscalationAfterCreateConflict() {
      const raced =
        await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding);
      if (!raced) throw new Error("Liveness escalation create conflict did not expose an open escalation");
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: raced.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return raced;
    }

    const buildEscalationInput = (parentId: string | null) => ({
      title: `Unblock liveness incident for ${recoveryIssue.identifier ?? recoveryIssue.title}`,
      description: buildLivenessEscalationDescription(input.finding),
      status: "todo",
      priority: "high",
      parentId,
      projectId: recoveryIssue.projectId,
      goalId: recoveryIssue.goalId,
      assigneeAgentId: ownerSelection.agentId,
      assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
      originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      originId: input.finding.incidentKey,
      originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
      billingCode: recoveryIssue.billingCode,
      ...(reuseRecoveryExecutionWorkspace
        ? { inheritExecutionWorkspaceFromIssueId: recoveryIssue.id }
        : {
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
          executionWorkspaceSettings: null,
        }),
    });

    let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      escalation = await issuesSvc.create(issue.companyId, buildEscalationInput(escalationParentIssueId));
    } catch (error) {
      if (isUniqueLivenessRecoveryConflict(error)) {
        const raced = await findOpenEscalationAfterCreateConflict();
        return { kind: "existing" as const, escalationIssueId: raced.id };
      }
      if (!isLivenessEscalationPlacementError(error)) throw error;

      escalationParentFallbackReason = error.message;
      escalationParentIssueId = null;
      escalationParentSource = "top_level_fallback";
      try {
        escalation = await issuesSvc.create(issue.companyId, buildEscalationInput(null));
      } catch (fallbackError) {
        if (!isUniqueLivenessRecoveryConflict(fallbackError)) throw fallbackError;
        const raced = await findOpenEscalationAfterCreateConflict();
        return { kind: "existing" as const, escalationIssueId: raced.id };
      }
    }

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
      {
        presentation: {
          kind: "system_notice",
          tone: "warning",
          title: "Needs unblock",
          detailsDefaultOpen: false,
        },
        metadata: livenessOriginalIssueCommentMetadata(input.finding, escalation),
      },
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
        escalationParentIssueId,
        escalationParentSource,
        escalationParentFallbackReason,
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
      }),
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
      }),
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

  type LegacyRecoveryDeliveryCandidate = {
    actionId: string;
    companyId: string;
    sourceIssueId: string;
    ownerAgentId: string | null;
    actionAttemptCount: number;
    actionUpdatedAt: Date;
    runIds: string[];
    wakeupIds: string[];
  };

  const liveRecoveryRunStatuses = ["queued", "scheduled_retry", "running"] as const;
  const terminalRecoveryRunStatuses = ["succeeded", "failed", "cancelled", "timed_out"] as const;
  const durableRecoveryRunStatuses = [
    ...liveRecoveryRunStatuses,
    ...terminalRecoveryRunStatuses,
  ] as const;

  /**
   * Recovery authority is no longer actionable once its source issue is
   * terminal. Reconcile that invariant independently of delivery history so
   * actions created by older releases cannot stay active forever merely
   * because they have no current run/wakeup evidence.
   *
   * The transaction follows the lifecycle lock order used by termination and
   * the recovery watchdog: owner agent -> wakeups -> runs -> source issue ->
   * recovery action. Running work is stopped through heartbeat control only
   * after database locks are released, then the candidate is retried.
   */
  async function reconcileTerminalSourceRecoveryActions(now = new Date()) {
    const candidates = await db
      .select({
        actionId: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        attemptCount: issueRecoveryActions.attemptCount,
        actionUpdatedAt: issueRecoveryActions.updatedAt,
        sourceStatus: issues.status,
      })
      .from(issueRecoveryActions)
      .leftJoin(
        issues,
        and(
          eq(issues.id, issueRecoveryActions.sourceIssueId),
          eq(issues.companyId, issueRecoveryActions.companyId),
        ),
      )
      .where(
        and(
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          or(isNull(issues.id), inArray(issues.status, ["done", "cancelled"]))!,
        ),
      )
      .orderBy(asc(issueRecoveryActions.id));

    const resolvedActionIds: string[] = [];
    const cancelledActionIds: string[] = [];
    const cancelledRunIds: string[] = [];
    const cancelledWakeupIds: string[] = [];
    const failedActionIds = new Set<string>();

    for (const candidate of candidates) {
      const externallyCancelledRunIds: string[] = [];
      const externallyCancelledWakeupIds: string[] = [];
      let reconciled: {
        actionId: string;
        companyId: string;
        sourceIssueId: string;
        sourceStatus: "done" | "cancelled" | null;
        actionStatus: "resolved" | "cancelled";
        cancelledRunIds: string[];
        cancelledWakeupIds: string[];
        details: Record<string, unknown>;
      } | null = null;

      for (let pass = 0; pass < 3 && !reconciled; pass += 1) {
        // Discover delivery identities before taking any lifecycle row lock.
        // The transaction below then locks only primary keys, avoiding the
        // full-table JSON scan/owner-lock convoy that older recovery sweeps
        // could create on large heartbeat history tables.
        const [preReadWakeups, preReadRuns] = await Promise.all([
          db
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, candidate.companyId),
                inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
                primarySourceRecoveryWakePredicate(candidate.actionId, candidate.sourceIssueId),
              ),
            ),
          db
            .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
            .from(heartbeatRuns)
            .innerJoin(
              agentWakeupRequests,
              and(
                eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
                eq(agentWakeupRequests.runId, heartbeatRuns.id),
              ),
            )
            .where(
              and(
                eq(heartbeatRuns.companyId, candidate.companyId),
                inArray(heartbeatRuns.status, [...liveRecoveryRunStatuses]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${candidate.actionId}`,
                primarySourceRecoveryWakePredicate(candidate.actionId, candidate.sourceIssueId),
              ),
            ),
        ]);
        const preReadWakeupIds = [
          ...new Set([
            ...preReadWakeups.map((wakeup) => wakeup.id),
            ...preReadRuns
              .map((run) => run.wakeupRequestId)
              .filter((id): id is string => Boolean(id)),
          ]),
        ].sort();
        const preReadRunIds = [...new Set(preReadRuns.map((run) => run.id))].sort();

        const result = await db.transaction(async (tx) => {
          if (candidate.ownerAgentId) {
            await tx
              .select({ id: agents.id })
              .from(agents)
              .where(
                and(
                  eq(agents.id, candidate.ownerAgentId),
                  eq(agents.companyId, candidate.companyId),
                ),
              )
              .for("update");
          }

          const lockedWakeups = preReadWakeupIds.length > 0
            ? await tx
                .select({
                  id: agentWakeupRequests.id,
                  status: agentWakeupRequests.status,
                  coalescedCount: agentWakeupRequests.coalescedCount,
                  payload: agentWakeupRequests.payload,
                  runId: agentWakeupRequests.runId,
                })
                .from(agentWakeupRequests)
                .where(
                  and(
                    eq(agentWakeupRequests.companyId, candidate.companyId),
                    inArray(agentWakeupRequests.id, preReadWakeupIds),
                  ),
                )
                .orderBy(asc(agentWakeupRequests.id))
                .for("update")
            : [];
          const lockedWakeupIds = lockedWakeups.map((wakeup) => wakeup.id);

          const lockedRuns = preReadRunIds.length > 0
            ? await tx
                .select({
                  id: heartbeatRuns.id,
                  status: heartbeatRuns.status,
                  wakeupRequestId: heartbeatRuns.wakeupRequestId,
                  contextSnapshot: heartbeatRuns.contextSnapshot,
                })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.companyId, candidate.companyId),
                    inArray(heartbeatRuns.id, preReadRunIds),
                    inArray(heartbeatRuns.status, [...liveRecoveryRunStatuses]),
                    sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${candidate.actionId}`,
                  ),
                )
                .orderBy(asc(heartbeatRuns.id))
                .for("update")
            : [];

          const lockedIssue = await tx
            .select({ id: issues.id, status: issues.status })
            .from(issues)
            .where(
              and(
                eq(issues.id, candidate.sourceIssueId),
                eq(issues.companyId, candidate.companyId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);

          const action = await tx
            .select()
            .from(issueRecoveryActions)
            .where(
              and(
                eq(issueRecoveryActions.id, candidate.actionId),
                eq(issueRecoveryActions.companyId, candidate.companyId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !action ||
            !["active", "escalated"].includes(action.status) ||
            action.sourceIssueId !== candidate.sourceIssueId ||
            action.ownerAgentId !== candidate.ownerAgentId ||
            action.attemptCount !== candidate.attemptCount ||
            action.updatedAt.getTime() !== candidate.actionUpdatedAt.getTime()
          ) {
            return { kind: "stale" as const };
          }

          const sourceStatus = lockedIssue?.status ?? null;
          if (sourceStatus !== null && !["done", "cancelled"].includes(sourceStatus)) {
            return { kind: "stale" as const };
          }

          // If a delivery changed or appeared after the advisory pre-read,
          // retry while the action is still active. Once the action row is
          // terminalized, the atomic claim gate rejects any later queued row.
          const lockedWakeupsById = new Map(lockedWakeups.map((wakeup) => [wakeup.id, wakeup]));
          const authoritativeLockedRuns = lockedRuns.filter((run) => {
            const context = parseObject(run.contextSnapshot);
            if (context.recoveryActionId !== candidate.actionId) return false;
            if (!run.wakeupRequestId) return false;
            const wakeup = run.wakeupRequestId
              ? lockedWakeupsById.get(run.wakeupRequestId) ?? null
              : null;
            return Boolean(
              wakeup &&
              wakeup.runId === run.id &&
              isPrimarySourceRecoveryWakePayload(
                wakeup.payload,
                candidate.actionId,
                candidate.sourceIssueId,
                wakeup,
              ),
            );
          });
          const lockedWakeupIdSet = new Set(lockedWakeupIds);
          if (authoritativeLockedRuns.some((run) =>
            run.wakeupRequestId && !lockedWakeupIdSet.has(run.wakeupRequestId)
          )) {
            return { kind: "retry" as const };
          }
          const newlyLinkedLiveRun = await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .innerJoin(
              agentWakeupRequests,
              and(
                eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
                eq(agentWakeupRequests.runId, heartbeatRuns.id),
              ),
            )
            .where(
              and(
                eq(heartbeatRuns.companyId, candidate.companyId),
                inArray(heartbeatRuns.status, [...liveRecoveryRunStatuses]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${candidate.actionId}`,
                primarySourceRecoveryWakePredicate(candidate.actionId, candidate.sourceIssueId),
                preReadRunIds.length > 0
                  ? notInArray(heartbeatRuns.id, preReadRunIds)
                  : undefined,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (newlyLinkedLiveRun) {
            return { kind: "retry" as const };
          }
          const newlyLinkedLiveWakeup = await tx
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, candidate.companyId),
                inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
                primarySourceRecoveryWakePredicate(candidate.actionId, candidate.sourceIssueId),
                preReadWakeupIds.length > 0
                  ? notInArray(agentWakeupRequests.id, preReadWakeupIds)
                  : undefined,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (newlyLinkedLiveWakeup) {
            return { kind: "retry" as const };
          }

          const runningRuns = authoritativeLockedRuns
            .filter((run) => run.status === "running")
            .map((run) => ({ id: run.id, wakeupRequestId: run.wakeupRequestId }));
          if (runningRuns.length > 0) {
            return { kind: "cancel_running" as const, runs: runningRuns };
          }

          const queuedRunIds = authoritativeLockedRuns
            .filter((run) => ["queued", "scheduled_retry"].includes(run.status))
            .map((run) => run.id);
          const cancelledRuns = queuedRunIds.length > 0
            ? await tx
                .update(heartbeatRuns)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: "Cancelled because the recovery source issue is terminal",
                  errorCode: "recovery_source_issue_terminal",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(heartbeatRuns.companyId, action.companyId),
                    inArray(heartbeatRuns.id, queuedRunIds),
                    inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
                  ),
                )
                .returning({ id: heartbeatRuns.id })
            : [];

          const activeWakeupIds = lockedWakeups
            .filter((wakeup) =>
              ["queued", "claimed", "deferred_issue_execution"].includes(wakeup.status) &&
              isPrimarySourceRecoveryWakePayload(
                wakeup.payload,
                candidate.actionId,
                candidate.sourceIssueId,
                wakeup,
              )
            )
            .map((wakeup) => wakeup.id);
          const cancelledWakeups = activeWakeupIds.length > 0
            ? await tx
                .update(agentWakeupRequests)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: "Cancelled because the recovery source issue is terminal",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(agentWakeupRequests.companyId, action.companyId),
                    inArray(agentWakeupRequests.id, activeWakeupIds),
                    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
                  ),
                )
                .returning({ id: agentWakeupRequests.id })
            : [];

          const actionStatus = sourceStatus === "done" ? "resolved" as const : "cancelled" as const;
          const previousEvidence = parseObject(action.evidence);
          const reconciledCancelledRunIds = [
            ...new Set([...externallyCancelledRunIds, ...cancelledRuns.map((run) => run.id)]),
          ];
          const reconciledCancelledWakeupIds = [
            ...new Set([...externallyCancelledWakeupIds, ...cancelledWakeups.map((wakeup) => wakeup.id)]),
          ];
          const details = {
            recoveryActionId: action.id,
            source: "recovery_terminal_source_reconciliation",
            sourceIssueStatus: sourceStatus ?? "missing",
            previousActionStatus: action.status,
            previousOwnerAgentId: action.ownerAgentId,
            recoveryAttempt: action.attemptCount,
            cancelledRunIds: reconciledCancelledRunIds,
            cancelledWakeupIds: reconciledCancelledWakeupIds,
            reconciledAt: now.toISOString(),
          };
          const updated = await tx
            .update(issueRecoveryActions)
            .set({
              status: actionStatus,
              outcome: actionStatus === "resolved" ? "restored" : "cancelled",
              resolutionNote: actionStatus === "resolved"
                ? "Recovery action resolved automatically because its source issue is done."
                : "Recovery action cancelled automatically because its source issue is cancelled or missing.",
              resolvedAt: now,
              evidence: {
                ...previousEvidence,
                terminalSourceReconciliation: details,
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(issueRecoveryActions.id, action.id),
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                eq(issueRecoveryActions.attemptCount, action.attemptCount),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!updated) return { kind: "stale" as const };

          await tx.insert(activityLog).values({
            companyId: action.companyId,
            actorType: "system",
            actorId: "system",
            agentId: null,
            runId: null,
            action: "issue.recovery_action_source_terminal_reconciled",
            entityType: "issue",
            entityId: action.sourceIssueId,
            details,
          });

          return {
            kind: "reconciled" as const,
            actionId: action.id,
            companyId: action.companyId,
            sourceIssueId: action.sourceIssueId,
            sourceStatus: sourceStatus as "done" | "cancelled" | null,
            actionStatus,
            cancelledRunIds: reconciledCancelledRunIds,
            cancelledWakeupIds: reconciledCancelledWakeupIds,
            details,
          };
        });

        if (result.kind === "reconciled") {
          reconciled = result;
          break;
        }
        if (result.kind === "stale") break;
        if (result.kind === "retry") {
          if (pass === 2) failedActionIds.add(candidate.actionId);
          continue;
        }
        if (!deps.cancelRun) {
          failedActionIds.add(candidate.actionId);
          logger.error(
            { recoveryActionId: candidate.actionId, runIds: result.runs.map((run) => run.id) },
            "cannot reconcile terminal-source recovery action without heartbeat cancellation",
          );
          break;
        }
        let cancellationFailed = false;
        for (const runningRun of result.runs) {
          try {
            await deps.cancelRun(runningRun.id, {
              reason: "Cancelled because the recovery source issue is terminal",
              suppressImmediateRecovery: true,
              force: true,
              errorCode: "recovery_source_issue_terminal",
              requireTransition: true,
            });
            const stoppedRun = await db
              .select({
                status: heartbeatRuns.status,
                errorCode: heartbeatRuns.errorCode,
                wakeupRequestId: heartbeatRuns.wakeupRequestId,
              })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, runningRun.id))
              .then((rows) => rows[0] ?? null);
            if (stoppedRun?.status === "running") {
              throw new Error("Heartbeat cancellation returned before the recovery run stopped");
            }
            if (
              stoppedRun?.status === "cancelled" &&
              stoppedRun.errorCode === "recovery_source_issue_terminal"
            ) {
              externallyCancelledRunIds.push(runningRun.id);
              if (stoppedRun.wakeupRequestId) {
                const stoppedWakeup = await db
                  .select({ status: agentWakeupRequests.status })
                  .from(agentWakeupRequests)
                  .where(eq(agentWakeupRequests.id, stoppedRun.wakeupRequestId))
                  .then((rows) => rows[0] ?? null);
                if (stoppedWakeup?.status === "cancelled") {
                  externallyCancelledWakeupIds.push(stoppedRun.wakeupRequestId);
                }
              }
            }
          } catch (error) {
            cancellationFailed = true;
            logger.error(
              { err: error, recoveryActionId: candidate.actionId, runId: runningRun.id },
              "failed to stop running recovery for a terminal source issue",
            );
          }
        }
        if (cancellationFailed) {
          failedActionIds.add(candidate.actionId);
          break;
        }
        if (pass === 2) failedActionIds.add(candidate.actionId);
      }

      if (!reconciled) continue;
      if (reconciled.actionStatus === "resolved") {
        resolvedActionIds.push(reconciled.actionId);
      } else {
        cancelledActionIds.push(reconciled.actionId);
      }
      cancelledRunIds.push(...reconciled.cancelledRunIds);
      cancelledWakeupIds.push(...reconciled.cancelledWakeupIds);
      publishLiveEvent({
        companyId: reconciled.companyId,
        type: "activity.logged",
        payload: {
          actorType: "system",
          actorId: "system",
          action: "issue.recovery_action_source_terminal_reconciled",
          entityType: "issue",
          entityId: reconciled.sourceIssueId,
          agentId: null,
          runId: null,
          details: reconciled.details,
        },
      });
    }

    const actionIds = [...resolvedActionIds, ...cancelledActionIds];
    const result = {
      reconciled: actionIds.length,
      resolved: resolvedActionIds.length,
      cancelled: cancelledActionIds.length,
      actionIds,
      resolvedActionIds,
      cancelledActionIds,
      cancelledRunIds: [...new Set(cancelledRunIds)],
      cancelledWakeupIds: [...new Set(cancelledWakeupIds)],
      failed: failedActionIds.size,
      failedActionIds: [...failedActionIds],
    };
    if (result.reconciled > 0 || result.failed > 0) {
      logger.warn(result, "reconciled recovery actions for terminal source issues");
    }
    return result;
  }

  /**
   * Pre-generation and stale source-scoped deliveries cannot be admitted by
   * the current claim gate. A terminal malformed delivery is also invisible to
   * the bounded-action watchdog because it has no exact current generation.
   * Migrate both live and terminal legacy deliveries before startup resumes
   * queued work. The transaction follows the global order: owner agent ->
   * wakeups -> runs -> source issue -> recovery action. Running work is stopped
   * only after those database locks have been released.
   */
  async function reconcileLegacySourceScopedRecoveryDeliveriesOnce(now: Date) {
    const legacyRows = await db
      .select({
        actionId: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        actionAttemptCount: issueRecoveryActions.attemptCount,
        actionUpdatedAt: issueRecoveryActions.updatedAt,
        runId: heartbeatRuns.id,
        runStatus: heartbeatRuns.status,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(issueRecoveryActions)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${issueRecoveryActions.id}::text`,
        ),
      )
      .innerJoin(
        agentWakeupRequests,
        and(
          eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
          eq(agentWakeupRequests.runId, heartbeatRuns.id),
          sql`${agentWakeupRequests.payload} ->> 'recoveryActionId' = ${issueRecoveryActions.id}::text`,
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueRecoveryActions.sourceIssueId}::text`,
          sql`${agentWakeupRequests.payload} ->> 'sourceIssueId' = ${issueRecoveryActions.sourceIssueId}::text`,
          sql`${agentWakeupRequests.payload} ->> 'managerEscalation' is distinct from 'true'`,
        ),
      )
      .where(
        and(
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          inArray(heartbeatRuns.status, [...durableRecoveryRunStatuses]),
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryAttempt' is null`,
            sql`${agentWakeupRequests.payload} ->> 'recoveryAttempt' is null`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryAttempt' is distinct from ${issueRecoveryActions.attemptCount}::text`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'source' is distinct from 'issue_recovery_action'`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' is distinct from 'source_scoped_recovery_action'`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is distinct from ${issueRecoveryActions.sourceIssueId}::text`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' is distinct from ${issueRecoveryActions.sourceIssueId}::text`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'sourceIssueId' is distinct from ${issueRecoveryActions.sourceIssueId}::text`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryCause' is distinct from ${issueRecoveryActions.cause}`,
            sql`${heartbeatRuns.agentId} is distinct from ${issueRecoveryActions.ownerAgentId}`,
            sql`${agentWakeupRequests.agentId} is distinct from ${issueRecoveryActions.ownerAgentId}`,
            sql`${agentWakeupRequests.reason} is distinct from 'source_scoped_recovery_action'`,
            sql`${agentWakeupRequests.runId} is distinct from ${heartbeatRuns.id}`,
            sql`${agentWakeupRequests.payload} ->> 'issueId' is distinct from ${issueRecoveryActions.sourceIssueId}::text`,
            sql`${agentWakeupRequests.payload} ->> 'sourceIssueId' is distinct from ${issueRecoveryActions.sourceIssueId}::text`,
            sql`${agentWakeupRequests.payload} ->> 'recoveryActionId' is distinct from ${issueRecoveryActions.id}::text`,
            sql`${agentWakeupRequests.payload} ->> 'recoveryAttempt' is distinct from ${issueRecoveryActions.attemptCount}::text`,
            sql`${agentWakeupRequests.payload} ->> 'recoveryCause' is distinct from ${issueRecoveryActions.cause}`,
          )!,
        ),
      )
      .orderBy(asc(issueRecoveryActions.id), asc(heartbeatRuns.id));

    // Do not repeatedly lock a valid historical terminal predecessor merely
    // because its attempt is older than an exact current delivery. Live
    // malformed rows for the same action remain candidates and are cleaned up
    // transactionally below. This is only an advisory pre-filter; the locked
    // transaction performs the same exact-current check again before writing.
    const legacyActionIds = [...new Set(legacyRows.map((row) => row.actionId))];
    const exactCurrentActionIds = new Set(
      legacyActionIds.length === 0
        ? []
        : await db
            .selectDistinct({ actionId: issueRecoveryActions.id })
            .from(issueRecoveryActions)
            .innerJoin(
              heartbeatRuns,
              and(
                eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${issueRecoveryActions.id}::text`,
              ),
            )
            .innerJoin(agentWakeupRequests, eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId))
            .where(
              and(
                inArray(issueRecoveryActions.id, legacyActionIds),
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                inArray(heartbeatRuns.status, [...durableRecoveryRunStatuses]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'source' = 'issue_recovery_action'`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' = 'source_scoped_recovery_action'`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueRecoveryActions.sourceIssueId}::text`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issueRecoveryActions.sourceIssueId}::text`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'sourceIssueId' = ${issueRecoveryActions.sourceIssueId}::text`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryAttempt' = ${issueRecoveryActions.attemptCount}::text`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryCause' = ${issueRecoveryActions.cause}`,
                sql`${heartbeatRuns.agentId} = ${issueRecoveryActions.ownerAgentId}`,
                sql`${agentWakeupRequests.agentId} = ${issueRecoveryActions.ownerAgentId}`,
                eq(agentWakeupRequests.reason, "source_scoped_recovery_action"),
                sql`${agentWakeupRequests.runId} = ${heartbeatRuns.id}`,
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueRecoveryActions.sourceIssueId}::text`,
                sql`${agentWakeupRequests.payload} ->> 'sourceIssueId' = ${issueRecoveryActions.sourceIssueId}::text`,
                sql`${agentWakeupRequests.payload} ->> 'recoveryActionId' = ${issueRecoveryActions.id}::text`,
                sql`${agentWakeupRequests.payload} ->> 'recoveryAttempt' = ${issueRecoveryActions.attemptCount}::text`,
                sql`${agentWakeupRequests.payload} ->> 'recoveryCause' = ${issueRecoveryActions.cause}`,
              ),
            )
            .then((rows) => rows.map((row) => row.actionId)),
    );

    const candidatesByAction = new Map<string, LegacyRecoveryDeliveryCandidate>();
    for (const row of legacyRows) {
      if (
        terminalRecoveryRunStatuses.includes(
          row.runStatus as (typeof terminalRecoveryRunStatuses)[number],
        ) && exactCurrentActionIds.has(row.actionId)
      ) {
        continue;
      }
      const candidate = candidatesByAction.get(row.actionId) ?? {
        actionId: row.actionId,
        companyId: row.companyId,
        sourceIssueId: row.sourceIssueId,
        ownerAgentId: row.ownerAgentId,
        actionAttemptCount: row.actionAttemptCount,
        actionUpdatedAt: row.actionUpdatedAt,
        runIds: [],
        wakeupIds: [],
      };
      candidate.runIds.push(row.runId);
      if (row.wakeupRequestId) candidate.wakeupIds.push(row.wakeupRequestId);
      candidatesByAction.set(row.actionId, candidate);
    }

    const migratedActionIds: string[] = [];
    const replacementRunIds: string[] = [];
    const cancelledLegacyRunIds: string[] = [];
    const failedActionIds: string[] = [];

    for (const candidate of candidatesByAction.values()) {
      let migration: {
        actionId: string;
        companyId: string;
        sourceIssueId: string;
        recoveryAttempt: number;
        replacementRunId: string | null;
        cancelledRunIds: string[];
        disposition:
          | "replacement_queued"
          | "escalated_timeout"
          | "escalated_owner_unavailable"
          | "source_resolved"
          | "source_cancelled"
          | "current_delivery_preserved"
          | "already_escalated";
      } | null = null;

      for (let pass = 0; pass < 3 && !migration; pass += 1) {
        const result = await db.transaction(async (tx) => {
          const lockedOwner = candidate.ownerAgentId
            ? await tx
                .select({ id: agents.id, status: agents.status })
                .from(agents)
                .where(
                  and(
                    eq(agents.id, candidate.ownerAgentId),
                    eq(agents.companyId, candidate.companyId),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;

          const wakeupLockPredicates = [
            primarySourceRecoveryWakePredicate(candidate.actionId, candidate.sourceIssueId),
          ];
          if (candidate.wakeupIds.length > 0) {
            wakeupLockPredicates.push(inArray(agentWakeupRequests.id, candidate.wakeupIds));
          }
          const lockedWakeups = await tx
            .select({
              id: agentWakeupRequests.id,
              agentId: agentWakeupRequests.agentId,
              status: agentWakeupRequests.status,
              coalescedCount: agentWakeupRequests.coalescedCount,
              reason: agentWakeupRequests.reason,
              payload: agentWakeupRequests.payload,
              runId: agentWakeupRequests.runId,
            })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, candidate.companyId),
                or(...wakeupLockPredicates)!,
              ),
            )
            .orderBy(asc(agentWakeupRequests.id))
            .for("update");

          const lockedRuns = await tx
            .select({
              id: heartbeatRuns.id,
              agentId: heartbeatRuns.agentId,
              status: heartbeatRuns.status,
              wakeupRequestId: heartbeatRuns.wakeupRequestId,
              contextSnapshot: heartbeatRuns.contextSnapshot,
            })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, candidate.companyId),
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${candidate.actionId}`,
              ),
            )
            .orderBy(asc(heartbeatRuns.id))
            .for("update");

          const lockedIssue = await tx
            .select({ id: issues.id, status: issues.status })
            .from(issues)
            .where(
              and(
                eq(issues.id, candidate.sourceIssueId),
                eq(issues.companyId, candidate.companyId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);

          const action = await tx
            .select()
            .from(issueRecoveryActions)
            .where(
              and(
                eq(issueRecoveryActions.id, candidate.actionId),
                eq(issueRecoveryActions.companyId, candidate.companyId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !action ||
            !["active", "escalated"].includes(action.status) ||
            action.sourceIssueId !== candidate.sourceIssueId ||
            action.ownerAgentId !== candidate.ownerAgentId ||
            action.attemptCount !== candidate.actionAttemptCount ||
            action.updatedAt.getTime() !== candidate.actionUpdatedAt.getTime()
          ) {
            return { kind: "stale" as const };
          }

          const wakeupsById = new Map(lockedWakeups.map((wakeup) => [wakeup.id, wakeup]));
          const previousEvidence = parseObject(action.evidence);
          const previousMigration = parseObject(
            previousEvidence.legacyRecoveryGenerationMigration,
          );
          const previouslyConsumedTerminalRunIds = new Set(
            previousMigration.recoveryAttempt === action.attemptCount &&
              Array.isArray(previousMigration.consumedTerminalRunIds)
              ? previousMigration.consumedTerminalRunIds.filter(
                  (runId): runId is string => typeof runId === "string",
                )
              : [],
          );
          const isExactCurrentDelivery = (run: (typeof lockedRuns)[number]) => {
            const context = parseObject(run.contextSnapshot);
            const wakeup = run.wakeupRequestId ? wakeupsById.get(run.wakeupRequestId) ?? null : null;
            const wakePayload = parseObject(wakeup?.payload);
            return (
              isPrimarySourceRecoveryRunContext(run.contextSnapshot, action.id, action.sourceIssueId) &&
              Boolean(wakeup) &&
              wakeup?.runId === run.id &&
              isPrimarySourceRecoveryWakePayload(wakeup?.payload, action.id, action.sourceIssueId, wakeup) &&
              context.wakeReason === "source_scoped_recovery_action" &&
              context.recoveryAttempt === action.attemptCount &&
              context.recoveryCause === action.cause &&
              run.agentId === action.ownerAgentId &&
              wakeup?.agentId === action.ownerAgentId &&
              wakeup.reason === "source_scoped_recovery_action" &&
              wakeup.runId === run.id &&
              wakePayload.issueId === action.sourceIssueId &&
              wakePayload.sourceIssueId === action.sourceIssueId &&
              wakePayload.recoveryActionId === action.id &&
              wakePayload.recoveryAttempt === action.attemptCount &&
              wakePayload.recoveryCause === action.cause
            );
          };
          const exactCurrentRuns = lockedRuns.filter((run) =>
            durableRecoveryRunStatuses.includes(
              run.status as (typeof durableRecoveryRunStatuses)[number],
            ) && isExactCurrentDelivery(run),
          );
          const hasExplicitLiveCurrentDelivery = exactCurrentRuns.some((run) =>
            liveRecoveryRunStatuses.includes(
              run.status as (typeof liveRecoveryRunStatuses)[number],
            ),
          );
          const hasExplicitTerminalCurrentDelivery = exactCurrentRuns.some((run) =>
            terminalRecoveryRunStatuses.includes(
              run.status as (typeof terminalRecoveryRunStatuses)[number],
            ),
          );
          const hasExplicitCurrentDelivery =
            hasExplicitLiveCurrentDelivery || hasExplicitTerminalCurrentDelivery;

          const candidateRunIds = new Set(candidate.runIds);
          const legacyRuns = lockedRuns.filter((run) => {
            const wakeup = run.wakeupRequestId ? wakeupsById.get(run.wakeupRequestId) ?? null : null;
            const context = parseObject(run.contextSnapshot);
            if (
              context.recoveryActionId !== action.id ||
              !wakeup ||
              wakeup.runId !== run.id ||
              !isPrimarySourceRecoveryWakePayload(wakeup.payload, action.id, action.sourceIssueId, wakeup)
            ) {
              return false;
            }
            if (isExactCurrentDelivery(run)) return false;
            if (
              terminalRecoveryRunStatuses.includes(
                run.status as (typeof terminalRecoveryRunStatuses)[number],
              ) && previouslyConsumedTerminalRunIds.has(run.id)
            ) {
              return false;
            }
            const wasSelectedAsCandidate = candidateRunIds.has(run.id);
            return wasSelectedAsCandidate || liveRecoveryRunStatuses.includes(
              run.status as (typeof liveRecoveryRunStatuses)[number],
            );
          });
          if (!legacyRuns.some((run) => candidateRunIds.has(run.id))) {
            return { kind: "stale" as const };
          }

          const hasLegacyLiveDelivery = legacyRuns.some((run) =>
            liveRecoveryRunStatuses.includes(
              run.status as (typeof liveRecoveryRunStatuses)[number],
            ),
          );
          // A terminal predecessor can be stale relative to the action's
          // current attempt while still being a valid historical delivery. If
          // an exact live replacement already exists, leave the predecessor
          // untouched. If an exact current terminal delivery exists, leave it
          // for the bounded watchdog to escalate instead of manufacturing a
          // new generation. Live malformed deliveries are still cancelled so
          // they cannot race the exact current delivery.
          if (hasExplicitCurrentDelivery && !hasLegacyLiveDelivery) {
            return { kind: "stale" as const };
          }

          const runningRunIds = legacyRuns
            .filter((run) => run.status === "running")
            .map((run) => run.id);
          if (runningRunIds.length > 0) {
            return { kind: "cancel_running" as const, runIds: runningRunIds };
          }

          const recoveryAttempt = Math.max(1, action.attemptCount);

          const cancellableLegacyRunIds = legacyRuns
            .filter((run) => ["queued", "scheduled_retry"].includes(run.status))
            .map((run) => run.id);
          const cancelledRuns = cancellableLegacyRunIds.length > 0
            ? await tx
                .update(heartbeatRuns)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: "Cancelled because this legacy recovery delivery had no explicit recovery generation",
                  errorCode: "legacy_recovery_generation_migrated",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(heartbeatRuns.companyId, action.companyId),
                    inArray(heartbeatRuns.id, cancellableLegacyRunIds),
                    inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
                  ),
                )
                .returning({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
            : [];
          const cancellableWakeupIds = [
            ...new Set(
              cancelledRuns
                .map((run) => run.wakeupRequestId)
                .filter((id): id is string => Boolean(id)),
            ),
          ];
          if (cancellableWakeupIds.length > 0) {
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "cancelled",
                finishedAt: now,
                error: "Cancelled because this legacy recovery delivery had no explicit recovery generation",
                updatedAt: now,
              })
              .where(
                and(
                  inArray(agentWakeupRequests.id, cancellableWakeupIds),
                  inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
                ),
              );
          }

          const templateRun = legacyRuns.find((run) => candidateRunIds.has(run.id)) ?? legacyRuns[0]!;
          const templateWakeup = templateRun.wakeupRequestId
            ? wakeupsById.get(templateRun.wakeupRequestId) ?? null
            : null;
          const ownerInvokable = Boolean(
            lockedOwner && !["paused", "terminated", "pending_approval"].includes(lockedOwner.status),
          );
          const actionExpired = Boolean(action.timeoutAt && action.timeoutAt <= now);
          const sourceOpen = Boolean(lockedIssue && !["done", "cancelled"].includes(lockedIssue.status));
          const shouldCreateReplacement =
            !hasExplicitCurrentDelivery &&
            action.status === "active" &&
            action.ownerType === "agent" &&
            Boolean(action.ownerAgentId) &&
            ownerInvokable &&
            !actionExpired &&
            sourceOpen;

          let replacementRunId: string | null = null;
          let replacementWakeupId: string | null = null;
          if (shouldCreateReplacement && action.ownerAgentId) {
            const contextSnapshot = {
              ...parseObject(templateRun.contextSnapshot),
              issueId: action.sourceIssueId,
              taskId: action.sourceIssueId,
              sourceIssueId: action.sourceIssueId,
              recoveryActionId: action.id,
              recoveryAttempt,
              wakeReason: "source_scoped_recovery_action",
              source: "issue_recovery_action",
              recoveryCause: action.cause,
              skipIssueComment: true,
            };
            const payload = {
              ...parseObject(templateWakeup?.payload),
              issueId: action.sourceIssueId,
              sourceIssueId: action.sourceIssueId,
              recoveryActionId: action.id,
              recoveryAttempt,
              recoveryCause: action.cause,
            };
            const replacementWakeup = await tx
              .insert(agentWakeupRequests)
              .values({
                companyId: action.companyId,
                agentId: action.ownerAgentId,
                source: "automation",
                triggerDetail: "system",
                reason: "source_scoped_recovery_action",
                payload,
                status: "queued",
                requestedByActorType: "system",
                requestedByActorId: null,
                idempotencyKey: `legacy_recovery_generation:${action.id}:${recoveryAttempt}`,
                updatedAt: now,
              })
              .returning()
              .then((rows) => rows[0]);
            const replacementRun = await tx
              .insert(heartbeatRuns)
              .values({
                companyId: action.companyId,
                agentId: action.ownerAgentId,
                invocationSource: "automation",
                triggerDetail: "system",
                status: "queued",
                wakeupRequestId: replacementWakeup.id,
                contextSnapshot,
                updatedAt: now,
              })
              .returning()
              .then((rows) => rows[0]);
            await tx
              .update(agentWakeupRequests)
              .set({ runId: replacementRun.id, updatedAt: now })
              .where(eq(agentWakeupRequests.id, replacementWakeup.id));
            replacementRunId = replacementRun.id;
            replacementWakeupId = replacementWakeup.id;
          }

          const shouldResolveForCompletedSource =
            action.status === "active" &&
            !hasExplicitLiveCurrentDelivery &&
            lockedIssue?.status === "done";
          const shouldCancelForMissingOrCancelledSource =
            action.status === "active" &&
            !hasExplicitLiveCurrentDelivery &&
            (!lockedIssue || lockedIssue.status === "cancelled");
          const shouldEscalateWithoutReplacement =
            action.status === "active" &&
            !hasExplicitLiveCurrentDelivery &&
            sourceOpen &&
            !replacementRunId &&
            (actionExpired ||
              action.ownerType !== "agent" ||
              !action.ownerAgentId ||
              !ownerInvokable);
          const disposition = replacementRunId
            ? "replacement_queued" as const
            : shouldResolveForCompletedSource
              ? "source_resolved" as const
              : shouldCancelForMissingOrCancelledSource
                ? "source_cancelled" as const
                : shouldEscalateWithoutReplacement
                  ? actionExpired
                    ? "escalated_timeout" as const
                    : "escalated_owner_unavailable" as const
                  : hasExplicitLiveCurrentDelivery
                    ? "current_delivery_preserved" as const
                  : "already_escalated" as const;

          const consumedTerminalRunIds = [
            ...new Set([
              ...previouslyConsumedTerminalRunIds,
              ...legacyRuns
                .filter((run) => terminalRecoveryRunStatuses.includes(
                  run.status as (typeof terminalRecoveryRunStatuses)[number],
                ))
                .map((run) => run.id),
            ]),
          ];
          const terminalTemplateRun = legacyRuns.find((run) =>
            terminalRecoveryRunStatuses.includes(
              run.status as (typeof terminalRecoveryRunStatuses)[number],
            ),
          ) ?? null;
          const escalationReason = disposition === "escalated_timeout"
            ? "timeout"
            : disposition === "escalated_owner_unavailable"
              ? "recovery_owner_not_invokable"
              : null;
          const migrationEvidence = {
            migratedAt: now.toISOString(),
            recoveryAttempt,
            legacyRunIds: legacyRuns.map((run) => run.id),
            legacyWakeupIds: legacyRuns
              .map((run) => run.wakeupRequestId)
              .filter((id): id is string => Boolean(id)),
            cancelledQueuedRunIds: cancelledRuns.map((run) => run.id),
            consumedTerminalRunIds,
            replacementRunId,
            replacementWakeupId,
            disposition,
          };
          await tx
            .update(issueRecoveryActions)
            .set({
              attemptCount: recoveryAttempt,
              evidence: {
                ...previousEvidence,
                legacyRecoveryGenerationMigration: migrationEvidence,
                ...(escalationReason
                  ? {
                      boundedRecoveryEscalation: {
                        reason: escalationReason,
                        previousOwnerAgentId: action.ownerAgentId,
                        terminalRunId: terminalTemplateRun?.id ?? null,
                        terminalRunStatus: terminalTemplateRun?.status ?? null,
                        escalatedAt: now.toISOString(),
                        source: "legacy_recovery_generation_migration",
                      },
                    }
                  : {}),
              },
              ...(replacementRunId ? { lastAttemptAt: now } : {}),
              ...(shouldResolveForCompletedSource
                ? {
                    status: "resolved",
                    outcome: "restored",
                    resolutionNote:
                      "Recovery action resolved because the source issue was already completed during legacy-delivery migration.",
                    resolvedAt: now,
                  }
                : {}),
              ...(shouldCancelForMissingOrCancelledSource
                ? {
                    status: "cancelled",
                    outcome: "cancelled",
                    resolutionNote:
                      "Recovery action cancelled because the source issue was missing or cancelled during legacy-delivery migration.",
                    resolvedAt: now,
                  }
                : {}),
              ...(shouldEscalateWithoutReplacement
                ? {
                    status: "escalated",
                    ownerType: "board",
                    ownerAgentId: null,
                    ownerUserId: null,
                    nextAction:
                      "Board action required: assign a capable recovery owner or record an intentional source-issue disposition.",
                    wakePolicy: {
                      type: "board_escalation",
                      reason: actionExpired
                        ? "recovery_action_timeout"
                        : "recovery_owner_not_invokable",
                    },
                  }
                : {}),
              updatedAt: now,
            })
            .where(eq(issueRecoveryActions.id, action.id));

          return {
            kind: "migrated" as const,
            actionId: action.id,
            companyId: action.companyId,
            sourceIssueId: action.sourceIssueId,
            recoveryAttempt,
            replacementRunId,
            cancelledRunIds: cancelledRuns.map((run) => run.id),
            disposition,
          };
        });

        if (result.kind === "stale") break;
        if (result.kind === "migrated") {
          migration = result;
          break;
        }
        if (!deps.cancelRun) {
          logger.error(
            { recoveryActionId: candidate.actionId, runIds: result.runIds },
            "cannot migrate running legacy recovery delivery without heartbeat cancellation",
          );
          failedActionIds.push(candidate.actionId);
          break;
        }
        let cancellationFailed = false;
        for (const runId of result.runIds) {
          try {
            await deps.cancelRun(runId, {
              reason: "Cancelled because this legacy recovery delivery had no explicit recovery generation",
              suppressImmediateRecovery: true,
              force: true,
              errorCode: "legacy_recovery_generation_migrated",
              requireTransition: true,
            });
            const stoppedRun = await db
              .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, runId))
              .then((rows) => rows[0] ?? null);
            if (stoppedRun?.status === "running") {
              throw new Error("Heartbeat cancellation returned before the legacy recovery run stopped");
            }
            if (
              stoppedRun?.status === "cancelled" &&
              stoppedRun.errorCode === "legacy_recovery_generation_migrated"
            ) {
              cancelledLegacyRunIds.push(runId);
            }
          } catch (error) {
            cancellationFailed = true;
            logger.error(
              { err: error, recoveryActionId: candidate.actionId, runId },
              "failed to stop running legacy recovery delivery",
            );
          }
        }
        if (cancellationFailed) {
          failedActionIds.push(candidate.actionId);
          break;
        }
      }

      if (!migration) continue;
      migratedActionIds.push(migration.actionId);
      cancelledLegacyRunIds.push(...migration.cancelledRunIds);
      if (migration.replacementRunId) replacementRunIds.push(migration.replacementRunId);
      await logActivity(db, {
        companyId: migration.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: migration.replacementRunId,
        action: "issue.recovery_action_generation_migrated",
        entityType: "issue",
        entityId: migration.sourceIssueId,
        details: {
          source: "recovery_legacy_generation_migration",
          recoveryActionId: migration.actionId,
          recoveryAttempt: migration.recoveryAttempt,
          replacementRunId: migration.replacementRunId,
          cancelledLegacyRunIds: migration.cancelledRunIds,
          disposition: migration.disposition,
        },
      });
    }

    const result = {
      migrated: migratedActionIds.length,
      actionIds: migratedActionIds,
      replacementRunIds,
      cancelledLegacyRunIds: [...new Set(cancelledLegacyRunIds)],
      failed: [...new Set(failedActionIds)].length,
      failedActionIds: [...new Set(failedActionIds)],
    };
    if (result.migrated > 0 || result.failed > 0) {
      logger.warn(result, "reconciled legacy source-scoped recovery deliveries");
    }
    return result;
  }

  async function reconcileLegacySourceScopedRecoveryDeliveries(now = new Date()) {
    type Result = Awaited<ReturnType<typeof reconcileLegacySourceScopedRecoveryDeliveriesOnce>>;
    const key = db as object;
    const active = legacyRecoveryReconciliationInFlight.get(key) as Promise<Result> | undefined;
    if (active) return active;

    const pending = reconcileLegacySourceScopedRecoveryDeliveriesOnce(now);
    legacyRecoveryReconciliationInFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (legacyRecoveryReconciliationInFlight.get(key) === pending) {
        legacyRecoveryReconciliationInFlight.delete(key);
      }
    }
  }

  async function escalateExhaustedRecoveryActions(now: Date) {
    const candidates = await db
      .select({
        id: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        attemptCount: issueRecoveryActions.attemptCount,
      })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.status, "active"),
          or(
            lte(issueRecoveryActions.timeoutAt, now),
            and(
              sql`exists (
                select 1
                from ${heartbeatRuns}
                where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
                  and ${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${issueRecoveryActions.id}::text
                  and ${heartbeatRuns.contextSnapshot} ->> 'recoveryAttempt' = ${issueRecoveryActions.attemptCount}::text
                  and ${heartbeatRuns.status} in ('succeeded', 'failed', 'cancelled', 'timed_out')
              )`,
              sql`not exists (
                select 1
                from ${heartbeatRuns}
                where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
                  and ${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${issueRecoveryActions.id}::text
                  and ${heartbeatRuns.contextSnapshot} ->> 'recoveryAttempt' = ${issueRecoveryActions.attemptCount}::text
                  and ${heartbeatRuns.status} in ('queued', 'scheduled_retry', 'running')
              )`,
            )!,
          )!,
        ),
      )
      .orderBy(asc(issueRecoveryActions.updatedAt));

    const escalatedActionIds: string[] = [];
    for (const candidate of candidates) {
      let escalated: {
        id: string;
        companyId: string;
        sourceIssueId: string;
        runId: string | null;
        details: Record<string, unknown>;
      } | null = null;

      // A run can be promoted from queued to running between candidate
      // discovery and row locking. If that happens, release all database
      // locks, stop it through the heartbeat control plane, then retry the
      // same generation. Never move authorization to the board while external
      // work from the expired generation is still executing.
      for (let pass = 0; pass < 3 && !escalated; pass += 1) {
        const result = await db.transaction(async (tx) => {
          // Match termination's global order: owner -> wakeups -> runs -> source issue
          // -> recovery action. Candidate generation is a stale-safe pre-read;
          // the action is revalidated after every prerequisite row is locked.
          if (candidate.ownerAgentId) {
            await tx
              .select({ id: agents.id })
              .from(agents)
              .where(and(
                eq(agents.id, candidate.ownerAgentId),
                eq(agents.companyId, candidate.companyId),
              ))
              .for("update");
          }
          const lockedWakeups = await tx
            .select({
              id: agentWakeupRequests.id,
              agentId: agentWakeupRequests.agentId,
              status: agentWakeupRequests.status,
              coalescedCount: agentWakeupRequests.coalescedCount,
              payload: agentWakeupRequests.payload,
              runId: agentWakeupRequests.runId,
            })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, candidate.companyId),
                primarySourceRecoveryWakePredicate(candidate.id, candidate.sourceIssueId),
                sql`coalesce(
                  ${agentWakeupRequests.payload} ->> 'recoveryAttempt',
                  ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'recoveryAttempt'
                ) = ${candidate.attemptCount}::text`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.id))
            .for("update");

          const lockedRuns = await tx
            .select({
              id: heartbeatRuns.id,
              agentId: heartbeatRuns.agentId,
              status: heartbeatRuns.status,
              wakeupRequestId: heartbeatRuns.wakeupRequestId,
              contextSnapshot: heartbeatRuns.contextSnapshot,
              finishedAt: heartbeatRuns.finishedAt,
              updatedAt: heartbeatRuns.updatedAt,
            })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, candidate.companyId),
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${candidate.id}`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryAttempt' = ${candidate.attemptCount}::text`,
              ),
            )
            .orderBy(asc(heartbeatRuns.id))
            .for("update");

          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.id, candidate.sourceIssueId),
                eq(issues.companyId, candidate.companyId),
              ),
            )
            .for("update");

          const action = await tx
            .select()
            .from(issueRecoveryActions)
            .where(eq(issueRecoveryActions.id, candidate.id))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !action ||
            action.status !== "active" ||
            action.attemptCount !== candidate.attemptCount ||
            action.ownerAgentId !== candidate.ownerAgentId
          ) {
            return { kind: "stale" as const };
          }

          const timedOut = Boolean(action.timeoutAt && action.timeoutAt <= now);
          const wakeupsById = new Map(lockedWakeups.map((wakeup) => [wakeup.id, wakeup]));
          const authoritativeRuns = lockedRuns.filter((run) => {
            const context = parseObject(run.contextSnapshot);
            if (
              context.recoveryActionId !== action.id ||
              context.recoveryAttempt !== action.attemptCount ||
              !run.wakeupRequestId
            ) return false;
            const wakeup = wakeupsById.get(run.wakeupRequestId) ?? null;
            return Boolean(
              wakeup &&
              wakeup.runId === run.id &&
              isPrimarySourceRecoveryWakePayload(
                wakeup.payload,
                action.id,
                action.sourceIssueId,
                wakeup,
              ) &&
              parseObject(wakeup.payload).recoveryAttempt === action.attemptCount,
            );
          });
          const runningRunIds = authoritativeRuns
            .filter((run) => run.status === "running")
            .map((run) => run.id);
          if (timedOut && runningRunIds.length > 0) {
            return { kind: "cancel_running" as const, runIds: runningRunIds };
          }

          const liveRun = authoritativeRuns.find((run) =>
            ["queued", "scheduled_retry", "running"].includes(run.status),
          );
          const terminalRun = [...authoritativeRuns]
            .filter((run) => ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status))
            .sort((left, right) =>
              (right.finishedAt?.getTime() ?? right.updatedAt.getTime()) -
              (left.finishedAt?.getTime() ?? left.updatedAt.getTime()),
            )[0] ?? null;
          if (!timedOut && (liveRun || !terminalRun)) return { kind: "stale" as const };

          const queuedRunIds = authoritativeRuns
            .filter((run) => ["queued", "scheduled_retry"].includes(run.status))
            .map((run) => run.id);
          const queuedRuns = queuedRunIds.length > 0
            ? await tx
                .update(heartbeatRuns)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: "Cancelled because the bounded recovery action escalated to the board",
                  errorCode: "recovery_action_escalated",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(heartbeatRuns.companyId, action.companyId),
                    inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
                    inArray(
                      heartbeatRuns.id,
                      queuedRunIds,
                    ),
                  ),
                )
                .returning({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
            : [];
          const wakeupIds = queuedRuns
            .map((run) => run.wakeupRequestId)
            .filter((id): id is string => Boolean(id));
          const lockedWakeupIds = new Set(lockedWakeups.map((wakeup) => wakeup.id));
          const cancellableWakeupIds = wakeupIds.filter((id) => lockedWakeupIds.has(id));
          if (cancellableWakeupIds.length > 0) {
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "cancelled",
                finishedAt: now,
                error: "Cancelled because the bounded recovery action escalated to the board",
                updatedAt: now,
              })
              .where(inArray(agentWakeupRequests.id, cancellableWakeupIds));
          }

          const previousEvidence = parseObject(action.evidence);
          const updated = await tx
            .update(issueRecoveryActions)
            .set({
              status: "escalated",
              ownerType: "board",
              ownerAgentId: null,
              ownerUserId: null,
              evidence: {
                ...previousEvidence,
                boundedRecoveryEscalation: {
                  reason: timedOut ? "timeout" : "terminal_run_without_disposition",
                  previousOwnerAgentId: action.ownerAgentId,
                  terminalRunId: terminalRun?.id ?? null,
                  terminalRunStatus: terminalRun?.status ?? null,
                  escalatedAt: now.toISOString(),
                },
              },
              nextAction: "Board action required: assign a capable recovery owner or record an intentional source-issue disposition.",
              wakePolicy: {
                type: "board_escalation",
                reason: timedOut ? "recovery_action_timeout" : "recovery_run_finished_without_disposition",
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(issueRecoveryActions.id, action.id),
                eq(issueRecoveryActions.status, "active"),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!updated) return { kind: "stale" as const };

          const activityDetails = {
            recoveryActionId: action.id,
            source: "recovery_action_watchdog",
            reason: timedOut ? "timeout" : "terminal_run_without_disposition",
            previousOwnerAgentId: action.ownerAgentId,
            terminalRunId: terminalRun?.id ?? null,
            terminalRunStatus: terminalRun?.status ?? null,
            cancelledQueuedRunIds: queuedRuns.map((run) => run.id),
            recoveryAttempt: action.attemptCount,
          };
          await tx.insert(activityLog).values({
            companyId: action.companyId,
            actorType: "system",
            actorId: "system",
            agentId: null,
            runId: terminalRun?.id ?? null,
            action: "issue.recovery_action_escalated",
            entityType: "issue",
            entityId: action.sourceIssueId,
            details: activityDetails,
          });
          return {
            kind: "escalated" as const,
            id: updated.id,
            companyId: action.companyId,
            sourceIssueId: action.sourceIssueId,
            runId: terminalRun?.id ?? null,
            details: activityDetails,
          };
        });

        if (result.kind === "escalated") {
          escalated = result;
          break;
        }
        if (result.kind !== "cancel_running") break;
        if (!deps.cancelRun) {
          logger.error(
            { recoveryActionId: candidate.id, runIds: result.runIds },
            "cannot escalate expired recovery action without heartbeat cancellation",
          );
          break;
        }
        let cancellationFailed = false;
        for (const runId of result.runIds) {
          try {
            await deps.cancelRun(runId, {
              reason: "Cancelled because the bounded recovery action timed out",
              suppressImmediateRecovery: true,
              force: true,
              requireTransition: true,
            });
          } catch (error) {
            cancellationFailed = true;
            logger.error(
              { err: error, recoveryActionId: candidate.id, runId },
              "failed to stop timed-out recovery run",
            );
          }
        }
        if (cancellationFailed) break;
      }

      if (escalated) {
        escalatedActionIds.push(escalated.id);
        publishLiveEvent({
          companyId: escalated.companyId,
          type: "activity.logged",
          payload: {
            actorType: "system",
            actorId: "system",
            action: "issue.recovery_action_escalated",
            entityType: "issue",
            entityId: escalated.sourceIssueId,
            agentId: null,
            runId: escalated.runId,
            details: escalated.details,
          },
        });
      }
    }

    return {
      escalated: escalatedActionIds.length,
      actionIds: escalatedActionIds,
    };
  }

  async function reconcileIssueGraphLiveness(opts?: {
    runId?: string | null;
    force?: boolean;
    lookbackHours?: number;
  }) {
    const now = new Date();
    const terminalSourceRecoveryActions = await reconcileTerminalSourceRecoveryActions(now);
    const legacyRecoveryDeliveries = await reconcileLegacySourceScopedRecoveryDeliveries(now);
    const exhaustedRecoveryActions = await escalateExhaustedRecoveryActions(now);
    const findings = await collectIssueGraphLivenessFindings(now);
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableIssueGraphLivenessAutoRecovery,
      true,
    ) || opts?.force === true;
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(
      opts?.lookbackHours ?? experimentalSettings.issueGraphLivenessAutoRecoveryLookbackHours,
    );
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryIssues(findings);
    const activityAtByIssueKey = await loadLivenessDependencyActivityAtByIssue(findings, now);
    const sourceFindingsByRecoveryLeaf = new Map<string, IssueLivenessFinding[]>();
    for (const finding of findings) {
      const key = livenessRecoveryLeafFingerprint(finding);
      const grouped = sourceFindingsByRecoveryLeaf.get(key) ?? [];
      grouped.push(finding);
      sourceFindingsByRecoveryLeaf.set(key, grouped);
    }
    const result = {
      findings: findings.length,
      autoRecoveryEnabled,
      lookbackHours,
      cutoff: cutoff.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      boardEscalationsCreated: 0,
      existingBoardEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      obsoleteRecoveriesRetired: obsoleteRecoveryCleanup.retired,
      obsoleteRecoveriesActiveSkipped: obsoleteRecoveryCleanup.activeSkipped,
      obsoleteRecoveryBlockerRelationsRemoved: obsoleteRecoveryCleanup.blockerRelationsRemoved,
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      boardInteractionIds: [] as string[],
      failed: 0,
      failedIssueIds: [] as string[],
      retiredRecoveryIssueIds: obsoleteRecoveryCleanup.retiredIssueIds,
      exhaustedRecoveryActionsEscalated: exhaustedRecoveryActions.escalated,
      exhaustedRecoveryActionIds: exhaustedRecoveryActions.actionIds,
      terminalSourceRecoveryActionsReconciled: terminalSourceRecoveryActions.reconciled,
      terminalSourceRecoveryActionsResolved: terminalSourceRecoveryActions.resolved,
      terminalSourceRecoveryActionsCancelled: terminalSourceRecoveryActions.cancelled,
      terminalSourceRecoveryActionIds: terminalSourceRecoveryActions.actionIds,
      terminalSourceRecoveryActionReconciliationFailed: terminalSourceRecoveryActions.failed,
      terminalSourceRecoveryActionReconciliationFailedIds: terminalSourceRecoveryActions.failedActionIds,
      legacyRecoveryDeliveriesMigrated: legacyRecoveryDeliveries.migrated,
      legacyRecoveryActionIds: legacyRecoveryDeliveries.actionIds,
      legacyRecoveryReplacementRunIds: legacyRecoveryDeliveries.replacementRunIds,
      legacyRecoveryDeliveryMigrationFailed: legacyRecoveryDeliveries.failed,
      legacyRecoveryDeliveryMigrationFailedActionIds: legacyRecoveryDeliveries.failedActionIds,
    };

    if (!autoRecoveryEnabled) {
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    for (const finding of findings) {
      if (!isLivenessFindingInsideAutoRecoveryLookback(finding, cutoff, activityAtByIssueKey)) {
        result.skippedOutsideLookback += 1;
        result.skipped += 1;
        continue;
      }
      let escalation: Awaited<ReturnType<typeof createIssueGraphLivenessEscalation>>;
      try {
        escalation = await createIssueGraphLivenessEscalation({
          finding,
          sourceFindings: sourceFindingsByRecoveryLeaf.get(livenessRecoveryLeafFingerprint(finding)) ?? [finding],
          runId: opts?.runId ?? null,
        });
      } catch (error) {
        result.failed += 1;
        result.skipped += 1;
        result.failedIssueIds.push(finding.issueId);
        logger.warn({
          err: error,
          incidentKey: finding.incidentKey,
          findingState: finding.state,
          sourceIssueId: finding.issueId,
          recoveryIssueId: finding.recoveryIssueId,
        }, "issue graph liveness escalation failed for finding");
        continue;
      }
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "board_created") {
        result.boardEscalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        if (!result.boardInteractionIds.includes(escalation.interactionId)) {
          result.boardInteractionIds.push(escalation.interactionId);
        }
      } else if (escalation.kind === "board_existing") {
        result.existingBoardEscalations += 1;
        result.issueIds.push(finding.issueId);
        if (!result.boardInteractionIds.includes(escalation.interactionId)) {
          result.boardInteractionIds.push(escalation.interactionId);
        }
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  return {
    buildRunOutputSilence,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    reconcileStrandedAssignedIssues,
    buildIssueGraphLivenessAutoRecoveryPreview,
    reconcileTerminalSourceRecoveryActions,
    reconcileLegacySourceScopedRecoveryDeliveries,
    reconcileIssueGraphLiveness,
    readRecoveryTimerIntervalMs,
  };
}
