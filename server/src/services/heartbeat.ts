import { externalConversationSettlementWork } from "./external-conversation-settlement-work.js";
import { nativeRecoveryNoticeWork } from "./native-runtime/native-recovery-notice-work.js";
import { nativeRunProjectionWork } from "./native-runtime/native-run-projection-work.js";
import { nativeResultCommitWork } from "./native-runtime/native-result-commit-work.js";
import { nativeStatusReassessmentWork } from "./native-runtime/native-status-reassessment-work.js";
import { registerNativeReviewResponseWork } from "./native-runtime/native-review-response-work.js";
import { registerNativeResponsePresentationWork } from "./native-runtime/native-response-presentation-work.js";
import { registerNativePendingEffectWork } from "./native-runtime/native-pending-effect-work.js";
import { registerUnsafeWorkspaceExportWork } from "./native-runtime/native-workspace-export-recovery.js";
import { registerAutomaticCompletionReviewWork } from "./native-runtime/automatic-completion-reviews.js";
import { registerObsoletePolicyReviewWork } from "./native-runtime/obsolete-policy-reviews.js";
import { registerCancelledWorkspacePreservationWork } from "./native-runtime/native-failed-workspace-recovery.js";
import { readUpgradeReadiness } from "./heartbeat/upgrade-readiness.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { writeExecutionControl } from "./execution-control-notifications.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { promptInjectionPreventionService } from "./prompt-injection-prevention.js";
import { createHeartbeatAgentStatus } from "./heartbeat/agent-status.js";
import { heartbeatExternalProvider, nativeRuntimeHasInstructionFilesystem } from "./heartbeat/external-provider.js";
import { pendingCaseHandoffForRun, recordCaseHandoffExecutionReleased, recordLegacyCaseHandoffCleanupIntent, recordLegacyCaseHandoffCleanupVerified } from "./heartbeat/case-handoff-lifecycle.js";
import { hasStoppedLocalProcessTree, legacyAdapterNeedsLocalProcessSettlement } from "./heartbeat/process-settlement.js";
import { dotRunnerBroker } from "./dot-runner-broker.js";
import { withRunExecutionTiming, measureRunPhase, measureWorkspaceSyncPhase, isWorkspaceSyncDetailPhase } from "./execution-preparation-timing.js";
import { createHeartbeatPreparationTiming } from "./heartbeat/preparation-timing.js";
import { createHeartbeatInstructionCopyRelease, createHeartbeatInstructionWorkingCopy } from "./heartbeat/instruction-working-copy.js";
import { prepareHeartbeatRuntimeServiceIntents, startHeartbeatRuntimeServices, recordHeartbeatAdapterRuntimeServices } from "./heartbeat/runtime-services.js";
import { bindHeartbeatRunnerHomeMode, prepareHeartbeatExecutionConfiguration } from "./heartbeat/execution-configuration.js";
import { createHeartbeatRunOutput } from "./heartbeat/run-output.js";
import { prepareHeartbeatSession, resolveHeartbeatAdapterSession } from "./heartbeat/session-preparation.js";
import { prepareHeartbeatTaskContext } from "./heartbeat/task-context.js";
import { selectHeartbeatEnvironment } from "./heartbeat/environment-selection.js";
import { reconcileMuseNativeTerminalRun } from "./native-runtime/muse-terminal-reconciliation.js";
import { prepareHeartbeatWorkspace } from "./heartbeat/workspace-preparation.js";
import { executeHeartbeatRuntime, NativeSessionResumeScheduledError, NativeWorkspaceFinalizeScheduledError } from "./heartbeat/runtime-execution.js";
import { preserveNativeFailedWorkspace } from "./native-runtime/native-failed-workspace-recovery.js";
import { nativeRunHasNoWorkspaceAccess } from "./workspace-restore-recovery-state.js";
import { selectHeartbeatRuntime } from "./heartbeat/runtime-selection.js";
import { createHeartbeatRunCompletion } from "./heartbeat/run-completion.js";
export {
  MAX_TURN_CONTINUATION_WAKE_REASON,
  parseSandboxProviderPluginNotReadyFailureMessage,
  isConfigurationIncompleteFailedRun,
  isWorkspaceSyncConflictFailure,
} from "./heartbeat/run-completion.js";
import {
  createHeartbeatScheduling,
  formatIssueIdentifierLink,
} from "./heartbeat/scheduling.js";
import { canApplyTaskWorkspaceSelectionAtAdmission, taskWorkspaceRuntimeSelectionEnabled } from "./execution-workspace-policy.js";
import { agentExecutionsHaveStopped } from "./agent-execution-stop.js";
import {
  cancelHeartbeatNativeRun,
  terminateHeartbeatRunProcess,
  providerResourceDispositionForTerminalRun,
  createHeartbeatRunControl,
  type CancelRunOptions,
} from "./heartbeat/run-control.js";
export {
  leaseReleaseStatusForRunStatus,
  providerResourceDispositionForTerminalRun,
  cancelHeartbeatNativeRun,
} from "./heartbeat/run-control.js";
import {
  isHeartbeatRunTerminalStatus,
  decorateHeartbeatRunRuntimeStatus,
  createHeartbeatLifecycle,
  persistHeartbeatRunProcessMetadata,
} from "./heartbeat/run-lifecycle.js";
export {
  redactDetectedSuccessfulRunProgressSummaryForBoard,
  redactSuccessfulRunHandoffEvidence,
  persistHeartbeatRunProcessMetadata,
  resolveSkillTestRunCompletionForHeartbeatOutcome,
} from "./heartbeat/run-lifecycle.js";
import {
  shouldDeferFollowupWakeForSameIssue,
  shouldQueueFollowupForRunningIssueWake,
  DEFERRED_WAKE_CONTEXT_KEY,
  createHeartbeatQueue,
} from "./heartbeat/queue.js";
export {
  shouldDeferFollowupWakeForSameIssue,
  shouldQueueFollowupForRunningIssueWake,
} from "./heartbeat/queue.js";
import {
  isProcessAlive,
  createHeartbeatRecovery,
} from "./heartbeat/recovery.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  isWorkspaceBusyDeferral,
  createHeartbeatRetries,
} from "./heartbeat/retries.js";
export {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  WORKSPACE_BUSY_RETRY_WAKE_REASON,
  WORKSPACE_BUSY_ERROR_CODE,
  WORKSPACE_BUSY_RETRY_BASE_DELAY_MS,
  WORKSPACE_BUSY_RETRY_JITTER_MS,
  WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
  type SharedWorkspaceHolder,
  WorkspaceBusyDeferral,
  computeWorkspaceBusyRetryDelayMs,
  computeBoundedTransientHeartbeatRetrySchedule,
} from "./heartbeat/retries.js";
import {
  EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON,
  deriveTaskKeyWithHeartbeatFallback,
  getAdapterSessionCodec,
  shouldResetTaskSessionForWake,
  normalizeSessionParams,
  normalizeResumeParamsForAdapter,
  truncateDisplayId,
  resolveLedgerScopeForRun,
  resolveNextSessionState,
  resolveCacheAdjustedCostUsd,
  resolveLedgerCostStatus,
  createHeartbeatRunState,
} from "./heartbeat/run-state.js";
export {
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
  normalizeBilledCostCents,
  resolveLedgerCostStatus,
  resolveCacheAdjustedCostUsd,
  resolveLedgerScopeForRun,
  buildExplicitResumeSessionOverride,
  normalizeAdapterRunUsage,
  parseSessionCompactionPolicy,
  deriveTaskKeyWithHeartbeatFallback,
  shouldResetTaskSessionForWake,
  describeSessionResetReason,
  normalizeSessionParams,
  resolveNextSessionState,
} from "./heartbeat/run-state.js";

import {
  ConfigurationIncompleteFailure,
  deriveTaskKey,
  type WakeupOptions,
  mergeCoalescedContextSnapshot,
  PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY,
  PAPERCLIP_HARNESS_CHECKOUT_KEY,
  attestReviewedExternalChatRun,
  resolveAcceptedPlanWakeRoutingDecision,
  clearInteractionContinuationWakeContext,
  PAPERCLIP_WAKE_PAYLOAD_KEY,
  MANAGED_GITHUB_TOKEN_KEYS,
  configuredPaperclipApiBaseUrl,
  createHeartbeatRunPreparation,
} from "./heartbeat/run-preparation.js";
export {
  ConfigurationIncompleteFailure,
  resolveExecutionRunAdapterConfig,
  extractMentionedSkillIdsFromSources,
  applyRunScopedMentionedSkillKeys,
  revokeHeartbeatRunGatewayTokens,
  buildPaperclipRuntimeMcpServers,
  createManagedMcpRunConfig,
  mergeCoalescedContextSnapshot,
  resolveExternalChatWakeProvider,
  attestReviewedExternalChatRun,
  buildPaperclipWakePayload,
} from "./heartbeat/run-preparation.js";
import {
  resolveRuntimeSessionParamsForWorkspace,
  buildRunWorkspaceHints,
  buildReferencedProjectRunObservability,
  assertGitSensitiveAdapterWorkspaceValid,
  createHeartbeatWorkspaceResolver,
} from "./heartbeat/workspaces.js";
export {
  WorkspaceValidationFailure,
  requiresPushCapabilityPreflight,
  applyPersistedExecutionWorkspaceConfig,
  mergeExecutionWorkspaceMetadataForPersistence,
  resolveExecutionWorkspaceBranchOwnership,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  preflightLowTrustWorkspaceIsolation,
  resolveWorkspaceAfterLowTrustPreflight,
  ensureManagedProjectWorkspace,
  prepareProjectRepositoryWorkspaces,
  type ResolveAdditionalProjectWorkspaceDeps,
  resolveAdditionalProjectWorkspace,
  assertGitWorktreeBaseWorkspaceReady,
  assertPushCapabilityCheckoutValid,
  reconcileReusedExecutionWorkspaceProjectWorkspaceId,
  assertGitSensitiveAdapterWorkspaceValid,
  type ResolvedAdditionalWorkspace,
  type WorkspaceMaterializationFailure,
  type ResolvedWorkspaceForRun,
  buildAnchorFallbackWorkspaceNotes,
  buildRunWorkspaceHints,
  prioritizeProjectWorkspaceCandidatesForRun,
  MULTI_PROJECT_WORKSPACE_SYNC_ENV,
  isMultiProjectWorkspaceSyncEnabled,
  isRemoteExecutionEnvironmentDriver,
  MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV,
  isMultiProjectWorkspaceSyncRemoteEnabled,
  isConfinedRemoteStagingDriver,
  MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS,
  MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS,
  type RunReferencedProject,
  type ReferencedProjectFailureReason,
  type ReferencedProjectFailure,
  type ResolvedRunReferencedProjects,
  type ResolveRunReferencedProjectsOptions,
  resolveRunReferencedProjects,
  type ResolveAdditionalRunWorkspacesOptions,
  resolveAdditionalRunWorkspaces,
  type ReferencedProjectRunObservability,
  buildReferencedProjectRunObservability,
  resolveRuntimeSessionParamsForWorkspace,
  type EffectiveRunWorkspaceConfigMetadata,
  type ExecutionWorkspaceReuseRequestForIssue,
  resolveNativeRecoveryExecutionWorkspaceBinding,
  resolveExecutionWorkspaceReuseRequestForIssue,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
  provisionExecutionWorkspaceForFreshnessDecision,
  buildWorkspaceConfigFreshnessOperation,
  buildEffectiveRunSessionConfigMetadata,
  buildEffectiveRunWorkspaceConfigMetadata,
  resolveExecutionWorkspaceConfigFreshness,
  isTaskSessionCredentialCompatible,
  shouldResetTaskSessionForModelChange,
  stripConfiguredModelFromSessionParams,
  stripPaperclipSessionMetadataFromSessionParams,
  resolveTaskSessionConfigFreshness,
} from "./heartbeat/workspaces.js";
import { boundHeartbeatRunEventPayloadForStorage } from "./heartbeat/run-log.js";
export {
  boundHeartbeatRunEventPayloadForStorage,
  compactRunLogChunk,
} from "./heartbeat/run-log.js";
export { buildPaperclipTaskMarkdown } from "./heartbeat/task-markdown.js";

import { decisionModelService } from "./decision-models.js";
import { TASK_QUESTION_GUIDANCE } from "./issue-question-context.js";
import { createAgentIdentityRedactor } from "./agent-identity-redaction.js";


import {
  startupCancellationFence,
} from "./native-runtime/native-cancellation-request.js";
import {
  prepareChatCompletionTurn,
} from "./chat-completion-delivery.js";

import {
  NativeWorkspaceFinalizationBusyError,
  NativeWorkspaceFinalizationOwnershipLostError,
} from "./native-runtime/native-workspace-finalization-ownership.js";

import { reserveRunBudget } from "./budget-reservations.js";
import { accountRunCost, createCostAccountingReconciler } from "./run-cost-accounting.js";

import { toolActionDeliveryService } from "./tool-action-delivery.js";
import { githubBotConnectionIdsForRun } from "./chat-github-tools.js";

import {
  isConversation,
  prepareConversationTurn,
  settleConversationTurn,
} from "./agent-conversations.js";
import { withAdapterExecutionPhase } from "@paperclipai/adapter-utils/execution-phase";
import {
  recordNativeLocalProcessStop,
  settleNativeRunProcess,
} from "./native-local-process-stop.js";

import {
  legacyControllerBootId,
  watchLegacyControllerLease,
} from "./legacy-controller-lease.js";


import {
  prepareManagedAiRuntime,
  assertManagedAiProjectAuth,
} from "./ai-connection-runtime.js";
import { aiConnectionBindingSchema, aiRuntimeConnectionBindingSchema, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { aiConnectionRouterService, AiConnectionPoolExhausted, applyAiConnectionRouterTaskSettings } from "./ai-connection-router.js";
import {
  getExecutionBlocker,
} from "./execution-blocker.js";
import {
  claimedAdapterType,
} from "./conversation-continuation.js";

import {
  settleInterruptedNativeBootstrap,
} from "./legacy-execution-recovery.js";
import {
  adapterExecutionControls,
  createAdapterExecutionControl,
} from "./adapter-execution-control.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "./heartbeat-run-status-payload.js";
export { buildHeartbeatRunStatusLiveEventPayload } from "./heartbeat-run-status-payload.js";
import { StaleExecutionContinuationError } from "./execution-continuation.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

import {
  initializeRunIdentity,
} from "./run-identity.js";
import {
  authorizeFailedChatRunRetryWake,
} from "./durable-chat-wakeup.js";
import { prepareHeartbeatGitHubLaunchers } from "./heartbeat-github-launchers.js";
import {
  cleanupGitHubOperationLaunchers,
  prepareGitHubExecutionEnvironment,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import { agentInstructionWorkingCopyService } from "./agent-instruction-working-copies.js";

import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  CHAT_PROVIDERS,
  ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
  isEnvironmentDriverSupportedForAdapter,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  chatActions,
  heartbeatRuns,
  environmentLeases,
  issueComments,
  issues,
  nativeRunFinalizations,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { conflict, HttpError, notFound } from "../errors.js";

import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

import {
  queuedCommentIdsFromRunContext,
} from "./issue-queued-comment-queue.js";

import {
  dispatchNativeSessionResumptions,
  NativeCancellationPendingRecoveryError,
  NativeControllerDetachedForRestartError,
  prepareNativeWorkspaceSync,
  type NativeRestartRecoveryClaim,
  resolveHeartbeatNativeRuntimeMode,
} from "./native-runtime/index.js";

import { nativeChatWorkspaceCwd } from "./native-runtime/native-chat-workspace.js";
import {
  type NativeExecutionInput,
  type NativeSessionBackend,
} from "../vendor/paperclip-runner/index.js";

import { getRunLogStore } from "./run-log-store.js";
import {
  providerTraceStore,
} from "./provider-trace-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";

import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import {
  parseObject,
} from "../adapters/utils.js";

import {
  EXTERNAL_CHAT_QUESTION_RESPONSE_KEY,
} from "./native-runtime/external-chat-question-response.js";

import {
  NativeRunnerOwnershipUnverifiedError,
  isNativeRunnerOwnershipHeld,
  NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "./native-runtime/native-runner-ownership.js";
import {
  emitAgentTaskRun,
  emitAgentTaskRunById,
} from "./agent-task-run-telemetry.js";
import { reportRunFailure } from "./run-failure-report.js";

import { collectRunFailureSecretValues, type RunFailureReportOptions } from "./run-failure-diagnostics.js";
import { companySkillService } from "./company-skills.js";
import {
  budgetService,
} from "./budgets.js";
import {
  secretService,
} from "./secrets.js";
import {
  resolveDefaultAgentWorkspaceDir,
} from "../home-paths.js";
import {
  buildHeartbeatRunIssueComment,
} from "./heartbeat-run-summary.js";

import {
  logActivity,
  type LogActivityInput,
} from "./activity-log.js";
import {
  releaseRuntimeServicesForRun,
} from "./workspace-runtime.js";

import { issueService } from "./issues.js";
import {
  failRunnerGoalAction,
} from "./runner-goals.js";

import {
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  issueTreeControlService,
} from "./issue-tree-control.js";
import {
  continuationSummaryParksExecutor,
} from "./issue-continuation-summary.js";

import {
  executionWorkspaceService,
} from "./execution-workspaces.js";
import {
  workspaceOperationService,
} from "./workspace-operations.js";
import {
  isProcessGroupAlive,
} from "./local-service-supervisor.js";

import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  type HeartbeatRunScratch,
} from "./run-scratch.js";
import {
  applyDefaultIsolatedExecutionWorkspacePolicy,
  buildExecutionWorkspaceAdapterConfig,
  parseIssueAssigneeAdapterOverrides,
  gateProjectExecutionWorkspacePolicy,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
  selectEnvironmentExecutionWorkspaceSettings,
} from "./execution-workspace-policy.js";
import {
  instanceSettingsService,
  resolveWorktreeRunExecutionActivation,
} from "./instance-settings.js";

import {
  buildConfigurationIncompleteRecoveryNoticeSeed,
  buildExecutionReviewParticipantRecoveryNoticeSeed,
  buildImmediateExecutionPathRecoveryNoticeSeed,
  buildWorkspaceValidationRecoveryNoticeSeed,
  type StrandedRecoveryNoticeSeed,
} from "./recovery/stranded-notice.js";

import { recoveryService } from "./recovery/service.js";
import {
  createRunDispatch,
  type PostCommitEffect,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  isNonAssigneeWorkspaceBusyRetry,
  extractWakeCommentIds,
  deriveCommentId,
  isResolvedInteractionContinuationWakeContext,
} from "../modules/run-dispatch/index.js";
import {
  createWakeQueue,
  type IssueSnapshot as WakeQueueIssueSnapshot,
  type PostCommitEffect as WakeQueuePostCommitEffect,
  type ReleaseRecoveryBlockedNoticeKind,
  type RunSnapshot as WakeQueueRunSnapshot,
} from "../modules/wake-queue/index.js";

import { taskWatchdogService } from "./task-watchdogs.js";

import {
  evaluateAgentInvokabilityFromDb,
  DIRECT_NON_INVOKABLE_STATUSES,
} from "./agent-invokability.js";


import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";


import { environmentService } from "./environments.js";

import {
  environmentRuntimeService,
  type ProviderResourceDisposition,
} from "./environment-runtime.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";

import {
  clearHeartbeatRunRuntimeStatus,
  sweepExpiredHeartbeatRunRuntimeStatuses,
} from "./heartbeat-run-runtime-status.js";

import { resolveAndRetainRunTrustPreset } from "./run-trust-preset.js";

import { effectiveProjectWorkspacePolicy } from "./project-workspace-provider.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

import { computeTaskDrain, applyTaskDrain, startTaskDrain, stopTaskDrain, readTaskDrain } from "./task-admission.js";

const execFile = promisify(execFileCallback);
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = [
  "failed",
  "cancelled",
  "timed_out",
] as const;

export {
  ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS,
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
} from "./recovery/service.js";
export { ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS, ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS } from "./heartbeat/run-output.js";

export {
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
};
const WORKSPACE_VALIDATION_RECOVERY_CAUSE = "workspace_validation_failed";

const CONFIGURATION_INCOMPLETE_RECOVERY_CAUSE = "configuration_incomplete";
const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON =
  "execution_review_participant_recovery";

const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_CAUSE =
  "execution_review_participant_recovery";

export { MAX_TURN_CONTINUATION_RETRY_REASON };

export { WORKSPACE_BUSY_RETRY_REASON };

export { isNonAssigneeWorkspaceBusyRetry };

// Routes and the scheduler construct separate heartbeatService instances, but
// they must agree on in-process adapter executions when reaping stale runs.
const activeRunExecutions = new Set<string>();
// A legacy process adapter's signal exit can race the operator cancellation CAS while
// its owned process group is still being joined. Keep that exit from becoming
// a successful result (or a competing failure) before Stop settles. This is an
// in-process ordering barrier, not durable cancellation or provider authority.
// Embedded adapters use their own cancellation control and acknowledgement.
const processRunCancellationSettlements = new Map<
  string,
  {
    settled: Promise<void>;
    failed: boolean;
    error?: unknown;
  }
>();
// Keep failed Stop evidence until the exact executor exits, independently of
// the active owner barrier. A later Stop may retry a still-owned live child.
const failedProcessRunCancellations = new Map<
  string,
  { settled: Promise<void>; failed: boolean; error?: unknown }
>();
// Background heartbeat executions are dispatched fire-and-forget (see
// startNextQueuedRunForAgent), so the promise that resolves once a run's DB
// writes are fully flushed is otherwise unobservable. Track those promises here
// — shared across service instances like activeRunExecutions above — so callers
// that must guarantee no run write is still in flight (graceful shutdown, and
// tests tearing down a shared database) can await drainActiveRunExecutions().
const activeRunExecutionPromises = new Set<Promise<void>>();
// Routes dispatch a wakeup fire-and-forget (void heartbeat.wakeup(...)). The
// wakeup promise stays pending through its asynchronous prologue, and it
// resolves only after it inserts the queued run and registers the run
// execution in activeRunExecutionPromises. Before that point neither
// activeRunExecutionPromises nor the run table shows the pending run, so a
// caller cannot observe the wake. Track each wakeup promise here — shared
// across service instances like the two sets above — so drainActiveRunExecutions
// can await a wake that is still before run registration. A caller that tears
// down a shared database (a test afterEach) then cannot race a late wake.
const activeWakeupPromises = new Set<Promise<unknown>>();
const nativeSessionResumeDispatchTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
// Shared with HTTP admission so an idle hold fences work before inspection.
export { computeTaskDrain, applyTaskDrain, startTaskDrain, stopTaskDrain } from "./task-admission.js";

/**
 * Report the task-drain state for this process only. `activeRuns` and
 * `pendingWakes` count in-process work. A process restart clears both
 * counters, even when the database still holds `running` rows for runs
 * this process did not finish.
 */
export function getTaskDrainStatus(): {
  draining: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;
  activeRuns: number;
  pendingWakes: number;
  quiescent: boolean;
  ownerId?: string;
} {
  const state = readTaskDrain(new Date());
  const activeRuns = activeRunExecutionPromises.size;
  const pendingWakes = activeWakeupPromises.size;
  return {
    ...(state?.ownerId ? { ownerId: state.ownerId } : {}),
    draining: state !== null,
    startedAt: state?.startedAt ?? null,
    expiresAt: state?.expiresAt ?? null,
    activeRuns,
    pendingWakes,
    quiescent: activeRuns === 0 && pendingWakes === 0,
  };
}

export { type NativeSandboxLifecycle } from "./heartbeat/runtime-selection.js";

export { resolveReusableSandboxLifecycle } from "./heartbeat/runtime-selection.js";

export { resolveNativeSandboxLifecycle } from "./heartbeat/runtime-selection.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}

/**
 * A run is a "zombie" if it's marked as running in the DB but has no live
 * execution tracked in memory. This happens when the server restarts and the
 * execution is lost, or when the DB row outlives the in-memory run state.
 *
 * Queued runs are never zombies — they don't have processes yet.
 */
export function isZombieRun(
  run: { status: string; id: string },
  tracked: { has(id: string): boolean },
): boolean {
  return run.status === "running" && !tracked.has(run.id);
}

/**
 * Filter a coalesce target — if it's a zombie run, return null so the
 * wakeup falls through to create a new queued run instead of coalescing
 * into the dead process (which would refresh updatedAt and make it immortal).
 *
 * Queued runs pass through unchanged (they have no process yet).
 * Null targets pass through unchanged.
 */
export function filterZombieCoalesceTarget<
  T extends { status: string; id: string },
>(target: T | null, tracked: { has(id: string): boolean }): T | null {
  return target && isZombieRun(target, tracked) ? null : target;
}

export function shouldAutoCheckoutIssueForWake(input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  issueStatus: string | null;
  issueAssigneeAgentId: string | null;
  issueExecutionState?: unknown;
  isDependencyReady: boolean;
  agentId: string;
}) {
  if (input.issueAssigneeAgentId !== input.agentId) return false;
  if (!input.isDependencyReady) return false;
  const executionState = parseIssueExecutionState(input.issueExecutionState);
  if (executionState?.status === "pending") return false;

  const issueStatus = readNonEmptyString(input.issueStatus);
  if (
    issueStatus !== "todo" &&
    issueStatus !== "backlog" &&
    issueStatus !== "blocked" &&
    issueStatus !== "in_progress"
  ) {
    return false;
  }

  const wakeReason = readNonEmptyString(input.contextSnapshot?.wakeReason);
  if (!wakeReason) return false;
  if (wakeReason === "issue_comment_mentioned") return false;
  if (wakeReason === "source_scoped_recovery_action") return false;
  if (wakeReason.startsWith("execution_")) return false;

  return true;
}

export function resolvedInteractionCheckoutExpectedStatuses() {
  // A resolved interaction authorizes a new provider turn. Review describes
  // the idle handoff state; once this turn acquires execution it must become
  // in_progress in the same guarded checkout update.
  return ["in_progress", "in_review"] as const;
}

function isCheckoutConflictError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.message === "Issue checkout conflict"
  );
}

