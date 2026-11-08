import { isInterruptedNativePreparation } from "../cancelled-native-startup.js";
import { isPreDispatchExecutionWaitVerified } from "../pre-dispatch-execution-wait.js";
import { notifyAttentionRetentionWork } from "../retention-work-notifications.js";
import { normalizeAgentNameKey } from "../agent-name-key.js";
import { notifyStatusCardIssueChange } from "../status-card-notifications.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { switchUnstartedLegacyQuotaPin } from "./quota-prestart-fence.js";
import { poolFailureKind, switchFailedPoolPin, poolConversationHandoff } from "./pool-failover.js";
import { deriveTaskKeyWithHeartbeatFallback } from "./run-state.js";
import { infrastructureRetryDelayMs } from "../system-recovery-state.js";
import {
  WORKSPACE_VALIDATION_FAILURE_CODE,
  isWorkspaceValidationFailedRun,
  readWorkspaceValidationPayloadFromRun,
} from "./workspaces.js";
import { admitExplicitContinuationRetry } from "../explicit-native-continuation.js";
import {
  CONVERSATION_CONTINUATION_POLICY,
  hasConversationContinuationPolicy,
} from "../conversation-continuation.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../legacy-execution-recovery.js";
import {
  executionFailureRetryCount,
  executionRetryAttemptCount,
  accountingForScheduledRetry,
  INTERRUPTED_PREPARATION_RETRY_MAX_ATTEMPTS,
  INTERRUPTED_PREPARATION_RETRY_REASON,
} from "../execution-recovery-attempt.js";
import { WORKSPACE_GIT_SCAN_ERROR_CODES } from "../workspace-git-operation-scheduler.js";
import { REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE, REMOTE_WORKSPACE_RESTORE_FAILED_CODE } from "../remote-workspace-transport.js";
import { REUSABLE_SANDBOX_RESUME_FAILED_CODE } from "../reusable-sandbox-resume-error.js";
import { PLUGIN_WORKER_UNAVAILABLE_CODE } from "../plugin-worker-unavailable-error.js";
import { ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE } from "../environment-provider-unavailable-error.js";
import { REPOSITORY_CATALOG_UNAVAILABLE_CODE } from "../repository-catalog-unavailable-error.js";
import { REVIEWED_CHAT_BINDING_NOT_READY } from "../reviewed-chat-binding-diagnostics.js";
import { RUNNER_REVISION_MISMATCH_CODE, RUNNER_REVISION_MISMATCH_RETRY, RUNNER_REVISION_WAIT_RETRY_REASON } from "../runner-revision-mismatch.js";
import { CONTROLLER_LEASE_LOST_FAILURE_CODE } from "../legacy-controller-lease.js";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  executionWorkspaces,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  HttpError,
  notFound,
} from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { parseObject } from "../../adapters/utils.js";
import { logActivity } from "../activity-log.js";
import { readContinuationAttempt } from "../recovery/index.js";
import { withRecoveryContext } from "../recovery/status-only-context.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_REASON,
  AI_CONNECTION_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
  WORKSPACE_BUSY_WAIT_KEY,
  readWorkspaceBusyWait,
  workspaceBusyWaitKey,
  type WorkspaceBusyWait,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
} from "../../modules/run-dispatch/index.js";

import type { AppendHeartbeatRunEventInput } from "../heartbeat-run-events.js";
import type { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { currentRunFailureText } from "../native-runtime/native-exact-resume-failure.js";
import type { createHeartbeatRunState } from "./run-state.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { createRunDispatch, PostCommitEffect } from "../../modules/run-dispatch/index.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type HeartbeatRunState = ReturnType<typeof createHeartbeatRunState>;
type PlanApprovalResumeFailure = {
  run: HeartbeatRun;
  issueId: string | null;
  attempt: number;
  maxAttempts: number;
};

/** The retry module owns scheduling writes; the service owns lifecycle effects. */
export interface HeartbeatRetryDependencies {
  hasCaseHandoffForRun: (run: Pick<HeartbeatRun, "id" | "companyId">) => Promise<boolean>;
  runDispatch: Pick<ReturnType<typeof createRunDispatch>,
    "evaluateScheduledRetryGate" | "promoteDueScheduledRetries" | "promoteScheduledRetry" | "nextScheduledRetryAt">;
  getAgent: (agentId: string) => Promise<typeof agents.$inferSelect | null | undefined>;
  getRun: (
    runId: string,
    options?: Parameters<HeartbeatRunState["getRun"]>[1],
  ) => Promise<Awaited<ReturnType<HeartbeatRunState["getRun"]>> | null | undefined>;
  resolveSessionBeforeForWakeup: HeartbeatRunState["resolveSessionBeforeForWakeup"];
  resolveResponsibleUserIdForRunContext: ReturnType<typeof createHeartbeatRunPreparation>["resolveResponsibleUserIdForRunContext"];
  getAgentInvokability: (agent: typeof agents.$inferSelect | null | undefined) => ReturnType<typeof evaluateAgentInvokabilityFromDb>;
  appendRunEvent: (run: HeartbeatRun, event: {
    eventType: string;
    stream?: "system" | "stdout" | "stderr";
    level?: "info" | "warn" | "error";
    color?: string;
    message?: string;
    payload?: Record<string, unknown>;
    retryExhaustion?: AppendHeartbeatRunEventInput["retryExhaustion"];
  }) => Promise<unknown>;
  escalatePlanApprovalResumeFailureNeedsAttention: (input: PlanApprovalResumeFailure) => Promise<string | null>;
  recordPlanApprovalResumeFailureRetry: (input: PlanApprovalResumeFailure & { retryRunId: string | null }) => Promise<string | null>;
  setRunStatusIfRunning: (runId: string, status: string, patch?: Partial<typeof heartbeatRuns.$inferInsert>) => Promise<{
    updated: boolean;
    run: HeartbeatRun | null;
  }>;
  setWakeupStatus: (wakeupRequestId: string | null | undefined, status: string, patch?: Partial<typeof agentWakeupRequests.$inferInsert>) => Promise<void>;
  releaseIssueExecutionAndPromote: (run: Pick<HeartbeatRun, "id" | "companyId">) => Promise<unknown>;
  finalizeAgentStatus: (
    agentId: string,
    outcome: "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out",
    failureReason?: string | null,
    options?: { keepIdleOnFailure?: boolean; wasFirstHeartbeat?: boolean },
  ) => Promise<void>;
  getWorktreeExecutionCutoff: () => Promise<Date | null>;
  applyRunDispatchPostCommitEffects: (effects: PostCommitEffect[]) => void;
}

export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS = [
  30_000, 60_000,
] as const;

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON = "transient_failure";

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON = "transient_failure_retry";

export function isTransientWorkspacePreparationCode(code: string | null | undefined): boolean {
  return code === WORKSPACE_GIT_SCAN_ERROR_CODES.timeout || code === WORKSPACE_GIT_SCAN_ERROR_CODES.saturated
    || code === REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE || code === REUSABLE_SANDBOX_RESUME_FAILED_CODE
    || code === REMOTE_WORKSPACE_RESTORE_FAILED_CODE || code === PLUGIN_WORKER_UNAVAILABLE_CODE
    || code === RUNNER_REVISION_MISMATCH_CODE || code === ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE
    || code === REPOSITORY_CATALOG_UNAVAILABLE_CODE || code === REVIEWED_CHAT_BINDING_NOT_READY;
}

export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS =
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length;

const PROVIDER_QUOTA_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 60_000] as const;
class PoolContinuationUnavailable extends Error {}

/** A policy decision only: callers must establish and recheck evidence under
 * the same durable claim used to create the successor and transition its pin. */
export function evaluateQuotaFailoverEvidence(input: {
  errorFamily: string | null | undefined;
  sourceStatus: string;
  stopRequested: boolean | undefined;
  providerStopped: boolean | undefined;
  cleanupSettled: boolean | undefined;
  actionOutcomesSettled: boolean | undefined;
  sessionSwitchSafe: boolean | undefined;
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.errorFamily !== "provider_quota") return { allowed: false, reason: "not_quota" };
  if (input.sourceStatus !== "failed") return { allowed: false, reason: "source_not_failed" };
  if (input.stopRequested !== false) return { allowed: false, reason: "stop_pending_or_unknown" };
  if (input.providerStopped !== true) return { allowed: false, reason: "provider_stop_unconfirmed" };
  if (input.cleanupSettled !== true) return { allowed: false, reason: "cleanup_unsettled" };
  if (input.actionOutcomesSettled !== true) return { allowed: false, reason: "action_outcomes_unsettled" };
  if (input.sessionSwitchSafe !== true) return { allowed: false, reason: "session_switch_unconfirmed" };
  return { allowed: true };
}

export function failedRunRetryBudgetSpent(run: Parameters<typeof executionFailureRetryCount>[0] & { errorCode?: string | null; resultJson?: Record<string, unknown> | null }): boolean {
  return run.errorCode === RUNNER_REVISION_MISMATCH_CODE
    ? executionRetryAttemptCount(run, RUNNER_REVISION_WAIT_RETRY_REASON) >= RUNNER_REVISION_MISMATCH_RETRY.maxAttempts
    : executionFailureRetryCount(run) >= (run.errorCode === "provider_quota" || run.resultJson?.errorFamily === "provider_quota"
      ? PROVIDER_QUOTA_RETRY_DELAYS_MS.length : BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS);
}

const INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS = 2;

const MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES = [
  "scheduled_retry",
  "queued",
  "running",
] as const;

export const WORKSPACE_BUSY_RETRY_WAKE_REASON = "workspace_busy_retry";

export const WORKSPACE_BUSY_ERROR_CODE = "workspace_busy";

export const WORKSPACE_BUSY_RETRY_BASE_DELAY_MS = 60 * 1000;

export const WORKSPACE_BUSY_RETRY_JITTER_MS = 60 * 1000;

// Preserve the one-hour shared-workspace holder cutoff independently of the
// informational output-silence warnings. Warning sooner must not let another
// run overtake a quiet holder and mutate its shared workspace. Run dispatch
// owns the value because its parked-wait check applies the same cutoff.
export { WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS };

// Issue-level executionWorkspaceSettings.mode values that unambiguously opt an
// issue's runs out of the shared project workspace, and therefore out of
// shared-workspace serialization ("isolated" is the legacy alias
// parseIssueExecutionWorkspaceSettings normalizes to isolated_workspace). Any
// other value â€” including agent_default and an absent mode â€” may still resolve
// to the shared workspace and counts as a holder.
const ISOLATED_EXECUTION_WORKSPACE_MODES = [
  "isolated_workspace",
  "operator_branch",
  "isolated",
] as const;

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

export interface SharedWorkspaceHolder {
  runId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string | null;
}

export interface ExecutionWorkspaceHolder extends SharedWorkspaceHolder {
  // Silent past WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS but still running.
  stale: boolean;
}

// Pre-dispatch gate outcome: another running run currently holds the issue's
// shared project workspace, or the shared execution workspace it reuses. Not a
// failure â€” the run is parked as a bounded scheduled retry and re-attempted
// once the holder finishes, so two agents never mutate the same working tree
// concurrently.
export class WorkspaceBusyDeferral extends Error {
  code = WORKSPACE_BUSY_ERROR_CODE;
  holder: SharedWorkspaceHolder;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  deferralAttempt: number;
  wasIssueAssignee: boolean;

  constructor(input: {
    holder: SharedWorkspaceHolder;
    projectWorkspaceId?: string | null;
    executionWorkspaceId?: string | null;
    deferralAttempt: number;
    wasIssueAssignee: boolean;
    holderEnded?: boolean;
  }) {
    super(
      `Shared ${input.executionWorkspaceId ? "execution" : "project"} workspace is busy: run ${input.holder.runId} (issue ${
        input.holder.issueIdentifier ?? input.holder.issueId
      }) ${input.holderEnded ? "ended, but its workspace save has not settled" : "is still running"}`,
    );
    this.name = "WorkspaceBusyDeferral";
    this.holder = input.holder;
    this.projectWorkspaceId = input.projectWorkspaceId ?? null;
    this.executionWorkspaceId = input.executionWorkspaceId ?? null;
    this.deferralAttempt = input.deferralAttempt;
    this.wasIssueAssignee = input.wasIssueAssignee;
  }
}

export function isWorkspaceBusyDeferral(
  error: unknown,
): error is WorkspaceBusyDeferral {
  return error instanceof WorkspaceBusyDeferral;
}

export function computeWorkspaceBusyRetryDelayMs(
  random: () => number = Math.random,
) {
  const jitter = Math.min(Math.max(random(), 0), 1);
  return (
    WORKSPACE_BUSY_RETRY_BASE_DELAY_MS +
    Math.floor(jitter * WORKSPACE_BUSY_RETRY_JITTER_MS)
  );
}

function resolveCodexTransientFallbackMode(
  attempt: number,
): CodexTransientFallbackMode {
  if (attempt <= 1) return "same_session";
  if (attempt === 2) return "safer_invocation";
  if (attempt === 3) return "fresh_session";
  return "fresh_session_safer_invocation";
}

export function readHeartbeatRunErrorFamily(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  const persistedFamily = readNonEmptyString(resultJson.errorFamily);
  if (persistedFamily) return persistedFamily;

  if (run.errorCode === "provider_quota") {
    return "provider_quota";
  }
  if (
    run.errorCode === "codex_transient_upstream" ||
    run.errorCode === "claude_transient_upstream" ||
    run.errorCode === "codex_harness_crash"
  ) {
    return "transient_upstream";
  }
  return null;
}

function readTransientRetryNotBeforeFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  const value = resultJson.retryNotBefore ?? resultJson.transientRetryNotBefore;
  if (!(
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof Date
  )) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readTransientRecoveryContractFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  const errorFamily = readHeartbeatRunErrorFamily(run);
  return errorFamily === "transient_upstream" ||
    errorFamily === "provider_quota"
    ? {
        errorFamily,
        retryNotBefore: readTransientRetryNotBeforeFromRun(run),
      }
    : null;
}

function isSpawnLikeFailureMessage(value: unknown) {
  if (typeof value !== "string") return false;
  return /failed to start command|spawn\b|\bENOENT\b/i.test(value);
}

// A sandbox provider plugin's worker can be briefly down during its own
// restart window (e.g. a rolling deploy of the plugin worker process). Lease
// acquisition fails immediately in that window, but the condition is
// transient and self-healing, so it must be treated as retryable
// infrastructure rather than a terminal setup failure. See
// resolveSandboxProviderPlugin's "worker_unavailable" message in
// environment-runtime.ts (":808"), e.g. 'Sandbox provider "kubernetes" is
// installed via plugin "acme.kubernetes-sandbox-provider", but its worker is
// not running.'
//
// This is anchored on both "is installed via plugin" and "but its worker is
// not running" so it does not also match plugin-environment-driver.ts's
// unrelated, permanent "provider not installed" message ('Sandbox provider
// "X" is not installed or its plugin worker is not running.'), which
// coincidentally contains the same "worker is not running" substring but
// describes a terminal condition that must not be retried.
function isSandboxProviderWorkerUnavailableFailureMessage(value: unknown) {
  if (typeof value !== "string") return false;
  return /sandbox provider .* is installed via plugin .* but its worker is not running/i.test(
    value,
  );
}

function isRetryableInteractionContinuationInfrastructureFailure(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "error" | "errorCode" | "resultJson"
  >,
) {
  // `controller_lease_lost` is only recorded before provider dispatch, so the
  // retry cannot repeat started work.
  if (
    run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE ||
    run.errorCode === "process_lost" ||
    run.errorCode === CONTROLLER_LEASE_LOST_FAILURE_CODE ||
    run.errorCode === PLUGIN_WORKER_UNAVAILABLE_CODE ||
    run.errorCode === ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE ||
    run.errorCode === REPOSITORY_CATALOG_UNAVAILABLE_CODE ||
    run.errorCode === REVIEWED_CHAT_BINDING_NOT_READY ||
    run.errorCode === RUNNER_REVISION_MISMATCH_CODE
  ) {
    return true;
  }

  if (run.errorCode !== "adapter_failed" && run.errorCode !== "setup_failed")
    return false;

  const resultJson = parseObject(run.resultJson);
  // A refused exact resume names its interrupted attempt in `error`; the
  // retry decision follows the current refusal only.
  const error = currentRunFailureText(run);
  return (
    isSpawnLikeFailureMessage(error) ||
    isSpawnLikeFailureMessage(resultJson.errorMessage) ||
    isSpawnLikeFailureMessage(resultJson.message) ||
    isSandboxProviderWorkerUnavailableFailureMessage(error) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.errorMessage) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.message)
  );
}

export function computeBoundedTransientHeartbeatRetrySchedule(
  attempt: number,
  now = new Date(),
  random: () => number = Math.random,
) {
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const baseDelayMs = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[attempt - 1];
  if (typeof baseDelayMs !== "number") return null;
  const delayMs = infrastructureRetryDelayMs(attempt, random());
  return {
    attempt,
    baseDelayMs,
    delayMs,
    dueAt: new Date(now.getTime() + delayMs),
    maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  };
}

