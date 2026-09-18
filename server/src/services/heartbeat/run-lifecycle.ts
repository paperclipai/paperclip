import {
  DEFERRED_WAKE_CONTEXT_KEY,
  EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
  shouldRequireIssueCommentForWake,
} from "./queue.js";
import {
  HEARTBEAT_RUN_TERMINAL_STATUSES,
  DETACHED_PROCESS_ERROR_CODE,
} from "./recovery.js";
import { normalizeAgentNameKey } from "./retries.js";
import {
  type RunSessionOutcome,
  deriveTaskKeyWithHeartbeatFallback,
  type UsageTotals,
} from "./run-state.js";
import { CONFIGURATION_INCOMPLETE_FAILURE_CODE } from "./run-preparation.js";
import { WORKSPACE_VALIDATION_FAILURE_CODE } from "./workspaces.js";
import { boundHeartbeatRunEventPayloadForStorage } from "./run-log.js";
import { preserveWorkspaceRestoreRecoveryMetadata } from "../workspace-restore-recovery-state.js";
import { pendingNativeWorkspaceFinalizationCondition } from "../native-runtime/native-workspace-finalization-state.js";
import { activeIssueInteractionCondition } from "../issue-question-context.js";
import {
  nativeRetryCancellationCommitCondition,
  rethrowNativeCancellationLockConflict,
} from "../native-runtime/native-cancellation-request.js";
import { cancellationResultJson } from "../run-cancellation.js";
import { accountRunCost } from "../run-cost-accounting.js";
import { isWaitingConversation } from "../agent-conversations.js";
import { PROCESS_IDENTITY_RECORDED } from "../native-local-process-stop.js";
import {
  hasAcknowledgedNativeReassignmentStopIntent,
  hasAcknowledgedNativeStopIntent,
} from "../acknowledged-native-stop.js";
import { connectionIntentService } from "../connection-intents.js";
import {
  CONVERSATION_CONTINUATION_POLICY,
  isConversationAdapter,
} from "../conversation-continuation.js";
import { terminalizeLegacyExecution } from "../legacy-execution-recovery.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "../heartbeat-run-status-payload.js";
import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  not,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  type HeartbeatRunStatusPhase,
  type RequestConfirmationResult,
  type RunLivenessState,
} from "@paperclipai/shared";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  approvals,
  companySkillTestRuns,
  documentRevisions,
  issueDocuments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  issueWorkProducts,
  routines,
  workspaceOperations,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { publishLiveEvent } from "../live-events.js";
import {
  appendHeartbeatRunEvent,
  type AppendHeartbeatRunEventInput,
} from "../heartbeat-run-events.js";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import {
  parseObject,
  asBoolean,
  asNumber,
} from "../../adapters/utils.js";
import {
  isNativeRunnerOwnershipHeld,
  nativeRunnerOwnershipNotHeldCondition,
} from "../native-runtime/native-runner-ownership.js";
import {
  type RunFailureReportOptions,
} from "../run-failure-diagnostics.js";
import {
  findHeartbeatRunCompletionComment,
  hasAcceptedSemanticResult,
  readCompletedAssistantMessageCandidate,
  selectHeartbeatRunFinalAgentMessage,
  type RunPresentationDecision,
} from "../heartbeat-run-summary.js";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
} from "../heartbeat-stop-metadata.js";
import { CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE } from "../chat-control-recovery-stop.js";
import {
  classifyRunLiveness,
  type RunLivenessClassificationInput,
} from "../run-liveness.js";
import {
  logActivity,
  publishPluginDomainEvent,
} from "../activity-log.js";
import { runnerGoalService } from "../runner-goals.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { hasArmedInvokableIssueWatchdog } from "../task-watchdog-delivery.js";
import {
  getIssueContinuationSummaryDocument,
  refreshIssueContinuationSummary,
} from "../issue-continuation-summary.js";
import {
  RECOVERY_ORIGIN_KINDS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  RUN_LIVENESS_CONTINUATION_REASON,
  buildRunLivenessContinuationIdempotencyKey,
  buildFinishSuccessfulRunHandoffIdempotencyKey,
  buildSuccessfulRunHandoffRequiredNotice,
  decideRunLivenessContinuation,
  decideSuccessfulRunHandoff,
  findExistingFinishSuccessfulRunHandoffWake,
  findExistingRunLivenessContinuationWake,
  isSuccessfulRunHandoffValidPathSkip,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  readContinuationAttempt,
} from "../recovery/index.js";
import { withRecoveryContext } from "../recovery/status-only-context.js";
import { deriveCommentId } from "../../modules/run-dispatch/index.js";
import {
  buildIssueReviewPathLostIdempotencyKey,
  decideIssueReviewPathRecovery,
  ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
  isReviewPathRecoveryIdempotencyConflict,
  reviewPathConsumedRefFromRun,
} from "../recovery/review-path-recovery.js";
import { resolveRequiredSuccessfulRunHandoffOnValidPath } from "../successful-run-handoff-state.js";
import {
  redactCurrentUserText,
  redactCurrentUserValue,
  type CurrentUserRedactionOptions,
} from "../../log-redaction.js";
import {
  redactEventPayload,
  redactSensitiveText,
} from "../../redaction.js";
import {
  type RuntimeStatusUpdate,
} from "@paperclipai/adapter-utils";
import {
  UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  UNMANAGED_BACKGROUND_TASK_STOP_REASON,
} from "@paperclipai/adapter-utils/server-utils";
import {
  clearHeartbeatRunRuntimeStatus,
  getHeartbeatRunRuntimeStatus,
  MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS,
  MAX_HEARTBEAT_RUN_RUNTIME_TOOL_NAME_CHARS,
  setHeartbeatRunRuntimeStatus,
} from "../heartbeat-run-runtime-status.js";
import { readProcessStartedAt } from "../hot-restart.js";

import type { createHeartbeatRunState } from "./run-state.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { createHeartbeatQueue } from "./queue.js";
import type { HeartbeatRetryDependencies } from "./retries.js";
import type { issueService } from "../issues.js";
import type { recoveryService } from "../recovery/index.js";
import type { companySkillService } from "../company-skills.js";
import type { budgetService, BudgetServiceHooks } from "../budgets.js";
import type { issueTreeControlService } from "../issue-tree-control.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

/** Lifecycle owns run writes; the service supplies reporting and admission effects. */
export interface HeartbeatLifecycleDependencies extends Pick<ReturnType<typeof createHeartbeatRunState>,
  "getRun" | "resolveSessionBeforeForWakeup" | "ensureRuntimeState">,
  Pick<ReturnType<typeof createHeartbeatRunPreparation>,
    "getIssueExecutionContext" | "resolveResponsibleUserIdForRunContext">,
  Pick<HeartbeatRetryDependencies, "getAgentInvokability"> {
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment" | "listReviewAttention">;
  recovery: Pick<ReturnType<typeof recoveryService>, "escalateStrandedAssignedIssue">;
  companySkills: Pick<ReturnType<typeof companySkillService>, "completeTestRunForIssue">;
  budgets: Pick<ReturnType<typeof budgetService>, "getInvocationBlock">;
  treeControlSvc: Pick<ReturnType<typeof issueTreeControlService>, "getActivePauseHoldGate">;
  enqueueWakeup: ReturnType<typeof createHeartbeatQueue>["enqueueWakeup"];
  getCurrentUserRedactionOptions: () => Promise<CurrentUserRedactionOptions>;
  budgetHooks: BudgetServiceHooks;
  emitTerminalAgentTaskRun: (run: HeartbeatRun, previousStatus: string | null, failureReport?: RunFailureReportOptions) => void;
}

export function redactDetectedSuccessfulRunProgressSummaryForBoard(
  summary: string,
  currentUserRedactionOptions?: CurrentUserRedactionOptions,
) {
  const normalized = summary.replace(/\s+/g, " ").trim();
  const redacted = redactSensitiveText(
    redactCurrentUserText(normalized, currentUserRedactionOptions),
  );
  return redacted.length <= 280 ? redacted : `${redacted.slice(0, 277)}...`;
}

export function redactSuccessfulRunHandoffEvidence(
  value: string | null,
  currentUserRedactionOptions?: CurrentUserRedactionOptions,
) {
  if (!value) return null;
  return redactSensitiveText(
    redactCurrentUserText(value, currentUserRedactionOptions),
  );
}

const LIVENESS_BOOKKEEPING_ACTIVITY_ACTIONS = [
  "environment.lease_acquired",
  "environment.lease_released",
  "cost.reported",
];

export const NON_RETRYABLE_PREFLIGHT_FAILURE_CODES = new Set<string>([
  "low_trust_isolation_unavailable",
  "low_trust_requires_isolated_workspace",
  "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment",
  "low_trust_runtime_services_denied",
  "chat_failed_run_retry_not_authorized",
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
]);

// Error codes that mark a pre-dispatch setup failure. The adapter process never
// started, so no agent could post an issue comment. The setup catch writes one
// of these codes when a failure happens before `adapter.execute`.
const PRE_ADAPTER_SETUP_FAILURE_CODES = new Set<string>([
  "setup_failed",
  CONFIGURATION_INCOMPLETE_FAILURE_CODE,
  WORKSPACE_VALIDATION_FAILURE_CODE,
  ...NON_RETRYABLE_PREFLIGHT_FAILURE_CODES,
]);

const MAX_TURN_CONTINUATION_DEFAULT_MAX_ATTEMPTS = 2;

const MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP = 10;