export { extractWakeCommentIds };

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(
    run.contextSnapshot as Record<string, unknown> | null,
    null,
  );
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

export type HeartbeatEnvironmentRuntime = ReturnType<
  typeof environmentRuntimeService
>;

export interface HeartbeatServiceOptions {
  /** Test seam before the atomic native runtime handoff. */
  beforeNativeRuntimeSelection?: (runId: string) => Promise<void>;
  /** Test seam immediately before the durable chat-control admission check. */
  beforeChatControlRecoveryCheck?: (input: {
    runId: string;
    issueId: string;
    stage: "claim" | "dispatch";
  }) => Promise<void>;
  pluginWorkerManager?: PluginWorkerManager;
  environmentRuntime?: HeartbeatEnvironmentRuntime;
  runtimeEnv?: Record<string, string | undefined>;
  /**
   * Provider-boundary seam for persisted native-run recovery tests. Keeping
   * the seam here exercises the production reaper, claim, execution, package
   * session loop, persistence port, and finalizer without spawning a provider.
   */
  nativeSessionBackendFactory?: (
    execution: NativeExecutionInput,
  ) => NativeSessionBackend;
  /** Test seam for observing the native-session shutdown boundary before lease destruction. */
  closeWarmNativeSessionsForRun?: (input: {
    runId: string;
    reason: string;
  }) => Promise<{ closed: number; busy: number; failed: number }>;
  /** Test seam for changing a continuation issue at the final pre-dispatch boundary. */
  beforeResolvedInteractionContinuationDispatchCheck?: (input: {
    runId: string;
    issueId: string;
  }) => Promise<void>;
  /** Test seam for racing an issue mutation immediately before the final dispatch gate. */
  afterResolvedInteractionContinuationDispatchCheck?: (input: {
    runId: string;
    issueId: string;
  }) => Promise<void>;
}

export { postWorkspaceReadyComment } from "./heartbeat/runtime-services.js";

export { postNativeModelFallbackWarning } from "./heartbeat/runtime-selection.js";

