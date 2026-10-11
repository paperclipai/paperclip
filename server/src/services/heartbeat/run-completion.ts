import { NON_RETRYABLE_PREFLIGHT_FAILURE_CODES, isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";
import { ChatControlRecoveryUnresolvedError } from "./queue.js";
import { readTransientRecoveryContractFromRun, readHeartbeatRunErrorFamily, isTransientWorkspaceGitScanCode } from "./retries.js";
import { type RunSessionOutcome, resolveNextSessionState, normalizeUsageTotals, resolveCacheAdjustedCostUsd, resolveLedgerBiller, resolveLedgerCostStatus, normalizeLedgerBillingType } from "./run-state.js";
import { readGitConnectionFailure } from "../git-connection-failure.js";
import { CONFIGURATION_INCOMPLETE_FAILURE_CODE, ConfigurationIncompleteFailure } from "./run-preparation.js";
import { isWorkspaceValidationFailedRun, isWorkspaceValidationFailure, attachPaperclipSessionMetadataToSessionParams } from "./workspaces.js";
import { preserveWorkspaceRestoreRecoveryMetadataSql } from "../legacy-workspace-restore-recovery.js";
import { cancellationResultJson, readRunCancellation } from "../run-cancellation.js";
import { accountRunCost } from "../run-cost-accounting.js";
import { isConversation, settleConversationTurn } from "../agent-conversations.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../legacy-execution-recovery.js";
import { isWorkspaceGitScanError } from "../workspace-git-operation-scheduler.js";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { normalizeResponsibleUserDenialCode } from "../responsible-user-denial-run-outcomes.js";
import { parseObject } from "../../adapters/utils.js";
import { CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON, isExternalChatPresentationContext, mergeHeartbeatRunResultJson, resolveHeartbeatRunResponse, type RunPresentationDecision } from "../heartbeat-run-summary.js";
import { normalizeMaxTurnStopReason } from "../heartbeat-stop-metadata.js";
import { isSuccessfulClaudeTerminalCleanup } from "../heartbeat-terminal-cleanup.js";
import { CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE } from "../chat-control-recovery-stop.js";
import { logActivity } from "../activity-log.js";
import { isUnresolvedWorkspaceBaseRefError, readUnresolvedWorkspaceBaseRefDiagnostic, type UnresolvedWorkspaceBaseRefError } from "../workspace-runtime.js";
import { runnerGoalService } from "../runner-goals.js";
import { resolveChatRunPresentationAuthorizationReason } from "../chat-run-publications.js";
import { SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON } from "../recovery/stranded-notice.js";
import { MAX_TURN_CONTINUATION_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { createHeartbeatRetries, HeartbeatRetryDependencies } from "./retries.js";
import type { createHeartbeatQueue } from "./queue.js";
import type { createHeartbeatRunControl, HeartbeatRunControlDependencies } from "./run-control.js";
import type { issueService } from "../issues.js";
import type { recoveryService } from "../recovery/index.js";
import type { BudgetServiceHooks } from "../budgets.js";
import type { providerTraceStore } from "../provider-trace-store.js";
import type { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { getRunLogStore, RunLogHandle } from "../run-log-store.js";
import type { createHeartbeatRunState, getAdapterSessionCodec } from "./run-state.js";
import type { EffectiveRunSessionConfigMetadata } from "./workspaces.js";
import type { Db, agents } from "@paperclipai/db";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;
type RunState = ReturnType<typeof createHeartbeatRunState>;
type IssueContext = Awaited<ReturnType<ReturnType<typeof createHeartbeatRunPreparation>["getIssueExecutionContext"]>> | null;
type TaskSession = Awaited<ReturnType<RunState["getTaskSession"]>> | null;

/** Completion persists terminal outcomes; the executor retains dispatch and cleanup ownership. */
export interface HeartbeatRunCompletionDependencies extends Pick<RunState,
  "getRun" | "getAgent" | "resolveNormalizedUsageForSession" | "clearTaskSessions" | "upsertTaskSession">,
  Pick<ReturnType<typeof createHeartbeatLifecycle>,
    "mergeRunStopMetadataForAgent" | "setRunStatusIfRunning" | "setWakeupStatus" | "appendRunEvent" |
    "classifyAndPersistRunLiveness" | "completeSkillTestRunForHeartbeatOutcome" | "refreshContinuationSummaryForRun" |
    "findRunIssueComment" | "findLatestCompletedFinalAgentMessage" | "parseMaxTurnContinuationPolicy" |
    "finalizeIssueCommentPolicy" | "handleIssueReviewPathDisposition" | "handleRunLivenessContinuation" |
    "handleSuccessfulRunHandoff" | "updateRuntimeState">,
  Pick<ReturnType<typeof createHeartbeatRetries>,
    "scheduleBoundedRetryForRun" | "scheduleInteractionContinuationInfrastructureRetryIfEligible" | "timerClaimWasFirstHeartbeat">,
  Pick<ReturnType<typeof createHeartbeatRunControl>, "releaseIssueExecutionAndPromote">,
  Pick<HeartbeatRetryDependencies, "finalizeAgentStatus">,
  Pick<ReturnType<typeof createHeartbeatQueue>, "enqueueWakeup"> {
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment">;
  recovery: Pick<ReturnType<typeof recoveryService>, "reconcileLegacyContinuation" | "reconcileResolvedDependencyWakeBackstop">;
  getCurrentUserRedactionOptions: () => Promise<CurrentUserRedactionOptions>;
  budgetHooks: BudgetServiceHooks;
  runLogStore: Pick<ReturnType<typeof getRunLogStore>, "finalize">;
  traceStore: Pick<ReturnType<typeof providerTraceStore>, "finalize">;
  processRunCancellationSettlements: Pick<HeartbeatRunControlDependencies["processRunCancellationSettlements"], "get">;
  failedProcessRunCancellations: HeartbeatRunCompletionDependencies["processRunCancellationSettlements"];
}

interface RunCompletionOutput {
  handle: RunLogHandle | null;
  outputProgressState: { pending: { bytes: number } | null };
  flushOutputProgress: (options?: { force?: boolean }) => Promise<void>;
  // Getters in the executor retain output that arrives while finalization awaits I/O.
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
}

interface RunCompletionSession {
  runtimeForAdapter: { sessionId: string | null; sessionDisplayId: string | null };
  previousSessionParams: Record<string, unknown> | null;
  taskKey: string | null;
  configuredModel: string | null;
  sessionConfigMetadata: EffectiveRunSessionConfigMetadata;
}

interface RunCompletionInput {
  run: Run;
  agent: Agent;
  issueId: string | null;
  issueRef: Pick<NonNullable<IssueContext>, "workMode" | "identifier" | "title"> | null;
  signal: AbortSignal;
  output: RunCompletionOutput;
  session: RunCompletionSession;
  readFailureReportSecrets: () => string[];
}

export interface CompleteHeartbeatRunInput extends RunCompletionInput {
  adapterResult: AdapterExecutionResult;
  sessionCodec: ReturnType<typeof getAdapterSessionCodec>;
  taskSessionForRun: TaskSession;
  sessionCompaction: Pick<Awaited<ReturnType<RunState["evaluateSessionCompaction"]>>, "rotate" | "reason">;
  configFreshnessResultMetadata: Record<string, unknown>;
  runLedgerScope: Record<string, unknown>;
  currentUserRedactionOptions: CurrentUserRedactionOptions;
  providerTraceCapture: boolean;
  // Update the executor immediately: a later completion step can still throw.
  onProviderTraceFinalized: () => void;
  issueContext: IssueContext;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface FailHeartbeatRunInput extends RunCompletionInput {
  runId: string;
  err: unknown;
  identityRedactor: Pick<ReturnType<typeof createAgentIdentityRedactor>, "redact">;
  requiredWorkspaceRestoreEvidence: Record<string, unknown> | null;
  legacyAdapterEntered: boolean;
  goalCheckpointSession: { current: { params: Record<string, unknown>; displayId: string } | null };
  previousSessionDisplayId: string | null;
  taskSession: TaskSession;
}

export interface FailHeartbeatRunSetupInput {
  run: Run;
  runId: string;
  outerErr: unknown;
  identityRedactor: Pick<ReturnType<typeof createAgentIdentityRedactor>, "redact">;
  readFailureReportSecrets: () => string[];
}

function nonRetryablePreflightFailureCode(error: unknown): string | null {
  if (error instanceof ChatControlRecoveryUnresolvedError)
    return CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE;
  if (
    error instanceof HttpError &&
    error.status === 409 &&
    parseObject(error.details).code === "chat_failed_run_retry_not_authorized"
  ) {
    return "chat_failed_run_retry_not_authorized";
  }
  if (!(error instanceof HttpError) || error.status !== 422) return null;
  const code = readNonEmptyString(parseObject(error.details).code);
  return code && NON_RETRYABLE_PREFLIGHT_FAILURE_CODES.has(code) ? code : null;
}

export const MAX_TURN_CONTINUATION_WAKE_REASON = "max_turns_continuation_retry";

// Build the configuration-incomplete result payload for a workspace base ref
// that never resolved to a commit. The setup catch maps this to errorCode
// `configuration_incomplete`, so the recovery path routes it to a human owner
// instead of a dispatched-then-failed run. The `fingerprint` uses the canonical
// remote ref, not the operator spelling. Two equivalent spellings of one remote
// branch (`fix/foo` and `origin/fix/foo`) share one fingerprint, so a repeated
// failure reuses one active recovery action and does not reset the attempt
// count or post a duplicate notice. A different branch makes a new action.
// Build the configuration-incomplete result payload for a sandbox provider
// plugin that is installed but not `ready`. The `fingerprint` is the plugin
// key plus its status, so every run that hits the same stuck plugin reuses
// one active recovery action instead of posting a fresh notice per attempt,
// while a status change (say `error` -> `disabled`) makes a new one.
function buildSandboxProviderPluginNotReadyResultJson(
  run: typeof heartbeatRuns.$inferSelect,
  failure: { provider: string; pluginKey: string; pluginStatus: string },
): Record<string, unknown> {
  const context = parseObject(run.contextSnapshot);
  return {
    configurationIncomplete: {
      reason: SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON,
      companyId: run.companyId,
      agentId: run.agentId,
      issueId: readNonEmptyString(context.issueId) ?? null,
      projectId: readNonEmptyString(context.projectId) ?? null,
      sandboxProvider: failure.provider,
      pluginKey: failure.pluginKey,
      pluginStatus: failure.pluginStatus,
      fingerprint: `sandbox_provider_plugin:${failure.pluginKey}:${failure.pluginStatus}`,
      missingBindings: [],
    },
  };
}

function buildUnresolvedWorkspaceBaseRefResultJson(
  run: typeof heartbeatRuns.$inferSelect,
  error: UnresolvedWorkspaceBaseRefError,
): Record<string, unknown> {
  const context = parseObject(run.contextSnapshot);
  const diagnostic = readUnresolvedWorkspaceBaseRefDiagnostic(error);
  return {
    configurationIncomplete: {
      reason: "workspace_base_ref_unresolved",
      ...(diagnostic ? { baseRefDiagnostic: diagnostic } : {}),
      companyId: run.companyId,
      agentId: run.agentId,
      issueId: readNonEmptyString(context.issueId) ?? null,
      projectId: readNonEmptyString(context.projectId) ?? null,
      requestedRef: error.requestedRef,
      defaultBranch: error.defaultBranch,
      attemptedRefs: error.attemptedRefs,
      fetchError: error.fetchError,
      fingerprint: `workspace_base_ref:${error.recoveryIdentityRef}`,
      missingBindings: [],
    },
  };
}

function isMaxTurnExhaustionRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  return Boolean(
    normalizeMaxTurnStopReason(resultJson.stopReason) ??
    normalizeMaxTurnStopReason(run.errorCode),
  );
}

// environment-runtime.ts's resolveSandboxProviderPlugin "not_ready" message,
// e.g. 'Sandbox provider "kubernetes" is installed via plugin
// "acme.kubernetes-sandbox-provider", but that plugin is currently error.'
// The plugin row exists but its status is `error` (a failed activation),
// `disabled` (an operator switched it off) or `upgrade_pending`. Unlike the
// worker restart window above, nothing on the run path ever changes that
// status: only an operator enabling the plugin, or a server boot that
// re-activates a bundled plugin, does. Re-running the agent produces the
// identical failure every time, so the setup catch classifies it as
// `configuration_incomplete` (routed to a human owner) instead of a retryable
// `setup_failed` that the scheduler would keep re-dispatching.
const SANDBOX_PROVIDER_PLUGIN_NOT_READY_RE =
  /sandbox provider "([^"]*)" is installed via plugin "([^"]*)", but that plugin is currently (error|disabled|upgrade_pending)\b/i;

export function parseSandboxProviderPluginNotReadyFailureMessage(
  value: unknown,
): { provider: string; pluginKey: string; pluginStatus: string } | null {
  if (typeof value !== "string") return null;
  const match = SANDBOX_PROVIDER_PLUGIN_NOT_READY_RE.exec(value);
  if (!match) return null;
  return {
    provider: match[1] ?? "",
    pluginKey: match[2] ?? "",
    pluginStatus: (match[3] ?? "").toLowerCase(),
  };
}

function mergeAdapterRecoveryMetadata(input: {
  resultJson: Record<string, unknown> | null | undefined;
  errorFamily?: string | null;
  retryNotBefore?: string | null;
}) {
  const errorFamily = readNonEmptyString(input.errorFamily);
  const retryNotBefore = readNonEmptyString(input.retryNotBefore);
  if (!input.resultJson && !errorFamily && !retryNotBefore)
    return input.resultJson ?? null;

  return {
    ...(input.resultJson ?? {}),
    ...(errorFamily ? { errorFamily } : {}),
    ...(retryNotBefore
      ? {
          retryNotBefore,
          transientRetryNotBefore: retryNotBefore,
          ...(errorFamily === "provider_quota"
            ? { providerQuotaRetryNotBefore: retryNotBefore }
            : {}),
        }
      : {}),
  };
}

function isConfigurationIncompleteFailure(
  error: unknown,
): error is ConfigurationIncompleteFailure {
  return error instanceof ConfigurationIncompleteFailure;
}

export function isConfigurationIncompleteFailedRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode"> | null | undefined,
) {
  return (
    run?.errorCode === CONFIGURATION_INCOMPLETE_FAILURE_CODE ||
    run?.errorCode === "model_not_found"
  );
}

/**
 * Failure signatures from sandbox→host git workspace reconciliation. These
 * describe the state of the SHARED workspace (divergent histories written by
 * different runs), not a defect in the agent that happened to run last —
 * putting the agent into a sticky `error` state over them removes a healthy
 * agent from rotation while leaving the actual problem (the workspace)
 * untouched. The run still fails and carries the full message.
 */
const WORKSPACE_SYNC_CONFLICT_SIGNATURES = [
  "Failed to merge concurrent remote git histories",
  "Failed to integrate concurrent remote git history",
  "did not send all necessary objects",
  "lacks these prerequisite commits",
];

export function isWorkspaceSyncConflictFailure(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return WORKSPACE_SYNC_CONFLICT_SIGNATURES.some((signature) =>
    message.includes(signature),
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function createHeartbeatRunCompletion(db: Db, dependencies: HeartbeatRunCompletionDependencies) {
  const {
    getRun,
    getAgent,
    resolveNormalizedUsageForSession,
    clearTaskSessions,
    upsertTaskSession,
    mergeRunStopMetadataForAgent,
    setRunStatusIfRunning,
    setWakeupStatus,
    appendRunEvent,
    classifyAndPersistRunLiveness,
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
    scheduleBoundedRetryForRun,
    scheduleInteractionContinuationInfrastructureRetryIfEligible,
    timerClaimWasFirstHeartbeat,
    releaseIssueExecutionAndPromote,
    finalizeAgentStatus,
    enqueueWakeup,
    issuesSvc,
    recovery,
    getCurrentUserRedactionOptions,
    budgetHooks,
    runLogStore,
    traceStore,
    processRunCancellationSettlements,
    failedProcessRunCancellations,
  } = dependencies;

  async function completeRun(input: CompleteHeartbeatRunInput) {
    const { run, agent, issueId, issueRef, signal, output, session, readFailureReportSecrets, adapterResult, sessionCodec, taskSessionForRun, sessionCompaction,
      configFreshnessResultMetadata, runLedgerScope, currentUserRedactionOptions,
      providerTraceCapture, onProviderTraceFinalized, issueContext, onLog } = input;
    const { runtimeForAdapter, previousSessionParams, taskKey, configuredModel, sessionConfigMetadata } = session;
    const { handle, outputProgressState, flushOutputProgress } = output;
    const processCancellation =
      processRunCancellationSettlements.get(run.id) ??
      failedProcessRunCancellations.get(run.id);
    await processCancellation?.settled;
    let outcome: RunSessionOutcome;
    const latestRun = await getRun(run.id);
    if (isHeartbeatRunTerminalStatus(latestRun?.status)) {
      outcome = latestRun.status;
    } else if (signal.aborted) {
      outcome = "cancelled";
    } else if (adapterResult.nativeFinalization) {
      const nativeTerminal =
        adapterResult.nativeFinalization.terminal.runTerminalState;
      outcome =
        nativeTerminal === "succeeded"
          ? "succeeded"
          : nativeTerminal === "cancelled"
            ? "cancelled"
            : "failed";
    } else if (adapterResult.timedOut) {
      outcome = "timed_out";
    } else if (adapterResult.resultJson?.status === "cancelled") {
      outcome = "cancelled";
    } else if (
      isSuccessfulClaudeTerminalCleanup(agent.adapterType, adapterResult, processCancellation?.failed) || (
        (adapterResult.exitCode ?? 0) === 0 &&
        !adapterResult.errorMessage &&
        !adapterResult.signal &&
        !processCancellation?.failed
      )
    ) {
      outcome = "succeeded";
    } else {
      outcome = "failed";
    }

    const nextSessionState = resolveNextSessionState({
      adapterType: agent.adapterType,
      codec: sessionCodec,
      adapterResult,
      outcome,
      previousParams: previousSessionParams,
      previousDisplayId: runtimeForAdapter.sessionDisplayId,
      previousLegacySessionId: runtimeForAdapter.sessionId,
    });
    const rawUsage = normalizeUsageTotals(adapterResult.usage);
    const sessionUsageResolution = await resolveNormalizedUsageForSession({
      agentId: agent.id,
      runId: run.id,
      sessionId:
        nextSessionState.displayId ?? nextSessionState.legacySessionId,
      rawUsage,
      usageBasis: adapterResult.usageBasis ?? null,
    });
    const normalizedUsage = sessionUsageResolution.normalizedUsage;
    const runErrorMessage =
      outcome === "cancelled"
        ? redactCurrentUserText(latestRun?.error ?? adapterResult.errorMessage ?? "Cancelled", currentUserRedactionOptions)
        : outcome === "succeeded"
          ? null
          : redactCurrentUserText(
              adapterResult.errorMessage ??
                (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
              currentUserRedactionOptions,
            );
    const recordedResponsibleUserDenialCode =
      normalizeResponsibleUserDenialCode(latestRun?.errorCode);
    const runErrorCode =
      outcome === "timed_out"
        ? "timeout"
        : outcome === "cancelled"
          ? (latestRun?.errorCode ?? "cancelled")
          : outcome === "failed"
            ? (adapterResult.errorCode ??
              recordedResponsibleUserDenialCode ??
              "adapter_failed")
            : null;

    let logSummary: {
      bytes: number | null;
      sha256?: string | null;
      compressed: boolean;
    } | null = null;
    if (handle) {
      logSummary = await runLogStore.finalize(handle);
    }
    const finalLogBytes = logSummary?.bytes;
    if (outputProgressState.pending && typeof finalLogBytes === "number") {
      outputProgressState.pending.bytes = finalLogBytes;
    }
    await flushOutputProgress({ force: true });

    if (providerTraceCapture) {
      try {
        await traceStore.finalize(run.id, run.companyId);
        onProviderTraceFinalized();
      } catch (error) {
        logger.warn(
          { error, runId: run.id },
          "provider trace finalization failed without affecting run outcome",
        );
      }
    }

    const status =
      outcome === "succeeded"
        ? "succeeded"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome === "timed_out"
            ? "timed_out"
            : "failed";

    const cacheAdjustedCostUsd = adapterResult.costUsdExact != null && adapterResult.cacheAdjustedCostUsd == null
      ? null : resolveCacheAdjustedCostUsd(adapterResult);
    const usageJson: Record<string, unknown> = {
      accountingReceiptReady: adapterResult.usageComplete !== false,
      costUsdExact: adapterResult.costUsdExact ?? null,
      providerRequestId: adapterResult.providerRequestId ?? null,
      ...(normalizedUsage ?? {}),
      ...(adapterResult.usageByModel ? { usageByModel: adapterResult.usageByModel } : {}),
      ...(rawUsage
        ? {
            rawInputTokens: rawUsage.inputTokens,
            rawInputIncludesCached: false,
            rawCachedInputTokens: rawUsage.cachedInputTokens,
            rawOutputTokens: rawUsage.outputTokens,
          }
        : {}),
      ...(sessionUsageResolution.derivedFromSessionTotals
        ? { usageSource: "session_delta" }
        : adapterResult.usageBasis === "per_run"
          ? { usageSource: "per_run" }
          : {}),
      ...((nextSessionState.displayId ??
      nextSessionState.legacySessionId)
        ? {
            persistedSessionId:
              nextSessionState.displayId ??
              nextSessionState.legacySessionId,
          }
        : {}),
      sessionReused:
        runtimeForAdapter.sessionId != null ||
        runtimeForAdapter.sessionDisplayId != null,
      taskSessionReused: taskSessionForRun != null,
      freshSession:
        runtimeForAdapter.sessionId == null &&
        runtimeForAdapter.sessionDisplayId == null,
      sessionRotated: sessionCompaction.rotate,
      sessionRotationReason: sessionCompaction.reason,
      configFreshness: configFreshnessResultMetadata,
      provider:
        readNonEmptyString(adapterResult.provider) ?? "unknown",
      biller: resolveLedgerBiller(adapterResult),
      model: readNonEmptyString(adapterResult.model) ?? "unknown",
      ...(adapterResult.costUsd != null
        ? { costUsd: adapterResult.costUsd }
        : {}),
      ...(cacheAdjustedCostUsd != null
        ? { cacheAdjustedCostUsd }
        : {}),
      pricingProvenance: adapterResult.pricingProvenance,
      costStatus: adapterResult.costStatus ?? resolveLedgerCostStatus({
        costUsd: cacheAdjustedCostUsd ?? (adapterResult.costUsdExact != null ? Number(adapterResult.costUsdExact) : null),
        billingType: normalizeLedgerBillingType(adapterResult.billingType),
        inputTokens: normalizedUsage?.inputTokens ?? 0,
        cachedInputTokens: normalizedUsage?.cachedInputTokens ?? 0,
        outputTokens: normalizedUsage?.outputTokens ?? 0,
      }),
      billingType: normalizeLedgerBillingType(
        adapterResult.billingType,
      ),
    };

    const persistedResultJson = cancellationResultJson(latestRun ?? run, outcome, mergeHeartbeatRunResultJson(
      mergeRunStopMetadataForAgent(agent, outcome, {
        resultJson: mergeAdapterRecoveryMetadata({
          resultJson: {
            ...(adapterResult.nativeFinalization || outcome === "cancelled"
              ? parseObject(latestRun?.resultJson)
              : {}),
            ...parseObject(adapterResult.resultJson),
            ...(adapterResult.executionRecovery
              ? { executionRecovery: adapterResult.executionRecovery }
              : {}),
            configFreshness: configFreshnessResultMetadata,
          },
          errorFamily: adapterResult.errorFamily ?? null,
          retryNotBefore: adapterResult.retryNotBefore ?? null,
        }),
        errorCode: runErrorCode,
        errorMessage: runErrorMessage,
      }),
      adapterResult.summary ?? null,
    ), runErrorCode, runErrorMessage);

    const ledgerScope = runLedgerScope;
    const finalRunPatch: Partial<typeof heartbeatRuns.$inferInsert> = {
      // Accounting must acknowledge even a proven pre-provider failure:
      // that transaction releases the reservation without creating a charge.
      costAccountingPending: true,
      finishedAt: new Date(),
      error: runErrorMessage,
      errorCode: runErrorCode,
      exitCode: adapterResult.exitCode,
      signal: adapterResult.signal,
      usageJson: { ...usageJson, ledgerScope },
      resultJson: persistedResultJson,
      sessionIdAfter:
        nextSessionState.displayId ?? nextSessionState.legacySessionId,
      stdoutExcerpt: output.stdoutExcerpt,
      stderrExcerpt: output.stderrExcerpt,
      logBytes: logSummary?.bytes,
      logSha256: logSummary?.sha256,
      logCompressed: logSummary?.compressed ?? false,
    };
    const persistedRunWrite = await setRunStatusIfRunning(
      run.id,
      status,
      finalRunPatch,
      { adapterErrorMeta: adapterResult.errorMeta, secretValues: readFailureReportSecrets() },
    );
    let persistedRun: typeof heartbeatRuns.$inferSelect | null =
      persistedRunWrite.run;
    if (!persistedRunWrite.updated) {
      persistedRun = null;
      // Native reconciliation can commit and project the terminal status in
      // the narrow window between adapter completion and this live write.
      // The status is authoritative, but it must not make us discard the
      // adapter's semantic result, usage, logs, or presentation decision.
      // Only complete the late metadata write when the reconciler chose the
      // same terminal status; a conflicting terminal outcome remains owned
      // by the path that won the compare-and-set. Owned legacy cancellation
      // likewise keeps the provider session, logs, and usage after Stop wins.
      if (
        (adapterResult.nativeFinalization ||
          (processCancellation && !processCancellation.failed && status === "cancelled")) &&
        persistedRunWrite.run?.status === status
      ) {
        persistedRun = await db
          .update(heartbeatRuns)
          .set({
            ...finalRunPatch,
            resultJson: preserveWorkspaceRestoreRecoveryMetadataSql(
              cancellationResultJson(persistedRunWrite.run, status, finalRunPatch.resultJson, runErrorCode, runErrorMessage) ?? null,
            ),

            usageJson: { ...parseObject(persistedRunWrite.run.usageJson), ...parseObject(finalRunPatch.usageJson) },
            finishedAt:
              persistedRunWrite.run.finishedAt ?? finalRunPatch.finishedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.status, status),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
      }
      if (!persistedRun) {
        await accountRunCost(db, run.id, budgetHooks).catch((err) => {
          logger.error({ err, runId: run.id }, "Late run accounting queued for recovery");
        });
        logger.info(
          {
            runId: run.id,
            attemptedStatus: status,
            currentStatus: persistedRunWrite.run?.status ?? null,
          },
          "skipping late run finalization because the run already left running state",
        );
        return;
      }
    }
    if (persistedRun) {
      // Accounting recovery is independent of workspace or issue finalization.
      await accountRunCost(db, persistedRun.id, budgetHooks).catch((err) => {
        logger.error({ err, runId: run.id }, "Run accounting queued for recovery");
      });
      persistedRun =
        (await classifyAndPersistRunLiveness(
          persistedRun,
          persistedResultJson,
        )) ?? persistedRun;
    }

    await setWakeupStatus(
      run.wakeupRequestId,
      outcome === "succeeded" ? "completed" : status,
      {
        finishedAt: new Date(),
        error: runErrorMessage,
      },
    );

    const finalizedRun = persistedRun ?? (await getRun(run.id));
    if (finalizedRun) {
      await appendRunEvent(finalizedRun, {
        eventType: "lifecycle",
        stream: "system",
        level: outcome === "succeeded" ? "info" : "error",
        message: `run ${outcome}`,
        payload: {
          status,
          exitCode: adapterResult.exitCode,
          ...(readRunCancellation(finalizedRun.resultJson) ? { cancellation: readRunCancellation(finalizedRun.resultJson) } : {}),
        },
      });
      try {
        await completeSkillTestRunForHeartbeatOutcome({
          run: finalizedRun,
          issueId,
          issueWorkMode: issueRef?.workMode ?? null,
          outcome,
          error: runErrorMessage,
        });
      } catch (err) {
        logger.warn(
          { err, runId: finalizedRun.id, issueId },
          "failed to complete skill test run after heartbeat finalization",
        );
        await onLog(
          "stderr",
          `[paperclip] Failed to complete skill test run: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      const livenessRun = finalizedRun;
      await refreshContinuationSummaryForRun(livenessRun, agent);
      const skipRunIssueComment =
        parseObject(livenessRun.contextSnapshot).skipIssueComment === true;
      let resolvedPresentationDecision: RunPresentationDecision | null =
        null;
      try {
        const existingRunComment = issueId
          ? await findRunIssueComment(
              livenessRun.id,
              livenessRun.companyId,
              issueId,
              persistedResultJson,
            )
          : null;
        const finalAgentMessage =
          await findLatestCompletedFinalAgentMessage(
            livenessRun.id,
            livenessRun.companyId,
          );
        const externalChatPresentationCandidate =
          isExternalChatPresentationContext(livenessRun.contextSnapshot) ||
          parseObject(livenessRun.contextSnapshot).source === "tool_action_review" ||
          String(parseObject(livenessRun.contextSnapshot).source ?? "").startsWith("issue.comment") ||
          parseObject(livenessRun.contextSnapshot).source === "issue.update";
        const externalChatPresentationAuthorization =
          issueId && externalChatPresentationCandidate
            ? await resolveChatRunPresentationAuthorizationReason(db, {
                companyId: livenessRun.companyId,
                issueId,
                runId: livenessRun.id,
              })
            : null;
        const externalChatPresentationContext = isExternalChatPresentationContext(
          livenessRun.contextSnapshot,
          externalChatPresentationAuthorization === CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON,
        );
        const resolved = resolveHeartbeatRunResponse({
          resultJson: persistedResultJson,
          conversationTurnFinished: isConversation(issueContext) && livenessRun.status === "succeeded"
            && persistedResultJson?.finalizationReasonCode === "conversation_turn_finished",
          existingComment: existingRunComment,
          finalAgentMessage,
          preferFinalResponseOverExistingComment:
            externalChatPresentationContext,
          externalChatReviewResponseSummaryAuthorized:
            persistedResultJson?.finalizationReasonCode ===
              "governed_response_waiting" &&
            externalChatPresentationAuthorization ===
              CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON,
          externalChatResponseWakeSummaryAuthorized:
            Boolean(adapterResult.nativeFinalization) &&
            externalChatPresentationAuthorization ===
              CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON,
        });
        let presentationDecision: RunPresentationDecision =
          resolved.decision;

        if (
          issueId &&
          !skipRunIssueComment &&
          presentationDecision.commentAction === "create" &&
          resolved.text
        ) {
          // The presentation resolver exposes only the final assistant
          // surface selected from completed final messages or accepted
          // semantic results. For an exactly bound external-chat run,
          // authorize that narrow presentation as the provider reply;
          // ordinary internal runs retain the private default.
          const presentationAuthorizationReason =
            await resolveChatRunPresentationAuthorizationReason(db, {
              companyId: livenessRun.companyId,
              issueId,
              runId: livenessRun.id,
            });
          const comment = await issuesSvc.addComment(
            issueId,
            resolved.text,
            { agentId: agent.id, runId: livenessRun.id },
            { authorizationReason: presentationAuthorizationReason, completionReply: true },
          );
          presentationDecision = {
            ...presentationDecision,
            commentId: comment.id,
            reasonCodes: [
              ...presentationDecision.reasonCodes,
              "resolved_response_materialized",
            ],
          };
          await logActivity(db, {
            companyId: livenessRun.companyId,
            actorType: "agent",
            actorId: agent.id,
            agentId: agent.id,
            runId: livenessRun.id,
            issueId,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: issueId,
            details: {
              commentId: comment.id,
              bodySnippet: comment.body.slice(0, 120),
              identifier: issueRef?.identifier ?? null,
              issueTitle: issueRef?.title ?? null,
              authorizationReason: presentationAuthorizationReason,
              source: "run_presentation_resolver",
              presentationSource: presentationDecision.chosenSource,
            },
          });
        } else if (presentationDecision.commentAction === "create") {
          presentationDecision = {
            ...presentationDecision,
            commentAction: "none",
            reasonCodes: [
              ...presentationDecision.reasonCodes,
              skipRunIssueComment
                ? "issue_comment_suppressed"
                : "run_has_no_issue",
            ],
          };
        }

        await db
          .update(heartbeatRuns)
          .set({
            resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ presentationDecision })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, livenessRun.id));
        await appendRunEvent(livenessRun, {
          eventType: "run.presentation.resolved",
          stream: "system",
          level: "info",
          message: "run presentation resolved",
          payload: { presentationDecision },
        });
        resolvedPresentationDecision = presentationDecision;
      } catch (err) {
        await onLog(
          "stderr",
          `[paperclip] Failed to resolve run presentation: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      if (outcome === "failed" && isMaxTurnExhaustionRun(livenessRun)) {
        const policy = parseMaxTurnContinuationPolicy(agent);
        if (policy.enabled && policy.maxAttempts > 0) {
          await scheduleBoundedRetryForRun(livenessRun, agent, {
            retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
            wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
            maxAttempts: policy.maxAttempts,
            delayMs: policy.delayMs,
          });
        } else {
          await appendRunEvent(livenessRun, {
            eventType: "lifecycle",
            stream: "system",
            level: "warn",
            message:
              "Max-turn continuation suppressed because the policy is disabled",
            payload: {
              retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
              policy,
            },
          });
        }
      } else if (
        outcome === "failed" &&
        readTransientRecoveryContractFromRun(livenessRun)
      ) {
        await scheduleBoundedRetryForRun(livenessRun, agent);
      } else if (
        outcome === "failed" &&
        !(await legacyExecutionNeedsReconciliationWithEvidence(db, livenessRun))
      ) {
        await scheduleInteractionContinuationInfrastructureRetryIfEligible(
          livenessRun,
          agent,
        );
      }
      const issueCommentPolicyResult = await finalizeIssueCommentPolicy(
        livenessRun,
        agent,
        resolvedPresentationDecision,
      );
      const conversationSettled = await settleConversationTurn(db, livenessRun);
      await releaseIssueExecutionAndPromote(livenessRun, {
        suppressImmediateRecovery: conversationSettled ||
          readNonEmptyString(
            parseObject(livenessRun.contextSnapshot).goalControlRequestId,
          ) !== null ||
          parseObject(livenessRun.contextSnapshot)
            .resumeSessionGoalHeartbeat === true,
      });
      if (!conversationSettled) {
        await handleIssueReviewPathDisposition(livenessRun);
        if (livenessRun.runtimeMode !== "native") {
          await recovery.reconcileLegacyContinuation(livenessRun.id);
        } else {
          await handleRunLivenessContinuation(livenessRun);
          await handleSuccessfulRunHandoff(
            issueCommentPolicyResult.outcome === "retry_queued" ||
              issueCommentPolicyResult.outcome === "retry_exhausted"
              ? { ...livenessRun, issueCommentStatus: issueCommentPolicyResult.outcome }
              : livenessRun,
            agent,
          );
        }
      }
      if (
        outcome === "succeeded" &&
        issueId &&
        parseObject(adapterResult.resultJson).goalRolloverRequired === true
      ) {
        const rolloverProjection = await runnerGoalService(db).projection(
          livenessRun.companyId,
          issueId,
          agent.id,
        );
        if (rolloverProjection?.goal?.status === "active") {
          await enqueueWakeup(agent.id, {
            source: "automation",
            triggerDetail: "system",
            reason: "goal_control",
            payload: {
              issueId,
              intent: "goal_rollover",
              predecessorRunId: livenessRun.id,
            },
            idempotencyKey: `goal_rollover:${livenessRun.id}`,
            requestedByActorType: "system",
            contextSnapshot: {
              issueId,
              taskKey: issueId,
              resumeSessionGoalHeartbeat: true,
              skipIssueComment: true,
              goalRolloverFromRunId: livenessRun.id,
            },
          });
        }
      }

      // Dependency wake re-check: if this run's issue was marked done mid-run,
      // the route-time `issue_blockers_resolved` wake may have been gated by
      // workspace finalization or merged into this run. Reuse the level-triggered
      // dependency backstop so finalize and periodic recovery share idempotency,
      // readiness, active-path, and observability rules.
      if (issueId && finalizedRun) {
        try {
          const blockerIssueStatus = await db
            .select({ status: issues.status })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0]?.status ?? null);
          if (blockerIssueStatus === "done") {
            await recovery.reconcileResolvedDependencyWakeBackstop({
              runId: finalizedRun.id,
              companyId: finalizedRun.companyId,
              blockerIssueId: issueId,
              source: "workspace.finalize",
            });
          }
        } catch (finalizeWakeErr) {
          logger.warn(
            { err: finalizeWakeErr, runId: run.id, issueId },
            "failed to evaluate dependent wakes after workspace_finalize",
          );
        }
      }
    }

    if (finalizedRun) {
      await updateRuntimeState(
        agent,
        finalizedRun,
        adapterResult,
        {
          legacySessionId: nextSessionState.legacySessionId,
        },
        normalizedUsage,
      );
      if (taskKey) {
        if (
          adapterResult.clearSession ||
          (!nextSessionState.params && !nextSessionState.displayId)
        ) {
          await clearTaskSessions(agent.companyId, agent.id, {
            taskKey,
            adapterType: agent.adapterType,
            expectedRunId: finalizedRun.id,
          });
        } else {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson:
              attachPaperclipSessionMetadataToSessionParams(
                nextSessionState.params,
                configuredModel,
                sessionConfigMetadata,
              ),
            sessionDisplayId: nextSessionState.displayId,
            lastRunId: finalizedRun.id,
            lastError: runErrorMessage,
          });
        }
      }
    }
    await finalizeAgentStatus(agent.id, outcome, runErrorMessage, {
      keepIdleOnFailure:
        outcome === "failed" &&
        ((finalizedRun
          ? readHeartbeatRunErrorFamily(finalizedRun) === "provider_quota"
          : runErrorCode === "provider_quota") ||
          isWorkspaceSyncConflictFailure(adapterResult.errorMessage)),
      wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
    });
  }

  async function failRun(input: FailHeartbeatRunInput) {
    const { run, agent, issueId, issueRef, signal, output, session, readFailureReportSecrets, runId, err, identityRedactor, requiredWorkspaceRestoreEvidence,
      legacyAdapterEntered, goalCheckpointSession, previousSessionDisplayId, taskSession } = input;
    const { runtimeForAdapter, previousSessionParams, taskKey, configuredModel, sessionConfigMetadata } = session;
    const { handle, outputProgressState, flushOutputProgress } = output;
    // A process adapter may throw while its owned Stop is joining the
    // child. Let the cancellation write settle before attempting failure.
    await processRunCancellationSettlements.get(run.id)?.settled;
    const message = redactCurrentUserText(
      identityRedactor.redact(err instanceof Error ? err.message : "Unknown adapter failure"),
      await getCurrentUserRedactionOptions(),
    );
    const workspaceValidationFailure = isWorkspaceValidationFailure(err)
      ? err
      : null;
    const configurationIncompleteFailure = isConfigurationIncompleteFailure(
      err,
    )
      ? err
      : null;
    const recordedResponsibleUserDenialCode =
      normalizeResponsibleUserDenialCode(
        (await getRun(run.id).catch(() => null))?.errorCode,
      );
    // The runtime resolution is scoped to the adapter try block. The
    // durable coordinator is also the stronger authority here: legacy
    // runs simply have no row, while native result-less exhaustion keeps
    // its named failure instead of being flattened to `adapter_failed`.
    const nativeTerminalFailureCode = await db
      .select({
        phase: nativeRunFinalizations.phase,
        resultId: nativeRunFinalizations.resultId,
        failureCode: nativeRunFinalizations.failureCode,
      })
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, run.id))
      .limit(1)
      .then((rows) => {
        const coordinator = rows[0];
        return coordinator?.phase === "terminal_failure" &&
          coordinator.resultId === null
          ? coordinator.failureCode
          : null;
      })
      .catch(() => null);
    const failureErrorCode =
      workspaceValidationFailure?.code ??
      configurationIncompleteFailure?.code ??
      nonRetryablePreflightFailureCode(err) ??
      recordedResponsibleUserDenialCode ??
      nativeTerminalFailureCode ??
      "adapter_failed";
    logger.error({ err: identityRedactor.redact({ message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }), runId }, "heartbeat execution failed");

    let logSummary: {
      bytes: number | null;
      sha256?: string | null;
      compressed: boolean;
    } | null = null;
    if (handle) {
      try {
        logSummary = await runLogStore.finalize(handle);
      } catch (finalizeErr) {
        logger.warn(
          { err: finalizeErr, runId },
          "failed to finalize run log after error",
        );
      }
    }
    const finalLogBytes = logSummary?.bytes;
    if (outputProgressState.pending && typeof finalLogBytes === "number") {
      outputProgressState.pending.bytes = finalLogBytes;
    }
    await flushOutputProgress({ force: true }).catch((flushErr) => {
      logger.warn(
        { err: flushErr, runId },
        "failed to flush run output progress after error",
      );
    });

    const stoppedDuringFailure = signal.aborted;
    const stopSnapshot = stoppedDuringFailure ? await getRun(run.id) : null;
    const failureOutcome = stoppedDuringFailure ? "cancelled" : "failed";
    const failedRunWrite = await setRunStatusIfRunning(run.id, failureOutcome, {
      error: message,
      errorCode: stopSnapshot?.errorCode ?? failureErrorCode,
      finishedAt: new Date(),
      resultJson: mergeRunStopMetadataForAgent(agent, failureOutcome, {
        errorCode: failureErrorCode,
        errorMessage: message,
        resultJson: {
          ...parseObject(stopSnapshot?.resultJson),
          ...requiredWorkspaceRestoreEvidence,
          ...(workspaceValidationFailure?.resultJson ??
            configurationIncompleteFailure?.resultJson ??
            {}),
          ...(!legacyAdapterEntered && run.runtimeMode !== "native"
            ? {
                executionRecovery: {
                  kind: "bootstrap",
                  providerWorkStarted: false,
                },
              }
            : {}),
        },
      }),
      stdoutExcerpt: output.stdoutExcerpt,
      stderrExcerpt: output.stderrExcerpt,
      logBytes: logSummary?.bytes,
      logSha256: logSummary?.sha256,
      logCompressed: logSummary?.compressed ?? false,
    }, { error: err, phase: "execute", secretValues: readFailureReportSecrets() });
    if (
      !failedRunWrite.updated &&
      !(
        nativeTerminalFailureCode && failedRunWrite.run?.status === "failed"
      )
    ) {
      logger.info(
        {
          runId: run.id,
          attemptedStatus: "failed",
          currentStatus: failedRunWrite.run?.status ?? null,
        },
        "skipping late adapter failure finalization because the run already left running state",
      );
      return;
    }

    const failedRun = failedRunWrite.run;
    await setWakeupStatus(run.wakeupRequestId, "failed", {
      finishedAt: new Date(),
      error: message,
    });

    if (failedRun) {
      await appendRunEvent(failedRun, {
        eventType: "error",
        stream: "system",
        level: "error",
        message,
      });
      const livenessRun =
        (await classifyAndPersistRunLiveness(failedRun)) ?? failedRun;
      try {
        await completeSkillTestRunForHeartbeatOutcome({
          run: livenessRun,
          issueId,
          issueWorkMode: issueRef?.workMode ?? null,
          outcome: "failed",
          error: message,
        });
      } catch (err) {
        logger.warn(
          { err, runId: livenessRun.id, issueId },
          "failed to complete skill test run after heartbeat adapter failure",
        );
      }
      await refreshContinuationSummaryForRun(livenessRun, agent);
      if (
        !isWorkspaceValidationFailedRun(livenessRun) &&
        !isConfigurationIncompleteFailedRun(livenessRun)
      ) {
        await finalizeIssueCommentPolicy(livenessRun, agent);
      }
      await scheduleInteractionContinuationInfrastructureRetryIfEligible(
        livenessRun,
        agent,
      );
      await releaseIssueExecutionAndPromote(livenessRun, {
        // Native recovery owns the original heartbeat run through
        // exhaustion. Once its durable coordinator has classified a
        // terminal failure, generic issue recovery must not create a
        // replacement retryOfRunId chain for the same provider work.
        suppressImmediateRecovery: nativeTerminalFailureCode !== null,
      });
      await handleIssueReviewPathDisposition(livenessRun);

      await updateRuntimeState(
        agent,
        livenessRun,
        {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        },
        {
          legacySessionId: runtimeForAdapter.sessionId,
        },
      );

      if (
        taskKey &&
        (goalCheckpointSession.current ||
          previousSessionParams ||
          previousSessionDisplayId ||
          taskSession)
      ) {
        await upsertTaskSession({
          companyId: agent.companyId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          taskKey,
          sessionParamsJson:
            goalCheckpointSession.current?.params ??
            attachPaperclipSessionMetadataToSessionParams(
              previousSessionParams,
              configuredModel,
              sessionConfigMetadata,
            ),
          sessionDisplayId:
            goalCheckpointSession.current?.displayId ??
            previousSessionDisplayId,
          lastRunId: failedRun.id,
          lastError: message,
        });
      }
    }

    await finalizeAgentStatus(agent.id, "failed", message, {
      wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
      keepIdleOnFailure:
        Boolean(nonRetryablePreflightFailureCode(err)) ||
        isWorkspaceSyncConflictFailure(message),
    });
  }

  async function failRunSetup(input: FailHeartbeatRunSetupInput) {
    const { run, runId, outerErr, identityRedactor, readFailureReportSecrets } = input;
    // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
    // The inner catch did not fire, so we must record the failure here.
    const message = redactCurrentUserText(
      identityRedactor.redact(outerErr instanceof Error
        ? outerErr.message
        : "Unknown setup failure"),
      await getCurrentUserRedactionOptions(),
    );
    // A missing secret/env binding is a known pre-dispatch configuration gap,
    // not an opaque setup crash. Surface it with its own errorCode so the
    // recovery path routes it to a human owner instead of looping retries.
    const workspaceValidationSetupFailure = isWorkspaceValidationFailure(
      outerErr,
    )
      ? outerErr
      : null;
    const configurationIncompleteSetupFailure =
      isConfigurationIncompleteFailure(outerErr) ? outerErr : null;
    const unresolvedBaseRefSetupFailure = isUnresolvedWorkspaceBaseRefError(
      outerErr,
    )
      ? outerErr
      : null;
    // A sandbox provider plugin stuck in error/disabled/upgrade_pending
    // fails every lease the same way until an operator acts, so it is a
    // configuration gap, not a transient setup failure.
    const sandboxProviderPluginNotReadySetupFailure =
      parseSandboxProviderPluginNotReadyFailureMessage(
        outerErr instanceof Error ? outerErr.message : null,
      );
    const recordedResponsibleUserDenialCode =
      normalizeResponsibleUserDenialCode(
        (await getRun(runId).catch(() => null))?.errorCode,
      );
    const nonRetryablePreflightCode =
      nonRetryablePreflightFailureCode(outerErr);
    const workspaceGitScanFailure = isWorkspaceGitScanError(outerErr) ? outerErr : null;
    const setupFailureErrorCode =
      workspaceGitScanFailure?.code ??
      workspaceValidationSetupFailure?.code ??
      configurationIncompleteSetupFailure?.code ??
      (unresolvedBaseRefSetupFailure ||
      sandboxProviderPluginNotReadySetupFailure
        ? CONFIGURATION_INCOMPLETE_FAILURE_CODE
        : null) ??
      recordedResponsibleUserDenialCode ??
      nonRetryablePreflightCode ??
      "setup_failed";
    logger.error(
      { err: identityRedactor.redact({ message: outerErr instanceof Error ? outerErr.message : String(outerErr), stack: outerErr instanceof Error ? outerErr.stack : undefined }), runId },
      "heartbeat execution setup failed",
    );
    const setupFailureAgent = await getAgent(run.agentId).catch(() => null);
    // The structured failure payload drives the recovery notice and next
    // action, so it is persisted even when the agent lookup failed and the
    // agent-scoped stop metadata cannot be merged in.
    const setupFailureDetails =
      (workspaceGitScanFailure ? {
        workspaceGitScan: {
          code: workspaceGitScanFailure.code,
          phase: "workspace_setup",
          retryable: isTransientWorkspaceGitScanCode(workspaceGitScanFailure.code),
        },
      } : null) ??
      workspaceValidationSetupFailure?.resultJson ??
      configurationIncompleteSetupFailure?.resultJson ??
      (unresolvedBaseRefSetupFailure
        ? buildUnresolvedWorkspaceBaseRefResultJson(
            run,
            unresolvedBaseRefSetupFailure,
          )
        : null) ??
      (sandboxProviderPluginNotReadySetupFailure
        ? buildSandboxProviderPluginNotReadyResultJson(
            run,
            sandboxProviderPluginNotReadySetupFailure,
          )
        : null);
    const connectionFailure = readGitConnectionFailure(outerErr);
    const setupFailureResultJson = {
      ...setupFailureDetails,
      ...(connectionFailure ? { connectionFailure } : {}),
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
    const setupFailureWrite = await setRunStatusIfRunning(runId, "failed", {
      error: message,
      errorCode: setupFailureErrorCode,
      finishedAt: new Date(),
      ...(setupFailureAgent
        ? {
            resultJson: mergeRunStopMetadataForAgent(
              setupFailureAgent,
              "failed",
              {
                errorCode: setupFailureErrorCode,
                errorMessage: message,
                resultJson: setupFailureResultJson,
              },
            ),
          }
        : setupFailureResultJson
          ? { resultJson: setupFailureResultJson }
          : {}),
    }, { error: outerErr, phase: "setup", secretValues: readFailureReportSecrets() }).catch(() => ({ run: null, updated: false as const }));
    if (!setupFailureWrite.updated) {
      logger.info(
        {
          runId,
          attemptedStatus: "failed",
          currentStatus: setupFailureWrite.run?.status ?? null,
        },
        "skipping late setup failure finalization because the run already left running state",
      );
    } else {
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      }).catch(() => undefined);
    }
    const failedRun = await getRun(runId).catch(() => null);
    if (setupFailureWrite.updated && failedRun) {
      // Emit a run-log event so the failure is visible in the run timeline,
      // consistent with what the inner catch block does for adapter failures.
      await appendRunEvent(failedRun, {
        eventType: "error",
        stream: "system",
        level: "error",
        message,
      }).catch(() => undefined);
      const livenessRun = await classifyAndPersistRunLiveness(
        failedRun,
      ).catch(() => failedRun);
      const setupFailureIssueId = readNonEmptyString(
        parseObject(livenessRun.contextSnapshot).issueId,
      );
      if (setupFailureIssueId) {
        await completeSkillTestRunForHeartbeatOutcome({
          run: livenessRun,
          issueId: setupFailureIssueId,
          outcome: "failed",
          error: message,
        }).catch((completionErr) => {
          logger.warn(
            {
              err: completionErr,
              runId: livenessRun.id,
              issueId: setupFailureIssueId,
            },
            "failed to complete skill test run after heartbeat setup failure",
          );
        });
      }
      const failedAgent =
        setupFailureAgent ??
        (await getAgent(run.agentId).catch(() => null));
      if (failedAgent) {
        await refreshContinuationSummaryForRun(
          livenessRun,
          failedAgent,
        ).catch(() => undefined);
        if (
          !isWorkspaceValidationFailedRun(livenessRun) &&
          !isConfigurationIncompleteFailedRun(livenessRun)
        ) {
          await finalizeIssueCommentPolicy(livenessRun, failedAgent).catch(
            () => undefined,
          );
        }
        // No provider work began. Retry temporary host scan failures with
        // the existing durable failure budget, before releasing execution.
        // Generic recovery must not grant a second budget on exhaustion.
        await (isTransientWorkspaceGitScanCode(livenessRun.errorCode)
          ? scheduleBoundedRetryForRun(livenessRun, failedAgent)
          : scheduleInteractionContinuationInfrastructureRetryIfEligible(livenessRun, failedAgent)
        ).catch((retryError) => {
          logger.warn(
            { err: retryError, runId: livenessRun.id },
            "failed to schedule interaction continuation retry after setup failure",
          );
        });
      }
      await releaseIssueExecutionAndPromote(livenessRun, {
        suppressImmediateRecovery:
          readNonEmptyString(
            parseObject(livenessRun.contextSnapshot).goalControlRequestId,
          ) !== null ||
          parseObject(livenessRun.contextSnapshot)
            .resumeSessionGoalHeartbeat === true,
      }).catch((releaseError) => {
        logger.error(
          { err: releaseError, runId },
          "failed to release issue execution after heartbeat setup failure",
        );
      });
      await handleIssueReviewPathDisposition(livenessRun).catch(
        (reviewPathError) => {
          logger.error(
            { err: reviewPathError, runId },
            "failed to evaluate review-path disposition after heartbeat setup failure",
          );
        },
      );
    }
    // Ensure the agent is not left stuck in "running" if the setup-failure
    // path owned the terminal transition. If another path already finalized
    // the run, keep that terminal outcome authoritative.
    if (setupFailureWrite.updated) {
      await finalizeAgentStatus(run.agentId, "failed", message, {
        wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
        // Low-trust admission failures are task/principal preconditions,
        // not evidence that the immutable endpoint agent is unhealthy.
        // Keep the failed run and its safe provider refusal authoritative,
        // but return the agent to idle so clients do not also announce a
        // misleading agent-wide error for the same rejected chat turn.
        keepIdleOnFailure: Boolean(nonRetryablePreflightCode),
      }).catch(() => undefined);
    }
  }

  return { completeRun, failRun, failRunSetup };
}