const MAX_TURN_CONTINUATION_DEFAULT_DELAY_MS = 1_000;

const MAX_TURN_CONTINUATION_MAX_DELAY_MS = 5 * 60 * 1000;

interface MaxTurnContinuationPolicy {
  enabled: boolean;
  maxAttempts: number;
  delayMs: number;
}

export function isHeartbeatRunTerminalStatus(
  status: string | null | undefined,
): status is (typeof HEARTBEAT_RUN_TERMINAL_STATUSES)[number] {
  return HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
    status as (typeof HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
  );
}

export function isHeartbeatRunRuntimeStatusActive(
  status: string | null | undefined,
): boolean {
  return status === "queued" || status === "running";
}

type HeartbeatRunRuntimeStatusRunLike = {
  id: string;
  status?: string | null;
  companyId?: string | null;
  agentId?: string | null;
  issueId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

function readRuntimeStatusIssueIdCandidate(
  run: HeartbeatRunRuntimeStatusRunLike,
): string | null | undefined {
  if ("issueId" in run) return readNonEmptyString(run.issueId) ?? null;
  if ("contextSnapshot" in run) {
    return readNonEmptyString(parseObject(run.contextSnapshot).issueId) ?? null;
  }
  return undefined;
}

export function decorateHeartbeatRunRuntimeStatus<
  T extends HeartbeatRunRuntimeStatusRunLike,
>(
  run: T,
  expected: {
    companyId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
  } = {},
): T & {
  currentStatusMessage: string | null;
  currentStatusUpdatedAt: Date | null;
  currentToolName: string | null;
  lastAssistantSnippet: string | null;
  lastEventAt: Date | null;
} {
  if (isHeartbeatRunTerminalStatus(run.status)) {
    clearHeartbeatRunRuntimeStatus(run.id);
  }

  const companyId = expected.companyId ?? run.companyId ?? null;
  const agentId = expected.agentId ?? run.agentId ?? null;
  const issueId =
    expected.issueId !== undefined
      ? expected.issueId
      : readRuntimeStatusIssueIdCandidate(run);
  const currentStatus =
    isHeartbeatRunRuntimeStatusActive(run.status) && companyId && agentId
      ? getHeartbeatRunRuntimeStatus(run.id, {
          companyId,
          agentId,
          ...(issueId !== undefined ? { issueId } : {}),
        })
      : null;

  return {
    ...run,
    currentStatusMessage: currentStatus?.message ?? null,
    currentStatusUpdatedAt: currentStatus?.updatedAt ?? null,
    currentToolName: currentStatus?.currentToolName ?? null,
    lastAssistantSnippet: currentStatus?.lastAssistantSnippet ?? null,
    lastEventAt: currentStatus?.lastEventAt ?? null,
  };
}

export function publishHeartbeatRunRuntimeProgress(status: {
  companyId: string;
  runId: string;
  agentId: string;
  issueId: string | null;
  phase: HeartbeatRunStatusPhase;
  message: string;
  updatedAt: Date;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: Date | null;
}) {
  publishLiveEvent({
    companyId: status.companyId,
    type: "heartbeat.run.progress",
    payload: {
      runId: status.runId,
      agentId: status.agentId,
      issueId: status.issueId,
      phase: status.phase,
      message: status.message,
      currentToolName: status.currentToolName ?? null,
      lastAssistantSnippet: status.lastAssistantSnippet ?? null,
      lastEventAt: (status.lastEventAt ?? status.updatedAt).toISOString(),
      updatedAt: status.updatedAt.toISOString(),
    },
  });
}

function recordHeartbeatRunRuntimeProgress(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "id" | "companyId" | "agentId" | "status" | "contextSnapshot"
  >,
  update: RuntimeStatusUpdate,
  issueId: string | null,
) {
  if (!isHeartbeatRunRuntimeStatusActive(run.status)) return null;
  const status = setHeartbeatRunRuntimeStatus({
    companyId: run.companyId,
    issueId,
    agentId: run.agentId,
    runId: run.id,
    phase: update.phase as HeartbeatRunStatusPhase,
    message: update.message,
    currentToolName: readNonEmptyString(update.currentToolName) ?? null,
    lastAssistantSnippet:
      readNonEmptyString(update.lastAssistantSnippet) ?? null,
    lastEventAt: update.lastEventAt ? new Date(update.lastEventAt) : new Date(),
  });
  if (!status) return null;

  publishHeartbeatRunRuntimeProgress(status);
  return status;
}

function sanitizeLiveRunProgressText(
  value: string,
  maxChars: number,
): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const redacted = redactSensitiveText(normalized);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars - 3)}...`;
}

function readLiveRunProgressString(
  value: unknown,
  maxChars: number,
): string | null {
  return typeof value === "string"
    ? sanitizeLiveRunProgressText(value, maxChars)
    : null;
}

function readFirstLiveRunProgressString(
  maxChars: number,
  values: unknown[],
): string | null {
  for (const value of values) {
    const text = readLiveRunProgressString(value, maxChars);
    if (text) return text;
  }
  return null;
}

function readLiveRunToolName(
  payload: Record<string, unknown> | null,
  eventType: string,
): string | null {
  const toolCall =
    parseObject(payload?.tool_call) ?? parseObject(payload?.toolCall);
  const message = parseObject(payload?.message);
  const direct = readFirstLiveRunProgressString(
    MAX_HEARTBEAT_RUN_RUNTIME_TOOL_NAME_CHARS,
    [
      payload?.toolName,
      payload?.tool_name,
      payload?.tool,
      payload?.name,
      payload?.title,
      toolCall?.name,
      toolCall?.toolName,
      message?.name,
      message?.toolName,
    ],
  );
  if (direct) return direct;

  const normalizedEventType = eventType.toLowerCase();
  if (!normalizedEventType.includes("tool")) return null;
  return readLiveRunProgressString(
    eventType.replace(/[._-]+/g, " "),
    MAX_HEARTBEAT_RUN_RUNTIME_TOOL_NAME_CHARS,
  );
}

function readLiveRunAssistantSnippet(
  payload: Record<string, unknown> | null,
  eventType: string,
  message: string | null,
): string | null {
  const normalizedEventType = eventType.toLowerCase();
  const messagePayload = parseObject(payload?.message);
  const direct = readFirstLiveRunProgressString(
    MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS,
    [
      payload?.text,
      payload?.delta,
      payload?.text_delta,
      payload?.content,
      payload?.summary,
      messagePayload?.text,
      messagePayload?.content,
    ],
  );
  if (direct) return direct;

  if (
    normalizedEventType.includes("assistant") ||
    normalizedEventType.includes("text_delta") ||
    normalizedEventType.includes("message.delta") ||
    normalizedEventType.includes("message_delta")
  ) {
    return message
      ? sanitizeLiveRunProgressText(
          message,
          MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS,
        )
      : null;
  }

  return null;
}

function buildRunEventRuntimeProgress(input: {
  eventType: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  at: Date;
}) {
  const normalizedEventType = input.eventType.toLowerCase();
  if (
    normalizedEventType === "lifecycle" ||
    normalizedEventType === "adapter.invoke"
  ) {
    return null;
  }

  const currentToolName = readLiveRunToolName(input.payload, input.eventType);
  const lastAssistantSnippet = readLiveRunAssistantSnippet(
    input.payload,
    input.eventType,
    input.message,
  );
  const fallbackMessage =
    readLiveRunProgressString(
      input.message,
      MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS,
    ) ??
    sanitizeLiveRunProgressText(
      input.eventType.replace(/[._-]+/g, " "),
      MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS,
    );
  const message = currentToolName
    ? `Using ${currentToolName}`
    : (lastAssistantSnippet ?? fallbackMessage);

  if (!message) return null;
  return {
    phase: "run_activity" as const,
    message,
    currentToolName,
    lastAssistantSnippet,
    lastEventAt: input.at,
  };
}

export async function persistHeartbeatRunProcessMetadata(
  db: Db,
  runId: string,
  meta: { pid: number; processGroupId: number | null; startedAt: string; targetKind?: "local" | "remote" },
) {
  // A sandbox PID belongs to a different host and may collide with a local PID.
  const observedStartedAt = meta.targetKind === "remote" ? null : await readProcessStartedAt(meta.pid).catch(
    () => null,
  );
  const startedAt = new Date(observedStartedAt ?? meta.startedAt);
  return db.transaction(async tx => {
    const run = await tx
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processGroupId: meta.processGroupId,
        processStartedAt: Number.isNaN(startedAt.getTime())
          ? new Date()
          : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (run?.runtimeMode === "native") await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: run.companyId, runId, agentId: run.agentId,
      eventType: PROCESS_IDENTITY_RECORDED, stream: "system", level: "info",
      message: "Process identity recorded; prior stop evidence no longer applies.",
    });
    return run;
  });
}

type SkillTestHeartbeatCompletion = {
  outcome: "failed" | "cancelled";
  error: string | null;
  heartbeatOutcome: RunSessionOutcome;
};

export function resolveSkillTestRunCompletionForHeartbeatOutcome(
  outcome: RunSessionOutcome,
  error: string | null | undefined,
): SkillTestHeartbeatCompletion | null {
  if (outcome === "cancelled") {
    return {
      outcome: "cancelled",
      error: error ?? "Harness run was cancelled",
      heartbeatOutcome: outcome,
    };
  }
  if (outcome === "timed_out") {
    return {
      outcome: "failed",
      error: error ?? "Timed out",
      heartbeatOutcome: outcome,
    };
  }
  if (outcome === "failed") {
    return {
      outcome: "failed",
      error: error ?? "Adapter failed",
      heartbeatOutcome: outcome,
    };
  }
  return null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Run lifecycle binds status, progress, liveness, and completion operations. */
export function createHeartbeatLifecycle(db: Db, dependencies: HeartbeatLifecycleDependencies) {
  const {
    issuesSvc,
    recovery,
    companySkills,
    getRun,
    emitTerminalAgentTaskRun,
    getIssueExecutionContext,
    budgets,
    enqueueWakeup,
    getCurrentUserRedactionOptions,
    treeControlSvc,
    getAgentInvokability,
    resolveSessionBeforeForWakeup,
    resolveResponsibleUserIdForRunContext,
    ensureRuntimeState,
    budgetHooks,
  } = dependencies;

  function isPlanApprovalConfirmationPayload(payload: unknown) {
    const target = parseObject(parseObject(payload).target);
    return (
      readNonEmptyString(target.type) === "issue_document" &&
      readNonEmptyString(target.key) === "plan"
    );
  }

  async function getAcceptedPlanApprovalInteractionForRun(
    run: typeof heartbeatRuns.$inferSelect,
    issueId: string | null,
  ) {
    const context = parseObject(run.contextSnapshot);
    const interactionId = readNonEmptyString(context.interactionId);
    if (!issueId || !interactionId) return null;

    const interaction = await db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        payload: issueThreadInteractions.payload,
        result: issueThreadInteractions.result,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, run.companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.id, interactionId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!interaction) return null;
    if (
      interaction.kind !== "request_confirmation" ||
      interaction.status !== "accepted"
    )
      return null;
    return isPlanApprovalConfirmationPayload(interaction.payload)
      ? interaction
      : null;
  }

  function planApprovalResumeFailureErrorCode(
    run: typeof heartbeatRuns.$inferSelect,
  ) {
    return readNonEmptyString(run.errorCode) ?? "unknown_error";
  }

  function buildPlanApprovalResumeFailureComment(input: {
    run: typeof heartbeatRuns.$inferSelect;
    status: "retrying" | "needs_attention";
    attempt: number;
    maxAttempts: number;
  }) {
    const errorCode = planApprovalResumeFailureErrorCode(input.run);
    if (input.status === "retrying") {
      return `Agent failed to resume after approval: \`${errorCode}\` — retrying (attempt ${input.attempt}/${input.maxAttempts})`;
    }
    return `Agent failed to resume after approval: \`${errorCode}\` — needs attention`;
  }

  function buildPlanApprovalResumeFailureResult(input: {
    run: typeof heartbeatRuns.$inferSelect;
    status: "retrying" | "needs_attention";
    attempt: number;
    maxAttempts: number;
    retryRunId?: string | null;
    recoveryActionId?: string | null;
  }): NonNullable<RequestConfirmationResult["resumeFailure"]> {
    return {
      status: input.status,
      errorCode: planApprovalResumeFailureErrorCode(input.run),
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      runId: input.run.id,
      retryRunId: input.retryRunId ?? null,
      recoveryActionId: input.recoveryActionId ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  async function updatePlanApprovalInteractionResumeFailure(input: {
    interaction: NonNullable<
      Awaited<ReturnType<typeof getAcceptedPlanApprovalInteractionForRun>>
    >;
    failure: NonNullable<RequestConfirmationResult["resumeFailure"]>;
  }) {
    const result = parseObject(input.interaction.result);
    const nextResult = {
      ...result,
      version: 1 as const,
      outcome: "accepted" as const,
      resumeFailure: input.failure,
    } satisfies RequestConfirmationResult;

    await db
      .update(issueThreadInteractions)
      .set({
        result: nextResult,
        updatedAt: new Date(),
      })
      .where(eq(issueThreadInteractions.id, input.interaction.id));
  }

  async function addPlanApprovalResumeFailureCommentOnce(input: {
    issueId: string;
    run: typeof heartbeatRuns.$inferSelect;
    body: string;
  }) {
    const existing = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.run.companyId),
          eq(issueComments.issueId, input.issueId),
          or(
            eq(issueComments.body, input.body),
            sql`${issueComments.body} like ${`${input.body}\n%`}`,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return null;
    return issuesSvc.addComment(
      input.issueId,
      input.body,
      { runId: input.run.id },
      { authorType: "system" },
    );
  }

  async function getActiveRecoveryActionId(
    companyId: string,
    sourceIssueId: string,
  ) {
    return db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null);
  }

  async function recordPlanApprovalResumeFailureRetry(input: {
    run: typeof heartbeatRuns.$inferSelect;
    issueId: string | null;
    retryRunId: string | null;
    attempt: number;
    maxAttempts: number;
  }) {
    const interaction = await getAcceptedPlanApprovalInteractionForRun(
      input.run,
      input.issueId,
    );
    if (!interaction || !input.issueId) return null;

    const body = buildPlanApprovalResumeFailureComment({
      run: input.run,
      status: "retrying",
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
    });
    await addPlanApprovalResumeFailureCommentOnce({
      issueId: input.issueId,
      run: input.run,
      body,
    });
    await updatePlanApprovalInteractionResumeFailure({
      interaction,
      failure: buildPlanApprovalResumeFailureResult({
        run: input.run,
        status: "retrying",
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        retryRunId: input.retryRunId,
      }),
    });
    return interaction.id;
  }

  async function escalatePlanApprovalResumeFailureNeedsAttention(input: {
    run: typeof heartbeatRuns.$inferSelect;
    issueId: string | null;
    attempt: number;
    maxAttempts: number;
  }) {
    const interaction = await getAcceptedPlanApprovalInteractionForRun(
      input.run,
      input.issueId,
    );
    if (!interaction || !input.issueId) return null;

    const issue = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.run.companyId),
          eq(issues.id, input.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) return null;
    if (
      issue.status !== "todo" &&
      issue.status !== "in_progress" &&
      issue.status !== "in_review"
    )
      return null;

    const body = buildPlanApprovalResumeFailureComment({
      run: input.run,
      status: "needs_attention",
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
    });
    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: issue.status,
      latestRun: input.run,
      comment: body,
    });
    await addPlanApprovalResumeFailureCommentOnce({
      issueId: issue.id,
      run: input.run,
      body,
    });

    const recoveryActionId = await getActiveRecoveryActionId(
      issue.companyId,
      issue.id,
    );
    await updatePlanApprovalInteractionResumeFailure({
      interaction,
      failure: buildPlanApprovalResumeFailureResult({
        run: input.run,
        status: "needs_attention",
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        recoveryActionId,
      }),
    });
    return interaction.id;
  }

  async function completeSkillTestRunForHeartbeatOutcome(input: {
    run: typeof heartbeatRuns.$inferSelect;
    issueId: string | null;
    issueWorkMode?: string | null;
    outcome: RunSessionOutcome;
    error: string | null;
  }) {
    const completion = resolveSkillTestRunCompletionForHeartbeatOutcome(
      input.outcome,
      input.error,
    );
    if (!completion || !input.issueId) return null;

    let isSkillTestIssue = input.issueWorkMode === "skill_test";
    if (!isSkillTestIssue && input.issueWorkMode === undefined) {
      const issueRow = await db
        .select({
          workMode: issues.workMode,
          harnessKind: issues.harnessKind,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.run.companyId),
            eq(issues.id, input.issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      isSkillTestIssue =
        issueRow?.workMode === "skill_test" ||
        issueRow?.harnessKind === "skill_test";
    }
    if (!isSkillTestIssue) return null;

    const existingRun = await db
      .select({
        id: companySkillTestRuns.id,
        status: companySkillTestRuns.status,
      })
      .from(companySkillTestRuns)
      .where(
        and(
          eq(companySkillTestRuns.companyId, input.run.companyId),
          eq(companySkillTestRuns.issueId, input.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (
      !existingRun ||
      ["succeeded", "failed", "cancelled"].includes(existingRun.status)
    )
      return null;

    const completedRun = await companySkills.completeTestRunForIssue({
      companyId: input.run.companyId,
      issueId: input.issueId,
      outcome: completion.outcome,
      error: completion.error,
    });
    if (!completedRun) return null;

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "heartbeat_finalize",
      agentId: input.run.agentId,
      runId: input.run.id,
      action: "company.skill_test_run_completed",
      entityType: "company_skill_test_run",
      entityId: completedRun.id,
      issueId: input.issueId,
      details: {
        issueId: input.issueId,
        status: completedRun.status,
        outputDocumentKey: completedRun.outputDocumentKey,
        heartbeatOutcome: completion.heartbeatOutcome,
        source: "heartbeat.run_finalized",
      },
    });

    return completedRun;
  }

  async function recordCurrentHeartbeatRunRuntimeProgress(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "agentId" | "status" | "contextSnapshot"
    >,
    update: RuntimeStatusUpdate,
    issueId: string | null,
  ) {
    if (!isHeartbeatRunRuntimeStatusActive(run.status)) {
      clearHeartbeatRunRuntimeStatus(run.id);
      return null;
    }

    const currentRun = await getRun(run.id);
    if (!currentRun || !isHeartbeatRunRuntimeStatusActive(currentRun.status)) {
      clearHeartbeatRunRuntimeStatus(run.id);
      return null;
    }

    return recordHeartbeatRunRuntimeProgress(currentRun, update, issueId);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const previousStatus = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    if (previousStatus && patch?.resultJson !== undefined) patch = { ...patch,
      resultJson: preserveWorkspaceRestoreRecoveryMetadata(previousStatus.resultJson, patch.resultJson),
    };

    // Preserve the receipt-source fence when finalization enriches usage. A
    // late spool replay must still be able to complete an unfinished receipt.
    if (patch?.usageJson && previousStatus?.usageJson) patch = { ...patch, usageJson: { ...previousStatus.usageJson, ...patch.usageJson } };

    // Cancelling a queued run that never acquired provider execution is
    // positive bootstrap evidence. It must not hold unrelated queued messages.
    if (previousStatus && (status === "cancelled" || status === "interrupted")) {
      patch = { ...patch, resultJson: cancellationResultJson(previousStatus, status, patch?.resultJson, patch?.errorCode, patch?.error) };
    }
    if (
      status === "cancelled" &&
      previousStatus?.status === "queued" &&
      previousStatus.runtimeMode !== "native" &&
      !previousStatus.startedAt &&
      !previousStatus.processPid
    ) {
      patch = {
        ...patch,
        resultJson: {
          ...previousStatus.resultJson,
          ...patch?.resultJson,
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
      };
    }
    const updated =
      previousStatus && previousStatus.runtimeMode === "legacy" && isHeartbeatRunTerminalStatus(status)
        ? await terminalizeLegacyExecution({
            db,
            run: previousStatus,
            status,
            patch,
            reconcileIfNeeded: true,
          })
        : await db
            .update(heartbeatRuns)
            .set({
              status,
              ...patch,
              executionStatusDeliveryId: randomUUID(),
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, runId))
            .returning()
            .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: buildHeartbeatRunStatusLiveEventPayload(updated),
      });
      publishRunLifecyclePluginEvent(updated);
      emitTerminalAgentTaskRun(updated, previousStatus?.status ?? null);
    }

    return updated;
  }

  async function setRunStatusIfRunning(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    failureReport?: RunFailureReportOptions,
  ) {
    return setRunStatusFromLive(runId, status, ["running"], patch, failureReport);
  }

  // Move a run to a new status only when its current status is one of
  // `fromStatuses`. The compare-and-set is a single conditional update, so a
  // concurrent path can win the race. When this update matches nothing, the
  // function reads the current row and reports updated=false, so the caller can
  // keep the terminal outcome that another path already wrote.
  async function setRunStatusFromLive(
    runId: string,
    status: string,
    fromStatuses: string[],
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    failureReport?: RunFailureReportOptions,
    cancellationCondition?: ReturnType<typeof nativeRetryCancellationCommitCondition>,
  ) {
    // fromStatuses can name a terminal status as its own source (for example,
    // an idempotent "still failed" patch), so the write below is not always a
    // genuine transition. Read the pre-write status to tell the two apart.
    const previous = await db
      .select({ run: heartbeatRuns, rowVersion: sql<string>`${heartbeatRuns}.xmin::text` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const previousStatus = previous?.run ?? null;

    if (previousStatus && (status === "cancelled" || status === "interrupted")) {
      patch = { ...patch, resultJson: cancellationResultJson(previousStatus, status, patch?.resultJson, patch?.errorCode, patch?.error) };
    }

    if (previousStatus && patch?.resultJson !== undefined) patch = { ...patch,
      resultJson: preserveWorkspaceRestoreRecoveryMetadata(previousStatus.resultJson, patch.resultJson),
    };

    // Preserve the receipt-source fence when finalization enriches usage. A
    // late spool replay must still be able to complete an unfinished receipt.
    if (patch?.usageJson && previousStatus?.usageJson) patch = { ...patch, usageJson: { ...previousStatus.usageJson, ...patch.usageJson } };

    // Cancelling a queued run that never acquired provider execution is
    // positive bootstrap evidence. It must not hold unrelated queued messages.
    if (
      status === "cancelled" &&
      previousStatus?.status === "queued" &&
      previousStatus.runtimeMode !== "native" &&
      !previousStatus.startedAt &&
      !previousStatus.processPid
    ) {
      patch = {
        ...patch,
        resultJson: {
          ...previousStatus.resultJson,
          ...patch?.resultJson,
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
      };
    }
    const updated =
      previousStatus && previousStatus.runtimeMode === "legacy" && isHeartbeatRunTerminalStatus(status)
        ? await terminalizeLegacyExecution({
            db,
            run: previousStatus,
            status,
            patch,
            fromStatuses,
            reconcileIfNeeded: true,
            writeConditions: [nativeRunnerOwnershipNotHeldCondition(), ...(cancellationCondition ? [cancellationCondition] : [])],
          })
        : await db
            .update(heartbeatRuns)
            .set({
              status,
              ...patch,
              executionStatusDeliveryId: randomUUID(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(heartbeatRuns.id, runId),
                inArray(heartbeatRuns.status, fromStatuses),
                // A result can commit after the orphan candidate was read.
                // Reject that stale process-loss transition before reporting,
                // issue promotion, or release of the unfinished source lease.
                ...(status === "failed" && patch?.errorCode === "process_lost"
                  ? [
                    not(pendingNativeWorkspaceFinalizationCondition(db)),
                    // Result publication locks and updates this heartbeat in
                    // its transaction. If this UPDATE waited behind it, the
                    // joined tables can still use the older statement snapshot;
                    // the exact tuple fence also rejects that blocked writer.
                    sql`${heartbeatRuns}.xmin::text = ${previous?.rowVersion ?? null}`,
                  ]
                  : []),
                ...(cancellationCondition ? [cancellationCondition] : []),
                ...(isHeartbeatRunTerminalStatus(status)
                  ? [nativeRunnerOwnershipNotHeldCondition()]
                  : []),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null)
            .catch((error: unknown) => {
              if (cancellationCondition) rethrowNativeCancellationLockConflict(error);
              throw error;
            });

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: buildHeartbeatRunStatusLiveEventPayload(updated),
      });
      publishRunLifecyclePluginEvent(updated);
      emitTerminalAgentTaskRun(updated, previousStatus?.status ?? null, failureReport);
      return { run: updated, updated: true as const };
    }

    const current = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    return { run: current, updated: false as const };
  }

  // Invariant: when a run releases its environment lease, the run row must be
  // terminal. The finalizer writes the terminal status in a step that is
  // separate from the agent status=done PATCH. If the sandbox or the run
  // process stops between the two steps, heartbeat_runs.status stays "running".
  // The UI reads liveness from that row, so a finished task shows "Live"
  // forever. This function closes the gap in the run teardown: when the run is
  // still running or queued, it forces a terminal status before the lease is
  // released. It never overwrites a status that another path already made
  // terminal.
  async function terminalizeRunOnLeaseRelease(
    run: typeof heartbeatRuns.$inferSelect,
  ): Promise<typeof heartbeatRuns.$inferSelect> {
    if (isNativeRunnerOwnershipHeld(run)) return run;
    if (isHeartbeatRunTerminalStatus(run.status)) return run;
    if (run.status !== "running" && run.status !== "queued") return run;

    // Choose the terminal status that reflects the true outcome. When the issue
    // already reached a terminal status, the run reached its goal, so use the
    // matching terminal run status. Otherwise the teardown cut the run short,
    // so use "interrupted".
    const issueId = readNonEmptyString(
      parseObject(run.contextSnapshot).issueId,
    );
    let terminalStatus: "succeeded" | "cancelled" | "interrupted" =
      "interrupted";
    if (issueId) {
      const issueStatus = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]?.status ?? null);
      if (issueStatus === "done") terminalStatus = "succeeded";
      else if (issueStatus === "cancelled") terminalStatus = "cancelled";
    }

    // Teardown can beat the cancellation finalizer. Preserve the acknowledged
    // user intent instead of reporting an infrastructure interruption.
    if (hasAcknowledgedNativeStopIntent(run) || hasAcknowledgedNativeReassignmentStopIntent(run)) terminalStatus = "cancelled";

    const message = `run terminalized on environment lease release: heartbeat_runs.status was still ${run.status} at teardown`;
    // Match both "running" and "queued". A queued run has released its lease but
    // never reached "running", so a running-only update would miss it and leave
    // a phantom live run behind.
    const write = await setRunStatusFromLive(
      run.id,
      terminalStatus,
      ["running", "queued"],
      {
        finishedAt: run.finishedAt ?? new Date(),
        error: run.error ?? (terminalStatus === "interrupted" ? message : null),
        errorCode:
          run.errorCode ??
          (terminalStatus === "interrupted"
            ? "lease_released_before_terminal"
            : null),
      },
    );
    if (!write.updated) {
      // Another path already finalized the run. Keep that terminal outcome.
      return write.run ?? run;
    }

    const terminalRun = write.run;
    if (terminalRun) {
      await appendRunEvent(terminalRun, {
        eventType: "lifecycle",
        stream: "system",
        level: terminalStatus === "interrupted" ? "warn" : "info",
        message,
        payload: {
          previousStatus: run.status,
          terminalStatus,
          reason: "environment_lease_release",
          ...(issueId ? { issueId } : {}),
        },
      }).catch((eventErr) => {
        logger.warn(
          { err: eventErr, runId: run.id },
          "failed to append run event for lease-release terminalization",
        );
      });
    }
    return terminalRun ?? run;
  }

  function publishRunLifecyclePluginEvent(
    run: typeof heartbeatRuns.$inferSelect,
  ) {
    publishRunLifecyclePluginEventData({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail,
      error: run.error,
      errorCode: run.errorCode,
      issueId: readNonEmptyString(parseObject(run.contextSnapshot).issueId),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  }

  function publishRunLifecyclePluginEventData(run: {
    companyId: string;
    runId: string;
    agentId: string;
    status: string;
    invocationSource: string;
    triggerDetail: string | null;
    error: string | null;
    errorCode: string | null;
    issueId: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  }) {
    const eventType =
      run.status === "running"
        ? "agent.run.started"
        : run.status === "succeeded"
          ? "agent.run.finished"
          : run.status === "failed" || run.status === "timed_out"
            ? "agent.run.failed"
            : run.status === "cancelled"
              ? "agent.run.cancelled"
              : null;
    if (!eventType) return;
    publishPluginDomainEvent({
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date().toISOString(),
      actorId: run.agentId,
      actorType: "agent",
      entityId: run.runId,
      entityType: "heartbeat_run",
      companyId: run.companyId,
      payload: {
        runId: run.runId,
        agentId: run.agentId,
        status: run.status,
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
        error: run.error ?? null,
        errorCode: run.errorCode ?? null,
        issueId: run.issueId,
        startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
        finishedAt: run.finishedAt
          ? new Date(run.finishedAt).toISOString()
          : null,
      },
    });
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      // Reassignment revokes requests transactionally. Late execution settlement
      // must not turn a revoked request back into authority for a later retry.
      .where(and(eq(agentWakeupRequests.id, wakeupRequestId), ne(agentWakeupRequests.status, "cancelled")));
  }

  async function addContinuationExhaustedCommentOnce(input: {
    run: typeof heartbeatRuns.$inferSelect;
    issueId: string;
    comment: string;
  }) {
    const existing = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.run.companyId),
          eq(issueComments.issueId, input.issueId),
          eq(issueComments.createdByRunId, input.run.id),
          sql`${issueComments.body} like 'Bounded liveness continuation exhausted%'`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return;
    await issuesSvc.addComment(input.issueId, input.comment, {
      agentId: input.run.agentId,
      runId: input.run.id,
    });
  }

  async function handleRunLivenessContinuation(
    run: typeof heartbeatRuns.$inferSelect,
  ) {
    const context = parseObject(run.contextSnapshot);
    if (
      readNonEmptyString(context.goalControlRequestId) ||
      context.resumeSessionGoalHeartbeat === true
    )
      return;
    const livenessState = run.livenessState as RunLivenessState | null;
    if (livenessState !== "plan_only" && livenessState !== "empty_response")
      return;

    const issueId = readNonEmptyString(context.issueId);
    if (!issueId) return;
    const waitingContext = await getIssueExecutionContext(run.companyId, issueId);
    if (isWaitingConversation(waitingContext) || waitingContext?.externalConversationState === "waiting") return;

    const [issue, agent] = await Promise.all([
      db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          executionState: issues.executionState,
          projectId: issues.projectId,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .then((rows) => rows[0] ?? null),
    ]);

    const budgetBlock =
      issue && agent
        ? await budgets.getInvocationBlock(issue.companyId, agent.id, {
            issueId: issue.id,
            projectId: issue.projectId,
          })
        : null;

    const nextAttempt = readContinuationAttempt(run.continuationAttempt) + 1;
    const idempotencyKey = issue
      ? buildRunLivenessContinuationIdempotencyKey({
          issueId: issue.id,
          sourceRunId: run.id,
          livenessState,
          nextAttempt,
        })
      : null;
    const existingWake = idempotencyKey
      ? await findExistingRunLivenessContinuationWake(db, {
          companyId: run.companyId,
          idempotencyKey,
        })
      : null;

    const decision = decideRunLivenessContinuation({
      run,
      issue,
      agent,
      livenessState,
      livenessReason: run.livenessReason,
      nextAction: run.nextAction,
      budgetBlocked: Boolean(budgetBlock),
      idempotentWakeExists: Boolean(existingWake),
    });

    if (decision.kind === "exhausted") {
      await setRunStatus(run.id, run.status, {
        livenessReason: `${run.livenessReason ?? "Run ended without concrete progress"}; continuation attempts exhausted`,
      });
      await addContinuationExhaustedCommentOnce({
        run,
        issueId,
        comment: decision.comment,
      });
      return;
    }

    if (decision.kind !== "enqueue") return;

    const continuationRun = await enqueueWakeup(run.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: RUN_LIVENESS_CONTINUATION_REASON,
      payload: decision.payload,
      contextSnapshot: {
        ...decision.contextSnapshot,
        originIdentityContextId: null,
        parentRunId: run.id,
      },
      idempotencyKey: decision.idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    if (continuationRun) {
      await db
        .update(heartbeatRuns)
        .set({
          continuationAttempt: decision.nextAttempt,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
  }

  function issueUiLink(
    issue: Pick<typeof issues.$inferSelect, "id" | "identifier">,
  ) {
    const label = issue.identifier ?? issue.id;
    const prefix = issue.identifier?.split("-")[0] || "PAP";
    return `[${label}](/${prefix}/issues/${label})`;
  }

  function hasUnmanagedBackgroundTaskEvidence(
    resultJson: Record<string, unknown> | null | undefined,
  ) {
    const evidence = parseObject(resultJson?.unmanagedBackgroundTask);
    return (
      evidence.stopped === true &&
      (evidence.stopReason === UNMANAGED_BACKGROUND_TASK_STOP_REASON ||
        evidence.reason === UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON)
    );
  }

  function withUnmanagedBackgroundTaskStopReason(
    resultJson: Record<string, unknown> | null | undefined,
  ) {
    return {
      ...(resultJson ?? {}),
      stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
    };
  }

  function buildDetectedSuccessfulRunProgressSummary(
    run: typeof heartbeatRuns.$inferSelect,
    currentUserRedactionOptions: CurrentUserRedactionOptions,
  ) {
    const resultJson = parseObject(run.resultJson);
    const candidates = [
      hasUnmanagedBackgroundTaskEvidence(resultJson)
        ? UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON
        : null,
      readNonEmptyString(run.nextAction)
        ? `Next action noted: ${readNonEmptyString(run.nextAction)}`
        : null,
      readNonEmptyString(run.livenessReason),
      readNonEmptyString(resultJson.summary),
      readNonEmptyString(resultJson.result),
      readNonEmptyString(resultJson.message),
    ].filter((value): value is string => Boolean(value));
    const summary = candidates[0];
    if (!summary) return null;
    return redactDetectedSuccessfulRunProgressSummaryForBoard(
      summary,
      currentUserRedactionOptions,
    );
  }

  async function addSuccessfulRunHandoffCommentOnce(input: {
    issue: Pick<
      typeof issues.$inferSelect,
      "id" | "identifier" | "title" | "status"
    >;
    run: typeof heartbeatRuns.$inferSelect;
    agent: Pick<typeof agents.$inferSelect, "id" | "name">;
    detectedProgressSummary: string;
  }) {
    const existing = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.run.companyId),
          eq(issueComments.issueId, input.issue.id),
          eq(issueComments.createdByRunId, input.run.id),
          sql`(${issueComments.body} = ${SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY} or ${issueComments.body} like '## This issue still needs a next step%' or ${issueComments.body} like '## Successful run missing issue disposition%')`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return null;
    const notice = buildSuccessfulRunHandoffRequiredNotice(input);
    return issuesSvc.addComment(
      input.issue.id,
      notice.body,
      { runId: input.run.id },
      {
        authorType: "system",
        presentation: notice.presentation,
        metadata: notice.metadata,
      },
    );
  }

  async function handleSuccessfulRunHandoff(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    if (run.status !== "succeeded") return;
    const context = parseObject(run.contextSnapshot);
    const issueId =
      readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
    if (!issueId) return;
    const waitingContext = await getIssueExecutionContext(run.companyId, issueId);
    if (isWaitingConversation(waitingContext) || waitingContext?.externalConversationState === "waiting") return;
    if (
      readNonEmptyString(context.goalControlRequestId) ||
      context.resumeSessionGoalHeartbeat === true
    ) {
      const goalProjection = await runnerGoalService(db).projection(
        run.companyId,
        issueId,
        run.agentId,
      );
      if (goalProjection?.goal?.status !== "complete") return;
    }

    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        projectId: issues.projectId,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .then((rows) => rows[0] ?? null);
    const idempotencyKey = issue
      ? buildFinishSuccessfulRunHandoffIdempotencyKey({
          issueId: issue.id,
          sourceRunId: run.id,
        })
      : null;
    const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const detectedProgressSummary = buildDetectedSuccessfulRunProgressSummary(
      run,
      currentUserRedactionOptions,
    );
    const resultJson = parseObject(run.resultJson);
    const finalReport = redactSuccessfulRunHandoffEvidence(
      [
        readNonEmptyString(resultJson.summary),
        readNonEmptyString(resultJson.result),
        readNonEmptyString(resultJson.message),
      ].find((value): value is string => Boolean(value)) ?? null,
      currentUserRedactionOptions,
    );
    const nextAction = redactSuccessfulRunHandoffEvidence(
      readNonEmptyString(run.nextAction),
      currentUserRedactionOptions,
    );

    const [
      activeExecutionPath,
      queuedWake,
      pendingInteraction,
      pendingApproval,
      explicitBlocker,
      openRecoveryIssue,
      existingWake,
      budgetBlock,
      pauseHold,
      activeRoutineContinuation,
      armedWatchdog,
    ] = await Promise.all([
      issue
        ? db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                eq(heartbeatRuns.agentId, run.agentId),
                inArray(heartbeatRuns.status, [
                  ...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
                ]),
                sql`(
                ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}
                or ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}
              )`,
                sql`${heartbeatRuns.id} <> ${run.id}`,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      issue
        ? db
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, issue.companyId),
                eq(agentWakeupRequests.agentId, run.agentId),
                inArray(agentWakeupRequests.status, [
                  "queued",
                  "deferred_issue_execution",
                  "claimed",
                ]),
                sql`(
                ${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}
                or ${agentWakeupRequests.payload} ->> 'taskId' = ${issue.id}
                or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${issue.id}
                or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId' = ${issue.id}
              )`,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      issue
        ? db
            .select({ id: issueThreadInteractions.id })
            .from(issueThreadInteractions)
            .where(
              and(
                eq(issueThreadInteractions.companyId, issue.companyId),
                eq(issueThreadInteractions.issueId, issue.id),
                eq(issueThreadInteractions.status, "pending"),
                activeIssueInteractionCondition({ runId: run.id }),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      issue
        ? db
            .select({ id: issueApprovals.approvalId })
            .from(issueApprovals)
            .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
            .where(
              and(
                eq(issueApprovals.companyId, issue.companyId),
                eq(issueApprovals.issueId, issue.id),
                inArray(approvals.status, ["pending", "revision_requested"]),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      issue
        ? db
            .select({ id: issueRelations.issueId })
            .from(issueRelations)
            .where(
              and(
                eq(issueRelations.companyId, issue.companyId),
                eq(issueRelations.relatedIssueId, issue.id),
                eq(issueRelations.type, "blocks"),
                sql`exists (
                select 1
                from issues blocker
                where blocker.id = ${issueRelations.issueId}
                  and blocker.company_id = ${issue.companyId}
                  and blocker.status not in ('done', 'cancelled')
                  and blocker.hidden_at is null
              )`,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      issue
        ? db
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, issue.companyId),
                inArray(issues.originKind, [
                  RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
                  RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
                ]),
                eq(issues.originId, issue.id),
                visibleIssueCondition(),
                notInArray(issues.status, ["done", "cancelled"]),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      idempotencyKey
        ? findExistingFinishSuccessfulRunHandoffWake(db, {
            companyId: run.companyId,
            idempotencyKey,
          })
        : Promise.resolve(null),
      issue
        ? budgets.getInvocationBlock(issue.companyId, run.agentId, {
            issueId: issue.id,
            projectId: issue.projectId,
          })
        : Promise.resolve(null),
      issue
        ? treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id)
        : Promise.resolve(null),
      issue
        ? db
            .select({ id: routines.id })
            .from(routines)
            .where(
              and(
                eq(routines.companyId, issue.companyId),
                eq(routines.parentIssueId, issue.id),
                eq(routines.status, "active"),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      issue
        ? hasArmedInvokableIssueWatchdog(db, issue)
        : Promise.resolve(false),
    ]);

    const decision = decideSuccessfulRunHandoff({
      run,
      issue,
      agent,
      livenessState: run.livenessState as RunLivenessState | null,
      detectedProgressSummary,
      finalReport,
      nextAction,
      taskKey,
      hasActiveExecutionPath: Boolean(activeExecutionPath),
      hasQueuedWake: Boolean(queuedWake),
      hasPendingInteractionOrApproval: Boolean(
        pendingInteraction || pendingApproval,
      ),
      hasPersistedMonitor: Boolean(issue?.monitorNextCheckAt),
      hasArmedWatchdog: armedWatchdog,
      hasExplicitBlockerPath: Boolean(explicitBlocker),
      hasOpenRecoveryIssue: Boolean(openRecoveryIssue),
      hasPauseHold: Boolean(pauseHold),
      hasActiveRoutineContinuation: Boolean(activeRoutineContinuation),
      budgetBlocked: Boolean(budgetBlock),
      idempotentWakeExists: Boolean(existingWake),
    });

    if (isSuccessfulRunHandoffValidPathSkip(decision) && issue) {
      await resolveRequiredSuccessfulRunHandoffOnValidPath(db, {
        companyId: issue.companyId,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        agentId: run.agentId,
        runId: run.id,
        skipReason: decision.reason,
      });
    }

    if (decision.kind !== "enqueue" || !issue) return;

    if (hasUnmanagedBackgroundTaskEvidence(parseObject(run.resultJson))) {
      await db
        .update(heartbeatRuns)
        .set({
          livenessReason: UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
          resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
            ${JSON.stringify({ stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }

    const handoffRun = await enqueueWakeup(decision.targetAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
      payload: decision.payload,
      contextSnapshot: {
        ...decision.contextSnapshot,
        originIdentityContextId: null,
        parentRunId: run.id,
      },
      idempotencyKey: decision.idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });
    if (!handoffRun) return;

    await addSuccessfulRunHandoffCommentOnce({
      issue,
      run,
      agent,
      detectedProgressSummary:
        detectedProgressSummary ??
        "The run reported progress, but did not choose a next step.",
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "heartbeat",
      agentId: run.agentId,
      runId: run.id,
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issue.id,
      details: {
        label: "Successful run missing issue disposition",
        sourceRunId: run.id,
        correctiveRunId: handoffRun.id,
        handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
        missingDisposition: "clear_next_step",
        detectedProgressSummary,
        issue: issueUiLink(issue),
      },
    });
  }

  async function handleIssueReviewPathDisposition(
    run: typeof heartbeatRuns.$inferSelect,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    if (readNonEmptyString(contextSnapshot.goalControlRequestId)) return;
    const issueId =
      readNonEmptyString(contextSnapshot.issueId) ??
      readNonEmptyString(contextSnapshot.taskId);
    if (!issueId) return;
    const waitingContext = await getIssueExecutionContext(run.companyId, issueId);
    if (isWaitingConversation(waitingContext) || waitingContext?.externalConversationState === "waiting") return;

    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.status !== "in_review" || !issue.assigneeAgentId)
      return;

    const reviewAttention = await issuesSvc
      .listReviewAttention(issue.companyId, [issue])
      .then(
        (map) =>
          map.get(issue.id) ?? {
            state: "none" as const,
            paths: [],
            reason: null,
          },
      );
    if (reviewAttention.state !== "stalled") return;

    const consumedPathRef = reviewPathConsumedRefFromRun({
      runId: run.id,
      issueId: issue.id,
      contextSnapshot,
    });
    const idempotencyKey = buildIssueReviewPathLostIdempotencyKey({
      issueId: issue.id,
      consumedPathRef,
    });
    const existingWake = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, issue.companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
          notInArray(agentWakeupRequests.status, ["skipped"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const decision = decideIssueReviewPathRecovery({
      issueId: issue.id,
      sourceRunId: run.id,
      assigneeAgentId: issue.assigneeAgentId,
      contextSnapshot,
      reviewAttention,
      existingWake: Boolean(existingWake),
    });
    if (decision.kind !== "enqueue") return;

    const recoveryRun = await enqueueWakeup(issue.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
      idempotencyKey: decision.idempotencyKey,
      payload: decision.payload,
      contextSnapshot: decision.contextSnapshot,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    }).catch((error: unknown) => {
      if (isReviewPathRecoveryIdempotencyConflict(error)) return null;
      throw error;
    });
    if (!recoveryRun) return;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "heartbeat",
      agentId: issue.assigneeAgentId,
      runId: run.id,
      action: "issue.review_path_recovery_queued",
      entityType: "issue",
      entityId: issue.id,
      details: {
        sourceRunId: run.id,
        recoveryRunId: recoveryRun.id,
        consumedPathRef,
        recoveryAttempt: 1,
        maxRecoveryAttempts: 1,
      },
    });
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
      retryExhaustion?: AppendHeartbeatRunEventInput["retryExhaustion"];
    },
  ) {
    const eventAt = new Date();
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactSensitiveText(
          redactCurrentUserText(event.message, currentUserRedactionOptions),
        )
      : event.message;
    const boundedPayload = event.payload
      ? boundHeartbeatRunEventPayloadForStorage(event.payload)
      : event.payload;
    const secretSanitizedPayload = boundedPayload
      ? redactEventPayload(boundedPayload)
      : boundedPayload;
    const sanitizedPayload = secretSanitizedPayload
      ? redactCurrentUserValue(
          secretSanitizedPayload,
          currentUserRedactionOptions,
        )
      : secretSanitizedPayload;
    const issueId = readRuntimeStatusIssueIdCandidate(run) ?? null;
    const progress = buildRunEventRuntimeProgress({
      eventType: event.eventType,
      message: sanitizedMessage ?? null,
      payload: sanitizedPayload ?? null,
      at: eventAt,
    });
    const persistedEvent = await appendHeartbeatRunEvent(db, {
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
      retryExhaustion: event.retryExhaustion,
    });
    if (persistedEvent.disposition === "duplicate") return;
    const seq = persistedEvent.row.seq;

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        issueId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        currentToolName: progress?.currentToolName ?? null,
        lastAssistantSnippet: progress?.lastAssistantSnippet ?? null,
        lastEventAt: (progress?.lastEventAt ?? eventAt).toISOString(),
        payload: sanitizedPayload ?? null,
      },
    });
    if (progress && isHeartbeatRunRuntimeStatusActive(run.status)) {
      const status = setHeartbeatRunRuntimeStatus({
        companyId: run.companyId,
        issueId,
        agentId: run.agentId,
        runId: run.id,
        phase: progress.phase,
        message: progress.message,
        updatedAt: eventAt,
        currentToolName: progress.currentToolName,
        lastAssistantSnippet: progress.lastAssistantSnippet,
        lastEventAt: progress.lastEventAt,
      });
      if (status) publishHeartbeatRunRuntimeProgress(status);
    }
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; processGroupId: number | null; startedAt: string; targetKind?: "local" | "remote" },
  ) {
    return persistHeartbeatRunProcessMetadata(db, runId, meta);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.status, "running"),
          eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message:
        "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function patchRunIssueCommentStatus(
    runId: string,
    patch: Partial<
      Pick<
        typeof heartbeatRuns.$inferInsert,
        | "issueCommentStatus"
        | "issueCommentSatisfiedByCommentId"
        | "issueCommentRetryQueuedAt"
      >
    >,
  ) {
    return db
      .update(heartbeatRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function findRunIssueComment(
    runId: string,
    companyId: string,
    issueId: string,
    resultJson?: Record<string, unknown> | null,
  ) {
    const comments = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.createdByRunId, runId),
        ),
      )
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id));
    return findHeartbeatRunCompletionComment(comments, resultJson);
  }

  async function findLatestCompletedFinalAgentMessage(
    runId: string,
    companyId: string,
  ) {
    const rows = await db
      .select({
        seq: heartbeatRunEvents.seq,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.companyId, companyId),
          eq(heartbeatRunEvents.runId, runId),
          eq(heartbeatRunEvents.eventType, "item.completed"),
        ),
      )
      .orderBy(desc(heartbeatRunEvents.seq))
      .limit(200);
    const candidates: Array<{
      seq: number;
      text: string;
      sourceEventId: string | null;
      channel: "final" | "unknown";
    }> = [];
    for (const row of rows) {
      const prpEvent = parseObject(parseObject(row.payload).prpEvent);
      const candidate = readCompletedAssistantMessageCandidate({
        seq: row.seq,
        prpEvent,
      });
      if (candidate) candidates.push(candidate);
    }
    const recoveryBoundary = await db
      .select({
        seq: heartbeatRunEvents.seq,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.companyId, companyId),
          eq(heartbeatRunEvents.runId, runId),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
        ),
      )
      .orderBy(heartbeatRunEvents.seq)
      .limit(200)
      .then(
        (lifecycleRows) =>
          lifecycleRows.find(
            (row) =>
              parseObject(row.payload).retryReasonCode ===
              "semantic_result_missing",
          )?.seq ?? null,
      );
    return selectHeartbeatRunFinalAgentMessage({
      candidates,
      semanticResultRecoveryAfterSeq: recoveryBoundary,
    });
  }

  async function refreshContinuationSummaryForRun(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    if (!issueId) return null;
    try {
      return await refreshIssueContinuationSummary({
        db,
        issueId,
        run: {
          id: run.id,
          status: run.status,
          error: run.error,
          errorCode: run.errorCode,
          resultJson: run.resultJson as Record<string, unknown> | null,
          stdoutExcerpt: run.stdoutExcerpt,
          stderrExcerpt: run.stderrExcerpt,
          finishedAt: run.finishedAt,
        },
        agent: {
          id: agent.id,
          name: agent.name,
          adapterType: agent.adapterType,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          runId: run.id,
          issueId,
          agentId: agent.id,
        },
        "failed to refresh issue continuation summary",
      );
      return null;
    }
  }

  async function enqueueMissingIssueCommentRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    issueId: string,
  ) {
    const invokability = await getAgentInvokability(agent);
    if (!invokability.invokable) {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message:
          "Missing-comment retry suppressed because the agent is not invokable",
        payload: {
          reason: invokability.reason,
          invalidOrgChain: invokability.invalidOrgChain,
          ...invokability.details,
        },
      });
      return null;
    }

    const contextSnapshot = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const retryContextSnapshot = withRecoveryContext(
      {
        ...contextSnapshot,
        retryOfRunId: run.id,
        wakeReason: "missing_issue_comment",
        retryReason: "missing_issue_comment",
        missingIssueCommentForRunId: run.id,
      },
      "status_only",
    );
    const responsibleUserId = await resolveResponsibleUserIdForRunContext(
      run,
      retryContextSnapshot,
    );
    const now = new Date();

    const retryRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, run.companyId),
            eq(issues.executionRunId, run.id),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!issue) return null;

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "missing_issue_comment",
          payload: withRecoveryContext(
            {
              issueId,
              retryOfRunId: run.id,
              retryReason: "missing_issue_comment",
            },
            "status_only",
          ),
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const queuedRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          scopeKind: "issue",
          issueId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          responsibleUserId,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          issueCommentStatus: "not_applicable",
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: queuedRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      await tx
        .update(issues)
        .set({
          executionRunId: queuedRun.id,
          executionAgentNameKey: normalizeAgentNameKey(agent.name),
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(eq(issues.id, issue.id));

      await tx
        .update(heartbeatRuns)
        .set({
          issueCommentStatus: "retry_queued",
          issueCommentRetryQueuedAt: now,
          updatedAt: now,
        })
        .where(eq(heartbeatRuns.id, run.id));

      return queuedRun;
    });

    if (!retryRun) return null;

    publishLiveEvent({
      companyId: retryRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: retryRun.id,
        agentId: retryRun.agentId,
        invocationSource: retryRun.invocationSource,
        triggerDetail: retryRun.triggerDetail,
        wakeupRequestId: retryRun.wakeupRequestId,
      },
    });

    return retryRun;
  }

  async function hasDeferredIssueCommentWake(
    companyId: string,
    issueId: string,
    agentId: string,
  ) {
    const deferredPayloads = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      );

    return deferredPayloads.some(({ payload }) => {
      const parsedPayload = parseObject(payload);
      const deferredContext = parseObject(
        parsedPayload[DEFERRED_WAKE_CONTEXT_KEY],
      );
      return Boolean(deriveCommentId(deferredContext, parsedPayload));
    });
  }

  async function finalizeIssueCommentPolicy(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    presentationDecision?: RunPresentationDecision | null,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    // The explicit receipt admitted one turn. A prose-only follow-up cannot
    // reuse it or renew it under the separate transient-failure retry policy.
    if (readNonEmptyString(contextSnapshot.goalControlRequestId) || contextSnapshot.explicitUserContinuation) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    if (!issueId) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    // A failed/timed-out/cancelled run may immediately enqueue the normal
    // assignment or continuation recovery below. Do not let the lower-priority
    // status-only missing-comment wake claim the issue first. The dedicated
    // missing-comment retry still records exhaustion if that retry itself
    // fails, but an original failed execution remains on the established
    // direct-adapter recovery path.
    if (
      run.status !== "succeeded" &&
      readNonEmptyString(contextSnapshot.retryReason) !==
        "missing_issue_comment"
    ) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    // A settled run may legitimately have no user-facing prose. The response
    // resolver owns that decision; do not wake the agent again merely to force
    // an artificial comment into the issue thread.
    if (
      presentationDecision?.chosenSource === "none" &&
      (hasAcceptedSemanticResult(parseObject(run.resultJson)) ||
        presentationDecision.reasonCodes.includes(
          "legacy_adapter_summary_ambiguous",
        ))
    ) {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "not_applicable",
        issueCommentSatisfiedByCommentId: null,
        issueCommentRetryQueuedAt: null,
      });
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    // A pre-dispatch setup failure means the adapter process never started (for
    // example an unresolved workspace base ref). No agent could run, so no agent
    // could post an issue comment. A missing-comment retry cannot help and would
    // loop the identical pre-adapter failure, so mark the policy not_applicable
    // and queue nothing.
    if (
      run.errorCode != null &&
      PRE_ADAPTER_SETUP_FAILURE_CODES.has(run.errorCode)
    ) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    const postedComment = await findRunIssueComment(
      run.id,
      run.companyId,
      issueId,
      parseObject(run.resultJson),
    );
    if (postedComment) {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "satisfied",
        issueCommentSatisfiedByCommentId: postedComment.id,
        issueCommentRetryQueuedAt: null,
      });
      return { outcome: "satisfied" as const, queuedRun: null };
    }

    // Missing-comment recovery is a legacy compatibility path for otherwise
    // successful runs. A failed, timed-out, or cancelled run is already owned
    // by lifecycle recovery and its terminal system presentation. Queuing a
    // prose-only retry here can seize the issue execution lock before the
    // authoritative continuation is materialized, replacing real recovery
    // with a cheap status-only turn.
    if (run.status !== "succeeded") {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "not_applicable",
        issueCommentSatisfiedByCommentId: null,
        issueCommentRetryQueuedAt: null,
      });
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    if (
      readNonEmptyString(contextSnapshot.retryReason) ===
      "missing_issue_comment"
    ) {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "retry_exhausted",
        issueCommentSatisfiedByCommentId: null,
      });
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message:
          "Run ended without an issue comment after one retry; no further comment wake will be queued",
      });
      return { outcome: "retry_exhausted" as const, queuedRun: null };
    }

    if (!shouldRequireIssueCommentForWake(contextSnapshot)) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    if (
      await hasDeferredIssueCommentWake(run.companyId, issueId, run.agentId)
    ) {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "not_applicable",
        issueCommentSatisfiedByCommentId: null,
        issueCommentRetryQueuedAt: null,
      });
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message:
          "Run ended without an issue comment; a deferred comment wake already exists for this issue",
      });
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    const queuedRun = await enqueueMissingIssueCommentRetry(
      run,
      agent,
      issueId,
    );
    if (queuedRun) {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message:
          "Run ended without an issue comment; queued one follow-up wake to require a comment",
      });
      return { outcome: "retry_queued" as const, queuedRun };
    }

    await patchRunIssueCommentStatus(run.id, {
      issueCommentStatus: "retry_exhausted",
      issueCommentSatisfiedByCommentId: null,
    });
    return { outcome: "retry_exhausted" as const, queuedRun: null };
  }

  function parseMaxTurnContinuationPolicy(
    agent: typeof agents.$inferSelect,
  ): MaxTurnContinuationPolicy {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);
    const configured = parseObject(heartbeat.maxTurnContinuation);
    const rawMaxAttempts = Math.floor(
      asNumber(
        configured.maxAttempts,
        MAX_TURN_CONTINUATION_DEFAULT_MAX_ATTEMPTS,
      ),
    );
    const rawDelayMs = Math.floor(
      asNumber(configured.delayMs, MAX_TURN_CONTINUATION_DEFAULT_DELAY_MS),
    );

    return {
      enabled: asBoolean(configured.enabled, true),
      maxAttempts: Math.max(
        0,
        Math.min(MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP, rawMaxAttempts),
      ),
      delayMs: Math.max(
        0,
        Math.min(MAX_TURN_CONTINUATION_MAX_DELAY_MS, rawDelayMs),
      ),
    };
  }

  function mergeRunStopMetadataForAgent(
    agent: Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig">,
    outcome: "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out",
    options?: {
      resultJson?: Record<string, unknown> | null;
      conversationContinuationEligible?: boolean;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ) {
    const stopMetadata = buildHeartbeatRunStopMetadata({
      adapterType: agent.adapterType,
      adapterConfig: parseObject(agent.adapterConfig),
      outcome,
      errorCode: options?.errorCode ?? null,
      errorMessage: options?.errorMessage ?? null,
    });
    const result = mergeHeartbeatRunStopMetadata(
      options?.resultJson ?? null,
      stopMetadata,
    );
    const cancellationAcknowledged =
      parseObject(result?.executionCancellation).state === "acknowledged";
    return options?.conversationContinuationEligible !== false && outcome !== "succeeded" &&
      (outcome !== "cancelled" || cancellationAcknowledged) &&
      isConversationAdapter(agent.adapterType)
      ? { ...result, conversationContinuation: CONVERSATION_CONTINUATION_POLICY }
      : result;
  }

  function countValue(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  function dateValue(value: unknown) {
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  function latestDate(...values: unknown[]) {
    let latest: Date | null = null;
    for (const value of values) {
      const parsed = dateValue(value);
      if (!parsed) continue;
      if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
    }
    return latest;
  }

  async function buildRunLivenessInput(
    run: typeof heartbeatRuns.$inferSelect,
    resultJson: Record<string, unknown> | null | undefined,
  ): Promise<RunLivenessClassificationInput> {
    const context = parseObject(run.contextSnapshot);
    const contextIssueId = readNonEmptyString(context.issueId);
    const continuationAttempt = asNumber(
      context.continuationAttempt,
      run.continuationAttempt ?? 0,
    );

    const issue = contextIssueId
      ? await db
          .select({
            status: issues.status,
            title: issues.title,
            description: issues.description,
            workMode: issues.workMode,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, run.companyId),
              eq(issues.id, contextIssueId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;

    const [commentStats] = contextIssueId
      ? await db
          .select({
            count: sql<number>`count(*)::int`,
            latestAt: sql<Date | null>`max(${issueComments.createdAt})`,
          })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, run.companyId),
              eq(issueComments.issueId, contextIssueId),
              eq(issueComments.createdByRunId, run.id),
              isNull(issueComments.deletedAt),
            ),
          )
      : [{ count: 0, latestAt: null }];

    const issueCommentBodies = contextIssueId
      ? await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, run.companyId),
              eq(issueComments.issueId, contextIssueId),
              eq(issueComments.createdByRunId, run.id),
            ),
          )
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(5)
          .then((rows) => rows.reverse().map((row) => row.body))
      : [];

    const continuationSummary = contextIssueId
      ? await getIssueContinuationSummaryDocument(db, contextIssueId)
      : null;

    const [documentStats] = contextIssueId
      ? await db
          .select({
            count: sql<number>`count(*)::int`,
            planCount: sql<number>`count(*) filter (where ${issueDocuments.key} = 'plan')::int`,
            latestAt: sql<Date | null>`max(${documentRevisions.createdAt})`,
          })
          .from(documentRevisions)
          .innerJoin(
            issueDocuments,
            eq(documentRevisions.documentId, issueDocuments.documentId),
          )
          .where(
            and(
              eq(documentRevisions.companyId, run.companyId),
              eq(documentRevisions.createdByRunId, run.id),
              eq(issueDocuments.companyId, run.companyId),
              eq(issueDocuments.issueId, contextIssueId),
              sql`${issueDocuments.key} != ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`,
            ),
          )
      : [{ count: 0, planCount: 0, latestAt: null }];

    const [workProductStats] = contextIssueId
      ? await db
          .select({
            count: sql<number>`count(*)::int`,
            latestAt: sql<Date | null>`max(${issueWorkProducts.createdAt})`,
          })
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, run.companyId),
              eq(issueWorkProducts.issueId, contextIssueId),
              eq(issueWorkProducts.createdByRunId, run.id),
            ),
          )
      : [{ count: 0, latestAt: null }];

    const [workspaceOperationStats] = await db
      .select({
        count: sql<number>`count(*)::int`,
        latestAt: sql<Date | null>`max(${workspaceOperations.startedAt})`,
      })
      .from(workspaceOperations)
      .where(
        and(
          eq(workspaceOperations.companyId, run.companyId),
          eq(workspaceOperations.heartbeatRunId, run.id),
        ),
      );

    const [activityStats] = await db
      .select({
        count: sql<number>`count(*)::int`,
        latestAt: sql<Date | null>`max(${activityLog.createdAt})`,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, run.companyId),
          eq(activityLog.runId, run.id),
          notInArray(activityLog.action, LIVENESS_BOOKKEEPING_ACTIVITY_ACTIONS),
        ),
      );

    const [eventStats] = await db
      .select({
        count: sql<number>`count(*) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))::int`,
        latestAt: sql<Date | null>`max(${heartbeatRunEvents.createdAt}) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))`,
      })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.companyId, run.companyId),
          eq(heartbeatRunEvents.runId, run.id),
        ),
      );

    return {
      runStatus: run.status,
      issue,
      resultJson: resultJson ?? run.resultJson ?? null,
      issueCommentBodies,
      continuationSummaryBody: continuationSummary?.body ?? null,
      stdoutExcerpt: run.stdoutExcerpt ?? null,
      stderrExcerpt: run.stderrExcerpt ?? null,
      error: run.error ?? null,
      errorCode: run.errorCode ?? null,
      continuationAttempt,
      evidence: {
        issueCommentsCreated: countValue(commentStats?.count),
        documentRevisionsCreated: countValue(documentStats?.count),
        planDocumentRevisionsCreated: countValue(documentStats?.planCount),
        workProductsCreated: countValue(workProductStats?.count),
        workspaceOperationsCreated: countValue(workspaceOperationStats?.count),
        activityEventsCreated: countValue(activityStats?.count),
        toolOrActionEventsCreated: countValue(eventStats?.count),
        latestEvidenceAt: latestDate(
          commentStats?.latestAt,
          documentStats?.latestAt,
          workProductStats?.latestAt,
          workspaceOperationStats?.latestAt,
          activityStats?.latestAt,
          eventStats?.latestAt,
        ),
      },
    };
  }

  async function classifyAndPersistRunLiveness(
    run: typeof heartbeatRuns.$inferSelect,
    resultJson?: Record<string, unknown> | null,
  ) {
    const authRepair = run.status === "failed"
      ? await connectionIntentService(db).requestForRunAuthFailure(run.id).catch(() => {
          logger.warn({ runId: run.id }, "Could not attach provider authentication repair; run failure remains available");
          return null;
        })
      : null;
    const classification = classifyRunLiveness({
      ...await buildRunLivenessInput(run, resultJson),
      authenticationRepairRequested: Boolean(authRepair?.interactionId),
    });
    return db
      .update(heartbeatRuns)
      .set({
        livenessState: classification.livenessState,
        livenessReason: classification.livenessReason,
        continuationAttempt: classification.continuationAttempt,
        lastUsefulActionAt: classification.lastUsefulActionAt,
        nextAction: classification.nextAction,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    await accountRunCost(db, run.id, budgetHooks);
    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: run.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

  }

  return {
    appendRunEvent,
    escalatePlanApprovalResumeFailureNeedsAttention,
    recordPlanApprovalResumeFailureRetry,
    setRunStatusIfRunning,
    setWakeupStatus,
    mergeRunStopMetadataForAgent,
    classifyAndPersistRunLiveness,
    setRunStatusFromLive,
    setRunStatus,
    publishRunLifecyclePluginEventData,
    publishRunLifecyclePluginEvent,
    persistRunProcessMetadata,
    recordCurrentHeartbeatRunRuntimeProgress,
    completeSkillTestRunForHeartbeatOutcome,
    refreshContinuationSummaryForRun,
    findRunIssueComment,
    findLatestCompletedFinalAgentMessage,
    parseMaxTurnContinuationPolicy,
    finalizeIssueCommentPolicy,
    handleIssueReviewPathDisposition,
    handleRunLivenessContinuation,
    handleSuccessfulRunHandoff,
    updateRuntimeState,
    terminalizeRunOnLeaseRelease,
    clearDetachedRunWarning,
  };
}