export { normalizeAgentNameKey };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Retry persistence uses the service database and explicit lifecycle callbacks. */
export function createHeartbeatRetries(db: Db, dependencies: HeartbeatRetryDependencies) {
  const {
    hasCaseHandoffForRun,
    appendRunEvent,
    escalatePlanApprovalResumeFailureNeedsAttention,
    getAgentInvokability,
    runDispatch,
    resolveSessionBeforeForWakeup,
    resolveResponsibleUserIdForRunContext,
    recordPlanApprovalResumeFailureRetry,
    setRunStatusIfRunning,
    setWakeupStatus,
    getRun,
    getAgent,
    releaseIssueExecutionAndPromote,
    finalizeAgentStatus,
    getWorktreeExecutionCutoff,
    applyRunDispatchPostCommitEffects,
  } = dependencies;

  async function scheduleBoundedRetryForRun(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    opts?: {
      now?: Date;
      random?: () => number;
      retryReason?: string;
      wakeReason?: string;
      maxAttempts?: number;
      delayMs?: number;
    },
  ) {
    const preparation = parseObject(run.resultJson?.executionRecovery);
    if (typeof preparation.preparationSettledAt === "string" && await isInterruptedNativePreparation(db, run)) {
      const children = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
        eq(heartbeatRuns.retryOfRunId, run.id),
      )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(2);
      const withheld = children.length === 1 ? children[0] : undefined;
      if (withheld && await isPreDispatchExecutionWaitVerified(db, withheld)) {
        // The first replacement was withheld before execution while files were
        // recovered. Preserve its history, budget and predecessor claim.
        run = withheld;
        opts = { ...opts, retryReason: opts?.retryReason ?? "interrupted_preparation" };
      }
    }
    if (!opts?.retryReason && run.errorCode === RUNNER_REVISION_MISMATCH_CODE) opts = { ...RUNNER_REVISION_MISMATCH_RETRY, ...opts };
    if (await hasCaseHandoffForRun(run)) return { outcome: "not_scheduled" as const,
      reason: "The durable case handoff owns successor work.", issueId: readNonEmptyString(run.contextSnapshot?.issueId) };
    if (["openai_dot", "muse"].includes(String(parseObject(agent.adapterConfig).provider))
        || ["openai_dot", "muse"].includes(String(parseObject(parseObject(parseObject(run.runnerProfileJson).nativeExecutionInput).provider).kind))) {
      return { outcome: "not_scheduled" as const, reason: "Dot external execution must be reconciled before a new assignment; Paperclip cannot confirm its external stop.", issueId: readNonEmptyString(run.contextSnapshot?.issueId) };
    }
    if (run.errorCode === "provider_tool_definition_invalid") {
      return { outcome: "not_scheduled" as const,
        reason: "Repair the invalid tool definitions before starting a new attempt.",
        issueId: readNonEmptyString(run.contextSnapshot?.issueId) };
    }
    if (Array.isArray(run.contextSnapshot?.chatCompletionDeliveryIds) &&
        run.contextSnapshot.chatCompletionDeliveryIds.some(id => typeof id === "string")) {
      return { outcome: "not_scheduled" as const, reason: "The completion outbox owns this reply's retry budget and publication identity.",
        errorCode: "chat_completion_outbox_owns_retry" as const, issueId: readNonEmptyString(run.contextSnapshot.issueId) };
    }
    const now = opts?.now ?? new Date();
    const poolFailure = poolFailureKind(run);
    const preparationRecovery = parseObject(run.resultJson?.executionRecovery);
    const interruptedPreparation = ["interrupted", "failed"].includes(run.status) &&
      preparationRecovery.kind === "bootstrap" && preparationRecovery.providerWorkStarted === false
      && (run.status === "interrupted" || await isInterruptedNativePreparation(db, run));
    const retryReason = opts?.retryReason ??
      (interruptedPreparation ? INTERRUPTED_PREPARATION_RETRY_REASON : BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON);
    const wakeReason =
      opts?.wakeReason ?? BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON;
    const transientRecovery =
      (retryReason === BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON
        || retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON && run.errorCode === REPOSITORY_CATALOG_UNAVAILABLE_CODE)
        ? readTransientRecoveryContractFromRun(run)
        : null;
    const quotaRetry = transientRecovery?.errorFamily === "provider_quota";
    const interruptedPreparationLane = retryReason === INTERRUPTED_PREPARATION_RETRY_REASON;
    const maxAttempts = Math.max(
      0,
      Math.floor(
        opts?.maxAttempts ?? (interruptedPreparationLane ? INTERRUPTED_PREPARATION_RETRY_MAX_ATTEMPTS
          : poolFailure ? Math.max(100, poolFailure === "quota" ? (run.scheduledRetryAttempt ?? 0) + 1 : 100)
          : quotaRetry ? PROVIDER_QUOTA_RETRY_DELAYS_MS.length : BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS),
      ),
    );
    const consumedAttempts = executionRetryAttemptCount(run, retryReason);
    const nextAttempt = consumedAttempts + 1;
    // An interrupted preparation never spends failures, but it never revives
    // a chain whose real failures already spent the failure budget either.
    const failureBudgetSpent = interruptedPreparationLane && opts?.maxAttempts == null
      && executionFailureRetryCount(run) >= BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS;
    const computedBaseSchedule = failureBudgetSpent ? null
      : opts?.delayMs != null
        ? nextAttempt <= maxAttempts
          ? {
              attempt: nextAttempt,
              baseDelayMs: Math.max(0, Math.floor(opts.delayMs)),
              delayMs: Math.max(0, Math.floor(opts.delayMs)),
              dueAt: new Date(
                now.getTime() + Math.max(0, Math.floor(opts.delayMs)),
              ),
              maxAttempts,
            }
          : null
        : poolFailure && !interruptedPreparationLane && nextAttempt <= maxAttempts
          ? { attempt: nextAttempt, baseDelayMs: 0, delayMs: 0, dueAt: now, maxAttempts }
        : nextAttempt <= maxAttempts && quotaRetry
          ? (() => {
              const baseDelayMs = PROVIDER_QUOTA_RETRY_DELAYS_MS[nextAttempt - 1];
              if (baseDelayMs === undefined) return null;
              const delayMs = nextAttempt === 3 ? baseDelayMs : Math.round(baseDelayMs * (0.8 + Math.min(1, Math.max(0, (opts?.random ?? Math.random)())) * 0.4));
              return { attempt: nextAttempt, baseDelayMs, delayMs, dueAt: new Date(now.getTime() + delayMs), maxAttempts };
            })()
        : nextAttempt <= maxAttempts
          ? interruptedPreparationLane
            ? (() => {
              // Later lane attempts keep the longest transient delay.
              const schedule = computeBoundedTransientHeartbeatRetrySchedule(
                Math.min(nextAttempt, BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS), now, opts?.random);
              return schedule ? { ...schedule, attempt: nextAttempt } : null;
            })()
            : computeBoundedTransientHeartbeatRetrySchedule(
              nextAttempt,
              now,
              opts?.random,
            )
          : null;
    const baseSchedule = computedBaseSchedule
      ? { ...computedBaseSchedule, maxAttempts }
      : null;

    const codexTransientFallbackMode =
      agent.adapterType === "codex_local" && run.errorCode !== REPOSITORY_CATALOG_UNAVAILABLE_CODE &&
      transientRecovery?.errorFamily === "transient_upstream"
        ? resolveCodexTransientFallbackMode(nextAttempt)
        : null;
    const transientRetryNotBefore = transientRecovery?.retryNotBefore ?? null;
    const contextSnapshot = parseObject(run.contextSnapshot);
    // A retry inherits the durable authorization scope of its source run. Do
    // not promote an untrusted or legacy contextSnapshot.issueId into a new
    // issue binding: that could either violate the FK or misclassify history.
    const issueId = run.scopeKind === "issue" ? run.issueId : null;

    if (!baseSchedule) {
      const exhaustion = {
        retryReason,
        scheduledRetryAttempt: consumedAttempts,
        maxAttempts,
      };
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: `Bounded retry exhausted after ${consumedAttempts} scheduled attempts; no further automatic retry will be queued`,
        payload: exhaustion,
        retryExhaustion: exhaustion,
      });
      if (retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON) {
        await escalatePlanApprovalResumeFailureNeedsAttention({
          run,
          issueId,
          attempt: Math.min(
            consumedAttempts,
            maxAttempts,
          ),
          maxAttempts,
        }).catch((error) => {
          logger.warn(
            { err: error, runId: run.id, issueId },
            "failed to escalate exhausted plan-approval resume failure",
          );
        });
      }
      return {
        outcome: "retry_exhausted" as const,
        attempt: nextAttempt,
        maxAttempts,
      };
    }

    if (await legacyExecutionNeedsReconciliationWithEvidence(db, run)) {
      return {
        outcome: "not_scheduled" as const,
        reason:
          "Reconcile the previous execution before retrying; safe provider recovery is unavailable.",
        errorCode: "legacy_execution_requires_reconciliation" as const,
        issueId: readNonEmptyString(run.contextSnapshot?.issueId),
      };
    }
    if (retryReason !== MAX_TURN_CONTINUATION_RETRY_REASON) {
      const invokability = await getAgentInvokability(agent);
      if (!invokability.invokable) {
        await appendRunEvent(run, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message:
            "Scheduled retry suppressed because the agent is not invokable",
          payload: {
            retryReason,
            scheduledRetryAttempt: nextAttempt,
            maxAttempts,
            reason: invokability.reason,
            invalidOrgChain: invokability.invalidOrgChain,
            ...invokability.details,
          },
        });
        return {
          outcome: "not_scheduled" as const,
          reason:
            "Scheduled retry suppressed because the agent is not invokable",
          errorCode: "agent_not_invokable" as const,
          issueId,
        };
      }
    }

    const schedule =
      transientRetryNotBefore &&
      transientRetryNotBefore.getTime() > baseSchedule.dueAt.getTime()
        ? {
            ...baseSchedule,
            dueAt: transientRetryNotBefore,
            delayMs: Math.max(
              0,
              transientRetryNotBefore.getTime() - now.getTime(),
            ),
          }
        : baseSchedule;

    const requiresIssueGate =
      Boolean(poolFailure) ||
      interruptedPreparation || retryReason === "interrupted_preparation" ||
      (run.status === "interrupted" && run.errorCode === "server_shutdown_interrupted") ||
      isTransientWorkspacePreparationCode(run.errorCode) ||
      hasConversationContinuationPolicy(run.resultJson) ||
      (retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON) ||
      retryReason === MAX_TURN_CONTINUATION_RETRY_REASON ||
      retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON;
    if (requiresIssueGate) {
      const gate = await runDispatch.evaluateScheduledRetryGate({
        runId: run.id,
        companyId: run.companyId,
        retryReasonOverride: retryReason,
        now,
      });
      if (!gate.allowed) {
        await appendRunEvent(run, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: gate.reason,
          payload: {
            retryReason,
            scheduledRetryAttempt: nextAttempt,
            maxAttempts,
            ...gate.details,
          },
        });
        return {
          outcome: "not_scheduled" as const,
          reason: gate.reason,
          errorCode: gate.errorCode,
          issueId: gate.issueId,
        };
      }
    }
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    let sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const interactionRunnerWait = retryReason === RUNNER_REVISION_WAIT_RETRY_REASON
      && isResolvedInteractionContinuationWakeContext(run.contextSnapshot);
    const interactionContinuationPayload =
      retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON || interactionRunnerWait
        ? {
            mutation: "interaction",
            interactionId: readNonEmptyString(contextSnapshot.interactionId),
            interactionKind: readNonEmptyString(
              contextSnapshot.interactionKind,
            ),
            interactionStatus: readNonEmptyString(
              contextSnapshot.interactionStatus,
            ),
            continuationPolicy: readNonEmptyString(
              contextSnapshot.continuationPolicy,
            ),
          }
        : {};
    const workspaceValidationRetryPayload =
      retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON &&
      isWorkspaceValidationFailedRun(run)
        ? readWorkspaceValidationPayloadFromRun(run)
        : null;
    const shouldQuarantineWorkspaceForRetry =
      workspaceValidationRetryPayload !== null &&
      Object.keys(workspaceValidationRetryPayload).length > 0;
    const retryContextSnapshot: Record<string, unknown> = withRecoveryContext(
      {
        ...contextSnapshot,
        executionRetryAccounting: accountingForScheduledRetry(run, retryReason, schedule.attempt),
        retryOfRunId: run.id,
        wakeReason,
        retryReason,
        ...(interactionRunnerWait ? { mutation: "interaction" } : {}),
        ...(retryReason === WORKSPACE_BUSY_RETRY_REASON
          ? {
              failureRetriesBeforeWorkspaceWait:
                executionFailureRetryCount(run),
            }
          : {}),
        ...((retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON)
          ? { failureRetriesBeforeAiConnectionWait: executionFailureRetryCount(run) }
          : {}),
        ...(shouldQuarantineWorkspaceForRetry
          ? {
              workspaceValidationRecovery: {
                strategy: "quarantine_failed_workspace_and_retry_clean",
                sourceRunId: run.id,
                reason:
                  readNonEmptyString(workspaceValidationRetryPayload?.reason) ??
                  WORKSPACE_VALIDATION_FAILURE_CODE,
                fingerprint: readNonEmptyString(
                  workspaceValidationRetryPayload?.fingerprint,
                ),
                failedExecutionWorkspaceId: readNonEmptyString(
                  workspaceValidationRetryPayload?.executionWorkspaceId,
                ),
              },
            }
          : {}),
        ...(transientRecovery
          ? { errorFamily: transientRecovery.errorFamily }
          : {}),
        scheduledRetryAttempt: schedule.attempt,
        scheduledRetryAt: schedule.dueAt.toISOString(),
        ...(transientRetryNotBefore
          ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
          : {}),
        ...(transientRecovery?.errorFamily === "provider_quota" &&
        transientRetryNotBefore
          ? {
              providerQuotaRetryNotBefore:
                transientRetryNotBefore.toISOString(),
            }
          : {}),
        ...(codexTransientFallbackMode ? { codexTransientFallbackMode } : {}),
      },
      "normal_model",
    );
    // A successor resolves current assignments; the failed run retains its snapshot.
    delete retryContextSnapshot.skillVersions;
    delete retryContextSnapshot.skillSelectionSnapshot;
    delete retryContextSnapshot.shadowedSkills;
    const responsibleUserId = await resolveResponsibleUserIdForRunContext(
      run,
      retryContextSnapshot,
    );
    const continuationRetryIdempotencyKey =
      retryReason === MAX_TURN_CONTINUATION_RETRY_REASON
        ? `max-turn-continuation:${run.companyId}:${issueId ?? "no-issue"}:${run.id}:${schedule.attempt}`
        : retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
          ? `interaction-continuation:${run.companyId}:${issueId ?? "no-issue"}:${run.id}:${schedule.attempt}`
          : null;

    type ScheduledRetryTransactionResult =
      | {
          outcome: "scheduled";
          run: typeof heartbeatRuns.$inferSelect;
          reusedExisting: boolean;
        }
      | {
          outcome: "not_scheduled";
          reason: string;
          errorCode:
            | "issue_not_found"
            | "issue_reassigned"
            | "issue_cancelled"
            | "issue_terminal_status"
            | "issue_not_in_progress"
            | "continuation_user_authorization_missing"
            | "legacy_quota_stopped"
            | "issue_execution_lock_changed";
          issueId: string | null;
          details: Record<string, unknown>;
        };

    const scheduleResult = await db.transaction(
      async (tx): Promise<ScheduledRetryTransactionResult> => {
        // All automatic failure paths share the same predecessor claim. A
        // duplicate monitor, restart sweep or wake must reuse its successor.
        if (
          retryReason !== MAX_TURN_CONTINUATION_RETRY_REASON &&
          retryReason !== INTERACTION_CONTINUATION_INFRA_RETRY_REASON
        ) {
          if (issueId)
            await tx.execute(
              sql`select id from issues where company_id = ${run.companyId} and id = ${issueId} for update`,
            );
          await tx.execute(
            sql`select id from heartbeat_runs where company_id = ${run.companyId} and id = ${run.id} for update`,
          );
          if (retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON || poolFailure) {
            const [current] = await tx.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
              .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
            if (current?.resultJson?.legacyQuotaStopRequested) return {
              outcome: "not_scheduled", reason: "The pending pool retry was stopped", errorCode: "legacy_quota_stopped", issueId, details: {},
            };
          }
          const [existing] = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, run.companyId),
                eq(heartbeatRuns.retryOfRunId, run.id),
              ),
            )
            .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
            .limit(1);
          if (existing)
            return {
              outcome: "scheduled",
              run: existing,
              reusedExisting: true,
            };
        }
        if (retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON) {
          if (issueId) {
            await tx.execute(
              sql`select id from issues where company_id = ${run.companyId} and id = ${issueId} for update`,
            );
          } else {
            await tx.execute(
              sql`select id from heartbeat_runs where company_id = ${run.companyId} and id = ${run.id} for update`,
            );
          }

          const existingContinuation = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, run.companyId),
                eq(heartbeatRuns.retryOfRunId, run.id),
                eq(heartbeatRuns.scheduledRetryReason, retryReason),
                eq(heartbeatRuns.scheduledRetryAttempt, schedule.attempt),
                inArray(heartbeatRuns.status, [
                  ...MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES,
                ]),
                issueId
                  ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`
                  : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
              ),
            )
            .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingContinuation) {
            if (existingContinuation.wakeupRequestId) {
              const existingWakeup = await tx
                .select({ coalescedCount: agentWakeupRequests.coalescedCount })
                .from(agentWakeupRequests)
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                )
                .then((rows) => rows[0] ?? null);

              await tx
                .update(agentWakeupRequests)
                .set({
                  coalescedCount: (existingWakeup?.coalescedCount ?? 0) + 1,
                  updatedAt: now,
                })
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                );
            }

            return {
              outcome: "scheduled",
              run: existingContinuation,
              reusedExisting: true,
            };
          }
        }

        if (retryReason === MAX_TURN_CONTINUATION_RETRY_REASON) {
          if (issueId) {
            await tx.execute(
              sql`select id from issues where company_id = ${run.companyId} and id = ${issueId} for update`,
            );
          } else {
            await tx.execute(
              sql`select id from heartbeat_runs where company_id = ${run.companyId} and id = ${run.id} for update`,
            );
          }

          const existingContinuation = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, run.companyId),
                eq(heartbeatRuns.retryOfRunId, run.id),
                eq(heartbeatRuns.scheduledRetryReason, retryReason),
                eq(heartbeatRuns.scheduledRetryAttempt, schedule.attempt),
                inArray(heartbeatRuns.status, [
                  ...MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES,
                ]),
                issueId
                  ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`
                  : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
              ),
            )
            .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingContinuation) {
            if (existingContinuation.wakeupRequestId) {
              const existingWakeup = await tx
                .select({ coalescedCount: agentWakeupRequests.coalescedCount })
                .from(agentWakeupRequests)
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                )
                .then((rows) => rows[0] ?? null);

              await tx
                .update(agentWakeupRequests)
                .set({
                  coalescedCount: (existingWakeup?.coalescedCount ?? 0) + 1,
                  updatedAt: now,
                })
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                );
            }

            return {
              outcome: "scheduled",
              run: existingContinuation,
              reusedExisting: true,
            };
          }

          if (issueId) {
            const lockedIssue = await tx
              .select({
                id: issues.id,
                status: issues.status,
                assigneeAgentId: issues.assigneeAgentId,
                executionRunId: issues.executionRunId,
              })
              .from(issues)
              .where(
                and(
                  eq(issues.id, issueId),
                  eq(issues.companyId, run.companyId),
                ),
              )
              .then((rows) => rows[0] ?? null);

            if (!lockedIssue) {
              return {
                outcome: "not_scheduled",
                reason:
                  "Scheduled max-turn continuation suppressed because the target issue no longer exists",
                errorCode: "issue_not_found",
                issueId,
                details: { issueId },
              };
            }

            if (lockedIssue.assigneeAgentId !== run.agentId) {
              return {
                outcome: "not_scheduled",
                reason:
                  "Scheduled max-turn continuation suppressed because issue ownership changed",
                errorCode: "issue_reassigned",
                issueId,
                details: {
                  issueId,
                  previousAssigneeAgentId: run.agentId,
                  currentAssigneeAgentId: lockedIssue.assigneeAgentId,
                },
              };
            }

            if (
              lockedIssue.status === "cancelled" ||
              lockedIssue.status === "done"
            ) {
              return {
                outcome: "not_scheduled",
                reason: `Scheduled max-turn continuation suppressed because issue reached terminal status (${lockedIssue.status})`,
                errorCode:
                  lockedIssue.status === "cancelled"
                    ? "issue_cancelled"
                    : "issue_terminal_status",
                issueId,
                details: { issueId, currentStatus: lockedIssue.status },
              };
            }

            if (lockedIssue.status !== "in_progress") {
              return {
                outcome: "not_scheduled",
                reason: `Scheduled max-turn continuation suppressed because issue is no longer in_progress (current status: ${lockedIssue.status})`,
                errorCode: "issue_not_in_progress",
                issueId,
                details: {
                  issueId,
                  currentStatus: lockedIssue.status,
                  requiredStatus: "in_progress",
                },
              };
            }

            if (lockedIssue.executionRunId !== run.id) {
              return {
                outcome: "not_scheduled",
                reason:
                  "Scheduled max-turn continuation suppressed because the issue execution lock belongs to a different run",
                errorCode: "issue_execution_lock_changed",
                issueId,
                details: {
                  issueId,
                  expectedExecutionRunId: run.id,
                  currentExecutionRunId: lockedIssue.executionRunId,
                },
              };
            }
          }
        }

        if (
          (retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON) && issueId &&
          !isNonAssigneeWorkspaceBusyRetry(retryReason, contextSnapshot)
        ) {
          // The issue row is locked above. Recheck after the preflight gate so
          // cancellation or recovery cannot leave a successor without its lock.
          const [lockedIssue] = await tx.select({ executionRunId: issues.executionRunId })
            .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
          if (lockedIssue?.executionRunId !== run.id) {
            return {
              outcome: "not_scheduled", issueId, errorCode: "issue_execution_lock_changed",
              reason: "Subscription retry suppressed because the task execution lock changed",
              details: { issueId, expectedExecutionRunId: run.id, currentExecutionRunId: lockedIssue?.executionRunId ?? null },
            };
          }
        }

        const scheduledRunId = randomUUID();
        if (contextSnapshot.explicitUserContinuation) {
          const continuation = issueId && (retryReason === "transient_failure" || retryReason === RUNNER_REVISION_WAIT_RETRY_REASON) ? await admitExplicitContinuationRetry({
            db: tx as unknown as Db, companyId: run.companyId, issueId, agentId: run.agentId,
            parentRunId: run.id, successorRunId: scheduledRunId, now,
          }) : null;
          if (!continuation) return {
            outcome: "not_scheduled", issueId,
            errorCode: "continuation_user_authorization_missing",
            reason: "The automatic retry could not revalidate the original user continuation.",
            details: {},
          };
          retryContextSnapshot.explicitUserContinuation = continuation;
          retryContextSnapshot.previousRunId = continuation.previousRunId;
        }

        if (poolFailure) {
          const transition = await switchFailedPoolPin(tx as unknown as Db, { run, agent, userId: responsibleUserId });
          if (!transition || transition.kind !== "selected") throw new PoolContinuationUnavailable();
          schedule.dueAt = transition.retryAt ?? now;
          schedule.delayMs = Math.max(0, schedule.dueAt.getTime() - now.getTime());
          retryContextSnapshot.aiRouterSelection = transition.selection;
          retryContextSnapshot.previousRunId = run.id;
          retryContextSnapshot.forceFreshSession = true;
          if (!issueId) retryContextSnapshot.paperclipSessionHandoffMarkdown = poolConversationHandoff(run);
          retryContextSnapshot.aiPoolFailover = { sourceRunId: run.id, reason: poolFailure,
            ...(schedule.dueAt > now ? { waitingUntil: schedule.dueAt.toISOString() } : {}) };
          retryContextSnapshot.scheduledRetryAt = schedule.dueAt.toISOString();
          delete retryContextSnapshot.resumeSessionParams;
          delete retryContextSnapshot.resumeSessionDisplayId;
          delete retryContextSnapshot.providerQuotaRetryNotBefore;
          delete retryContextSnapshot.transientRetryNotBefore;
          sessionBefore = null;
        }
        if (retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON && issueId && !sessionBefore && agent.adapterType === "claude_local") {
          const selected = await switchUnstartedLegacyQuotaPin(tx as unknown as Db, { companyId: run.companyId,
            runId: run.id, issueId, agentId: run.agentId, userId: responsibleUserId });
          if (selected) {
            schedule.dueAt = now;
            schedule.delayMs = 0;
            retryContextSnapshot.aiRouterSelection = selected;
            retryContextSnapshot.scheduledRetryAt = now.toISOString();
          }
        }

        await notifyAttentionRetentionWork(tx, { companyId: run.companyId });
        await notifyScheduledRetryDispatch(tx, { companyId: run.companyId });
        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: run.companyId,
            agentId: run.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: wakeReason,
            payload: withRecoveryContext(
              {
                ...(issueId ? { issueId } : {}),
                retryOfRunId: run.id,
                ...interactionContinuationPayload,
                retryReason,
                ...(transientRecovery
                  ? { errorFamily: transientRecovery.errorFamily }
                  : {}),
                scheduledRetryAttempt: schedule.attempt,
                scheduledRetryAt: schedule.dueAt.toISOString(),
                ...(transientRetryNotBefore
                  ? {
                      transientRetryNotBefore:
                        transientRetryNotBefore.toISOString(),
                    }
                  : {}),
                ...(transientRecovery?.errorFamily === "provider_quota" &&
                transientRetryNotBefore
                  ? {
                      providerQuotaRetryNotBefore:
                        transientRetryNotBefore.toISOString(),
                    }
                  : {}),
                ...(codexTransientFallbackMode
                  ? { codexTransientFallbackMode }
                  : {}),
              },
              "normal_model",
            ),
            status: "queued",
            requestedByActorType: "system",
            requestedByActorId: null,
            idempotencyKey: continuationRetryIdempotencyKey,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);

        const scheduledRun = await tx
          .insert(heartbeatRuns)
          .values({
            id: scheduledRunId,
            companyId: run.companyId,
            agentId: run.agentId,
          scopeKind: run.scopeKind,
          issueId,
            invocationSource: "automation",
            triggerDetail: "system",
            status: "scheduled_retry",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: retryContextSnapshot,
            ...(hasConversationContinuationPolicy(run.resultJson)
              ? { resultJson: { conversationContinuation: CONVERSATION_CONTINUATION_POLICY } } : {}),
            responsibleUserId,
            sessionIdBefore: sessionBefore,
            retryOfRunId: run.id,
            scheduledRetryAt: schedule.dueAt,
            scheduledRetryAttempt: schedule.attempt,
            scheduledRetryReason: retryReason,
            continuationAttempt: readContinuationAttempt(
              retryContextSnapshot.livenessContinuationAttempt,
            ),
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: scheduledRun.id,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        let detachWorkspaceFromIssue = false;
        if (issueId && shouldQuarantineWorkspaceForRetry) {
          const issueWorkspace = await tx
            .select({
              id: issues.id,
              companyId: issues.companyId,
              executionWorkspaceId: issues.executionWorkspaceId,
            })
            .from(issues)
            .where(
              and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          const failedExecutionWorkspaceId =
            readNonEmptyString(
              workspaceValidationRetryPayload?.executionWorkspaceId,
            ) ?? readNonEmptyString(issueWorkspace?.executionWorkspaceId);

          if (issueWorkspace && failedExecutionWorkspaceId) {
            const failedWorkspace = await tx
              .select({
                id: executionWorkspaces.id,
                companyId: executionWorkspaces.companyId,
                sourceIssueId: executionWorkspaces.sourceIssueId,
                status: executionWorkspaces.status,
                metadata: executionWorkspaces.metadata,
              })
              .from(executionWorkspaces)
              .where(
                and(
                  eq(executionWorkspaces.id, failedExecutionWorkspaceId),
                  eq(executionWorkspaces.companyId, run.companyId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null);

            const workspaceBelongsToIssue = failedWorkspace
              ? failedWorkspace.sourceIssueId === issueId
              : false;

            if (
              failedWorkspace &&
              workspaceBelongsToIssue &&
              issueWorkspace.executionWorkspaceId === failedExecutionWorkspaceId
            ) {
              const existingMetadata = parseObject(failedWorkspace.metadata);
              const quarantine = {
                reason: WORKSPACE_VALIDATION_FAILURE_CODE,
                retryReason,
                sourceRunId: run.id,
                retryRunId: scheduledRun.id,
                issueId,
                sourceIssueId: failedWorkspace.sourceIssueId ?? null,
                quarantinedAt: now.toISOString(),
                workspaceValidation: workspaceValidationRetryPayload ?? {},
              };
              await tx
                .update(executionWorkspaces)
                .set({
                  status: "archived",
                  closedAt: now,
                  cleanupEligibleAt: null,
                  cleanupReason: WORKSPACE_VALIDATION_FAILURE_CODE,
                  metadata: {
                    ...existingMetadata,
                    workspaceValidationQuarantine: quarantine,
                  },
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(executionWorkspaces.id, failedWorkspace.id),
                    eq(executionWorkspaces.companyId, run.companyId),
                  ),
                );

              await logActivity(tx as unknown as Db, {
                companyId: run.companyId,
                actorType: "system",
                actorId: "heartbeat",
                agentId: run.agentId,
                runId: run.id,
                action: "execution_workspace.workspace_validation_quarantined",
                entityType: "execution_workspace",
                entityId: failedWorkspace.id,
                details: quarantine,
              });
              detachWorkspaceFromIssue =
                issueWorkspace.executionWorkspaceId ===
                failedExecutionWorkspaceId;
            }
          }
        }

        if (issueId) {
          await notifyStatusCardIssueChange(tx, run.companyId);
          await tx
            .update(issues)
            .set({
              executionRunId: scheduledRun.id,
              checkoutRunId: sql`case when ${issues.checkoutRunId} = ${run.id} then null else ${issues.checkoutRunId} end`,
              executionAgentNameKey: normalizeAgentNameKey(agent.name),
              executionLockedAt: now,
              ...(detachWorkspaceFromIssue
                ? {
                    executionWorkspaceId: null,
                    executionWorkspacePreference: null,
                  }
                : {}),
              updatedAt: now,
            })
            .where(
              and(
                eq(issues.id, issueId),
                eq(issues.companyId, run.companyId),
                eq(issues.executionRunId, run.id),
              ),
            );
        }

        return {
          outcome: "scheduled",
          run: scheduledRun,
          reusedExisting: false,
        };
      },
    ).catch((error): ScheduledRetryTransactionResult => {
      if (!(error instanceof PoolContinuationUnavailable)) throw error;
      return { outcome: "not_scheduled", issueId, errorCode: "issue_execution_lock_changed",
        reason: "No authorized backup with settled predecessor execution is available", details: {} };
    });

    if (scheduleResult.outcome === "not_scheduled") {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: scheduleResult.reason,
        payload: {
          retryReason,
          scheduledRetryAttempt: nextAttempt,
          maxAttempts,
          ...scheduleResult.details,
        },
      });
      return {
        outcome: "not_scheduled" as const,
        reason: scheduleResult.reason,
        errorCode: scheduleResult.errorCode,
        issueId: scheduleResult.issueId,
      };
    }

    const retryRun = scheduleResult.run;
    const dueAt = retryRun.scheduledRetryAt
      ? new Date(retryRun.scheduledRetryAt)
      : schedule.dueAt;

    if (scheduleResult.reusedExisting) {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: `Reused existing continuation retry ${retryRun.scheduledRetryAttempt}/${schedule.maxAttempts}`,
        payload: {
          retryRunId: retryRun.id,
          retryReason,
          idempotencyKey: continuationRetryIdempotencyKey,
          scheduledRetryAttempt: retryRun.scheduledRetryAttempt,
          scheduledRetryAt: dueAt.toISOString(),
        },
      });

      return {
        outcome: "scheduled" as const,
        run: retryRun,
        dueAt,
        attempt: retryRun.scheduledRetryAttempt,
        maxAttempts: schedule.maxAttempts,
        reusedExisting: true,
      };
    }

    await appendRunEvent(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: `Scheduled bounded retry ${schedule.attempt}/${schedule.maxAttempts} for ${schedule.dueAt.toISOString()}`,
      payload: {
        retryRunId: retryRun.id,
        retryReason,
        ...(transientRecovery
          ? { errorFamily: transientRecovery.errorFamily }
          : {}),
        scheduledRetryAttempt: schedule.attempt,
        scheduledRetryAt: schedule.dueAt.toISOString(),
        baseDelayMs: schedule.baseDelayMs,
        delayMs: schedule.delayMs,
        ...(transientRetryNotBefore
          ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
          : {}),
        ...(transientRecovery?.errorFamily === "provider_quota" &&
        transientRetryNotBefore
          ? {
              providerQuotaRetryNotBefore:
                transientRetryNotBefore.toISOString(),
            }
          : {}),
        ...(codexTransientFallbackMode ? { codexTransientFallbackMode } : {}),
      },
    });

    if (retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON) {
      await recordPlanApprovalResumeFailureRetry({
        run,
        issueId,
        retryRunId: retryRun.id,
        attempt: schedule.attempt,
        maxAttempts: schedule.maxAttempts,
      }).catch((error) => {
        logger.warn(
          { err: error, runId: run.id, issueId, retryRunId: retryRun.id },
          "failed to record plan-approval resume retry failure",
        );
      });
    }

    return {
      outcome: "scheduled" as const,
      run: retryRun,
      dueAt,
      attempt: schedule.attempt,
      maxAttempts: schedule.maxAttempts,
    };
  }

  // Finds a running heartbeat run (other than the caller's) whose context
  // issue shares the same project workspace, i.e. the run that currently
  // "holds" the shared working tree. Runs that have been silent past
  // WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS do not count â€” a zombie holder must
  // not park other work forever. This cutoff is independent of informational
  // silence warnings. When isolated workspaces are enabled, holders whose
  // issue explicitly opted into an isolated workspace never touch the shared
  // tree, so they are excluded; a NULL/agent_default mode may resolve to the
  // shared tree and counts as a holder (over-serializing is the safe
  // direction). When the isolated-workspaces experiment is off, every run
  // resolves to the shared tree, so no holder is excluded.
  async function findSharedWorkspaceHolder(input: {
    companyId: string;
    projectWorkspaceId: string;
    excludeIssueId: string;
    excludeRunId: string;
    honorIsolatedWorkspaceModes: boolean;
    now?: Date;
  }): Promise<SharedWorkspaceHolder | null> {
    const staleCutoff = new Date(
      (input.now ?? new Date()).getTime() -
        WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
    );
    return await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueId: sql<string>`${issues.id}::text`,
        issueIdentifier: issues.identifier,
      })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, heartbeatRuns.companyId),
          sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.id, input.excludeRunId),
          // Last observed activity: output beats start beats creation. A run
          // that started recently but has not written output yet is live.
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${staleCutoff.toISOString()}::timestamptz`,
          eq(issues.projectWorkspaceId, input.projectWorkspaceId),
          ne(sql`${issues.id}::text`, input.excludeIssueId),
          ...(input.honorIsolatedWorkspaceModes
            ? [
                or(
                  // Covers both a NULL settings blob and a blob without a mode
                  // key; either may still resolve to the shared workspace.
                  sql`${issues.executionWorkspaceSettings} ->> 'mode' is null`,
                  notInArray(
                    sql`${issues.executionWorkspaceSettings} ->> 'mode'`,
                    [...ISOLATED_EXECUTION_WORKSPACE_MODES],
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Finds a running run (other than the caller's) on an issue bound to the
  // same reused execution workspace, typically a parent run that is still
  // active after delegating a child that inherited its workspace. Unlike
  // findSharedWorkspaceHolder, a holder silent past
  // WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS is still returned (flagged stale):
  // silence does not prove the holder stopped, so the caller must not treat
  // the folder as free. A live holder is preferred over a stale one.
  async function findExecutionWorkspaceHolder(input: {
    companyId: string;
    executionWorkspaceId: string;
    excludeRunId: string;
    now?: Date;
  }): Promise<ExecutionWorkspaceHolder | null> {
    const staleCutoff = new Date(
      (input.now ?? new Date()).getTime() -
        WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
    );
    const lastActivityBefore = sql<boolean>`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) < ${staleCutoff.toISOString()}::timestamptz`;
    return await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueId: sql<string>`${issues.id}::text`,
        issueIdentifier: issues.identifier,
        stale: lastActivityBefore,
      })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, heartbeatRuns.companyId),
          eq(issues.executionWorkspaceId, input.executionWorkspaceId),
          or(
            eq(issues.executionRunId, heartbeatRuns.id),
            sql`${issues.id}::text = coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId')`,
          ),
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.id, input.excludeRunId),
        ),
      )
      .orderBy(asc(lastActivityBefore), asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Credential rotation can briefly contend with a fresh runtime read. Keep
  // the task on its automatic pre-provider retry path while the lock clears.
  async function finalizeAiConnectionBusyDeferral(
    run: typeof heartbeatRuns.$inferSelect,
    error: HttpError,
    wasIssueAssignee: boolean,
  ) {
    const now = new Date();
    const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
      error: error.message, errorCode: AI_CONNECTION_BUSY_RETRY_REASON, finishedAt: now,
      resultJson: {
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        cancellation: {
          source: "control_plane",
          expected: true,
          initiator: { type: "system" },
          reason: "Waiting for shared AI credentials",
          recordedAt: now.toISOString(),
        },
      },
      contextSnapshot: {
        ...parseObject(run.contextSnapshot),
        aiConnectionBusyDeferredWhileAssignee: wasIssueAssignee,
      },
    });
    if (!cancelled.updated) return;
    await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: error.message }).catch(() => undefined);
    const cancelledRun = cancelled.run ?? await getRun(run.id);
    const agent = await getAgent(run.agentId);
    let scheduled = false;
    try {
      if (cancelledRun && agent) {
        const retry = await scheduleBoundedRetryForRun(cancelledRun, agent, {
          now, retryReason: AI_CONNECTION_BUSY_RETRY_REASON, wakeReason: "ai_connection_busy_retry",
          maxAttempts: (cancelledRun.scheduledRetryAttempt ?? 0) + 1,
          delayMs: computeWorkspaceBusyRetryDelayMs(),
        });
        scheduled = retry.outcome === "scheduled";
        await appendRunEvent(cancelledRun, {
          eventType: "lifecycle", stream: "system", level: "info",
          message: scheduled ? "Waiting for the shared AI subscription. This task will retry automatically." : "The AI subscription is busy; this task can no longer retry automatically.",
          payload: { retryScheduled: scheduled },
        });
      }
    } finally {
      try {
        if (cancelledRun && !scheduled) await releaseIssueExecutionAndPromote(cancelledRun);
      } finally {
        await finalizeAgentStatus(run.agentId, "cancelled", null, { wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run) });
      }
    }
  }

  // The wait applies only while the task keeps the workspace binding it had
  // when it deferred; run dispatch compares the same binding before parking.
  async function readWorkspaceBusyWaitForRetry(
    run: typeof heartbeatRuns.$inferSelect,
    runContext: Record<string, unknown>,
    deferral: WorkspaceBusyDeferral,
    now: Date,
  ): Promise<WorkspaceBusyWait | null> {
    const key = workspaceBusyWaitKey(deferral);
    const issueId = readNonEmptyString(runContext.issueId);
    if (!key || !issueId) return null;
    const [issue] = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
    if (!issue) return null;
    // The run is already cancelled, so the task may have moved in between.
    // Keep the wait only if the binding still names the deferral's workspace
    // (a remote reservation can defer before it binds the execution workspace).
    const stillBound = deferral.executionWorkspaceId
      ? issue.executionWorkspaceId === null || issue.executionWorkspaceId === deferral.executionWorkspaceId
      : issue.projectWorkspaceId === deferral.projectWorkspaceId;
    if (!stillBound) return null;
    const priorWait = readWorkspaceBusyWait(run.scheduledRetryReason, runContext);
    return {
      key,
      holderRunId: deferral.holder.runId,
      waitingSince: priorWait?.key === key ? priorWait.waitingSince : now.toISOString(),
      issueExecutionWorkspaceId: issue.executionWorkspaceId ?? null,
      issueProjectWorkspaceId: issue.projectWorkspaceId ?? null,
    };
  }

  // Terminal handling for a WorkspaceBusyDeferral thrown by the pre-dispatch
  // gate: cancel the run (contention is not a failure), schedule a
  // workspace_busy retry, and leave the agent idle. The issue execution lock
  // transfers to the scheduled retry run inside scheduleBoundedRetryForRun, so
  // the issue keeps an active execution path and recovery leaves it alone.
  // Deferral has no attempt ceiling â€” the retry keeps rescheduling while a
  // live holder exists, and holder staleness (not a counter) is what prevents
  // waiting on a zombie. If no retry could be scheduled (agent no longer
  // invokable), the lock is released so the issue does not strand on a
  // cancelled run.
  async function finalizeWorkspaceBusyDeferral(
    run: typeof heartbeatRuns.$inferSelect,
    deferral: WorkspaceBusyDeferral,
  ) {
    const now = new Date();
    const runContext = parseObject(run.contextSnapshot);
    const cancelWrite = await setRunStatusIfRunning(run.id, "cancelled", {
      error: deferral.message,
      errorCode: WORKSPACE_BUSY_ERROR_CODE,
      finishedAt: now,
      resultJson: {
        executionRecovery: {
          kind: "workspace_wait",
          providerWorkStarted: false,
        },
        cancellation: {
          source: "control_plane",
          expected: true,
          initiator: { type: "system" },
          reason: `Waiting for the shared ${deferral.executionWorkspaceId ? "execution" : "project"} workspace`,
          recordedAt: now.toISOString(),
        },
        workspaceBusy: {
          projectWorkspaceId: deferral.projectWorkspaceId,
          executionWorkspaceId: deferral.executionWorkspaceId,
          holderRunId: deferral.holder.runId,
          holderIssueId: deferral.holder.issueId,
          deferralAttempt: deferral.deferralAttempt,
        },
      },
      // Recorded on the run (and inherited by the scheduled retry's context)
      // so the retry promotion gate can tell a non-assignee wake â€” where an
      // assignee mismatch is the expected state â€” from a reassignment race.
      contextSnapshot: {
        ...runContext,
        workspaceBusyDeferredWhileAssignee: deferral.wasIssueAssignee,
      },
    });
    if (!cancelWrite.updated) {
      logger.info(
        { runId: run.id, currentStatus: cancelWrite.run?.status ?? null },
        "skipping workspace-busy deferral finalization because the run already left running state",
      );
      return;
    }
    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: now,
      error: deferral.message,
    }).catch(() => undefined);

    const cancelledRun =
      cancelWrite.run ?? (await getRun(run.id).catch(() => null));
    const agentRow = await getAgent(run.agentId).catch(() => null);
    let scheduleOutcome: string | null = null;
    if (cancelledRun && agentRow) {
      // Record what the retry waits behind, so run dispatch can keep it parked
      // in place until the holder ends instead of re-dispatching it on a timer.
      const workspaceBusyWait = await readWorkspaceBusyWaitForRetry(run, runContext, deferral, now)
        .catch((waitErr) => {
          logger.warn({ err: waitErr, runId: run.id }, "failed to record the workspace wait; the retry re-checks on its timer");
          return null;
        });
      const scheduleResult = await scheduleBoundedRetryForRun(
        workspaceBusyWait
          ? { ...cancelledRun, contextSnapshot: { ...parseObject(cancelledRun.contextSnapshot), [WORKSPACE_BUSY_WAIT_KEY]: workspaceBusyWait } }
          : cancelledRun,
        agentRow,
        {
          now,
          retryReason: WORKSPACE_BUSY_RETRY_REASON,
          wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
          // Always admit the next attempt: workspace-busy deferral is bounded by
          // holder liveness, not by an attempt counter.
          maxAttempts: (cancelledRun.scheduledRetryAttempt ?? 0) + 1,
          delayMs: computeWorkspaceBusyRetryDelayMs(),
        },
      ).catch((scheduleErr) => {
        logger.error(
          { err: scheduleErr, runId: run.id },
          "failed to schedule workspace-busy retry after deferral",
        );
        return null;
      });
      scheduleOutcome = scheduleResult?.outcome ?? null;
    }

    if (cancelledRun) {
      await appendRunEvent(cancelledRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message:
          scheduleOutcome === "scheduled"
            ? `Deferred: ${deferral.message}. Retry ${deferral.deferralAttempt + 1} scheduled; the run waits for the workspace to free.`
            : `Deferred: ${deferral.message}. No retry could be scheduled; releasing the issue for other runs.`,
        payload: {
          projectWorkspaceId: deferral.projectWorkspaceId,
          executionWorkspaceId: deferral.executionWorkspaceId,
          holderRunId: deferral.holder.runId,
          holderIssueId: deferral.holder.issueId,
          deferralAttempt: deferral.deferralAttempt,
          retryScheduled: scheduleOutcome === "scheduled",
        },
      }).catch(() => undefined);
    }

    if (cancelledRun && scheduleOutcome !== "scheduled") {
      await releaseIssueExecutionAndPromote(cancelledRun).catch(
        (releaseErr) => {
          logger.error(
            { err: releaseErr, runId: run.id },
            "failed to release issue execution after workspace-busy deferral",
          );
        },
      );
    }

    await finalizeAgentStatus(run.agentId, "cancelled", null, {
      wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
    }).catch(() => undefined);
  }

  async function scheduleInteractionContinuationInfrastructureRetryIfEligible(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    if (await hasCaseHandoffForRun(run)) return null;
    if (!run.wakeupRequestId) return null;
    if (!isResolvedInteractionContinuationWakeContext(run.contextSnapshot))
      return null;
    if (!isRetryableInteractionContinuationInfrastructureFailure(run)) {
      const context = parseObject(run.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      await escalatePlanApprovalResumeFailureNeedsAttention({
        run,
        issueId,
        attempt: Math.min(
          run.scheduledRetryAttempt ??
            INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
          INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
        ),
        maxAttempts: INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
      }).catch((error) => {
        logger.warn(
          { err: error, runId: run.id, issueId },
          "failed to escalate non-retryable plan-approval resume failure",
        );
      });
      return null;
    }

    return scheduleBoundedRetryForRun(run, agent, {
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
    });
  }

  async function nextScheduledRetryAt() {
    return runDispatch.nextScheduledRetryAt({ cutoff: await getWorktreeExecutionCutoff() });
  }

  async function promoteDueScheduledRetries(now = new Date()) {
    const cutoff = await getWorktreeExecutionCutoff();
    const result = await runDispatch.promoteDueScheduledRetries({
      now,
      cutoff,
    });
    applyRunDispatchPostCommitEffects(result.postCommitEffects);
    return { promoted: result.promoted, runIds: result.runIds };
  }

  async function getIssueRetryRun(
    companyId: string,
    issueId: string,
    statuses: Array<"scheduled_retry" | "queued" | "running" | "cancelled">,
  ) {
    if (statuses.length === 0) return null;
    return db
      .select({
        run: heartbeatRuns,
        agentName: agents.name,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, statuses),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.retryOfRunId} is not null`,
        ),
      )
      .orderBy(
        desc(heartbeatRuns.updatedAt),
        desc(heartbeatRuns.createdAt),
        desc(heartbeatRuns.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function summarizeIssueScheduledRetryRun(row: {
    run: typeof heartbeatRuns.$inferSelect;
    agentName: string | null;
  }) {
    return {
      runId: row.run.id,
      status: row.run.status as
        "scheduled_retry" | "queued" | "running" | "cancelled",
      agentId: row.run.agentId,
      agentName: row.agentName,
      retryOfRunId: row.run.retryOfRunId,
      scheduledRetryAt: row.run.scheduledRetryAt,
      scheduledRetryAttempt: row.run.scheduledRetryAttempt,
      scheduledRetryReason: row.run.scheduledRetryReason,
      error: row.run.error,
      errorCode: row.run.errorCode,
    };
  }

  async function retryScheduledRetryNow(input: {
    issueId: string;
    actor?: {
      actorType?: "user" | "agent" | "system";
      actorId?: string | null;
    };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const scheduled = await getIssueRetryRun(issue.companyId, issue.id, [
      "scheduled_retry",
    ]);
    if (!scheduled) {
      const alreadyPromoted = await getIssueRetryRun(
        issue.companyId,
        issue.id,
        ["queued", "running"],
      );
      if (alreadyPromoted) {
        return {
          outcome: "already_promoted" as const,
          message: "Scheduled retry was already promoted",
          scheduledRetry: summarizeIssueScheduledRetryRun(alreadyPromoted),
        };
      }
      return {
        outcome: "no_scheduled_retry" as const,
        message: "No live scheduled retry exists for this issue",
        scheduledRetry: null,
      };
    }

    const contextSnapshot = {
      ...parseObject(scheduled.run.contextSnapshot),
      scheduledRetryAt: now.toISOString(),
      retryNowRequestedAt: now.toISOString(),
      retryNowRequestedByActorType: input.actor?.actorType ?? null,
      retryNowRequestedByActorId: input.actor?.actorId ?? null,
    };

    const updated = await db.transaction(async (tx) => {
      await notifyScheduledRetryDispatch(tx, { companyId: scheduled.run.companyId });
      const row = await tx
        .update(heartbeatRuns)
        .set({
          scheduledRetryAt: now,
          contextSnapshot,
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, scheduled.run.id),
            eq(heartbeatRuns.status, "scheduled_retry"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      if (row.wakeupRequestId) {
        const wakeupPayload = {
          ...parseObject(
            await tx
              .select({ payload: agentWakeupRequests.payload })
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.id, row.wakeupRequestId))
              .then((rows) => rows[0]?.payload ?? null),
          ),
          scheduledRetryAt: now.toISOString(),
          retryNowRequestedAt: now.toISOString(),
        };
        await tx
          .update(agentWakeupRequests)
          .set({
            payload: wakeupPayload,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, row.wakeupRequestId));
      }

      return row;
    });

    if (!updated) {
      const alreadyPromoted = await getIssueRetryRun(
        issue.companyId,
        issue.id,
        ["queued", "running"],
      );
      if (alreadyPromoted) {
        return {
          outcome: "already_promoted" as const,
          message: "Scheduled retry was already promoted",
          scheduledRetry: summarizeIssueScheduledRetryRun(alreadyPromoted),
        };
      }
      return {
        outcome: "no_scheduled_retry" as const,
        message: "No live scheduled retry exists for this issue",
        scheduledRetry: null,
      };
    }

    await appendRunEvent(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Scheduled retry was requested to run now",
      payload: {
        issueId: issue.id,
        scheduledRetryAttempt: updated.scheduledRetryAttempt,
        scheduledRetryAt: updated.scheduledRetryAt
          ? new Date(updated.scheduledRetryAt).toISOString()
          : null,
        scheduledRetryReason: updated.scheduledRetryReason,
        requestedByActorType: input.actor?.actorType ?? null,
        requestedByActorId: input.actor?.actorId ?? null,
      },
    });

    const promotion = await runDispatch.promoteScheduledRetry({
      runId: updated.id,
      companyId: updated.companyId,
      now,
    });
    if (promotion.outcome === "promoted") {
      applyRunDispatchPostCommitEffects(promotion.postCommitEffects);
    }
    // Promotion can preserve this row as a cleanup wait. Read that exact run,
    // not an older cancelled retry or the pre-promotion schedule.
    const currentRun = await getRun(updated.id);
    const scheduledRetry = currentRun
      ? summarizeIssueScheduledRetryRun({
          run: currentRun,
          agentName: scheduled.agentName,
        })
      : null;

    if (currentRun?.status === "scheduled_retry") {
      return {
        outcome: "waiting" as const,
        message: parseObject(currentRun.resultJson?.executionWait).cause === "execution_owner_active"
          ? "Waiting for execution cleanup. Paperclip will retry automatically once cleanup finishes."
          : "The retry remains scheduled. Paperclip will check again at the scheduled time.",
        scheduledRetry,
      };
    }

    if (promotion.outcome === "promoted") {
      return {
        outcome: "promoted" as const,
        message: "Scheduled retry was promoted to the queued run pool",
        scheduledRetry,
      };
    }
    if (promotion.outcome === "gate_suppressed") {
      return {
        outcome: "gate_suppressed" as const,
        message: promotion.reason,
        scheduledRetry,
      };
    }
    if (currentRun && ["queued", "running"].includes(currentRun.status)) {
      return {
        outcome: "already_promoted" as const,
        message: "Scheduled retry was already promoted",
        scheduledRetry,
      };
    }
    return {
      outcome: "no_scheduled_retry" as const,
      message: "No live scheduled retry exists for this issue",
      scheduledRetry: null,
    };
  }

  function timerClaimWasFirstHeartbeat(
    run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot">,
  ): true | undefined {
    return parseObject(run.contextSnapshot).timerClaimWasFirstHeartbeat === true
      ? true
      : undefined;
  }

  return {
    scheduleBoundedRetryForRun,
    timerClaimWasFirstHeartbeat,
    scheduleInteractionContinuationInfrastructureRetryIfEligible,
    findSharedWorkspaceHolder,
    findExecutionWorkspaceHolder,
    finalizeAiConnectionBusyDeferral,
    finalizeWorkspaceBusyDeferral,
    promoteDueScheduledRetries,
    nextScheduledRetryAt,
    retryScheduledRetryNow,

    scheduleBoundedRetry: async (
      runId: string,
      opts?: {
        now?: Date;
        random?: () => number;
        retryReason?: string;
        wakeReason?: string;
        maxAttempts?: number;
        delayMs?: number;
      },
    ) => {
      const run = await getRun(runId, { unsafeFullResultJson: true });
      if (!run) return { outcome: "missing_run" as const };
      const agent = await getAgent(run.agentId);
      if (!agent) return { outcome: "missing_agent" as const };
      return scheduleBoundedRetryForRun(run, agent, opts);
    },
  };
}