function isTruthyRuntimeEnvValue(value: string | undefined) {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

export function resolveHeartbeatSchedulingSuppression(
  env: Record<string, string | undefined> = process.env,
  overrides: { allowWorktreeRunExecution?: boolean } = {},
): {
  suppressed: boolean;
  reason:
    "worktree_instance" | "database_restore_in_progress" | "task_drain" | null;
} {
  if (
    isTruthyRuntimeEnvValue(env.PAPERCLIP_IN_WORKTREE) &&
    !overrides.allowWorktreeRunExecution
  ) {
    return { suppressed: true, reason: "worktree_instance" };
  }
  if (
    isTruthyRuntimeEnvValue(env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS) ||
    isTruthyRuntimeEnvValue(env.PAPERCLIP_RESTORE_IN_PROGRESS)
  ) {
    return { suppressed: true, reason: "database_restore_in_progress" };
  }
  if (readTaskDrain(new Date()) !== null) {
    return { suppressed: true, reason: "task_drain" };
  }
  return { suppressed: false, reason: null };
}

export function heartbeatService(
  db: Db,
  options: HeartbeatServiceOptions = {},
) {
  const { finalizeAgentStatus } = createHeartbeatAgentStatus(db);
  const {
    getAgent,
    resolveSessionBeforeForWakeup,
    getRun,
    getRunCleanupState,
    getRunExecutionWait,
    getRunWorkspaceSettlement,
    getRunStatus,
    ensureRuntimeState,
    getTaskSession,
    getLatestAgentConfigRevision,
    evaluateSessionCompaction,
    upsertTaskSession,
    resolveNormalizedUsageForSession,
    clearTaskSessions,
    resolveExplicitResumeSessionOverride,
    hasResolvablePriorSessionWorkspaceForWake,
    getRunReadAccess,
    getRunLogAccess,
    getRunWorkspaceAccess,
    listRuns,
    getRuntimeStateWithSessions,
    listTaskSessions,
    resetRuntimeSession,
    listEvents,
    getRetryExhaustedReason,
    getRunIssueSummary,
    getRunIssueControl,
    getActiveRunIssueControlForAgent,
    getActiveRunForAgent,
    getActiveRunIssueSummaryForAgent,
  } = createHeartbeatRunState(db);
  const {
    toAgentOrgRow,
    listCompanyAgentOrgRows,
    groupAgentOrgRowsByCompany,
    getIssueExecutionContext,
    getPinnedSkillTestContext,
    getRoutineEnvForExecutionIssue,
    resolveResponsibleUserIdForRunSeed,
    resolveResponsibleUserIdForRun,
    resolveResponsibleUserIdForRunContext,
  } = createHeartbeatRunPreparation(db);
  let shutdownInProgress = false;
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const inWorktreeRuntime = isTruthyRuntimeEnvValue(
    runtimeEnv.PAPERCLIP_IN_WORKTREE,
  );
  // Preview worktree instances suppress the run engine by default. Users can lift
  // that per-worktree via the `enableWorktreeRunExecution` experimental setting
  // (worktree instances have their own isolated DB, so it can't affect the parent).
  // Only worktree runtimes ever read the setting; a short TTL keeps the hot-path
  // suppression checks off the DB, and a read failure falls back to prior/default
  // (fail closed to suppression).
  let cachedWorktreeRunExecutionOverride: {
    allowed: boolean;
    cutoff: Date | null;
    at: number;
  } = {
    allowed: false,
    cutoff: null,
    at: 0,
  };
  const WORKTREE_RUN_EXECUTION_OVERRIDE_TTL_MS = 3_000;
  const resolveWorktreeRunExecutionOverride = async (fresh = false) => {
    if (!inWorktreeRuntime) return { allowed: false, cutoff: null };
    const now = Date.now();
    if (
      !fresh && now - cachedWorktreeRunExecutionOverride.at <
      WORKTREE_RUN_EXECUTION_OVERRIDE_TTL_MS
    ) {
      return cachedWorktreeRunExecutionOverride;
    }
    try {
      const activation = resolveWorktreeRunExecutionActivation(
        await instanceSettings.getExperimental(),
        runtimeEnv.PAPERCLIP_INSTANCE_ID?.trim() || null,
      );
      const cutoff = activation.armed ? new Date(activation.cutoff) : null;
      cachedWorktreeRunExecutionOverride = {
        allowed: Boolean(
          activation.armed && cutoff && !Number.isNaN(cutoff.getTime()),
        ),
        cutoff: cutoff && !Number.isNaN(cutoff.getTime()) ? cutoff : null,
        at: now,
      };
    } catch (error) {
      if (fresh) throw error;
      // Keep the prior (default-false) value so a settings read failure fails
      // closed to the safe suppressed state.
    }
    return cachedWorktreeRunExecutionOverride;
  };
  const getSchedulingSuppression = async (fresh = false) => {
    const override = await resolveWorktreeRunExecutionOverride(fresh);
    return resolveHeartbeatSchedulingSuppression(runtimeEnv, {
      allowWorktreeRunExecution: override.allowed,
    });
  };
  const getWorktreeExecutionCutoff = async () => {
    const override = await resolveWorktreeRunExecutionOverride();
    return override.allowed ? override.cutoff : null;
  };

  const runLogStore = getRunLogStore();
  const traceStore = providerTraceStore(db);
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const treeControlSvc = issueTreeControlService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const environmentsSvc = environmentService(db);
  const environmentRuntime =
    options.environmentRuntime ??
    environmentRuntimeService(db, {
      pluginWorkerManager: options.pluginWorkerManager,
    });
  const instructionCopies = agentInstructionWorkingCopyService(db, { environmentRuntime });
  const envOrchestrator = environmentRunOrchestrator(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    environmentRuntime,
  });
  const workspaceOperationsSvc = workspaceOperationService(db);
  const liveRunExecutions = {
    has(id: string) {
      return runningProcesses.has(id) || activeRunExecutions.has(id);
    },
  };
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const reconcileCostAccounting = createCostAccountingReconciler(db, budgetHooks, async () => {
    const outcomes = await Promise.allSettled([
      decisionModelService(db, { budgetHooks }).recoverInterrupted(),
      promptInjectionPreventionService(db, { budgetHooks }).recoverInterrupted(),
    ]);
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
  const budgets = budgetService(db, budgetHooks);
  const recovery = recoveryService(db, {
    enqueueWakeup,
    liveRunExecutions,
    settleExplicitContinuationRetry: releaseIssueExecutionAndPromote,
    scheduleRecoveryRetry: async (runId) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      if (!run) return null;
      const agent = await getAgent(run.agentId);
      if (!agent || agent.companyId !== run.companyId) return null;
      const result = await scheduleBoundedRetryForRun(run, agent);
      return result.outcome === "scheduled" ? result.run : null;
    },
    // Mirrors scheduleBoundedRetryForRun's transient budget check: a failed
    // or interrupted run that has already consumed every bounded transient
    // attempt cannot be retried again through this lane.
    transientRetryBudgetSpent: (run) =>
      executionFailureRetryCount(run) >=
      BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  });
  const runDispatch = createRunDispatch(db);
  const {
    scheduleBoundedRetryForRun,
    timerClaimWasFirstHeartbeat,
    scheduleInteractionContinuationInfrastructureRetryIfEligible,
    findSharedWorkspaceHolder,
    findExecutionWorkspaceHolder,
    finalizeAiConnectionBusyDeferral,
    finalizeWorkspaceBusyDeferral,
    promoteDueScheduledRetries,
    retryScheduledRetryNow,
    scheduleBoundedRetry,
  } = createHeartbeatRetries(db, {
    hasCaseHandoffForRun: async (run) => Boolean(await pendingCaseHandoffForRun(db, run.id, run.companyId)),
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
  });

  const {
    sweepPendingCleanupLeases,
    markNativeOwnershipUnverified,
    prepareHotRestartShutdown,
    reconcileHotRestartAdoption,
    recoverNativeRunsAfterRestart,
    reapOrphanedRuns,
    sweepOrphanedActiveLeases,
    drainRunningRunsForShutdown,
    registerScheduledRetryCancellationWork,
    registerRetainedNativeSessionCleanupWork,
    registerNativeWorkspaceFinalizationWork,
    registerNativeEnvironmentSettlementWork,
  } = createHeartbeatRecovery(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    enterShutdown: () => { shutdownInProgress = true; },
    scheduleBoundedRetryForRun,
    appendRunEvent,
    environmentRuntime,
    scheduleNativeSessionResumeDispatch,
    getRun,
    getRunWorkspaceSettlement,
    executeRun,
    activeRunExecutionPromises,
    cancelHeartbeatNativeRun,
    terminateHeartbeatRunProcess,
    setRunStatusIfRunning,
    mergeRunStopMetadataForAgent,
    setWakeupStatus,
    classifyAndPersistRunLiveness,
    releaseEnvironmentLeasesForRun,
    releaseIssueExecutionAndPromote,
    finalizeAgentStatus,
    timerClaimWasFirstHeartbeat,
    environmentsSvc,
    acknowledgeRemoteStop,
    resumeRemoteStopComments,
    setRunStatusFromLive,
    instructionCopies,
    dispatchPendingNativeStatusWakeups,
    runtimeEnv,
    cancelRunInternal,
    activeRunExecutions,
    setRunStatus,
    getAgent,
    scheduleInteractionContinuationInfrastructureRetryIfEligible,
    startNextQueuedRunForAgent,
  });

  // Applies the post-commit effects a run-dispatch operation returns, on a
  // best-effort basis, exactly as this service publishes them for every
  // other run write. A publish failure never rolls back the write that
  // already committed.
  function applyRunDispatchPostCommitEffects(effects: PostCommitEffect[]) {
    for (const effect of effects) {
      if (effect.kind === "run_queued") {
        publishLiveEvent({
          companyId: effect.companyId,
          type: "heartbeat.run.queued",
          payload: {
            runId: effect.runId,
            agentId: effect.agentId,
            invocationSource: effect.invocationSource,
            triggerDetail: effect.triggerDetail,
            wakeupRequestId: effect.wakeupRequestId,
          },
        });
      } else {
        publishLiveEvent({
          companyId: effect.companyId,
          type: "heartbeat.run.status",
          payload: buildHeartbeatRunStatusLiveEventPayload({
            id: effect.runId,
            agentId: effect.agentId,
            status: effect.status,
            invocationSource: effect.invocationSource,
            triggerDetail: effect.triggerDetail,
            error: effect.error,
            errorCode: effect.errorCode,
            startedAt: effect.startedAt,
            finishedAt: effect.finishedAt,
            resultJson: effect.result,
            contextSnapshot: { source: effect.contextSource },
          }),
        });
        publishRunLifecyclePluginEventData(effect);
        if (
          isHeartbeatRunTerminalStatus(effect.status) &&
          effect.previousStatus !== effect.status
        ) {
          clearHeartbeatRunRuntimeStatus(effect.runId);
          void emitAgentTaskRunById(db, {
            runId: effect.runId,
            companyId: effect.companyId,
          });
        }
      }
    }
  }

  // The wake-queue module's plain snapshots hold only the fields the release
  // decision needs; escalation needs the full row, so this re-reads both by
  // id after the release transaction has committed. Returns null when either
  // row is gone, so both escalation adapters below skip the escalation call.
  async function loadStrandedEscalationRows(input: {
    issue: WakeQueueIssueSnapshot;
    latestRun: WakeQueueRunSnapshot;
  }) {
    const [issueRow] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.issue.id), eq(issues.companyId, input.issue.companyId)));
    const [runRow] = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.latestRun.id), eq(heartbeatRuns.companyId, input.latestRun.companyId)));
    if (!issueRow || !runRow) return null;
    return { issueRow, runRow };
  }

  // Reproduces `adapters/postgres.ts`'s former `buildBlockedRecoveryNotice`
  // four-arm switch, now built once here from the full run row this file
  // already re-reads through `loadStrandedEscalationRows`.
  function buildStrandedRecoveryNoticeForKind(
    noticeKind: ReleaseRecoveryBlockedNoticeKind,
    input: { issueStatus: "todo" | "in_progress"; runRow: typeof heartbeatRuns.$inferSelect },
  ): {
    notice: StrandedRecoveryNoticeSeed;
    recoveryCause:
      | typeof WORKSPACE_VALIDATION_RECOVERY_CAUSE
      | typeof CONFIGURATION_INCOMPLETE_RECOVERY_CAUSE
      | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_CAUSE
      | undefined;
  } {
    if (noticeKind === "workspace_validation") {
      return { notice: buildWorkspaceValidationRecoveryNoticeSeed(), recoveryCause: WORKSPACE_VALIDATION_RECOVERY_CAUSE };
    }
    if (noticeKind === "configuration_incomplete") {
      const configurationIncomplete = parseObject(parseObject(input.runRow.resultJson).configurationIncomplete);
      return {
        notice: buildConfigurationIncompleteRecoveryNoticeSeed(
          Object.keys(configurationIncomplete).length > 0 ? configurationIncomplete : null,
        ),
        recoveryCause: CONFIGURATION_INCOMPLETE_RECOVERY_CAUSE,
      };
    }
    if (noticeKind === "execution_review_participant") {
      return {
        notice: buildExecutionReviewParticipantRecoveryNoticeSeed(),
        recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_CAUSE,
      };
    }
    return { notice: buildImmediateExecutionPathRecoveryNoticeSeed({ status: input.issueStatus }), recoveryCause: undefined };
  }

  const wakeQueue = createWakeQueue(db, {
    resolveResponsibleUserId: async (input) => {
      // `input.issue` is the wake-queue module's own transaction-scoped
      // snapshot; using it here, instead of re-reading the issue through
      // `getIssueExecutionContext`, keeps this read off a second connection
      // while the module's transaction is open, and keeps it seeing the
      // in-transaction issue status rather than a stale one.
      return resolveResponsibleUserIdForRunSeed({
        companyId: input.companyId,
        contextSnapshot: input.contextSnapshot,
        issueContext: input.issue,
        // The wake-queue module's port type widens `env` to `unknown` so its
        // application layer stays free of this file's routine env type; the
        // value always comes from this file's own getRoutineEnvForExecutionIssue.
        routineEnvContext: input.routineEnvContext as Awaited<
          ReturnType<typeof getRoutineEnvForExecutionIssue>
        >,
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        source: input.source as WakeupOptions["source"],
        triggerDetail: input.triggerDetail as WakeupOptions["triggerDetail"],
        existingRunResponsibleUserId: input.existingRunResponsibleUserId,
      });
    },
    getRoutineEnv: async (input) => {
      // Same reason as `resolveResponsibleUserId` above: use the passed-in
      // transaction-scoped issue snapshot instead of reading the issue again.
      return getRoutineEnvForExecutionIssue(input.companyId, input.issue);
    },
    resolveSessionBeforeForWakeup: async (input) => {
      // Scoped to this port only, so a wake-queue agent id can never resolve
      // a session against another company's agent row. The shared `getAgent`
      // helper below has no company predicate, so this reads the agent
      // directly with the company named in its own `WHERE` clause.
      const agent = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) return null;
      return resolveSessionBeforeForWakeup(agent, input.taskKey);
    },
    // These four helpers stay in this file today; the wake-queue module
    // receives them here so it never imports this file, the service it is
    // extracted from.
    wakeAdmissionHelpers: {
      filterZombieCoalesceTarget,
      mergeCoalescedContextSnapshot,
      shouldDeferFollowupWakeForSameIssue,
      shouldQueueFollowupForRunningIssueWake,
    },
    recovery: {
      escalateStrandedAssignedIssue: async (input) => {
        const rows = await loadStrandedEscalationRows(input);
        if (!rows) return;
        const { notice, recoveryCause } = buildStrandedRecoveryNoticeForKind(input.noticeKind, {
          issueStatus: input.issue.status === "todo" ? "todo" : "in_progress",
          runRow: rows.runRow,
        });
        await recovery.escalateStrandedAssignedIssue({
          issue: rows.issueRow,
          previousStatus: input.previousStatus,
          latestRun: rows.runRow,
          notice,
          recoveryCause,
        });
      },
      escalateStrandedRecoveryIssueInPlace: async (input) => {
        const rows = await loadStrandedEscalationRows(input);
        if (!rows) return;
        await recovery.escalateStrandedRecoveryIssueInPlace({
          issue: rows.issueRow,
          previousStatus: input.previousStatus,
          latestRun: rows.runRow,
        });
      },
    },
  });

  const heartbeatQueue = createHeartbeatQueue(db, {
    canStartNewExternalBotWork: async agent => {
      if (agent.adapterType !== "paperclip_runner" || agent.adapterConfig.provider !== "grok_bot") return true;
      const aiConnection = aiRuntimeConnectionBindingSchema.safeParse(agent.runtimeConfig?.aiConnection);
      if (aiConnection.success && aiConnection.data.mode === "router") return true;
      return dotRunnerBroker(db).canStartNewWork(agent.companyId, agent.id,
        readNonEmptyString(agent.adapterConfig.externalBindingId) ?? "");
    },
    applyWakeQueuePostCommitEffects,
    setRunStatus,
    setWakeupStatus,
    appendRunEvent,
    releaseIssueExecutionAndPromote,
    issuesSvc,
    options,
    publishRunLifecyclePluginEvent,
    finalizeAgentStatus,
    getAgent,
    cancelRunInternal,
    toAgentOrgRow,
    getAgentInvokability,
    budgets,
    activeRunExecutions,
    treeControlSvc,
    runDispatch,
    applyRunDispatchPostCommitEffects,
    resolveResponsibleUserIdForRun,
    getIssueExecutionContext,
    isHeartbeatRunTerminalStatus,
    liveRunExecutions,
    getSchedulingSuppression,
    resumeExecutionWaitComments,
    getWorktreeExecutionCutoff,
    resumeQueuedCommentInterrupt,
    resumeSavedLegacyComments,
    cancelActiveForAgentInternal,
    listCompanyAgentOrgRows,
    executeRun,
    activeRunExecutionPromises,
    activeWakeupPromises,
    instanceSettings,
    getRun,
    sweepPendingCleanupLeases,
    resolveExplicitResumeSessionOverride,
    resolveSessionBeforeForWakeup,
    hasResolvablePriorSessionWorkspaceForWake,
    getRoutineEnvForExecutionIssue,
    resolveResponsibleUserIdForRunSeed,
    formatIssueIdentifierLink,
    wakeQueue,
    isSameTaskScope,
    runTaskKey,
    filterZombieCoalesceTarget,
  });

  const {
    releaseRunClaimedJustBeforeSuppression,
    claimQueuedRun,
    withChatControlRecoveryGate,
    trackWakeup,
    resumeQueuedRuns,
    parseHeartbeatPolicy,
    nextTimerHeartbeatAt,
    claimDueTimerHeartbeat,
  } = heartbeatQueue;

  // Earlier factories capture these callbacks before queue construction.
  function enqueueWakeup(...args: Parameters<typeof heartbeatQueue.enqueueWakeup>) {
    return heartbeatQueue.enqueueWakeup(...args);
  }

  function startNextQueuedRunForAgent(...args: Parameters<typeof heartbeatQueue.startNextQueuedRunForAgent>) {
    return heartbeatQueue.startNextQueuedRunForAgent(...args);
  }

  function dispatchPendingNativeStatusWakeups(...args: Parameters<typeof heartbeatQueue.dispatchPendingNativeStatusWakeups>) {
    return heartbeatQueue.dispatchPendingNativeStatusWakeups(...args);
  }

  function resumeQueuedRunsAfterDrain() {
    const promise = heartbeatQueue.resumeQueuedRunsAfterDrain();
    activeWakeupPromises.add(promise);
    void promise.then(
      () => { activeWakeupPromises.delete(promise); },
      () => { activeWakeupPromises.delete(promise); },
    );
    return promise;
  }

  const runLifecycle = createHeartbeatLifecycle(db, {
    issuesSvc,
    recovery,
    companySkills,
    getRunStatus,
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
  });

  const {
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
  } = runLifecycle;

  // Earlier factories capture these callbacks before lifecycle construction.
  function appendRunEvent(...args: Parameters<typeof runLifecycle.appendRunEvent>) {
    return runLifecycle.appendRunEvent(...args);
  }

  function escalatePlanApprovalResumeFailureNeedsAttention(...args: Parameters<typeof runLifecycle.escalatePlanApprovalResumeFailureNeedsAttention>) {
    return runLifecycle.escalatePlanApprovalResumeFailureNeedsAttention(...args);
  }

  function recordPlanApprovalResumeFailureRetry(...args: Parameters<typeof runLifecycle.recordPlanApprovalResumeFailureRetry>) {
    return runLifecycle.recordPlanApprovalResumeFailureRetry(...args);
  }

  function setRunStatusIfRunning(...args: Parameters<typeof runLifecycle.setRunStatusIfRunning>) {
    return runLifecycle.setRunStatusIfRunning(...args);
  }

  function setWakeupStatus(...args: Parameters<typeof runLifecycle.setWakeupStatus>) {
    return runLifecycle.setWakeupStatus(...args);
  }

  function mergeRunStopMetadataForAgent(...args: Parameters<typeof runLifecycle.mergeRunStopMetadataForAgent>) {
    return runLifecycle.mergeRunStopMetadataForAgent(...args);
  }

  function classifyAndPersistRunLiveness(...args: Parameters<typeof runLifecycle.classifyAndPersistRunLiveness>) {
    return runLifecycle.classifyAndPersistRunLiveness(...args);
  }

  function setRunStatusFromLive(...args: Parameters<typeof runLifecycle.setRunStatusFromLive>) {
    return runLifecycle.setRunStatusFromLive(...args);
  }

  function setRunStatus(...args: Parameters<typeof runLifecycle.setRunStatus>) {
    return runLifecycle.setRunStatus(...args);
  }

  function publishRunLifecyclePluginEventData(...args: Parameters<typeof runLifecycle.publishRunLifecyclePluginEventData>) {
    return runLifecycle.publishRunLifecyclePluginEventData(...args);
  }

  function publishRunLifecyclePluginEvent(...args: Parameters<typeof runLifecycle.publishRunLifecyclePluginEvent>) {
    return runLifecycle.publishRunLifecyclePluginEvent(...args);
  }

  const runControl = createHeartbeatRunControl(db, {
    getRun,
    getRunCleanupState,
    getRunExecutionWait,
    options,
    envOrchestrator,
    activeRunExecutions,
    enqueueWakeup,
    getAgent,
    sweepPendingCleanupLeases,
    getSchedulingSuppression,
    wakeQueue,
    applyWakeQueuePostCommitEffects,
    processRunCancellationSettlements,
    mergeRunStopMetadataForAgent,
    setRunStatusFromLive,
    failedProcessRunCancellations,
    setWakeupStatus,
    appendRunEvent,
    finalizeAgentStatus,
    timerClaimWasFirstHeartbeat,
    startNextQueuedRunForAgent,
    setRunStatus,
  });

  const {
    cancelInvocationsForAgentsInternal,
  } = runControl;

  // Earlier factories capture these callbacks before run-control construction.
  function cancelBudgetScopeWork(...args: Parameters<typeof runControl.cancelBudgetScopeWork>) {
    return runControl.cancelBudgetScopeWork(...args);
  }

  function releaseIssueExecutionAndPromote(...args: Parameters<typeof runControl.releaseIssueExecutionAndPromote>) {
    return runControl.releaseIssueExecutionAndPromote(...args);
  }

  function releaseEnvironmentLeasesForRun(...args: Parameters<typeof runControl.releaseEnvironmentLeasesForRun>) {
    return runControl.releaseEnvironmentLeasesForRun(...args);
  }

  function acknowledgeRemoteStop(...args: Parameters<typeof runControl.acknowledgeRemoteStop>) {
    return runControl.acknowledgeRemoteStop(...args);
  }

  function resumeRemoteStopComments(...args: Parameters<typeof runControl.resumeRemoteStopComments>) {
    return runControl.resumeRemoteStopComments(...args);
  }

  function cancelRunInternal(...args: Parameters<typeof runControl.cancelRunInternal>) {
    return runControl.cancelRunInternal(...args);
  }

  function resumeExecutionWaitComments(...args: Parameters<typeof runControl.resumeExecutionWaitComments>) {
    return runControl.resumeExecutionWaitComments(...args);
  }

  function resumeQueuedCommentInterrupt(...args: Parameters<typeof runControl.resumeQueuedCommentInterrupt>) {
    return runControl.resumeQueuedCommentInterrupt(...args);
  }

  function resumeSavedLegacyComments(...args: Parameters<typeof runControl.resumeSavedLegacyComments>) {
    return runControl.resumeSavedLegacyComments(...args);
  }

  function cancelActiveForAgentInternal(...args: Parameters<typeof runControl.cancelActiveForAgentInternal>) {
    return runControl.cancelActiveForAgentInternal(...args);
  }

  // Applies the post-commit effects a wake-queue release returns, exactly as
  // the original release function did before its writes moved into that
  // module: publish + dispatch a promoted or recovery run, log a reopened
  // issue's activity entry.
  async function applyWakeQueuePostCommitEffects(effects: WakeQueuePostCommitEffect[]) {
    for (const effect of effects) {
      if (effect.kind === "conversation_retry_requested") {
        const [source] = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, effect.companyId), eq(heartbeatRuns.id, effect.runId),
        ));
        const agent = source ? await getAgent(source.agentId) : null;
        if (source && agent && agent.companyId === source.companyId) {
          const retry = await scheduleBoundedRetryForRun(source, agent, effect.reviewParticipant ? {
            retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
            wakeReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON,
          } : undefined);
          const issueId = readNonEmptyString(source.contextSnapshot?.issueId);
          if (retry.outcome !== "scheduled" && source.contextSnapshot?.explicitUserContinuation && issueId &&
              !adapterExecutionControls.has(source.id) && !(await getExecutionBlocker(db, source.companyId, issueId))) {
            // Cleanup has settled, so exhaustion or revoked/missing authority
            // must not retain a terminal claim. Do not request another retry.
            const settled = await wakeQueue.releaseIssueExecution({ companyId: source.companyId,
              runId: source.id, now: new Date(), suppressImmediateRecovery: true });
            await applyWakeQueuePostCommitEffects(settled.postCommitEffects);
          }
        }
      } else if (effect.kind === "run_queued") {
        publishLiveEvent({
          companyId: effect.run.companyId,
          type: "heartbeat.run.queued",
          payload: {
            runId: effect.run.id,
            agentId: effect.run.agentId,
            invocationSource: effect.run.invocationSource,
            triggerDetail: effect.run.triggerDetail,
            wakeupRequestId: effect.run.wakeupRequestId,
          },
        });
        await startNextQueuedRunForAgent(effect.run.agentId);
      } else {
        await logActivity(db, {
          companyId: effect.companyId,
          actorType: "system",
          actorId: "heartbeat",
          agentId: effect.agentId,
          runId: effect.runId,
          action: "issue.updated",
          entityType: "issue",
          entityId: effect.issueId,
          details: {
            status: "todo",
            reopened: true,
            reopenedFrom: effect.reopenedFrom,
            source: "deferred_comment_wake",
            identifier: effect.identifier,
          },
        });
      }
    }
  }

  const taskWatchdogs = taskWatchdogService(db, { enqueueWakeup });
  async function getAgentInvokability(
    agent: typeof agents.$inferSelect | null | undefined,
  ) {
    return evaluateAgentInvokabilityFromDb(db, agent);
  }

  const {
    triggerIssueMonitor,
    tickTimers,
    tickAgentTimers,
    nextAgentTimerAt,
    tickIssueMonitors,
    nextIssueMonitorAt,
    recoverActiveSessionGoals,
    recoverPendingSessionGoalActions,
  } = createHeartbeatScheduling(db, {
    issuesSvc,
    enqueueWakeup,
    getRun,
    getAgent,
    scheduleBoundedRetryForRun,
    getSchedulingSuppression,
    getWorktreeExecutionCutoff,
    toAgentOrgRow,
    groupAgentOrgRowsByCompany,
    parseHeartbeatPolicy,
    nextTimerHeartbeatAt,
    claimDueTimerHeartbeat,
  });

  const {
    resolveReusedGitWorkspaceAnchor,
    resolveWorkspaceForRun,
  } = createHeartbeatWorkspaceResolver(db);

  // Emits agent.task_run for a run write that just reached a terminal
  // status, unless the write only re-set a status the run already had (a
  // status-preserving patch, such as a livenessReason update on a run that
  // finished earlier). Only a genuine transition into a terminal status
  // emits. The emission runs in the background: it never blocks the
  // caller's remaining lifecycle work, because emitAgentTaskRun never
  // throws (it logs and swallows its own failures).
  function emitTerminalAgentTaskRun(
    updated: typeof heartbeatRuns.$inferSelect,
    previousStatus: string | null,
    failureReport?: RunFailureReportOptions,
  ) {
    if (!isHeartbeatRunTerminalStatus(updated.status)) return;
    if (previousStatus === updated.status) return;
    clearHeartbeatRunRuntimeStatus(updated.id);
    void emitAgentTaskRun(db, updated);
    void reportRunFailure(db, updated, failureReport);
  }

  async function reconcileStrandedAssignedIssues(opts?: { skipExternalConversationSettlement?: boolean }) {
    return recovery.reconcileStrandedAssignedIssues({
      skipExternalConversationSettlement: opts?.skipExternalConversationSettlement,
      issueCreatedAtGte: await getWorktreeExecutionCutoff(),
    });
  }

  async function sweepStaleIssueLocks() {
    return recovery.sweepStaleIssueLocks();
  }

  function issueIdFromRunContext(contextSnapshot: unknown) {
    const context = parseObject(contextSnapshot);
    return (
      readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId)
    );
  }

  function issueIdFromWakePayload(payload: unknown) {
    const parsed = parseObject(payload);
    const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
    return (
      readNonEmptyString(parsed.issueId) ??
      readNonEmptyString(nestedContext.issueId) ??
      readNonEmptyString(nestedContext.taskId)
    );
  }

  async function scanSilentActiveRuns(opts?: {
    now?: Date;
    companyId?: string;
  }) {
    return recovery.scanSilentActiveRuns({
      ...opts,
      issueCreatedAtGte: await getWorktreeExecutionCutoff(),
    });
  }

  async function reconcileTaskWatchdogs(opts?: {
    companyId?: string | null;
    runId?: string | null;
  }) {
    return taskWatchdogs.reconcileTaskWatchdogs({
      ...opts,
      issueCreatedAtGte: await getWorktreeExecutionCutoff(),
    });
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      | "id"
      | "companyId"
      | "status"
      | "lastOutputAt"
      | "lastOutputSeq"
      | "lastOutputStream"
      | "processStartedAt"
      | "startedAt"
      | "createdAt"
    >,
    now = new Date(),
  ) {
    return recovery.buildRunOutputSilence(run, now);
  }

  async function reconcileResolvedDependencyWakes(opts?: {
    runId?: string | null;
    companyId?: string | null;
  }) {
    return recovery.reconcileResolvedDependencyWakeBackstop(opts);
  }

  // Await every background heartbeat execution that is currently in flight. A
  // draining run can, in its finally block, promote and dispatch the next queued
  // run for the same agent — that follow-up execution is registered in the set
  // before the parent promise settles, so we loop until the set is empty rather
  // than snapshotting once. Callers use this to guarantee no run is still
  // writing rows/events (graceful shutdown, deterministic test teardown).
  //
  // Await in-flight wakeup promises first. A wakeup resolves only after it
  // registers its run execution, so a wake that is still before run registration
  // is invisible to activeRunExecutionPromises alone. Awaiting the wakeup promise
  // closes that window: once it settles, any run it dispatched is already in
  // activeRunExecutionPromises, and the second await drains that run. A wakeup or
  // a run can add more entries as it settles, so loop until both sets are empty.
  async function drainActiveRunExecutions() {
    for (const timer of nativeSessionResumeDispatchTimers.values()) {
      clearTimeout(timer);
    }
    nativeSessionResumeDispatchTimers.clear();
    while (
      activeWakeupPromises.size > 0 ||
      activeRunExecutionPromises.size > 0
    ) {
      await Promise.allSettled([...activeWakeupPromises]);
      await Promise.all([...activeRunExecutionPromises]);
    }
  }

  function scheduleNativeSessionResumeDispatch(
    runId: string,
    nextAttemptAt: Date,
  ) {
    const prior = nativeSessionResumeDispatchTimers.get(runId);
    if (prior) clearTimeout(prior);
    const delayMs = Math.max(0, nextAttemptAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      if (nativeSessionResumeDispatchTimers.get(runId) !== timer) return;
      nativeSessionResumeDispatchTimers.delete(runId);
      void (async () => {
        if ((await getSchedulingSuppression()).suppressed) return;
        await dispatchNativeSessionResumptions({
          db,
          runnerInstanceId:
            runtimeEnv.PAPERCLIP_INSTANCE_ID?.trim() || "paperclip-heartbeat",
          runIds: [runId],
          dispatch: (claim) => {
            const execution = executeRun(claim.runId, {
              nativeLeaseOwner: claim.leaseOwner,
            }).catch((error) => {
              logger.error(
                { err: error, runId: claim.runId },
                "scheduled native session resume failed",
              );
            });
            activeRunExecutionPromises.add(execution);
            void execution.finally(() =>
              activeRunExecutionPromises.delete(execution),
            );
          },
        });
      })().catch((error) => {
        logger.error(
          { err: error, runId },
          "failed to dispatch scheduled native session resume",
        );
      });
    }, delayMs);
    timer.unref?.();
    nativeSessionResumeDispatchTimers.set(runId, timer);
  }

  const runCompletion = createHeartbeatRunCompletion(db, {
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
  });

  async function executeRun(
    runId: string,
    runOptions: {
      nativeLeaseOwner?: string;
      nativeRestartRecovery?: NativeRestartRecoveryClaim;
      onNativeExecutionLeaseAcquired?: () => Promise<void>;
    } = {},
  ) {
    return withRunExecutionTiming(runId, () => executeRunAttempt(runId, runOptions));
  }

  async function executeRunAttempt(
    runId: string,
    runOptions: { nativeLeaseOwner?: string; nativeRestartRecovery?: NativeRestartRecoveryClaim; onNativeExecutionLeaseAcquired?: () => Promise<void> },
  ) {
    const attemptStartedAtMs = Date.now();
    let attestedQuestionResponseAtMs: number | null = null;
    if ((await getSchedulingSuppression()).suppressed) {
      try {
        await releaseRunClaimedJustBeforeSuppression(runId);
      } catch (err) {
        logger.error(
          { err, runId },
          "failed to release run claimed just before task-drain suppression; the run row stays running, and the orphan reaper finalizes it and releases the issue lock on its next cycle",
        );
      }
      return;
    }

    let legacyAdapterEntered = false;
    let legacyLocalAdapterEntered = false;
    let persistUsageCaptureFailure: (() => Promise<void>) | undefined;
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // claimQueuedRun can also leave the run queued when dependencies are unresolved.
        return;
      }
      run = claimed;
    }

    const releaseInstructionCopy = createHeartbeatInstructionCopyRelease(run, instructionCopies, appendRunEvent);

    if (
      runOptions.nativeLeaseOwner &&
      run.runtimeMode === "native" &&
      runOptions.nativeRestartRecovery?.kind !== "reattach_existing_runner" &&
      runOptions.nativeRestartRecovery?.kind !== "reattach_remote_runner"
    ) {
      // A numeric PID or process-group ID is a liveness signal, never an
      // ownership capability: the OS may have recycled it after the service
      // restart. A still-active in-memory child handle is also insufficient to
      // authorize recovery to kill it. Any live or active-looking process
      // therefore blocks replacement recovery without receiving a signal.
      const tracked = runningProcesses.get(run.id);
      const trackedChildIsActive =
        !!tracked &&
        tracked.child.exitCode === null &&
        tracked.child.signalCode === null;
      const trackedPid = tracked?.child.pid ?? null;
      const trackedProcessGroupId = tracked?.processGroupId ?? null;
      const trackedPidAlive = trackedPid ? isProcessAlive(trackedPid) : false;
      const trackedProcessGroupAlive = trackedProcessGroupId
        ? isProcessGroupAlive(trackedProcessGroupId)
        : false;
      const persistedPidAlive =
        !!run.processPid && isProcessAlive(run.processPid);
      const persistedProcessGroupAlive =
        !!run.processGroupId && isProcessGroupAlive(run.processGroupId);
      if (
        trackedChildIsActive ||
        trackedPidAlive ||
        trackedProcessGroupAlive ||
        persistedPidAlive ||
        persistedProcessGroupAlive
      ) {
        await markNativeOwnershipUnverified(run, {
          reason: "live_process_identifier",
          processPidAlive: trackedPidAlive || persistedPidAlive,
          processGroupAlive:
            trackedProcessGroupAlive || persistedProcessGroupAlive,
        });
        throw new Error(NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE);
      }
      runningProcesses.delete(run.id);
      if (run.processPid || run.processGroupId || run.processStartedAt) {
        const cleared = await db.transaction(async tx => {
          const cleared = await tx
            .update(heartbeatRuns)
            .set({
              processPid: null,
              processGroupId: null,
              processStartedAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(heartbeatRuns.id, run.id),
                eq(heartbeatRuns.runtimeMode, "native"),
                run.processPid === null
                  ? isNull(heartbeatRuns.processPid)
                  : eq(heartbeatRuns.processPid, run.processPid),
                run.processGroupId === null
                  ? isNull(heartbeatRuns.processGroupId)
                  : eq(heartbeatRuns.processGroupId, run.processGroupId),
                run.processStartedAt === null
                  ? isNull(heartbeatRuns.processStartedAt)
                  : eq(heartbeatRuns.processStartedAt, run.processStartedAt),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
          if (cleared) await recordNativeLocalProcessStop(tx as unknown as Db, run);
          return cleared;
        });
        if (!cleared) {
          const current = await getRun(run.id);
          if (current) {
            await markNativeOwnershipUnverified(current, {
              reason: "live_process_identifier",
            });
          }
          throw new Error(NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE);
        }
        run = cleared;
      }
    }

    if (run.runtimeMode === "legacy" && run.controllerBootId &&
        run.controllerBootId !== legacyControllerBootId) return;
    activeRunExecutions.add(run.id);
    const timePreparation = createHeartbeatPreparationTiming(run.id);
    const executionControl = createAdapterExecutionControl();
    // This coarse scope also covers host finalization after the adapter returns.
    // Nested scopes refine the label without making any termination claim.
    executionControl.phases.enter("host_execution");
    const executionPhaseContext = { onExecutionPhase: executionControl.phases.enter };
    const controllerLease = watchLegacyControllerLease(db, run, executionControl.controller);
    let runScratch: HeartbeatRunScratch | null = null;
    let githubLauncherLocation:
      Parameters<typeof cleanupGitHubOperationLaunchers>[0] | null = null;
    let nativeSessionResumeScheduled = false;
    let nativeOwnershipHeld = false;
    let instructionWorkingCopy: ReturnType<typeof createHeartbeatInstructionWorkingCopy> | null = null;
    let nativeDispatchStarted = false;
    let nativeWorkspaceFinalizeScheduled = false;
    let nativeWorkspaceSync: Awaited<
      ReturnType<typeof prepareNativeWorkspaceSync>
    > = null;
    let requiredWorkspaceRestoreEvidence: Record<string, unknown> | null = null;
    let providerResourceDispositionForRun:
      ProviderResourceDisposition | undefined;
    const preserveNativeWorkspaceOnFailure = async () => {
      const failureRun = await getRun(run.id);
      if (failureRun?.runtimeMode === "native"
        && parseObject(failureRun.runnerProfileJson?.nativeWorkspaceSync).state === "prepared") {
        if (!nativeRunHasNoWorkspaceAccess(failureRun)) providerResourceDispositionForRun = "stop_and_retain";
        try {
          await preserveNativeFailedWorkspace(db, failureRun, {
            allowPreterminal: true,
            restartRecovery: runOptions.nativeRestartRecovery,
          });
        } catch (recoveryError) {
          if (recoveryError instanceof NativeWorkspaceFinalizationBusyError) nativeOwnershipHeld = true;
          else logger.error({ err: recoveryError, runId: run.id }, "failed to record retained native workspace recovery");
        }
      }
      return !nativeOwnershipHeld;
    };
    let nativeLifecycleTelemetryForRun:
      | {
          provider: string;
          harness: string;
          lifecycleMode: "per_turn" | "warm";
          sandboxResource:
            "keep_running" | "stop_and_reuse" | "destroy_after_turn";
        }
      | undefined;
    let managedAiRuntime: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
    let providerTraceCapture: Awaited<
      ReturnType<typeof traceStore.prepare>
    > | null = null;
    let providerTraceFinalized = false;
    let readFailureReportSecrets: () => string[] = () => [];
    let identityRedactor = createAgentIdentityRedactor();

    try {
      let agent = await getAgent(run.agentId);
      if (!agent) {
        await setRunStatus(runId, "failed", {
          error: "Agent not found",
          errorCode: "agent_not_found",
          finishedAt: new Date(),
        });
        await setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: new Date(),
          error: "Agent not found",
        });
        const failedRun = await getRun(runId);
        if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
        return;
      }

      // The claimed adapter identity is immutable recovery evidence. Do not
      // execute a newly selected adapter under a previous adapter's claim.
      const selectedAdapter = claimedAdapterType(run);
      if (selectedAdapter && selectedAdapter !== agent.adapterType) {
        throw new Error("Agent adapter changed during startup; start a new turn with the updated agent.");
      }

      const dispatchIssueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
      const resumingAdmittedConversationTurn = !!runOptions.nativeLeaseOwner
        && typeof run.contextSnapshot?.conversationSessionGeneration === "number";
      if (dispatchIssueId && isConversation(await getIssueExecutionContext(run.companyId, dispatchIssueId))
        && !resumingAdmittedConversationTurn && !(await instanceSettings.getExperimental()).enableAgentChat) {
        await setRunStatus(run.id, "cancelled", { finishedAt: new Date(), error: "Agent Chat is disabled", errorCode: "agent_chat_disabled" });
        await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: new Date() });
        await releaseIssueExecutionAndPromote((await getRun(run.id))!, { suppressImmediateRecovery: true });
        await finalizeAgentStatus(agent.id, "cancelled");
        return;
      }
      run = await prepareChatCompletionTurn(db, run);
      const preparedConversation = await prepareConversationTurn(db, run);
      run = { ...run, contextSnapshot: preparedConversation.context };
      if (preparedConversation.reset) {
        const contextSnapshot = { ...preparedConversation.context, conversationReset: true };
        await setRunStatus(run.id, "succeeded", { finishedAt: new Date(), contextSnapshot, resultJson: { conversationReset: true }, issueCommentStatus: "not_applicable" });
        await setWakeupStatus(run.wakeupRequestId, "completed", { finishedAt: new Date() });
        const resetRun = (await getRun(run.id))!;
        await settleConversationTurn(db, resetRun);
        await appendRunEvent(resetRun, { eventType: "lifecycle", stream: "system", level: "info", message: "New conversation session" });
        await releaseIssueExecutionAndPromote(resetRun, { suppressImmediateRecovery: true });
        await finalizeAgentStatus(agent.id, "succeeded");
        return;
      }
      const runtime = await ensureRuntimeState(agent);
      const context = parseObject(run.contextSnapshot);
      const authorizeFailedChatRetryExecution = () =>
        db.transaction((tx) =>
          authorizeFailedChatRunRetryWake(db, tx as unknown as Db, {
            phase: "execution",
            wakeupRequestId: run.wakeupRequestId,
            companyId: run.companyId,
            agentId: run.agentId,
            issueId: readNonEmptyString(context.issueId),
            runId: run.id,
            contextSnapshot: context,
          }),
        );
      const isFailedChatRunRetry = await authorizeFailedChatRetryExecution();
      // Never adopt a chat-execution attestation supplied in a wake payload.
      // Reviewed chat turns rebuild it from the current durable owner below.
      delete context[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY];
      delete context[EXTERNAL_CHAT_QUESTION_RESPONSE_KEY];
      const providerTraceRequested =
        parseObject(context.debug).providerTrace === "raw";
      if (providerTraceRequested) {
        if (context.providerTraceRequestSource === "agent_debug_setting") {
          try {
            await logActivity(db, {
              companyId: run.companyId,
              actorType: "system",
              actorId: "system",
              agentId: run.agentId,
              runId: run.id,
              action: "provider_trace.capture_requested",
              entityType: "heartbeat_run",
              entityId: run.id,
              details: {
                mode: "raw",
                source: "agent_debug_setting",
                retentionHours: 24,
                maxBytes: 64 * 1024 * 1024,
              },
            });
          } catch (error) {
            logger.warn(
              { error, runId: run.id },
              "provider trace capture audit could not be recorded",
            );
          }
        }
        try {
          providerTraceCapture = await traceStore.prepare({
            runId: run.id,
            companyId: run.companyId,
            provider:
              readNonEmptyString(parseObject(agent.adapterConfig).provider) ??
              agent.adapterType,
            requestedBy:
              readNonEmptyString(context.providerTraceRequestedBy) ??
              "local-admin",
          });
        } catch (error) {
          logger.warn(
            { error, runId: run.id },
            "provider trace sidecar could not be prepared",
          );
        }
      }
      const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
      const sessionCodec = getAdapterSessionCodec(agent.adapterType);
      const issueId = readNonEmptyString(context.issueId);
      if (issueId && canApplyTaskWorkspaceSelectionAtAdmission({ admittedInput: parseObject(run.runnerProfileJson).nativeExecutionInput, restarting: Boolean(runOptions.nativeRestartRecovery), hasLeaseOwner: Boolean(runOptions.nativeLeaseOwner) })) {
        const changed = await executionWorkspacesSvc.applyPendingTaskWorkspaceSelection({ companyId: agent.companyId,
          issueId, runId: run.id, actor: { type: "agent", agentId: agent.id, companyId: agent.companyId, source: "agent_key" } });
        if (changed) {
          delete context.resumeSessionParams;
          delete context.resumeSessionDisplayId;
          context.workspaceSelectionChanged = true;
        }
      }
      let issueContext = issueId
        ? await getIssueExecutionContext(agent.companyId, issueId)
        : null;
      const issueDependencyReadiness = issueId
        ? await issuesSvc
            .listDependencyReadiness(agent.companyId, [issueId])
            .then((rows) => rows.get(issueId) ?? null)
        : null;
      if (
        issueId &&
        issueContext &&
        isResolvedInteractionContinuationWakeContext(context)
      ) {
        try {
          // Claim the issue under the same active-status predicate used by the
          // queued-run staleness gate. This is the final atomic guard before
          // dispatch: an operator parking the issue after claim but before this
          // checkout must not be overwritten by the continuation.
          await issuesSvc.checkout(
            issueId,
            agent.id,
            [...resolvedInteractionCheckoutExpectedStatuses()],
            run.id,
          );
          context[PAPERCLIP_HARNESS_CHECKOUT_KEY] = true;
        } catch (error) {
          if (!isCheckoutConflictError(error)) throw error;
          const staleness = await runDispatch.cancelStaleQueuedRun({
            runId: run.id,
            companyId: run.companyId,
            expectedStatus: "running",
          });
          if (staleness.outcome === "cancelled") {
            applyRunDispatchPostCommitEffects(staleness.postCommitEffects);
            return;
          }
          throw error;
        }
        issueContext = await getIssueExecutionContext(agent.companyId, issueId);
      }
      if (
        issueId &&
        issueContext &&
        !isResolvedInteractionContinuationWakeContext(context) &&
        shouldAutoCheckoutIssueForWake({
          contextSnapshot: context,
          issueStatus: issueContext.status,
          issueAssigneeAgentId: issueContext.assigneeAgentId,
          issueExecutionState: issueContext.executionState,
          isDependencyReady:
            issueDependencyReadiness?.isDependencyReady ?? true,
          agentId: agent.id,
        })
      ) {
        try {
          await issuesSvc.checkout(
            issueId,
            agent.id,
            typeof context.workspaceReconstructionActionId === "string" ? ["todo"] : ["todo", "backlog", "blocked"],
            run.id,
          );
          context[PAPERCLIP_HARNESS_CHECKOUT_KEY] = true;
        } catch (error) {
          if (!isCheckoutConflictError(error)) throw error;
          context[PAPERCLIP_HARNESS_CHECKOUT_KEY] = false;
        }
        issueContext = await getIssueExecutionContext(agent.companyId, issueId);
      }
      if (
        issueId &&
        ((issueContext?.status === "in_review" &&
          CHAT_PROVIDERS.some(
            (provider) =>
              context.source === `chat:${provider}` ||
              context.source === `chat:${provider}:recovery`,
          )) ||
          (context.source === "issue.interaction.respond" &&
            context.externalChatContinuation === true &&
            context.interactionKind === "ask_user_questions" &&
            ["in_progress", "in_review"].includes(issueContext?.status ?? "")))
      ) {
        const attested = await attestReviewedExternalChatRun({
          db,
          companyId: agent.companyId,
          agentId: agent.id,
          issueId,
          runId: run.id,
          contextSnapshot: context,
          onQuestionResponseAttested: (answeredAtMs) => {
            attestedQuestionResponseAtMs = answeredAtMs;
          },
        });
        if (!attested)
          throw new Error("reviewed_chat_execution_binding_not_authorized");
        context[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY] = true;
      }
      const wakeCommentId = deriveCommentId(context, null);
      const wakeCommentContext =
        issueContext && wakeCommentId
          ? await db
              .select({
                id: issueComments.id,
                body: issueComments.body,
                authorType: issueComments.authorType,
                authorAgentId: issueComments.authorAgentId,
                authorUserId: issueComments.authorUserId,
                presentation: issueComments.presentation,
                metadata: issueComments.metadata,
                deletedAt: issueComments.deletedAt,
                deletedByType: issueComments.deletedByType,
                deletedByAgentId: issueComments.deletedByAgentId,
                deletedByUserId: issueComments.deletedByUserId,
                deletedByRunId: issueComments.deletedByRunId,
                sourceTrust: issueComments.sourceTrust,
              })
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.id, wakeCommentId),
                  eq(issueComments.issueId, issueContext.id),
                  eq(issueComments.companyId, agent.companyId),
                ),
              )
              .then((rows) => {
                const row = rows[0] ?? null;
                return row?.deletedAt
                  ? {
                      ...row,
                      body: "",
                      presentation: null,
                      metadata: null,
                    }
                  : row;
              })
          : null;
      let issueAssigneeOverrides =
        issueContext && issueContext.assigneeAgentId === agent.id
          ? parseIssueAssigneeAdapterOverrides(
              issueContext.assigneeAdapterOverrides,
            )
          : null;
      const experimentalInstanceSettings =
        await instanceSettings.getExperimental();
      const isolatedWorkspacesEnabled =
        experimentalInstanceSettings.enableIsolatedWorkspaces;
      // Inert on its own: the operator default only reaches the resolver when
      // isolated workspaces are enabled at all, so a stack that has one flag
      // without the other keeps its current behavior.
      const defaultIsolatedWorkspacesEnabled =
        isolatedWorkspacesEnabled &&
        experimentalInstanceSettings.enableIsolatedWorkspacesByDefault;
      const externalProvider = heartbeatExternalProvider({ run, agent });
      const [taskWorkspaceIntentRow] = issueId && !externalProvider ? await db.select({ intent: issues.workspaceSelection }).from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId))) : [];
      const freshWorkspace = await readFreshWorkspaceReadiness(db, run);
      const contextProjectId = readNonEmptyString(context.projectId);
      const boundSourceWorkspace = !externalProvider && issueContext?.executionWorkspaceId
        ? await executionWorkspacesSvc.getStoredById(agent.companyId, issueContext.executionWorkspaceId) : null;
      const [selectedWorkspaceSource] = !externalProvider && !boundSourceWorkspace && issueContext?.projectWorkspaceId
        ? await db.select({ projectId: projectWorkspaces.projectId }).from(projectWorkspaces)
          .where(and(eq(projectWorkspaces.id, issueContext.projectWorkspaceId), eq(projectWorkspaces.companyId, agent.companyId))) : [];
      const loadProjectContext = async (projectId: string | null | undefined) => projectId
        ? await db
            .select({
              id: projects.id,
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
              hasWorkspace: exists(
                db.select({ id: projectWorkspaces.id })
                  .from(projectWorkspaces)
                  .where(and(
                    eq(projectWorkspaces.projectId, projects.id),
                    eq(projectWorkspaces.companyId, agent.companyId),
                    sql`(nullif(btrim(${projectWorkspaces.cwd}), '') is not null
                      or nullif(btrim(${projectWorkspaces.repoUrl}), '') is not null)`,
                  )),
              ).mapWith(Boolean),
              hasGitSource: exists(db.select({ id: projectWorkspaces.id }).from(projectWorkspaces)
                .where(and(eq(projectWorkspaces.projectId, projects.id), eq(projectWorkspaces.companyId, agent.companyId),
                  sql`nullif(btrim(${projectWorkspaces.repoUrl}), '') is not null`))).mapWith(Boolean),
              env: projects.env,
              updatedAt: projects.updatedAt,
            })
            .from(projects)
            .where(
              and(
                eq(projects.id, projectId),
                eq(projects.companyId, agent.companyId),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;
      const taskProjectId = issueContext ? issueContext.projectId : contextProjectId;
      const taskProjectContext = await loadProjectContext(taskProjectId);
      const executionProjectId = externalProvider ? null : boundSourceWorkspace ? boundSourceWorkspace.projectId
        : taskWorkspaceIntentRow?.intent?.selection.kind === "task_directory" ? null
          : selectedWorkspaceSource?.projectId ?? (taskProjectContext?.hasWorkspace ? taskProjectId : null);
      if (issueContext) {
        if (taskProjectId) context.projectId = taskProjectId;
        else delete context.projectId;
      }
      const workspaceProjectContext = externalProvider ? null : executionProjectId === taskProjectId
        ? taskProjectContext : await loadProjectContext(executionProjectId);
      const acceptedPlanContinuationWake = issueContext && !isConversation(issueContext)
        ? readNonEmptyString(context.workspaceRefreshReason) ===
            "accepted_plan_confirmation" ||
          (issueContext.workMode === "planning" &&
            readNonEmptyString(context.interactionKind) ===
              "request_confirmation" &&
            readNonEmptyString(context.interactionStatus) === "accepted")
        : false;
      const acceptedPlanWakeRoutingDecision = issueContext
        ? await resolveAcceptedPlanWakeRoutingDecision({
            db,
            companyId: agent.companyId,
            agentId: agent.id,
            issueId,
            acceptedPlanContinuationWake,
            contextSnapshot: context,
          })
        : null;
      if (acceptedPlanWakeRoutingDecision) {
        context.forceFreshSession = true;
        context.acceptedPlanWakeRouting = {
          reason: "other_issue_claim_in_flight",
          otherActiveClaimIssueId:
            acceptedPlanWakeRoutingDecision.otherActiveClaimIssueId,
          otherActiveClaimIdentifier:
            acceptedPlanWakeRoutingDecision.otherActiveClaimIdentifier,
          otherActiveClaimTitle:
            acceptedPlanWakeRoutingDecision.otherActiveClaimTitle,
        };
        if (acceptedPlanWakeRoutingDecision.suppressAcceptedContinuation) {
          clearInteractionContinuationWakeContext(context);
          delete context.workspaceRefreshReason;
        }
      } else {
        delete context.acceptedPlanWakeRouting;
      }
      const routineEnvContext = await getRoutineEnvForExecutionIssue(
        agent.companyId,
        issueContext,
      );
      let responsibleUserId: string | null =
        await resolveResponsibleUserIdForRun({
          run,
          contextSnapshot: context,
          issueContext,
          routineEnvContext,
        });
      const identityContext = await initializeRunIdentity(db, {
        companyId: agent.companyId,
        runId: run.id,
        responsibleUserId,
        interactionId: readNonEmptyString(context.interactionId),
        issueId,
        messageIds:
          (run.retryOfRunId || context.retryOfRunId) && !isFailedChatRunRetry
            ? []
            : queuedCommentIdsFromRunContext(context).length
              ? queuedCommentIdsFromRunContext(context)
              : Array.isArray(context.wakeCommentIds)
                ? context.wakeCommentIds.filter(
                    (id): id is string => typeof id === "string",
                  )
                : wakeCommentId
                  ? [wakeCommentId]
                  : [],
        parentContextId:
          run.retryOfRunId || context.retryOfRunId
            ? null
            : (readNonEmptyString(context.originIdentityContextId) ??
              (run.triggerDetail === "manual" || context.parentRunId
                ? null
                : (issueContext?.continuationIdentityContextId ??
                  issueContext?.originIdentityContextId))),
        parentRunId:
          run.retryOfRunId ??
          readNonEmptyString(context.retryOfRunId) ??
          readNonEmptyString(context.parentRunId),
        cause:
          readNonEmptyString(context.executionIdentityCause) ??
          readNonEmptyString(context.wakeReason) ??
          "dispatch",
      });
      // Initialization has persisted the active context, including an explicit
      // absence of identity inherited from an automatic continuation.
      responsibleUserId = identityContext.responsibleUserId;
      run = {
        ...run,
        activeIdentityContextId: identityContext.id,
        responsibleUserId,
      };
      context.executionIdentityRunId = run.id;
      if (
        responsibleUserId &&
        issueContext &&
        !issueContext.responsibleUserId
      ) {
        await db
          .update(issues)
          .set({ responsibleUserId, updatedAt: new Date() })
          .where(
            and(
              eq(issues.companyId, agent.companyId),
              eq(issues.id, issueContext.id),
              isNull(issues.responsibleUserId),
            ),
          );
        issueContext = { ...issueContext, responsibleUserId };
      }
      const workspacePolicyContext = workspaceProjectContext ?? (
        !boundSourceWorkspace && !taskWorkspaceIntentRow?.intent && !issueContext?.projectWorkspaceId
          ? taskProjectContext : null
      );
      const parsedProjectExecutionWorkspacePolicy = workspacePolicyContext?.hasWorkspace
        ? await effectiveProjectWorkspacePolicy(db, agent.companyId, workspacePolicyContext.executionWorkspacePolicy, workspacePolicyContext.hasGitSource)
        : parseProjectExecutionWorkspacePolicy(workspacePolicyContext?.executionWorkspacePolicy);
      const projectExecutionWorkspacePolicy =
        applyDefaultIsolatedExecutionWorkspacePolicy({
          projectPolicy: gateProjectExecutionWorkspacePolicy(
            parsedProjectExecutionWorkspacePolicy,
            isolatedWorkspacesEnabled || Boolean(parsedProjectExecutionWorkspacePolicy?.storageProviderPluginId),
          ),
          defaultIsolatedWorkspacesEnabled,
          // Projects without workspace configuration get a plain managed
          // directory. The operator default cannot turn it into a worktree.
          hasProjectWorkspace: workspaceProjectContext?.hasWorkspace ?? false,
        });
      const runtimeWorkspaceSelectionEnabled = !externalProvider && (freshWorkspace?.mode === "fresh_isolated_workspace" || taskWorkspaceRuntimeSelectionEnabled({ legacyUiEnabled: isolatedWorkspacesEnabled || Boolean(projectExecutionWorkspacePolicy?.storageProviderPluginId), hasTypedSelection: Boolean(taskWorkspaceIntentRow?.intent), hasBinding: Boolean(issueContext?.executionWorkspaceId) }));
      const parsedIssueExecutionWorkspaceSettings =
        parseIssueExecutionWorkspaceSettings(
          issueContext?.executionWorkspaceSettings,
        );
      const issueExecutionWorkspaceSettings = runtimeWorkspaceSelectionEnabled
        ? parsedIssueExecutionWorkspaceSettings
        : null;
      const environmentExecutionWorkspaceSettings =
        selectEnvironmentExecutionWorkspaceSettings(
          parsedIssueExecutionWorkspaceSettings,
          runtimeWorkspaceSelectionEnabled,
        );
      const retainedTrust = await resolveAndRetainRunTrustPreset(db, {
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
        agent: {
          companyId: agent.companyId,
          permissions: agent.permissions,
        },
        project: taskProjectContext
          ? { companyId: agent.companyId, executionWorkspacePolicy: taskProjectContext.executionWorkspacePolicy }
          : null,
        workspaceSourceProject: workspaceProjectContext && workspaceProjectContext.id !== taskProjectContext?.id
          ? { companyId: agent.companyId, executionWorkspacePolicy: workspaceProjectContext.executionWorkspacePolicy }
          : null,
        issue: issueContext
          ? {
              companyId: agent.companyId,
              executionPolicy: issueContext.executionPolicy,
            }
          : null,
      });
      const trustPreset = retainedTrust.trustPreset;
      if (retainedTrust.executionPolicy !== undefined) {
        // Later launch-context writes must preserve the boundary already made
        // durable for authorization and operation-time credential resolution.
        context.executionPolicy = retainedTrust.executionPolicy;
      }
      let config = parseObject(agent.adapterConfig);
      const taskSession = taskKey
        ? await getTaskSession(
            agent.companyId,
            agent.id,
            agent.adapterType,
            taskKey,
          )
        : null;
      const savedRouterInput = parseObject(parseObject(run.runnerProfileJson).nativeExecutionInput);
      const routerHasPersistedInput = Object.keys(savedRouterInput).length > 0;
      if (agent.adapterType === "paperclip_runner") {
        const homeConfig = bindHeartbeatRunnerHomeMode(config, savedRouterInput);
        if ("homeMode" in homeConfig) config = { ...config, homeMode: homeConfig.homeMode };
      }
      const persistedRouterPoolId = routerHasPersistedInput ? readNonEmptyString(parseObject(context.aiRouterSelection).poolId) : null;
      const preconfiguredHome = agent.adapterType === "paperclip_runner" && config.homeMode === "preconfigured";
      const requestedAiBinding = preconfiguredHome ? undefined : persistedRouterPoolId ? { mode: "router" as const, connectionId: persistedRouterPoolId } : agent.runtimeConfig?.aiConnection ? aiRuntimeConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : undefined;
      let aiBinding = requestedAiBinding?.mode === "router" ? undefined : requestedAiBinding;
      const originalAiIssueOverrides = issueAssigneeOverrides;
      if (requestedAiBinding?.mode === "router") {
        try {
          const routerTaskKey = readNonEmptyString(context.aiRouterTaskKey) ?? taskKey ?? run.id;
          // A retry must retain the original run-key affinity even if the host
          // crashes after committing a pin but before recording its selection.
          if (routerTaskKey !== run.contextSnapshot?.aiRouterTaskKey) {
            await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ aiRouterTaskKey: routerTaskKey })}::jsonb` }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId)));
          }
          context.aiRouterTaskKey = routerTaskKey;
          const savedIdentity = taskSession?.sessionParamsJson?.paperclipAiCredentialIdentity;
          const selection = await aiConnectionRouterService(db, options.pluginWorkerManager).resolve({
            companyId: agent.companyId, poolId: requestedAiBinding.connectionId, agentId: agent.id,
            userId: responsibleUserId, adapterType: agent.adapterType, taskKey: String(context.aiRouterTaskKey),
            overrides: issueAssigneeOverrides?.adapterConfig ?? {},
            existingGrantId: typeof savedIdentity === "string" ? savedIdentity.split(":")[0] : undefined,
            requireExisting: Boolean(taskSession?.sessionDisplayId) && !shouldResetTaskSessionForWake(context),
            persisted: routerHasPersistedInput ? context.aiRouterSelection as AiConnectionRouterSelection | undefined : undefined,
          });
          aiBinding = selection.binding;
          // Provider-specific fields from the configured harness must not leak into the selected member.
          config = applyAiConnectionRouterTaskSettings(config, selection);
          if (issueAssigneeOverrides) issueAssigneeOverrides = { ...issueAssigneeOverrides, adapterConfig: applyAiConnectionRouterTaskSettings(issueAssigneeOverrides.adapterConfig ?? {}, selection) };
          agent = { ...agent, adapterConfig: config };
          context.aiRouterSelection = selection;
          await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ aiRouterTaskKey: context.aiRouterTaskKey, aiRouterSelection: selection })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
          await appendRunEvent(run, { eventType: "lifecycle", stream: "system", level: "info", message: "Using task-pinned pool account", payload: { poolId: selection.poolId, memberId: selection.memberId, provider: aiBinding.provider, model: config.model, notes: selection.notes } });
        } catch (error) {
          if (error instanceof AiConnectionPoolExhausted && !routerHasPersistedInput) {
            const now = new Date();
            context.aiConnectionBusyDeferredWhileAssignee = issueContext?.assigneeAgentId === agent.id;
            const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
              error: error.message, errorCode: error.code, finishedAt: now,
              resultJson: {
                executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
                cancellation: {
                  source: "control_plane",
                  expected: true,
                  initiator: { type: "system" },
                  reason: "Waiting for an AI connection pool account",
                  recordedAt: now.toISOString(),
                },
                retryAt: error.retryAt,
              },
              contextSnapshot: context,
            });
            if (cancelled.updated) {
              await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: error.message });
              const retry = await scheduleBoundedRetryForRun(cancelled.run ?? run, agent, { now, retryReason: AI_CONNECTION_POOL_WAIT_RETRY_REASON, wakeReason: "ai_connection_pool_retry", maxAttempts: (run.scheduledRetryAttempt ?? 0) + 1, delayMs: Math.max(1000, Date.parse(error.retryAt) - Date.now()) });
              if (retry.outcome !== "scheduled") await releaseIssueExecutionAndPromote(cancelled.run ?? run);
              await finalizeAgentStatus(run.agentId, "cancelled");
            }
            return;
          }
          throw new ConfigurationIncompleteFailure(error instanceof Error ? error.message : "Configure this connection pool", { configurationIncomplete: { reason: "ai_connection_unavailable", companyId: agent.companyId, agentId: agent.id, responsibleUserId, actionUrl: `/agents/${agent.id}/runtime`, fingerprint: `ai-router:${requestedAiBinding.connectionId}` } });
        }
      }
      if (isConversation(issueContext)) {
        delete context.resumeSessionParams;
        delete context.resumeSessionDisplayId;
        delete context.executionContinuation;
        delete context.paperclipContinuationSummary;
      }
      const taskSessionDecodedParams = normalizeSessionParams(
        sessionCodec.deserialize(context.workspaceSelectionChanged ? null : taskSession?.sessionParamsJson ?? null),
      );
      const explicitResumeSessionParams = normalizeResumeParamsForAdapter(
        agent.adapterType,
        sessionCodec.deserialize(parseObject(context.resumeSessionParams)),
      );
      const explicitResumeSessionDisplayId = truncateDisplayId(
        readNonEmptyString(context.resumeSessionDisplayId) ??
          (sessionCodec.getDisplayId
            ? sessionCodec.getDisplayId(explicitResumeSessionParams)
            : null) ??
          readNonEmptyString(explicitResumeSessionParams?.sessionId),
      );
      const resolvedExecutionWorkspaceMode = resolveExecutionWorkspaceMode({
        projectPolicy: projectExecutionWorkspacePolicy,
        issueSettings: issueExecutionWorkspaceSettings,
        legacyUseProjectWorkspace:
          issueAssigneeOverrides?.useProjectWorkspace ?? null,
      });
      const requestedExecutionWorkspaceMode = freshWorkspace?.mode === "fresh_isolated_workspace"
        ? "isolated_workspace" : trustPreset.kind === "low_trust_review" &&
        resolvedExecutionWorkspaceMode === "shared_workspace"
          ? "isolated_workspace"
          : resolvedExecutionWorkspaceMode;
      const issueRef = issueContext
        ? {
            id: issueContext.id,
            identifier: issueContext.identifier,
            title: issueContext.title,
            status: issueContext.status,
            priority: issueContext.priority,
            workMode: issueContext.workMode,
            conversationAgentId: issueContext.conversationAgentId,
            reviewPolicy: issueContext.reviewPolicy,
            description: issueContext.description,
            projectId: issueContext.projectId,
            projectWorkspaceId: issueContext.projectWorkspaceId,
            executionWorkspaceId: freshWorkspace?.mode === "fresh_isolated_workspace" ? null : issueContext.executionWorkspaceId,
            executionWorkspacePreference: freshWorkspace?.mode === "fresh_isolated_workspace" ? "create_new" : issueContext.executionWorkspacePreference,
          }
        : null;
      const storedLedgerScope = parseObject(parseObject(run.usageJson).ledgerScope);
      const runLedgerScope = Object.keys(storedLedgerScope).length > 0
        ? storedLedgerScope
        : await resolveLedgerScopeForRun(db, agent.companyId, run);
      await db.update(heartbeatRuns).set({
        usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({ ledgerScope: runLedgerScope })}::jsonb`,
      }).where(eq(heartbeatRuns.id, run.id));
      const {
        continuationSummary, executionContinuation, paperclipWakePayload, safeWakeComments, safeWakeCommentContext,
      } = await prepareHeartbeatTaskContext(db, {
        run, agent,
        task: { issueRef, issueContext, wakeCommentContext, context, taskSession },
        policy: { trustPreset, experimentalInstanceSettings, recovering: Boolean(runOptions.nativeRestartRecovery || runOptions.nativeLeaseOwner) },
        services: { issuesSvc, getPinnedSkillTestContext },
      });
      const sourceWorkspaceConfig = buildExecutionWorkspaceAdapterConfig({
        agentConfig: config,
        projectPolicy: projectExecutionWorkspacePolicy,
        issueSettings: issueExecutionWorkspaceSettings,
        mode: requestedExecutionWorkspaceMode,
        legacyUseProjectWorkspace:
          issueAssigneeOverrides?.useProjectWorkspace ?? null,
        adapterConfigOverrides: {
          ...Object.fromEntries(Object.entries(issueAssigneeOverrides?.adapterConfig ?? {}).filter(([key]) => requestedAiBinding?.mode !== "router" || !["provider", "acpxAgent", "model", "modelReasoningEffort", "reasoningEffort", "effort", "variant"].includes(key))),
          ...(requestedAiBinding?.mode === "router" ? parseObject(parseObject(context.aiRouterSelection).runtimeConfig) : {}),
        },
      });
      const {
        persistedRunnerProfile,
        persistedNativeExecutionInput,
        isDotRun,
        existingExecutionWorkspace,
        nativeRecoveryExecutionWorkspaceId,
        workspaceReuseRequest,
        requestedShouldReuseExisting,
        reusableExistingExecutionWorkspace,
        requestedReusableExecutionWorkspaceConfig,
        localEnvironment,
        resolvedInstanceSettings,
        environmentResolution,
        effectiveExecutionWorkspaceMode,
        executionPolicy,
        selectedEnvironmentId,
        selectedEnvironmentForConfig,
        nativeChatWorkspaceScope,
        nativeChatExpectedCwd: selectedNativeChatExpectedCwd,
        materializeNativeChatWorktree,
        explicitTaskDirectory,
        useIsolatedTaskDirectory,
      } = await timePreparation("environment_selection", () => selectHeartbeatEnvironment(db, {
        run, agent,
        task: { issueRef, issueContext, issueId, context, executionProjectId, workspaceProjectContext, boundSourceWorkspace,
          freshWorkspace, hasSelectedWorkspaceSource: Boolean(selectedWorkspaceSource), taskWorkspaceIntent: taskWorkspaceIntentRow?.intent ?? null, responsibleUserId },
        policy: {
          trustPreset, requestedExecutionWorkspaceMode, isolatedWorkspacesEnabled: runtimeWorkspaceSelectionEnabled,
          projectExecutionWorkspacePolicy, issueExecutionWorkspaceSettings,
        },
        config: { config, sourceWorkspaceConfig, issueAssigneeOverrides },
        services: { executionWorkspacesSvc, environmentsSvc, instanceSettings, findSharedWorkspaceHolder, findExecutionWorkspaceHolder },
      }));
      let nativeChatExpectedCwd = selectedNativeChatExpectedCwd;
      const executionConfiguration = await timePreparation("execution_configuration", () => prepareHeartbeatExecutionConfiguration(db, {
        run, agent,
        task: { issueId, context, responsibleUserId, acceptedPlanContinuationWake, acceptedPlanWakeRoutingDecision, taskProjectContext, routineEnvContext },
        config: { sourceWorkspaceConfig, aiBinding },
        policy: { trustPreset, useIsolatedTaskDirectory, explicitTaskDirectory, requestedExecutionWorkspaceMode },
        environment: { selectedEnvironmentId, selectedEnvironmentForConfig, resolvedInstanceSettings, persistedNativeExecutionInput },
        services: { secretsSvc, companySkills, appendRunEvent, finalizeAiConnectionBusyDeferral },
        onFailureSecretsResolved: (readSecrets) => { readFailureReportSecrets = () => [...readSecrets(), ...identityRedactor.values]; },
        onManagedAiRuntimeAcquired: (runtime) => { managedAiRuntime = runtime; },
        onIdentityRedactorPrepared: (redactor) => { identityRedactor = redactor; },
      }));
      if (!executionConfiguration.prepared) return;
      const {
        mergedConfig, configSnapshot, runScopedMentionedSkillKeys, githubSelection, useHostGitHub,
        resolvedConfig, configuredTaskEnvironment, secretKeys, secretManifest,
        runtimeSkillEntries, nativeRunnerPreparationSpans, agentIdentity, observability,
      } = executionConfiguration;
      let { runtimeConfig } = executionConfiguration;
      const resolvedFailureSecrets = readFailureReportSecrets();
      readFailureReportSecrets = () => [
        ...resolvedFailureSecrets,
        ...identityRedactor.values,
        ...collectRunFailureSecretValues(runtimeConfig.env, secretKeys),
      ];
      const preparedSession = await timePreparation("session", () => prepareHeartbeatSession(db, {
        run, agent,
        task: { context, issueRef, issueContext, taskProjectContext, workspaceProjectContext, wakeCommentId, acceptedPlanContinuationWake, acceptedPlanWakeRoutingDecision },
        session: { taskSession, taskSessionDecodedParams, explicitResumeSessionParams, explicitResumeSessionDisplayId, sessionCodec },
        config: {
          runtimeConfig, agentIdentity, issueAssigneeOverrides, originalAiIssueOverrides,
          managedAiRuntime, aiBinding, requestedAiBinding, secretManifest, runtimeSkillEntries, routineEnvContext,
        },
        workspace: {
          requestedExecutionWorkspaceMode, effectiveExecutionWorkspaceMode, projectExecutionWorkspacePolicy,
          issueExecutionWorkspaceSettings, executionPolicy, requestedReusableExecutionWorkspaceConfig, reusableExistingExecutionWorkspace,
        },
        environment: { environmentResolution, selectedEnvironmentId, selectedEnvironmentForConfig },
        getLatestAgentConfigRevision,
      }));
      const { sessionConfigMetadata, configuredModel, resetTaskSession, sessionResetReason, taskSessionForRun, getFreshSessionHandoff, previousSessionParams } = preparedSession;
      const {
        resolvedWorkspace,
        hostExecutionWorkspaceConfig,
        skipHostProvision,
        latestWorkspaceConfigMetadata,
        workspaceConfigFreshness,
        workspaceOperationRecorder,
        executionWorkspace,
        reusedExecutionWorkspace,
        resolvedWorkspaceReusePolicy,
        persistedExecutionWorkspace,
        projectRepositoryPaths,
        environmentAcquireStartedAtMs,
        selectedEnvironment,
        activeEnvironmentLease,
        realizationResult,
        environmentRealizeEndedAtMs,
        workspaceRealization,
        executionTarget,
        workspaceRestoreSource,
      } = await timePreparation("workspace", () => prepareHeartbeatWorkspace(db, {
        run, agent, controllerLease, nativeRunnerPreparationSpans,
        task: {
          issueRef,
          issueId,
          context,
          responsibleUserId,
          previousSessionParams,
          workspaceSelection: taskWorkspaceIntentRow?.intent ?? null,
          freshWorkspace,
        },
        policy: {
          trustPreset,
          isolatedWorkspacesEnabled: runtimeWorkspaceSelectionEnabled,
          effectiveExecutionWorkspaceMode,
          requestedExecutionWorkspaceMode,
          useIsolatedTaskDirectory,
          nativeChatWorkspaceScope,
          projectExecutionWorkspacePolicy,
          issueExecutionWorkspaceSettings,
          environmentExecutionWorkspaceSettings,
          executionPolicy,
        },
        environment: {
          selectedEnvironmentId,
          localEnvironment,
          selectedEnvironmentForConfig,
          environmentResolution,
          resolvedInstanceSettings,
        },
        config: {
          mergedConfig,
          configSnapshot,
          secretManifest,
          managedAiCredentialIdentity: managedAiRuntime?.identity,
        },
        reuse: {
          requestedShouldReuseExisting,
          existingExecutionWorkspace,
          reusableExistingExecutionWorkspace,
          workspaceReuseRequest,
          nativeRecoveryExecutionWorkspaceId,
          persistedNativeExecutionInput,
          isDotRun,
          runOptions,
        },
        services: {
          workspaceWorkers: options.pluginWorkerManager,
          envOrchestrator,
          executionWorkspacesSvc,
          workspaceOperationsSvc,
          resolveWorkspaceForRun,
          resolveReusedGitWorkspaceAnchor,
          appendRunEvent,
        },
      }));
      const preparedInstructions = instructionWorkingCopy = createHeartbeatInstructionWorkingCopy({
        observabilityCompatibilityKey: observability?.compatibilityKey,
        db, instructionCopies, readRun: () => run!, agent, context,
        session: { taskSession, taskSessionForRun, sessionConfigMetadata },
        workspace: { executionTarget, executionWorkspace, persistedExecutionWorkspace },
        appendRunEvent,
      });
      if (managedAiRuntime && aiBinding) {
        try { await assertManagedAiProjectAuth({ ...resolvedConfig, cwd: executionWorkspace.cwd }, aiBinding.provider, executionTarget); }
        catch { throw new ConfigurationIncompleteFailure("Project authentication conflicts with this agent’s managed AI connection", { configurationIncomplete: { reason: "ai_connection_incompatible", actionUrl: `/agents/${agent.id}/runtime` } }); }
      }
      const remoteExecution = realizationResult.remoteExecution;
      if (nativeChatWorkspaceScope && materializeNativeChatWorktree) {
        nativeChatExpectedCwd = nativeChatWorkspaceCwd(nativeChatWorkspaceScope, persistedExecutionWorkspace, true);
      }
      if (
        nativeChatWorkspaceScope &&
        (executionTarget?.kind === "remote" ||
          path.resolve(executionWorkspace.cwd) !== nativeChatExpectedCwd)
      ) {
        throw new ConfigurationIncompleteFailure(
          "External chat workspace realization did not preserve this task's isolated filesystem. Repair its workspace before retrying.",
          {
            configurationIncomplete: {
              reason: "native_chat_workspace_realization_mismatch",
              issueId,
            },
          },
        );
      }
      const dispatchResolvedInteractionContinuationAfterAdmission = async <T>(
        dispatch: (markDispatchStarted: () => void) => Promise<T>,
        reservation: { id: string; reused: boolean },
      ): Promise<
        { dispatched: true; resultPromise: Promise<T> } | { dispatched: false }
      > => {
        await controllerLease.assertOwned("dispatching");
        // Recheck after preparation. The final locked gate commits a dispatch
        // claim before entering adapter bootstrap or contacting a provider.
        await authorizeFailedChatRetryExecution();
        if (
          !(await withChatControlRecoveryGate(
            run,
            "dispatch",
            async () => run,
            Boolean(
              runOptions.nativeLeaseOwner || runOptions.nativeRestartRecovery,
            ),
          ))
        )
          return { dispatched: false };
        const repairBlock = await recovery.legacyRepairDispatchBlock(run.id);
        if (repairBlock) {
          const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
            finishedAt: new Date(), errorCode: "legacy_disposition_repair_suppressed",
            error: `Disposition repair suppressed: ${repairBlock}`,
          });
          if (cancelled.updated) {
            await setWakeupStatus(run.wakeupRequestId, "skipped", { finishedAt: new Date(), error: repairBlock });
            await releaseIssueExecutionAndPromote(cancelled.run!, { suppressImmediateRecovery: true });
            await finalizeAgentStatus(run.agentId, "cancelled");
          }
          return { dispatched: false };
        }
        const enforceContinuationOwnership = Boolean(issueId && (isResolvedInteractionContinuationWakeContext(context) ||
          typeof context.workspaceReconstructionActionId === "string" ||
          ["native_safe_replacement", "native_provider_overloaded"].includes(run.scheduledRetryReason ?? "")));
        if (issueId && enforceContinuationOwnership) {
          await options.beforeResolvedInteractionContinuationDispatchCheck?.({ runId: run.id, issueId });
          await options.afterResolvedInteractionContinuationDispatchCheck?.({ runId: run.id, issueId });
        }
        const gate = await runDispatch.dispatchResolvedInteractionIfCurrent({
          runId: run.id,
          companyId: run.companyId,
          expectedStatus: "running",
          reservationId: reservation.id,
          enforceContinuationOwnership,
          ...(runOptions.nativeLeaseOwner ? { recoveryLeaseOwner: runOptions.nativeLeaseOwner } : {}),
          // The gate persists admission under the ownership lock, then invokes
          // this callback after commit so provider I/O holds no accounting lock.
          dispatch,
        });

        if (gate.dispatched) return gate;
        if ("admissionBlockReason" in gate) throw conflict(gate.admissionBlockReason);
        if (gate.cancellation.outcome === "cancelled") {
          applyRunDispatchPostCommitEffects(
            gate.cancellation.postCommitEffects,
          );
        }
        return { dispatched: false };
      };
      const dispatchResolvedInteractionContinuationWithAtomicGate = async <T>(
        dispatch: (markDispatchStarted: () => void) => Promise<T>,
      ) => {
        // Admission can wait for accounting locks. Finish that wait before the
        // final ownership gate, whose callback must enter the adapter directly.
        const reservation = await measureRunPhase("execution.budget_reservation", () =>
          reserveRunBudget(db, run.companyId, run.id,
            readNonEmptyString(runLedgerScope.projectId), runLedgerScope, runOptions.nativeLeaseOwner));
        let entered = false;
        try {
          return await dispatchResolvedInteractionContinuationAfterAdmission((markDispatchStarted) => {
            entered = true;
            return dispatch(markDispatchStarted);
          }, reservation);
        } finally {
          if (!entered && !reservation.reused) {
            await db.update(heartbeatRuns).set({ costAccountingPending: true,
              usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || '{"accountingProviderWorkStarted":false}'::jsonb`,
            }).where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.costAccountedAt)));
            await accountRunCost(db, run.id, budgetHooks).catch((err) => {
              logger.warn({ err, runId: run.id }, "Undispatched reservation release remains pending");
            });
          }
        }
      };
      if (!executionTarget || executionTarget.kind === "local") {
        try {
          runScratch = await prepareHeartbeatRunScratch({
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            issueId: issueRef?.id ?? null,
            issueIdentifier: issueRef?.identifier ?? null,
          });
          const existingRuntimeEnv = parseObject(runtimeConfig.env);
          const scratchEnv = buildHeartbeatRunScratchEnv(
            existingRuntimeEnv,
            runScratch,
          );
          runtimeConfig = {
            ...runtimeConfig,
            env: {
              ...existingRuntimeEnv,
              ...scratchEnv.env,
            },
          };
          context.paperclipScratch = {
            type: "heartbeat_run",
            dir: runScratch.dir,
            cleanupPolicy: "terminal_run",
            marker: HEARTBEAT_RUN_SCRATCH_MARKER,
            tempKeysApplied: scratchEnv.tempKeysApplied,
          };
        } catch (scratchPrepareError) {
          runScratch = null;
          delete context.paperclipScratch;
          logger.warn(
            {
              err: scratchPrepareError,
              runId: run.id,
              issueId,
              agentId: agent.id,
            },
            "failed to prepare heartbeat run scratch directory; continuing without scratch env",
          );
        }
      } else {
        delete context.paperclipScratch;
      }
      if (issueId && (!executionTarget || executionTarget.kind === "local")) {
        await recordLegacyCaseHandoffCleanupIntent(db, { runId: run.id, issueId, controllerBootId: legacyControllerBootId, scratch: runScratch });
      }
      const gitExecutionEnv = await timePreparation("github_environment", () => prepareGitHubExecutionEnvironment({
        target: executionTarget,
        cwd: executionWorkspace.cwd,
        env: Object.fromEntries(
          Object.entries(parseObject(runtimeConfig.env)).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        hostCredentials: useHostGitHub,
        // Networking is a controller-owned trust decision, independent of
        // whether GitHub is configured or a credential can be acquired.
        networkAccess:
          trustPreset.kind === "standard" &&
          process.env.PAPERCLIP_RUNNER_NETWORK_ACCESS !== "disabled",
      }));
      runtimeConfig = { ...runtimeConfig, env: gitExecutionEnv };
      for (const key of MANAGED_GITHUB_TOKEN_KEYS) secretKeys.add(key);
      context.githubAuthenticationMode = useHostGitHub ? "host" : "managed";
      if (!useHostGitHub) {
        const githubLaunchers = await timePreparation("github_launchers", () => prepareHeartbeatGitHubLaunchers({
          native: agent.adapterType === "paperclip_runner",
          githubConfigured: githubSelection.configured,
          agentId: agent.id,
          runId: run.id,
          target: executionTarget,
          cwd: executionWorkspace.cwd,
          env: gitExecutionEnv,
          brokerUrl: configuredPaperclipApiBaseUrl() ?? "",
          createBrokerToken: () => createRuntimeToolsToken({
            agentId: agent.id,
            companyId: agent.companyId,
            runId: run.id,
            responsibleUserId: responsibleUserId ?? "",
            scope: "github_credentials",
          })?.token ?? "",
        }));
        githubLauncherLocation = githubLaunchers.cleanupLocation;
        runtimeConfig = { ...runtimeConfig, env: githubLaunchers.env };
        secretKeys.add("PAPERCLIP_GITHUB_BROKER_TOKEN");
      }
      context.paperclipEnvironment = {
        id: selectedEnvironment.id,
        name: selectedEnvironment.name,
        driver: selectedEnvironment.driver,
        leaseId: activeEnvironmentLease.lease.id,
        workspaceRealization,
        sandboxLeaseAcquisition:
          activeEnvironmentLease.lease.metadata?.sandboxLeaseAcquisition ??
          null,
        ...(typeof activeEnvironmentLease.lease.metadata?.remoteCwd === "string"
          ? {
              remoteCwd: activeEnvironmentLease.lease.metadata.remoteCwd,
              host:
                typeof activeEnvironmentLease.lease.metadata?.host === "string"
                  ? activeEnvironmentLease.lease.metadata.host
                  : undefined,
              port:
                typeof activeEnvironmentLease.lease.metadata?.port === "number"
                  ? activeEnvironmentLease.lease.metadata.port
                  : undefined,
              username:
                typeof activeEnvironmentLease.lease.metadata?.username ===
                "string"
                  ? activeEnvironmentLease.lease.metadata.username
                  : undefined,
            }
          : {}),
      };
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
      const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
        agentId: agent.id,
        previousSessionParams,
        resolvedWorkspace: {
          ...resolvedWorkspace,
          cwd: executionWorkspace.cwd,
        },
      });
      const runtimeSessionParams = runtimeSessionResolution.sessionParams;
      const runtimeWorkspaceWarnings = [
        ...resolvedWorkspace.warnings,
        ...executionWorkspace.warnings,
        ...(runtimeSessionResolution.warning
          ? [runtimeSessionResolution.warning]
          : []),
        ...(requestedShouldReuseExisting &&
        workspaceConfigFreshness.reasons.length > 0
          ? [
              `Execution workspace reuse freshness action "${workspaceConfigFreshness.action}" because ${workspaceConfigFreshness.reasons.join("; ")}.`,
            ]
          : []),
        ...(resetTaskSession && sessionResetReason
          ? [
              taskKey
                ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
                : `Skipping saved session resume because ${sessionResetReason}.`,
            ]
          : []),
      ];
      context.paperclipWorkspace = {
        cwd: executionWorkspace.cwd,
        source: executionWorkspace.source,
        mode: effectiveExecutionWorkspaceMode,
        strategy: executionWorkspace.strategy,
        projectId: executionWorkspace.projectId,
        workspaceId: executionWorkspace.workspaceId,
        repoUrl: executionWorkspace.repoUrl,
        repoRef: executionWorkspace.repoRef,
        branchName: executionWorkspace.branchName,
        worktreePath: executionWorkspace.worktreePath,
        realization: workspaceRealization,
        agentHome: await (async () => {
          const home = resolveDefaultAgentWorkspaceDir(agent.id);
          await fs.mkdir(home, { recursive: true });
          return home;
        })(),
      };
      context.paperclipWorkspaces = buildRunWorkspaceHints(resolvedWorkspace);
      // Emit exactly one requested-vs-synced observability line for the referenced-project set. A run
      // with no referenced project stays silent, so this adds no noise to the anchor-only default. The
      // per-drop human warning already rides `runtimeWorkspaceWarnings`; this line carries the counts
      // and the per-failure reason for a partial sync.
      const referencedProjectObservability =
        buildReferencedProjectRunObservability({
          syncedProjectIds: resolvedWorkspace.runnerTaskProjectIds?.filter(id => id !== resolvedWorkspace.projectId) ?? resolvedWorkspace.additionalWorkspaces.map(
            (additional) => additional.projectId,
          ),
          failures: resolvedWorkspace.referencedProjectFailures,
        });
      if (referencedProjectObservability.referenced_projects_requested > 0) {
        logger.info(
          {
            runId: run.id,
            companyId: agent.companyId,
            issueId: issueRef?.id ?? null,
            ...referencedProjectObservability,
          },
          "run referenced-project sync",
        );
      }
      // The wake payload is built before the execution workspace is resolved, so
      // attach the branch pin here; the shared wake-prompt renderer surfaces it as
      // a one-time "stay on this branch" hint on non-resumed sessions.
      if (executionWorkspace.branchName) {
        const wakePayloadForWorkspace = parseObject(
          context[PAPERCLIP_WAKE_PAYLOAD_KEY],
        );
        context[PAPERCLIP_WAKE_PAYLOAD_KEY] = {
          ...wakePayloadForWorkspace,
          executionWorkspace: { branchName: executionWorkspace.branchName },
        };
      }
      prepareHeartbeatRuntimeServiceIntents({ hostExecutionWorkspaceConfig, context, trustPreset });
      if (
        !issueContext && executionWorkspace.projectId &&
        !readNonEmptyString(context.projectId)
      ) {
        context.projectId = executionWorkspace.projectId;
      }
      const {
        previousSessionDisplayId, runtimeSessionParamsForAdapter, taskSessionCredentialCompatible, runtimeForAdapter, configFreshnessResultMetadata, sessionCompaction,
      } = await resolveHeartbeatAdapterSession({
        agent,
        task: { context, taskKey, issueId, continuationSummary, executionContinuation },
        session: { runtime, taskSession, sessionCodec, explicitResumeSessionDisplayId, runtimeSessionParams, managedAiRuntime, prepared: preparedSession },
        workspace: {
          latestWorkspaceConfigMetadata, workspaceConfigFreshness, reusedExecutionWorkspace, resolvedWorkspaceReusePolicy,
          persistedExecutionWorkspace, runtimeWorkspaceWarnings, requestedShouldReuseExisting, workspaceReuseRequest,
        },
        evaluateSessionCompaction,
      });

      const runOutput = createHeartbeatRunOutput(db, {
        run, runId, issueId, runLogStore, identityRedactor, secretKeys,
        appendRunEvent, getCurrentUserRedactionOptions,
      });
      const goalCheckpointSession: {
        current: {
          params: Record<string, unknown>;
          displayId: string;
        } | null;
      } = { current: null };
      try {
        const startedAt = run.startedAt ?? new Date();
        const runningWithSession = await db
          .update(heartbeatRuns)
          .set({
            startedAt,
            sessionIdBefore:
              runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (runningWithSession) run = runningWithSession;

        // Pause Durability: flip to "running" ONLY if the agent is still invokable.
        // Atomic conditional UPDATE is the sole gate (no read-then-write); 0 rows => abort.
        const runningAgent = await db
          .update(agents)
          .set({ status: "running", updatedAt: new Date() })
          .where(
            and(
              eq(agents.id, agent.id),
              notInArray(agents.status, [...DIRECT_NON_INVOKABLE_STATUSES]),
              eq(agents.lifecycleState, "ready"),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!runningAgent) {
          logger.warn(
            { agentId: agent.id, runId: run.id, previousStatus: agent.status },
            "execution-start aborted: agent not invokable",
          );
          const abortReason =
            "Cancelled: agent not invokable at execution-start";
          await setRunStatus(run.id, "cancelled", {
            finishedAt: new Date(),
            error: abortReason,
            errorCode: "agent_not_invokable",
            ...(agent
              ? {
                  resultJson: mergeRunStopMetadataForAgent(agent, "cancelled", {
                    resultJson: parseObject(run.resultJson),
                    errorCode: "agent_not_invokable",
                    errorMessage: abortReason,
                  }),
                }
              : {}),
          });
          await setWakeupStatus(run.wakeupRequestId, "cancelled", {
            finishedAt: new Date(),
            error: abortReason,
          });
          await releaseIssueExecutionAndPromote(run);
          return;
        }

        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });

        const currentRun = run;
        await appendRunEvent(currentRun, {
          eventType: "lifecycle",
          stream: "system",
          level: "info",
          message: "run started",
        });

        const { currentUserRedactionOptions, appendIdentityRedactedLog, onLog, onAdapterMeta, onAdapterEvent } =
          await timePreparation("run_output", () => runOutput.begin(currentRun));
        if (runScopedMentionedSkillKeys.length > 0) {
          await onLog(
            "stdout",
            `[paperclip] Enabled run-scoped skills from issue mentions: ${runScopedMentionedSkillKeys.join(", ")}\n`,
          );
        }
        for (const warning of runtimeWorkspaceWarnings) {
          const logEntry = formatRuntimeWorkspaceWarningLog(warning);
          await onLog(logEntry.stream, logEntry.chunk);
        }
        await timePreparation("workspace_validation", () => assertGitSensitiveAdapterWorkspaceValid({
          adapterType: agent.adapterType,
          agentId: agent.id,
          issue: issueRef
            ? {
                id: issueRef.id,
                identifier: issueRef.identifier,
                projectId: issueRef.projectId,
                projectWorkspaceId: issueRef.projectWorkspaceId,
              }
            : null,
          resolvedWorkspace,
          executionWorkspace,
          persistedExecutionWorkspace,
          executionTarget,
          environmentDriver: selectedEnvironment.driver,
          leaseMetadata: activeEnvironmentLease.lease.metadata,
        }));
        const adapterEnv = Object.fromEntries(
          Object.entries(parseObject(runtimeConfig.env)).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        );
        const runtimeServices = await timePreparation("runtime_services", () => startHeartbeatRuntimeServices(db, {
          run, agent, issueId, issueRef, executionWorkspace, context, issuesSvc, onLog,
          persistedExecutionWorkspace, hostExecutionWorkspaceConfig, skipHostProvision, adapterEnv, workspaceOperationRecorder,
        }));
        const adapter = getServerAdapter(agent.adapterType);
        const durableGoalControlRun =
          readNonEmptyString(context.goalControlRequestId) !== null ||
          context.resumeSessionGoalHeartbeat === true;
        // Goals must use the selected durable runner, never silently convert a
        // direct adapter or let an old goal-control wake become a normal prompt.
        if (durableGoalControlRun && agent.adapterType !== "paperclip_runner") {
          const requestId = readNonEmptyString(context.goalControlRequestId);
          if (issueRef && requestId) {
            await failRunnerGoalAction(
              db,
              {
                companyId: run.companyId,
                issueId: issueRef.id,
                agentId: agent.id,
                adapterType: agent.adapterType,
              },
              requestId,
              "direct_adapter_goal_controller_unavailable",
            );
          }
          throw new Error("direct_adapter_goal_controller_unavailable");
        }
        // Runtime selection is immutable once persisted. In particular, turning the instance flag
        // off prevents new native runs without changing the recovery path for an already-native run.
        const nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({
          persisted: run,
          enabled:
            resolvedInstanceSettings.experimental.enableNativeRunner === true,
          museEnabled: resolvedInstanceSettings.experimental.enableMuse === true,
          grokEnabled: resolvedInstanceSettings.experimental.enableGrokBot === true && resolvedInstanceSettings.experimental.enablePublicMcp === true,
          dotEnabled: resolvedInstanceSettings.experimental.enableOpenAiDot === true
            && resolvedInstanceSettings.experimental.enablePublicMcp === true,
          runtimeConfig: agent.runtimeConfig,
          adapterConfig: agent.adapterConfig,
          agent: {
            id: agent.id,
            companyId: agent.companyId,
            status: runningAgent.status,
            adapterType: agent.adapterType,
          },
          issue: issueRef,
          target: executionTarget,
          workspaceId: persistedExecutionWorkspace?.id ?? null,
        });
        const hasInstructionFilesystem = nativeRuntimeResolution.kind !== "native"
          ? adapter.supportsInstructionsBundle === true
          : nativeRuntimeHasInstructionFilesystem(nativeRuntimeResolution.profile.backend);
        runtimeConfig = await timePreparation("instructions", () => preparedInstructions.prepare({ runtimeConfig, nativeRuntimeResolution, hasInstructionFilesystem }));
        const runtimeSelection = await timePreparation("runtime_selection", () => selectHeartbeatRuntime(db, {
          run,
          agent,
          nativeRuntimeResolution,
          task: {
            issueRef,
            issueContext,
            context,
            executionContinuation,
            safeWakeComments,
            safeWakeCommentContext,
            paperclipWakePayload,
            acceptedPlanContinuationWake,
          },
          session: {
            persistedNativeExecutionInput,
            persistedRunnerProfile,
            taskSessionCredentialCompatible,
            taskSessionDecodedParams,
            taskSessionForRun,
            isFailedChatRunRetry,
            getFreshSessionHandoff,
          },
          workspace: {
            persistedExecutionWorkspace,
            executionWorkspace,
            executionTarget,
            activeEnvironmentLease,
            isDotRun,
            projectRepositoryPaths,
            onCheckpoint: async (metrics) => {
              await appendRunEvent(run, { eventType: "lifecycle", stream: "system", level: "info",
                message: "workspace_checkpoint", payload: { phase: "workspace_checkpoint", ...metrics } });
            },
            onPhase: async (name, work) => {
              if (isWorkspaceSyncDetailPhase(name)) return measureWorkspaceSyncPhase(name, work);
              const started = Date.now();
              try { return await measureWorkspaceSyncPhase(name, work); }
              finally { await measureRunPhase("workspace_sync.progress", () => appendRunEvent(run, { eventType: "lifecycle", stream: "system", level: "info",
                message: name, payload: { phase: name, durationMs: Date.now() - started } })); }
            },
          },
          config: {
            runtimeConfig,
            runtimeSkillEntries,
            runScopedMentionedSkillKeys,
            instructionCopy: preparedInstructions.instructionCopy,
            agentIdentity,
            issueAssigneeOverrides,
            resolvedConfig,
            managedAiRuntime,
          },
          recovery: runOptions,
          trace: { providerTraceRequested, providerTraceCapture },
          issuesSvc,
          runtimeEnv,
          beforeNativeRuntimeSelection: options.beforeNativeRuntimeSelection,
          onAdapterEvent,
          onNativeLifecycleSelected: (telemetry) => {
            nativeLifecycleTelemetryForRun = telemetry;
          },
          onProviderResourceDisposition: (disposition) => {
            providerResourceDispositionForRun = disposition;
          },
          onNativeOwnershipHeld: () => {
            nativeOwnershipHeld = true;
          },
          stopControllerLease: () => controllerLease.stop(),
        }));
        if (!runtimeSelection.selected) return;
        const { nativeExecution, nativeRunnerInstanceId, getNativeFreshSessionHandoff } = runtimeSelection;
        nativeWorkspaceSync = runtimeSelection.nativeWorkspaceSync;
        const execution = await measureRunPhase("execution.runtime", () => executeHeartbeatRuntime(db, {
          run, agent, options,
          task: {
            issueRef,
            issueContext,
            context,
            issueId,
            taskKey,
            executionContinuation,
          },
          runtime: {
            nativeRuntimeResolution,
            nativeExecution,
            nativeRunnerInstanceId,
            adapter,
            runtimeForAdapter,
            getNativeFreshSessionHandoff,
            getFreshSessionHandoff,
            runOptions,
          },
          workspace: {
            persistedExecutionWorkspace,
            executionWorkspace,
            executionTarget,
            workspaceOperationRecorder,
            nativeWorkspaceSync,
            workspaceRestoreSource,
            remoteExecution,
          },
          config: {
            runtimeConfig,
            resolvedConfig,
            resolvedInstanceSettings,
            configuredTaskEnvironment,
            adapterEnv,
            agentIdentity,
            observability,
            managedAiRuntime,
            runtimeEnv,
            useHostGitHub,
            githubSelection,
          },
          session: {
            runtimeSessionParamsForAdapter,
            configuredModel,
            sessionConfigMetadata,
            goalCheckpointSession,
          },
          instructions: {
            nativeInstructionWorkingCopy: preparedInstructions.nativeInstructionWorkingCopy,
            collectStoppedInstructions: preparedInstructions.collectStoppedInstructions,
            nativeInstructionReservation: preparedInstructions.nativeInstructionReservation,
            releaseInstructionCopy,
            get instructionCopy() { return preparedInstructions.instructionCopy; },
            getInstructionSave: preparedInstructions.getInstructionSave,
          },
          trace: {
            providerTraceCapture,
            nativeRunnerPreparationSpans,
            attestedQuestionResponseAtMs,
            attemptStartedAtMs,
            environmentAcquireStartedAtMs,
            environmentRealizeEndedAtMs,
          },
          control: {
            executionControl,
            executionPhaseContext,
            dispatchResolvedInteractionContinuationWithAtomicGate,
          },
          output: {
            identityRedactor,
            appendIdentityRedactedLog,
            onLog,
            onAdapterEvent,
            onAdapterMeta,
          },
          services: {
            executionWorkspacesSvc,
            instanceSettings,
            envOrchestrator,
            upsertTaskSession,
            getRun,
            cancelRunInternal,
            enqueueWakeup,
            persistRunProcessMetadata: async (processRunId, meta) => {
              if (!issueId || (executionTarget && executionTarget.kind !== "local")) {
                return persistRunProcessMetadata(processRunId, meta);
              }
              // Bind cleanup intent to this exact process generation in the
              // same commit as its host-observed PID/group/start identity.
              return db.transaction(async transaction => {
                const tx = transaction as unknown as Db;
                const persisted = await persistHeartbeatRunProcessMetadata(tx, processRunId, meta);
                await recordLegacyCaseHandoffCleanupIntent(tx, { runId: processRunId, issueId,
                  controllerBootId: legacyControllerBootId, scratch: runScratch });
                return persisted;
              });
            },
            recordCurrentHeartbeatRunRuntimeProgress,
            dispatchPendingNativeStatusWakeups,
          },
          effects: {
            onUsageCaptureReady: (value) => { persistUsageCaptureFailure = value; },
            onNativeDispatchStarted: () => { nativeDispatchStarted = true; },
            onLegacyAdapterEntered: () => {
              legacyAdapterEntered = true;
              legacyLocalAdapterEntered = legacyAdapterNeedsLocalProcessSettlement({
                adapterType: adapter.type, executionTargetKind: executionTarget?.kind,
              });
            },
            onNativeWorkspaceFinalizeScheduled: () => { nativeWorkspaceFinalizeScheduled = true; },
            onNativeSessionResumeScheduled: () => { nativeSessionResumeScheduled = true; },
            onNativeOwnershipHeld: () => { nativeOwnershipHeld = true; },
            onProviderResourceDisposition: (value) => { providerResourceDispositionForRun = value; },
            onWorkspaceRestoreFailure: (evidence) => { requiredWorkspaceRestoreEvidence = evidence; },
          },
        }));
        if (!execution.dispatched) return;
        const { adapterResult } = execution;
        // Reconcile the referenced-project set against the real remote staging outcome. A referenced
        // project can pass authorization and clone locally at run prep, then fail to stage into the
        // sandbox during execution. The run-prep observability above counts such a project as synced,
        // so emit a second, stage-time line that counts each staging failure as a first-class
        // `staging` failure. The synced set is the resolved referenced projects minus the ones that
        // failed to stage. A run with no staging failure stays silent, so the anchor-only and
        // fully-synced paths add no noise.
        const referencedProjectStagingFailures =
          adapterResult.referencedProjectStagingFailures ?? [];
        if (referencedProjectStagingFailures.length > 0) {
          const stagingFailedProjectIds = new Set(
            referencedProjectStagingFailures.map(
              (failure) => failure.projectId,
            ),
          );
          const stagedProjectObservability =
            buildReferencedProjectRunObservability({
              syncedProjectIds: resolvedWorkspace.additionalWorkspaces
                .map((additional) => additional.projectId)
                .filter((projectId) => !stagingFailedProjectIds.has(projectId)),
              failures: referencedProjectStagingFailures.map((failure) => ({
                projectId: failure.projectId,
                reason: "staging" as const,
                error: failure.error,
              })),
            });
          logger.info(
            {
              runId: run.id,
              companyId: agent.companyId,
              issueId: issueRef?.id ?? null,
              ...stagedProjectObservability,
            },
            "run referenced-project remote staging",
          );
        }
        await recordHeartbeatAdapterRuntimeServices(db, {
          run, agent, issueId, issueRef, executionWorkspace, context, issuesSvc, onLog,
          adapterResult, runtimeServices,
        });
        await measureRunPhase("completion.run", () => runCompletion.completeRun({
          run, agent, issueId, issueRef, signal: executionControl.controller.signal,
          output: runOutput,
          session: { runtimeForAdapter, previousSessionParams, taskKey, configuredModel, sessionConfigMetadata },
          readFailureReportSecrets,
          adapterResult, sessionCodec, taskSessionForRun, sessionCompaction,
          configFreshnessResultMetadata, runLedgerScope, currentUserRedactionOptions,
          providerTraceCapture: providerTraceCapture !== null,
          onProviderTraceFinalized: () => { providerTraceFinalized = true; },
          issueContext, onLog,
        }));
      } catch (err) {
        await persistUsageCaptureFailure?.();
        if (err instanceof NativeControllerDetachedForRestartError) {
          nativeSessionResumeScheduled = true;
          return;
        }
        if (err instanceof NativeRunnerOwnershipUnverifiedError) {
          nativeOwnershipHeld = true;
          const heldRun = await getRun(run.id);
          if (heldRun)
            await markNativeOwnershipUnverified(heldRun, {
              reason: err.reason,
            });
          return;
        }
        if (err instanceof NativeCancellationPendingRecoveryError) {
          await preserveNativeWorkspaceOnFailure();
          await cancelRunInternal(
            run.id,
            "Recovered durable native run cancellation",
          );
          return;
        }
        if (err instanceof NativeSessionResumeScheduledError) {
          const retryMessage =
            err.original instanceof Error
              ? err.original.message
              : String(err.original ?? "");
          const retryReasonCode = /native_finalization_missing/i.test(
            retryMessage,
          )
            ? "semantic_result_missing"
            : "native_session_interrupted";
          const coordinator = await db
            .select({
              nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
              attempt: nativeRunFinalizations.attempt,
              failureDetail: nativeRunFinalizations.failureDetail,
            })
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, run.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          await appendRunEvent(run, {
            eventType: "lifecycle",
            stream: "system",
            level: "warn",
            message:
              retryReasonCode === "semantic_result_missing"
                ? "provider turn completed without a semantic result; same-run disposition recovery persisted"
                : "native session transport interrupted; same-run resume persisted",
            payload: {
              attempt: coordinator?.attempt ?? null,
              nextAttemptAt: coordinator?.nextAttemptAt?.toISOString() ?? null,
              fallbackSuppressed: true,
              retryReasonCode,
              // The executor has already redacted and bounded this diagnostic
              // before persisting it. Retain it on the immutable transition
              // event as well: a same-run retry reopens the log stream, so the
              // first attempt's stderr must not be the only explanation for
              // why a live warm runner was replaced.
              failureDetail: coordinator?.failureDetail ?? null,
            },
          }).catch(() => undefined);
          if (coordinator?.nextAttemptAt) {
            scheduleNativeSessionResumeDispatch(
              run.id,
              coordinator.nextAttemptAt,
            );
          }
          return;
        }
        if (err instanceof NativeWorkspaceFinalizationBusyError
          || err instanceof NativeWorkspaceFinalizationOwnershipLostError) {
          // Another exact owner is finishing copyback, or this owner lost its
          // lock connection. Preserve the accepted result and let reconciliation
          // inspect durable ownership; neither case consumes an export retry.
          logger.info({ runId: run.id, reason: err.message }, "native workspace finalization deferred to its durable owner");
          return;
        }
        if (err instanceof NativeWorkspaceFinalizeScheduledError) {
          const coordinator = await db
            .select({
              nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
              attempt: nativeRunFinalizations.attempt,
            })
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, run.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          await appendRunEvent(run, {
            eventType: "lifecycle",
            stream: "system",
            level: err.terminalFailure ? "error" : "warn",
            message: err.terminalFailure
              ? err.reasonCode === "workspace_sync_out_failed"
                  ? "native result is durable; automatic workspace copy-back retries stopped and saved work is retained for export repair"
                  : "native result is durable, but the sandbox containing unexported workspace changes is unrecoverable"
              : "native result is durable; workspace copy-back will retry without another provider turn",
            payload: {
              attempt: coordinator?.attempt ?? null,
              nextAttemptAt: coordinator?.nextAttemptAt?.toISOString() ?? null,
              fallbackSuppressed: true,
              retryReasonCode: err.reasonCode,
            },
          }).catch(() => undefined);
          if (err.terminalFailure) {
            // The durable coordinator already failed the run, blocked the
            // issue, and cleared its execution lock. Let ordinary teardown
            // release the lease while retaining the sandbox and its unexported work.
            nativeWorkspaceFinalizeScheduled = false;
            providerResourceDispositionForRun = "stop_and_retain";
            await finalizeAgentStatus(
              run.agentId,
              "failed",
              `native_${err.reasonCode}`,
              { wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run) },
            ).catch(() => undefined);
          }
          return;
        }
        if (!(await preserveNativeWorkspaceOnFailure())) return;
        await runCompletion.failRun({
          run, agent, issueId, issueRef, signal: executionControl.controller.signal,
          output: runOutput,
          session: { runtimeForAdapter, previousSessionParams, taskKey, configuredModel, sessionConfigMetadata },
          readFailureReportSecrets,
          runId, err, identityRedactor, requiredWorkspaceRestoreEvidence, legacyAdapterEntered,
          goalCheckpointSession, previousSessionDisplayId, taskSession,
        });
      }
    } catch (outerErr) {
      if (
        nativeOwnershipHeld ||
        outerErr instanceof NativeRunnerOwnershipUnverifiedError
      ) {
        nativeOwnershipHeld = true;
        const heldRun = await getRun(run.id).catch(() => null);
        if (heldRun)
          await markNativeOwnershipUnverified(heldRun, {
            reason:
              outerErr instanceof NativeRunnerOwnershipUnverifiedError
                ? outerErr.reason
                : "adopted_runner_authentication_timeout",
          }).catch(() => undefined);
      } else if (outerErr instanceof StaleExecutionContinuationError) {
        // The queued continuation became obsolete before adapter dispatch.
        // Use cancellation settlement so wakeup, issue ownership, agent state,
        // and notifications agree; do not retry work for the previous owner.
        await cancelRunInternal(run.id, outerErr.code, {
          errorCode: outerErr.code,
          eventMessage: "stale execution continuation cancelled before dispatch",
          suppressImmediateRecovery: true,
        });
      } else if (isWorkspaceBusyDeferral(outerErr)) {
        // Expected contention on a shared project workspace, not a
        // failure: park the run as a bounded scheduled retry and leave the
        // holder undisturbed. The finally block below still releases
        // leases, runtime services, and scratch for this run.
        await finalizeWorkspaceBusyDeferral(run, outerErr).catch(
          (deferralErr) => {
            logger.error(
              { err: deferralErr, runId },
              "failed to finalize workspace-busy deferral",
            );
          },
        );
      } else {
        await preserveNativeWorkspaceOnFailure();
        if (!nativeOwnershipHeld) await runCompletion.failRunSetup({
          run, runId, outerErr, signal: executionControl.controller.signal,
          providerDispatchStarted: legacyAdapterEntered || nativeDispatchStarted,
          identityRedactor, readFailureReportSecrets,
        });
      }
    } finally {
      let caseHandoffCleanupSettled = false;
      await instructionWorkingCopy?.nativeInstructionReservation?.release().catch(error => logger.warn({ runId: run.id, err: error }, "Managed warm session preparation cleanup failed"));
      if (managedAiRuntime) await managedAiRuntime.cleanup().catch(() => logger.warn({ runId: run.id }, "AI connection refresh or cleanup failed"));
      let latestRun = await getRun(run.id).catch(() => null);
      try {
        if (latestRun && isHeartbeatRunTerminalStatus(latestRun.status)) {
          await writeExecutionControl(db, DELIVERY_QUEUES.executionFinalization, tx => tx
            .update(heartbeatRuns)
            .set({ executionControlDeadlineAt: null })
            .where(eq(heartbeatRuns.id, run.id)));
        }
        nativeOwnershipHeld =
          nativeOwnershipHeld ||
          Boolean(latestRun && isNativeRunnerOwnershipHeld(latestRun));
        // Trace capture is debug-only and must settle independently of every
        // provider outcome. Adapter/setup failures used to skip the success-path
        // finalizer, leaving metadata permanently stuck at `capturing` even when
        // runnerd had already closed (or never managed to write) its sidecar.
        // Same-run native resumes retain the open capture until the resumed
        // execution reaches a true terminal boundary.
        if (
          providerTraceCapture &&
          !providerTraceFinalized &&
          !nativeSessionResumeScheduled
        ) {
          try {
            await traceStore.finalize(run.id, run.companyId);
            providerTraceFinalized = true;
          } catch (traceFinalizeError) {
            logger.warn(
              { err: traceFinalizeError, runId: run.id },
              "provider trace finalization failed during heartbeat teardown",
            );
          }
        }
        // Close the invariant "environment lease released implies the run is
        // terminal". When the teardown reaches this point with the run still
        // running or queued, force a terminal status before the lease is
        // released, so the UI never shows a finished task as "Live".
        if (
          latestRun &&
          !nativeSessionResumeScheduled &&
          !nativeWorkspaceFinalizeScheduled &&
          !nativeOwnershipHeld
        ) {
          latestRun = await terminalizeRunOnLeaseRelease(latestRun).catch(
            (terminalizeErr) => {
              logger.error(
                { err: terminalizeErr, runId: run.id },
                "failed to terminalize run before environment lease release",
              );
              return latestRun;
            },
          );
        }
        // Warm retention is earned only by a fully successful turn. A failed,
        // cancelled, or timed-out run stops the reusable sandbox so the next
        // acquisition must revalidate and explicitly resume it.
        nativeOwnershipHeld =
          nativeOwnershipHeld ||
          Boolean(latestRun && isNativeRunnerOwnershipHeld(latestRun));
        providerResourceDispositionForRun =
          providerResourceDispositionForTerminalRun(
            providerResourceDispositionForRun,
            latestRun?.status,
          );
        if (
          !nativeSessionResumeScheduled &&
          !nativeWorkspaceFinalizeScheduled &&
          !nativeOwnershipHeld
        ) {
          // Keep launchers during same-run recovery. At a terminal boundary all
          // operations have settled; clean before the remote lease can be stopped.
          if (
            githubLauncherLocation &&
            latestRun &&
            isHeartbeatRunTerminalStatus(latestRun.status)
          ) {
            await cleanupGitHubOperationLaunchers(githubLauncherLocation).catch(
              (err) => {
                logger.warn(
                  { err, runId: run.id },
                  "failed to clean managed GitHub launchers",
                );
              },
            );
          }
          // A retained or unverified process stays above this release boundary.
          // If no stopped-copy capture occurred, preserve an explicit loss report.
          await instructionWorkingCopy?.releaseWarmInstructionPreparation?.();
          const uncapturedInstructions = await instructionCopies.reportUnavailable(run.companyId, run.id);
          if (uncapturedInstructions?.state === "unavailable") {
            await appendRunEvent(run, { eventType: "instruction_save", stream: "system", level: "warn",
              message: "Instruction edits could not be recovered before environment release. No instruction save is claimed.",
              payload: { state: "unavailable", code: uncapturedInstructions.errorCode } });
          }
          await withAdapterExecutionPhase(executionPhaseContext, "instruction_cleanup", releaseInstructionCopy);
          await withAdapterExecutionPhase(executionPhaseContext, "lease_release", () => releaseEnvironmentLeasesForRun({
            runId: run.id,
            companyId: run.companyId,
            agentId: run.agentId,
            status: latestRun?.status,
            failureReason: latestRun?.error ?? undefined,
            providerResourceDisposition: providerResourceDispositionForRun,
            nativeLifecycleTelemetry: nativeLifecycleTelemetryForRun,
          }));
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          caseHandoffCleanupSettled = true;
        }
        if (
          runScratch &&
          latestRun &&
          isHeartbeatRunTerminalStatus(latestRun.status)
        ) {
          const scratchForCleanup = runScratch;
          let scratchCleanup: Awaited<
            ReturnType<typeof cleanupHeartbeatRunScratch>
          > | null = null;
          try {
            scratchCleanup = await cleanupHeartbeatRunScratch({
              scratch: scratchForCleanup,
              processGroupId: latestRun.processGroupId,
              isProcessGroupAlive,
              beforeRemove: caseHandoffCleanupSettled && latestRun.runtimeMode === "legacy"
                ? () => recordLegacyCaseHandoffCleanupVerified(db, { runId: run.id, controllerBootId: legacyControllerBootId, scratch: scratchForCleanup })
                : undefined,
            });
          } catch (scratchCleanupError) {
            caseHandoffCleanupSettled = false;
            logger.warn(
              {
                err: scratchCleanupError,
                runId: run.id,
                scratchDir: scratchForCleanup.dir,
              },
              "failed to clean heartbeat run scratch directory",
            );
            await appendRunEvent(latestRun, {
              eventType: "error",
              stream: "system",
              level: "warn",
              message: "run scratch cleanup failed",
              payload: {
                dir: scratchForCleanup.dir,
                error:
                  scratchCleanupError instanceof Error
                    ? scratchCleanupError.message
                    : String(scratchCleanupError),
              },
            }).catch(() => undefined);
          }
          if (scratchCleanup) {
            // Scratch cleanup verifies the owned process group, including
            // grandchildren. The main adapter's exit is not this proof.
            if (!scratchCleanup.removed) caseHandoffCleanupSettled = false;
            await appendRunEvent(latestRun, {
              eventType: "lifecycle",
              stream: "system",
              level: scratchCleanup.removed ? "info" : "warn",
              message: scratchCleanup.removed
                ? "run scratch cleaned"
                : `run scratch cleanup skipped: ${scratchCleanup.reason}`,
              payload: scratchCleanup,
            }).catch((scratchCleanupEventError) => {
              logger.warn(
                {
                  err: scratchCleanupEventError,
                  runId: run.id,
                  scratchDir: scratchForCleanup.dir,
                },
                "failed to record heartbeat run scratch cleanup event",
              );
            });
          }
        }
        if (latestRun?.status === "interrupted" && latestRun.errorCode === "server_shutdown_interrupted") {
          latestRun = await settleInterruptedNativeBootstrap(db, { run: latestRun,
            providerDispatchStarted: legacyAdapterEntered || nativeDispatchStarted || nativeOwnershipHeld,
          }) ?? latestRun;
        }
        if (latestRun?.status === "cancelled" && !nativeDispatchStarted && !nativeOwnershipHeld &&
            (latestRun.runtimeMode === "native" ||
              parseObject(latestRun.resultJson?.startupCancellation).beforeNativeSelection === true)) {
          // This executor has finished preparation and lease cleanup without
          // handing off to native execution. Keep a durable receipt for admission
          // after a restart; cleanup receipts are independently rechecked there.
          await db.update(heartbeatRuns).set({
            resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
              ${JSON.stringify({ startupPreparationSettledAt: new Date().toISOString() })}::jsonb`,
          }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "cancelled")));
        }
        if (latestRun?.runtimeMode === "native" && isHeartbeatRunTerminalStatus(latestRun.status) &&
            !nativeSessionResumeScheduled && !nativeWorkspaceFinalizeScheduled && !nativeOwnershipHeld) {
          await settleNativeRunProcess(db, run.id).catch(error => {
            logger.warn({ err: error, runId: run.id }, "failed to release settled native process identity");
          });
        }
        await db.update(heartbeatRuns).set({
          executionStage: sql`case when ${heartbeatRuns.status} = 'cancelled' then 'settled' else ${heartbeatRuns.executionStage} end`,
          controllerLeaseExpiresAt: null,
        }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.runtimeMode, "legacy"),
          eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
          inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"])));

        latestRun = await getRun(run.id).catch(() => null);
        if (latestRun && isHeartbeatRunTerminalStatus(latestRun.status) && !isNativeRunnerOwnershipHeld(latestRun)) {
          await appendRunEvent(run, { eventType: "lifecycle", stream: "system", level: "info", message: "task.run.measured",
            payload: { phase: "task.run.measured", durationMs: Date.now() - (latestRun.startedAt ?? latestRun.createdAt).getTime(),
              outcome: latestRun.status, durableSettlement: true } }).catch(error => logger.warn({ runId: run.id, error }, "Could not record terminal run duration"));
        }
      } finally {
        controllerLease.stop();
        activeRunExecutions.delete(run.id);
        // A failed owned Stop remains visible until this exact executor settles,
        // including a graceful exit result arriving after the cancellation error.
        // It is never retained beyond the active execution's cleanup.
        failedProcessRunCancellations.delete(run.id);
        executionControl.finish();
        if (adapterExecutionControls.get(run.id) === executionControl) {
          adapterExecutionControls.delete(run.id);
        }
      }
      if (latestRun) await reconcileMuseNativeTerminalRun(db, latestRun);
      // Scratch preparation is optional. Its removal cannot be the only proof
      // that a local legacy adapter's closed-stdio descendants stopped.
      if (caseHandoffCleanupSettled && latestRun?.runtimeMode === "legacy" && legacyLocalAdapterEntered) {
        caseHandoffCleanupSettled = hasStoppedLocalProcessTree(latestRun);
      }
      if (caseHandoffCleanupSettled && latestRun && !nativeSessionResumeScheduled && !nativeWorkspaceFinalizeScheduled &&
          !nativeOwnershipHeld && isHeartbeatRunTerminalStatus(latestRun.status)) {
        const handoff = await pendingCaseHandoffForRun(db, run.id);
        if (handoff) await recordCaseHandoffExecutionReleased(db, run.id, handoff.issueId);
      }
      // Terminalization precedes lease and adapter cleanup. Only now is the
      // owner gone; retry pending input for ordinary completions as well as Stop.
      if (latestRun?.runtimeMode === "legacy" && ["failed", "timed_out"].includes(latestRun.status) &&
          latestRun.contextSnapshot?.explicitUserContinuation) {
        // Re-run the same queue-first recovery decision after cleanup. Its
        // earlier retry request could not authorize work while this executor
        // still held its controller or environment lease.
        await releaseIssueExecutionAndPromote(latestRun).catch(err => {
          logger.error({ err, runId: run.id }, "failed to settle explicit continuation after cleanup");
        });
      }
      if (latestRun?.runtimeMode === "legacy" && isHeartbeatRunTerminalStatus(latestRun.status)) {
        const [pending] = await db.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${String(latestRun.contextSnapshot?.issueId)}`,
        )).limit(1);
        if (pending) await (pending.payload?.queuedCommentInterrupt
          ? resumeQueuedCommentInterrupt(run.companyId, pending.id)
          : releaseIssueExecutionAndPromote(latestRun, { suppressImmediateRecovery: true })).catch(err => {
          logger.error({ err, runId: run.id }, "failed to promote legacy comment queue after cleanup");
        });
      }
      if (
        !nativeSessionResumeScheduled &&
        !nativeWorkspaceFinalizeScheduled &&
        !shutdownInProgress
      ) {
        if (latestRun) await resumeRemoteStopComments(latestRun).catch(err => {
          logger.warn({ err, runId: run.id }, "failed to resume user messages after remote Stop");
        });
        if (latestRun && isHeartbeatRunTerminalStatus(latestRun.status)) {
          await toolActionDeliveryService(db, { wakeup: trackWakeup })
            .deliverForRun({ companyId: run.companyId, runId: run.id })
            .catch(err => {
              logger.warn({ err, runId: run.id }, "failed to deliver settled tool reviews after execution cleanup");
            });
        }
        await startNextQueuedRunForAgent(run.agentId);
      }
    }
  }

  async function stopInvocationsForAgents(agentIds: string[], reason: string) {
    await cancelInvocationsForAgentsInternal(agentIds, reason);
    const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
    const leasesToRelease = await db.select({ runId: environmentLeases.heartbeatRunId }).from(environmentLeases)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))
      .where(and(inArray(heartbeatRuns.agentId, agentIds),
        or(and(eq(heartbeatRuns.status, "cancelled"), inArray(environmentLeases.status, ["active", "pending_cleanup"])),
          and(eq(environmentLeases.status, "retained"), eq(environmentLeases.cleanupStatus, "failed")))));
    const needsRelease = new Set(leasesToRelease.map(lease => lease.runId));
    for (const run of runs) {
      if (!isHeartbeatRunTerminalStatus(run.status) || liveRunExecutions.has(run.id) ||
          adapterExecutionControls.has(run.id) || processRunCancellationSettlements.has(run.id) ||
          (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())) return false;
      if (needsRelease.has(run.id)) {
        // Retry incomplete cleanup after a run becomes terminal.
        await releaseEnvironmentLeasesForRun({ runId: run.id, companyId: run.companyId,
          agentId: run.agentId, status: run.status, providerResourceDisposition: "destroy" });
      }
    }
    return agentExecutionsHaveStopped(db, agentIds);
  }

  return {
    stopInvocationsForAgents,
    waitForRunExecutionDrain: async (
      runId: string,
      options: { timeoutMs?: number; intervalMs?: number } = {},
    ) => {
      const timeoutMs = options.timeoutMs ?? 5_000;
      const intervalMs = options.intervalMs ?? 25;
      const deadline = Date.now() + timeoutMs;

      while (liveRunExecutions.has(runId)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for heartbeat run ${runId} execution to drain`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    list: listRuns,

    getRun,

    decorateActiveRunStatus: decorateHeartbeatRunRuntimeStatus,
    recordRuntimeProgress: recordCurrentHeartbeatRunRuntimeProgress,
    sweepExpiredRuntimeStatuses: sweepExpiredHeartbeatRunRuntimeStatuses,

    getRunReadAccess,
    getRunLogAccess,
    getRunWorkspaceAccess,

    getRuntimeState: getRuntimeStateWithSessions,

    listTaskSessions,

    resetRuntimeSession,

    listEvents,

    getRetryExhaustedReason,

    readLog: async (
      runOrLookup:
        | string
        | {
            id: string;
            companyId: string;
            logStore: string | null;
            logRef: string | null;
          },
      opts?: { offset?: number; limitBytes?: number; alignStartToRecord?: boolean; signal?: AbortSignal },
    ) => {
      const run =
        typeof runOrLookup === "string"
          ? await getRunLogAccess(runOrLookup)
          : runOrLookup;
      const runId =
        typeof runOrLookup === "string" ? runOrLookup : runOrLookup.id;
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
        // Run-log chunks are already redacted before they are appended to the store.
        // Rewriting the full chunk again on every poll creates avoidable string copies.
        content: result.content,
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: {
        actorType?: "user" | "agent" | "system";
        actorId?: string | null;
      },
    ) =>
      trackWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: trackWakeup,
    dispatchPendingNativeStatusWakeups,
    triggerIssueMonitor,

    reportRunActivity: clearDetachedRunWarning,
    registerExternalConversationSettlementWork: (
      coordinator: Parameters<ReturnType<typeof externalConversationSettlementWork>["register"]>[0], canRun: () => boolean,
    ) => externalConversationSettlementWork(db).register(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerNativeRecoveryNoticeWork: (
      coordinator: Parameters<ReturnType<typeof nativeRecoveryNoticeWork>["register"]>[0], canRun: () => boolean,
    ) => nativeRecoveryNoticeWork(db).register(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerNativeRunProjectionWork: (
      coordinator: Parameters<ReturnType<typeof nativeRunProjectionWork>["register"]>[0], canRun: () => boolean,
    ) => nativeRunProjectionWork(db).register(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerNativeResultCommitWork: (
      coordinator: Parameters<ReturnType<typeof nativeResultCommitWork>["register"]>[0], canRun: () => boolean,
    ) => nativeResultCommitWork(db).register(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerNativeEnvironmentSettlementWork: (
      coordinator: Parameters<typeof registerNativeEnvironmentSettlementWork>[0], canRun: () => boolean,
    ) => registerNativeEnvironmentSettlementWork(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerNativeWorkspaceFinalizationWork: (
      coordinator: Parameters<typeof registerNativeWorkspaceFinalizationWork>[0], canRun: () => boolean,
    ) => registerNativeWorkspaceFinalizationWork(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerRetainedNativeSessionCleanupWork: (
      coordinator: Parameters<typeof registerRetainedNativeSessionCleanupWork>[0], canRun: () => boolean,
    ) => registerRetainedNativeSessionCleanupWork(coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerNativeStatusReassessmentWork: (coordinator: Parameters<ReturnType<typeof nativeStatusReassessmentWork>["register"]>[0], canRun: () => boolean) =>
      nativeStatusReassessmentWork(db).register(coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerNativeReviewResponseWork: (coordinator: Parameters<typeof registerNativeReviewResponseWork>[1], canRun: () => boolean) =>
      registerNativeReviewResponseWork(db, coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerNativeResponsePresentationWork: (coordinator: Parameters<typeof registerNativeResponsePresentationWork>[1], canRun: () => boolean) =>
      registerNativeResponsePresentationWork(db, coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerNativePendingEffectWork: (coordinator: Parameters<typeof registerNativePendingEffectWork>[1], canRun: () => boolean) =>
      registerNativePendingEffectWork(db, coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerUnsafeWorkspaceExportWork: (coordinator: Parameters<typeof registerUnsafeWorkspaceExportWork>[1], canRun: () => boolean) =>
      registerUnsafeWorkspaceExportWork(db, coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerAutomaticCompletionReviewWork: (coordinator: Parameters<typeof registerAutomaticCompletionReviewWork>[1], canRun: () => boolean) =>
      registerAutomaticCompletionReviewWork(db, coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerObsoletePolicyReviewWork: (coordinator: Parameters<typeof registerObsoletePolicyReviewWork>[1], canRun: () => boolean) =>
      registerObsoletePolicyReviewWork(db, coordinator, () => canRun() && readTaskDrain(new Date()) === null),
    registerCancelledWorkspacePreservationWork: (
      coordinator: Parameters<typeof registerCancelledWorkspacePreservationWork>[1], canRun: () => boolean,
    ) => registerCancelledWorkspacePreservationWork(db, coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerStoppedInstructionCollectionWork: (
      coordinator: Parameters<typeof instructionCopies.registerStoppedCollectionWork>[0], canRun: () => boolean,
    ) => instructionCopies.registerStoppedCollectionWork(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerInstructionDirectoryCleanupWork: (
      coordinator: Parameters<typeof instructionCopies.registerDirectoryCleanupWork>[0], canRun: () => boolean,
    ) => instructionCopies.registerDirectoryCleanupWork(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerCapturedInstructionCommitWork: (
      coordinator: Parameters<typeof instructionCopies.registerCapturedCommitWork>[0], canRun: () => boolean,
    ) => instructionCopies.registerCapturedCommitWork(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),
    registerScheduledRetryCancellationWork: (
      coordinator: Parameters<typeof registerScheduledRetryCancellationWork>[0], canRun: () => boolean,
    ) => registerScheduledRetryCancellationWork(coordinator,
      () => canRun() && readTaskDrain(new Date()) === null,
      async () => {
        const state = await getSchedulingSuppression(true);
        return !state.suppressed || state.reason === "task_drain";
      }),

    prepareHotRestartShutdown,
    reconcileHotRestartAdoption,
    recoverNativeRunsAfterRestart,
    reapOrphanedRuns,
    sweepOrphanedActiveLeases,
    sweepPendingCleanupLeases,
    // Override-aware scheduling-suppression check (honors the worktree
    // run-execution experimental setting). Callers outside the service that
    // gate on suppression should prefer this over the env-only resolver.
    resolveSchedulingSuppression: getSchedulingSuppression,
    drainRunningRunsForShutdown,
    drainActiveRunExecutions,
    startTaskDrain,
    stopTaskDrain,
    getTaskDrainStatus,
    readUpgradeReadiness: () => readUpgradeReadiness(db, { activeRunIds: activeRunExecutions, counters: getTaskDrainStatus }),
    computeTaskDrain,
    applyTaskDrain,

    promoteDueScheduledRetries,
    retryScheduledRetryNow,

    resumeQueuedRuns,

    resumeQueuedRunsAfterDrain,

    resumeQueuedRunsForAgent: async (companyId: string, agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent || agent.companyId !== companyId) return [];
      return startNextQueuedRunForAgent(agentId);
    },

    scheduleBoundedRetry,

    reconcileStrandedAssignedIssues,
    recoverPendingSessionGoalActions,
    recoverActiveSessionGoals,

    terminalizeRunOnLeaseRelease,

    releaseEnvironmentLeasesForRun,
    resumeRemoteStopComments,
    resumeTaskRetry: runControl.resumeTaskRetry,
    resumeQueuedCommentInterrupt,
    resumeExecutionWaitComments,

    sweepStaleIssueLocks,

    reconcileResolvedDependencyWakes,

    scanSilentActiveRuns,

    reconcileTaskWatchdogs,
    reconcileCostAccounting,

    buildRunOutputSilence,

    tickTimers,
    tickAgentTimers,
    nextAgentTimerAt,
    tickIssueMonitors,
    nextIssueMonitorAt,

    cancelRun: (runId: string, reason?: string, options?: CancelRunOptions) =>
      cancelRunInternal(runId, reason, options),

    requestCaseHandoffYield: async (input: { runId: string; issueId: string; handoffId: string }) => {
      const handoff = await pendingCaseHandoffForRun(db, input.runId);
      if (!handoff || handoff.id !== input.handoffId || handoff.issueId !== input.issueId || handoff.state !== "awaiting_release") return;
      // Native tool-result observation parks the turn. Legacy adapters are told
      // to end it. Never stop synchronously inside the caller's own tool request.
      if (Date.now() - handoff.createdAt.getTime() < 30_000) return;
      const source = await getRun(input.runId);
      if (!source || !["queued", "running"].includes(source.status)) return;
      await cancelRunInternal(source.id, "Yielding the task to its next case phase", {
        errorCode: "issue_reassigned", suppressImmediateRecovery: true,
        resultJson: { caseHandoffYieldStop: true, reassignmentStopConfirmed: true, caseHandoffId: handoff.id },
      });
    },

    /**
     * Pause-only. Emits errorCode "agent_paused" unconditionally; its sole caller is the
     * agent pause route. For non-pause cancellations use cancelRun, or call the internal
     * cancelActiveForAgentInternal(agentId, reason, errorCode) with an explicit errorCode.
     */
    cancelActiveForAgent: (agentId: string, reason?: string) =>
      cancelActiveForAgentInternal(agentId, reason, "agent_paused"),

    cancelInvocationsForAgents: (agentIds: string[], reason: string) =>
      cancelInvocationsForAgentsInternal(agentIds, reason),

    cancelBudgetScopeWork,

    getRunIssueSummary,

    getRunIssueControl,

    getActiveRunIssueControlForAgent,

    getActiveRunForAgent,

    getActiveRunIssueSummaryForAgent,
  };
}
